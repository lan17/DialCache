module remote_io {
  // Remote effects the drivers hold and release by effect index (the position
  // of the read or decode in the drivers' invocation order): the traversal
  // splits again in time at the remote layer. `release` traverses with the
  // remote layer unobserved (`serving::judgeRelease`) and, when the traversal
  // reaches it, dispatches a read (counted then, its budget on the drivers'
  // io channel) and registers the caller's flight, so a follower released
  // while the read is pending joins it through the registries; `settleRead`
  // observes the frame with the state current at settlement and either holds
  // a decode (counted then) or starts the flight's loader with the authority
  // that read fixed (`serving::authority`: refill denied after a failed or
  // expired read, the fence the read observed, `remote_frames::fenceFor`);
  // `settleLoad` completes the flight from a decoded frame, warming local
  // storage for the reply's local TTL, or starts a loader after a failed
  // decode; `settleLoader` settles a loader by the drivers' ordinal: an
  // accepted value publishes and completes, a failure completes the flight
  // with its error unless the flight retained a snapshot the recovery rules
  // accept (`recovery`), in which case a recovery decode is held and the
  // flight stays pending and joinable.
  //
  // A flight is one `sources` record from its read dispatch to its
  // completion; `loaders` maps the drivers' loader ordinal (`o.loaders`) to
  // the flight it runs for, so `sources.length()` counts flights and
  // `loaders.length() == o.loaders`, and a flight whose decode failed restarts
  // a loader under a new ordinal. Held reads and decodes are pending-only
  // records: a settled one leaves nothing behind. A read whose deadline was
  // delivered owns nothing (`flight` NO_OWNER) and stays until its late reply
  // drains. The adapter's read fault is per release (`failed`), so
  // `readFailed` stays false in a held profile.
  //
  // The io channel (BEHAVIOR.md, `readIO`) is a mandatory field written by
  // the transitions that have each fact in hand: `budgets` one row per
  // dispatched read, `aborted` the expired reads in delivery order,
  // `sourceErrors` one row per caller, 0 at admission and the one-based
  // ordinal of the loader whose ordinary error the caller returned when it
  // completes with SOURCE_ERROR.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import remote_frames as Remote from "./remote-frames"
  import flights as Flights from "./flights"
  import recovery as Recovery from "./recovery"

  // A held read: the drivers' effect index, the flight registered for it at
  // dispatch (NO_OWNER once its deadline was delivered) and the effective TTLs
  // the reply resolved to (`layer_policy::effectiveTtls`: the local TTL a hit
  // warms with, the freshness the frame is judged by, the retention a refill
  // is written with and the recovery maximum).
  type HeldRead = { read: int, flight: int, ttls: Ttls }
  // A held decode: the drivers' index, its flight, the TTLs in force (a
  // recovery decode carries no local TTL and warms nothing), the bytes and
  // whether it is a recovery decode.
  type HeldLoad = { load: int, flight: int, ttls: Ttls, value: int, recovery: bool }
  type IO = { budgets: List[int], aborted: List[int], sourceErrors: List[int] }
  pure val NO_IO: IO = { budgets: List(), aborted: List(), sourceErrors: List() }
  type Held[r] = Serving::Served[{ reads: List[HeldRead], loads: List[HeldLoad], loaders: List[int], io: IO, retained: List[Recovery::Snapshot] | r }]

  pure def holdsRead(state: Held[r], read: int): bool = state.reads.select(held => held.read == read).length() > 0
  pure def heldRead(state: Held[r], read: int): HeldRead = state.reads.select(held => held.read == read).nth(0)
  pure def holdsLoad(state: Held[r], load: int): bool = state.loads.select(held => held.load == load).length() > 0
  pure def heldLoad(state: Held[r], load: int): HeldLoad = state.loads.select(held => held.load == load).nth(0)
  // A read owns its traversal until its deadline is delivered.
  pure def owning(held: HeldRead): bool = held.flight != NO_OWNER
  // The latest loader ordinal a flight ran (the identity its error carries).
  pure def latestLoader(state: Held[r], flight: int): int =
    state.loaders.indices().fold(NO_OWNER, (latest, ordinal) =>
      if (state.loaders.nth(ordinal) == flight and ordinal > latest) ordinal else latest)

  // -- Admission -----------------------------------------------------------------

  // Every caller has an io row for the error identity it may return; a
  // bypass source started at admission runs its loader at once, under the
  // next ordinal.
  pure def admit(state: Held[r], layout: Serving::Layout, call: Call): Held[r] = {
    val admitted = Serving::admit(state, layout, call)
    val recorded = { io: { sourceErrors: admitted.io.sourceErrors.append(0), ...admitted.io }, ...admitted }
    if (Serving::participating(state, layout, call)) recorded
    else { loaders: recorded.loaders.append(recorded.sources.length() - 1), ...recorded }
  }

  // -- Release: the traversal up to the remote layer -----------------------------

  // A read is dispatched for the caller: counted, budgeted on the io channel,
  // and its flight registered (shared when the reply coalesces over a shared
  // layer) so a follower released while it is pending joins it. The flight's
  // publication authority is fixed when the read settles.
  pure def dispatchRead(state: Held[r], layout: Serving::Layout, judged: Serving::LayeredRelease, ttls: Ttls, budget: int): Held[r] = {
    val call = judged.call
    val registered = Flights::registerSource(state,
      Serving::sourceOf({ instance: call.instance, key: call.key, localMs: 0, fence: NO_FENCE, retentionMs: 0 },
        CALL_PENDING, judged.effective.coalesce and sharedLayers(judged.effective.layers)),
      judged.caller, judged.decision.slot, judged.effective.coalesce, Serving::identity(layout, call))
    {
      reads: registered.reads.append({ read: state.o.reads, flight: state.sources.length(), ttls: effectiveTtls(judged.effective, ttls) }),
      io: { budgets: registered.io.budgets.append(budget), ...registered.io },
      o: { reads: registered.o.reads + 1, ...registered.o },
      ...registered
    }
  }
  // The release judged with the remote layer unobserved: a traversal that
  // reaches it dispatches the read; one that does not is the layered release.
  pure def release(state: Held[r], layout: Serving::Layout, policyCall: int, resolved: Resolution, ttls: Ttls, budget: int): Held[r] = {
    val judged = Serving::judgeRelease(state, layout, policyCall, resolved, ttls, false)
    val applied = Serving::applyRelease(state, layout, judged, policyCall, ttls)
    match judged.decision.outcome {
      | Starts => if (judged.effective.layers.remote) dispatchRead(applied, layout, judged, ttls, budget)
        else Serving::startSource(applied, layout, judged.caller, judged.call, judged.decision.slot, judged.open, judged.effective, ttls, false)
      | JoinsRequest(_) => applied
      | JoinsProcess(_) => applied
      | ServesMemo(_) => applied
      | ServesLocal(_) => applied
      // The remote layer is unobserved at release; nothing serves from it here.
      | ServesRemote(_) => applied
    }
  }
  // An immediate policy reply: admission and the held release in one step.
  pure def begin(state: Held[r], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls, budget: int): Held[r] = {
    val admitted = admit(state, layout, call)
    if (Serving::participating(state, layout, call)) release(admitted, layout, state.o.policyCalls, resolved, ttls, budget) else admitted
  }

  // -- Loaders and decodes ---------------------------------------------------------

  // A loader starts for a flight with the authority its read fixed: counted
  // against the profile and mapped from the drivers' next ordinal.
  pure def startLoader(state: Held[r], layout: Serving::Layout, flight: int, ttls: Ttls, readOk: bool, visible: bool): Held[r] = {
    val source = state.sources.nth(flight)
    val payload = Serving::authority(state, source, ttls, true, readOk, Remote::fenceFor(state, source.key, layout.operationsPerEntity, visible))
    {
      sources: state.sources.replaceAt(flight, Serving::sourceOf(payload, source.result, source.shared)),
      loaders: state.loaders.append(flight),
      ...Serving::started(state, layout, true)
    }
  }
  pure def holdLoad(state: Held[r], flight: int, ttls: Ttls, value: int, recovery: bool): Held[r] = {
    loads: state.loads.append({ load: state.o.loads, flight: flight, ttls: ttls, value: value, recovery: recovery }),
    o: { loads: state.o.loads + 1, ...state.o },
    ...state
  }

  // -- Read settlement -----------------------------------------------------------------

  // The read judged once with the state current at settlement: the record,
  // its flight's key, whether the adapter found a frame and the value a fresh
  // one serves. A read that owns nothing observes nothing.
  type ReadSettlement = { held: HeldRead, key: int, visible: bool, value: int }
  pure def judgeRead(state: Held[r], layout: Serving::Layout, read: int, failed: bool): ReadSettlement = {
    val held = heldRead(state, read)
    if (not(owning(held))) { held: held, key: NO_OWNER, visible: false, value: NO_VALUE }
    else {
      val key = state.sources.nth(held.flight).key
      val visible = not(failed) and Remote::visible(state, key, layout.operationsPerEntity)
      {
        held: held, key: key, visible: visible,
        value: if (visible) Remote::readableFrame(state, key, layout.operationsPerEntity, held.ttls.freshMs) else NO_VALUE
      }
    }
  }
  // A settled read that still owns its traversal: a frame the read judged
  // fresh is held for decoding; anything else starts the flight's loader with
  // the authority fixed here (refill denied after a failed read), a completed
  // read first retaining the flight's snapshot under the classifier in force.
  // A read expired by its deadline drains without effect.
  pure def settleRead(state: Held[r], layout: Serving::Layout, read: int, failed: bool, classifier: int): Held[r] = {
    val judged = judgeRead(state, layout, read, failed)
    val held = judged.held
    val settled = { reads: state.reads.select(other => other.read != read), ...state }
    if (not(owning(held))) settled
    else if (judged.value > NO_VALUE) holdLoad(settled, held.flight, held.ttls, judged.value, false)
    else {
      val retained = if (failed) settled
        else Recovery::retain(settled, held.flight, judged.key, layout.operationsPerEntity, judged.visible, held.ttls, classifier)
      startLoader(retained, layout, held.flight, held.ttls, not(failed), judged.visible)
    }
  }
  // A read whose deadline is delivered: recorded as aborted, disowned (its
  // late reply drains), and its flight's loader starts at once with refill
  // denied (the read never completed) and no fence.
  pure def expireRead(state: Held[r], layout: Serving::Layout, read: int): Held[r] = {
    val held = heldRead(state, read)
    startLoader({
      reads: state.reads.foldl(List(), (out, other) => out.append(if (other.read == read) { flight: NO_OWNER, ...other } else other)),
      io: { aborted: state.io.aborted.append(read), ...state.io },
      ...state
    }, layout, held.flight, held.ttls, false, false)
  }

  // -- Completion ------------------------------------------------------------------

  // Every owner completes; a caller that returned its loader's ordinary error
  // records the loader's identity; the flight's snapshot, if any, is dropped.
  pure def complete(state: Held[r], layout: Serving::Layout, flight: int, value: int): Held[r] = {
    val identity = if (value == SOURCE_ERROR) latestLoader(state, flight) + 1 else 0
    val recorded = Flights::ownedBy(state, flight).fold(state, (out, caller) =>
      { io: { sourceErrors: out.io.sourceErrors.replaceAt(caller, identity), ...out.io }, ...out })
    Recovery::drop(Serving::complete(recorded, layout, flight, value), flight)
  }
  pure def finish(state: Held[r], layout: Serving::Layout, flight: int, value: int): Held[r] =
    complete(Flights::recordResult(state, flight, value), layout, flight, value)
  // A failed loader: its error recorded on the flight; a flight without a
  // snapshot completes with the error, unclassified; one with a snapshot is
  // classified once and holds a recovery decode while the candidate's age
  // allows, its callers pending and its flight joinable, else completes with
  // the error, reporting a miss when recovery was allowed.
  pure def failed(state: Held[r], layout: Serving::Layout, flight: int, error: int, timeout: bool): Held[r] = {
    val recorded = Flights::recordResult(state, flight, error)
    val snapshot = Recovery::retainedFor(recorded, flight)
    if (snapshot.flight == NO_OWNER) complete(recorded, layout, flight, error)
    else {
      val classified = Recovery::classified(recorded, flight, error)
      val recovers = Recovery::mayRecover(snapshot, timeout)
      if (recovers and Recovery::validCandidate(classified, snapshot))
        holdLoad(classified, flight, { localMs: 0, freshMs: 0, retentionMs: snapshot.maximum }, snapshot.candidate, true)
      else complete(if (recovers) Recovery::recordOutcome(classified, "miss") else classified, layout, flight, error)
    }
  }
  // The drivers settle a loader by its ordinal: an accepted value publishes
  // with the flight's authority and completes it; an error is classified.
  // `timeout` marks a propagated timeout settled as an error.
  pure def settleLoader(state: Held[r], layout: Serving::Layout, ordinal: int, value: int, timeout: bool): Held[r] = {
    val flight = state.loaders.nth(ordinal)
    if (accepted(value)) finish(Serving::publish(state, layout, flight, value), layout, flight, value)
    else failed(state, layout, flight, value, timeout)
  }
  // A held decode settles: a fresh decode completes the flight with its value
  // (warming local storage for the reply's local TTL) or, failed, starts the
  // flight's loader with refill allowed and no fence (the frame it decoded was
  // visible); a recovery decode rechecks the candidate's age and completes the
  // flight with the candidate or the loader's own error, never publishing.
  pure def settleLoad(state: Held[r], layout: Serving::Layout, load: int, failed: bool): Held[r] = {
    val held = heldLoad(state, load)
    val settled = { loads: state.loads.select(other => other.load != load), ...state }
    if (held.recovery) {
      val outcome = Recovery::recovered(settled, Recovery::retainedFor(settled, held.flight), failed)
      complete(Recovery::recordOutcome(settled, outcome.label), layout, held.flight, outcome.value)
    } else if (failed) startLoader(settled, layout, held.flight, held.ttls, true, true)
    else finish(Serving::warm(settled, layout, state.sources.nth(held.flight), held.value, held.ttls.localMs), layout, held.flight, held.value)
  }
}

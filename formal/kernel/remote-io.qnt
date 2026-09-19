module remote_io {
  // Remote effects the drivers hold and release by effect index (the position
  // of the read or decode in the drivers' invocation order): the traversal
  // splits again in time at the remote layer. `release` traverses with the
  // remote layer unobserved (`serving::judgeRelease`) and, when the traversal
  // reaches it, dispatches a read (counted then, its budget on the drivers'
  // io channel) and registers the caller's flight, so a follower released
  // while the read is pending joins it through the registries; a traversal
  // that starts a source without the remote layer starts it at once, under
  // the next loader ordinal. `settleRead` observes the frame with the state
  // current at settlement (`remote_frames::observe`) and either holds a
  // decode (counted then) or starts the flight's loader with the authority
  // that read fixed (`serving::authority`: refill denied after a failed or
  // expired read, the fence the read observed, `remote_frames::fenceFor`);
  // `settleLoad` completes the flight from a decoded frame, warming local
  // storage for the reply's local TTL, or starts a loader after a failed
  // decode (the drivers' fault, or a payload whose bytes fail to decode,
  // `payloads::decodeFails`); `settleLoader` settles a loader by the
  // drivers' ordinal: an
  // accepted value publishes and completes, a failure completes the flight
  // with its error unless the flight retained a snapshot the recovery rules
  // accept (`recovery`), in which case a recovery decode is held and the
  // flight stays pending and joinable.
  //
  // A flight is one `sources` record from its start (a read dispatch, or a
  // source started at admission or at a release without the remote layer) to
  // its completion; `loaders` maps the drivers' loader ordinal (`o.loaders`)
  // to the flight it runs for, so `sources.length()` counts flights and
  // `loaders.length() == o.loaders`: a source that starts as a new flight
  // takes the next ordinal (`mapLoader`), a loader started later for a held
  // read's flight maps itself (`startLoader`), and a flight whose decode
  // failed restarts a loader under a new ordinal. Held reads and decodes are
  // pending-only records: a settled one leaves nothing behind. A read whose
  // deadline was delivered owns nothing (`flight` NO_OWNER) and stays until
  // its late reply drains. The adapter's read fault is per release
  // (`failed`), so `readFailed` stays false in a held profile; a visible
  // frame whose payload fails the read (`payloads::readFails`) fails it the
  // same way, judged once in `remote_frames::observe`. A held decode holds
  // the frame's payload code and decodes it when it settles
  // (`payloads::valueOf`), as does a recovery decode its snapshot's candidate.
  //
  // `begin` is admission and the held release in one step for a profile
  // whose replies are immediate, like `serving::begin`; `latestRead`,
  // `latestLoad` and `latestOrdinal` name the most recently held read and
  // decode and the newest loader ordinal, for profiles whose drivers name
  // the latest effect rather than an index (a wrapper guards on the list
  // being non-empty, as it does on `holdsRead`).
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
  import payloads as Payloads from "./payloads"

  // A held read: the drivers' effect index, the flight registered for it at
  // dispatch (NO_OWNER once its deadline was delivered) and the effective TTLs
  // the reply resolved to (`layer_policy::effectiveTtls`: the local TTL a hit
  // warms with, the freshness the frame is judged by, the retention a refill
  // is written with and the recovery maximum).
  type HeldRead = { read: int, flight: int, ttls: Ttls }
  // A held decode: the drivers' index, its flight, the TTLs in force (a
  // recovery decode carries none, `NO_TTLS`: it warms nothing and its maximum
  // is the snapshot's), the bytes (the frame's payload code, decoded when the
  // load settles) and whether it is a recovery decode.
  type HeldLoad = { load: int, flight: int, ttls: Ttls, value: int, recovery: bool }
  type IO = { budgets: List[int], aborted: List[int], sourceErrors: List[int] }
  pure val NO_IO: IO = { budgets: List(), aborted: List(), sourceErrors: List() }
  type Held[r] = Serving::Served[{ reads: List[HeldRead], loads: List[HeldLoad], loaders: List[int], io: IO, retained: List[Recovery::Snapshot] | r }]

  pure def holdsRead(state: Held[r], read: int): bool = state.reads.select(held => held.read == read).length() > 0
  pure def heldRead(state: Held[r], read: int): HeldRead = state.reads.select(held => held.read == read).nth(0)
  pure def holdsLoad(state: Held[r], load: int): bool = state.loads.select(held => held.load == load).length() > 0
  pure def heldLoad(state: Held[r], load: int): HeldLoad = state.loads.select(held => held.load == load).nth(0)
  // The most recently held read and decode (the held lists are in dispatch
  // order) and the newest loader ordinal (NO_OWNER before any loader ran).
  pure def latestRead(state: Held[r]): HeldRead = state.reads.nth(state.reads.length() - 1)
  pure def latestLoad(state: Held[r]): HeldLoad = state.loads.nth(state.loads.length() - 1)
  pure def latestOrdinal(state: Held[r]): int = state.loaders.length() - 1
  // A read owns its traversal until its deadline is delivered.
  pure def owning(held: HeldRead): bool = held.flight != NO_OWNER
  // The latest loader ordinal a flight ran (the identity its error carries).
  pure def latestLoader(state: Held[r], flight: int): int =
    state.loaders.indices().fold(NO_OWNER, (latest, ordinal) =>
      if (state.loaders.nth(ordinal) == flight and ordinal > latest) ordinal else latest)
  // A source a step started as a new flight (the latest `sources` record)
  // runs its loader at once, under the drivers' next ordinal: the mapping of
  // a started source, stated once for admission and release.
  pure def mapLoader(before: Held[r], after: Held[r]): Held[r] =
    if (after.o.loaders > before.o.loaders) { loaders: after.loaders.append(after.sources.length() - 1), ...after } else after

  // -- Admission -----------------------------------------------------------------

  // Every caller has an io row for the error identity it may return; a
  // bypass source started at admission takes the next ordinal.
  pure def admit(state: Held[r], layout: Serving::Layout, call: Call): Held[r] = {
    val admitted = Serving::admit(state, layout, call)
    mapLoader(state, { io: { sourceErrors: admitted.io.sourceErrors.append(0), ...admitted.io }, ...admitted })
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
  // reaches the remote layer dispatches the read; one that starts a source
  // without it (a reply without the remote layer, or the bypass reply of a
  // scope closed since admission) starts the source at once, under the next
  // ordinal; one that serves or joins is the layered release.
  pure def release(state: Held[r], layout: Serving::Layout, policyCall: int, resolved: Resolution, ttls: Ttls, budget: int): Held[r] = {
    val judged = Serving::judgeRelease(state, layout, policyCall, resolved, ttls, false)
    val applied = Serving::applyRelease(state, layout, judged, policyCall, ttls)
    match judged.decision.outcome {
      | Starts => if (judged.effective.layers.remote) dispatchRead(applied, layout, judged, ttls, budget)
        else mapLoader(applied, Serving::startSource(applied, layout, judged.caller, judged.call, judged.decision.slot, judged.open, judged.effective, ttls, judged.readOk, false))
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

  // A read that owns its traversal, judged once with the state current at
  // settlement (`remote_frames::observe`): its flight's key, whether the read
  // failed (the drivers' fault or a payload that fails the read), whether the
  // adapter found a frame, its payload code and the value a fresh one serves.
  type ReadSettlement = { key: int, visible: bool, failed: bool, payload: int, value: int }
  pure def judgeRead(state: Held[r], layout: Serving::Layout, held: HeldRead, failed: bool): ReadSettlement = {
    val key = state.sources.nth(held.flight).key
    val observed = Remote::observe(state, key, layout.operationsPerEntity, held.ttls.freshMs, failed)
    { key: key, visible: observed.visible, failed: observed.failed, payload: observed.payload, value: observed.value }
  }
  // A settled read that still owns its traversal: a frame the read judged
  // fresh is held for decoding with its payload code; anything else starts
  // the flight's loader with the authority fixed here (refill denied after a
  // failed read), a completed read first retaining the flight's snapshot
  // under the classifier in force. A read expired by its deadline drains
  // without effect.
  pure def settleRead(state: Held[r], layout: Serving::Layout, read: int, failed: bool, classifier: int): Held[r] = {
    val held = heldRead(state, read)
    val settled = { reads: state.reads.select(other => other.read != read), ...state }
    if (not(owning(held))) settled
    else {
      val judged = judgeRead(state, layout, held, failed)
      if (judged.value > NO_VALUE) holdLoad(settled, held.flight, held.ttls, judged.payload, false)
      else {
        val retained = if (judged.failed) settled else Recovery::retain(settled, held.flight, judged.key, judged.visible, held.ttls, classifier)
        startLoader(retained, layout, held.flight, held.ttls, not(judged.failed), judged.visible)
      }
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
  // the error, reporting a miss when recovery was allowed. A deadline error
  // is a timeout for the recovery rules, as is a propagated timeout the
  // profile names (`timeout`).
  pure def failed(state: Held[r], layout: Serving::Layout, flight: int, error: int, timeout: bool): Held[r] = {
    val recorded = Flights::recordResult(state, flight, error)
    val snapshot = Recovery::retainedFor(recorded, flight)
    if (snapshot.flight == NO_OWNER) complete(recorded, layout, flight, error)
    else {
      val classified = Recovery::classified(recorded, snapshot)
      val recovers = Recovery::mayRecover(snapshot, timeout or error == DEADLINE_ERROR)
      if (recovers and Recovery::validCandidate(classified, snapshot)) holdLoad(classified, flight, NO_TTLS, snapshot.candidate, true)
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
  // A held decode settles: a fresh decode completes the flight with the value
  // its payload decodes to (warming local storage for the reply's local TTL)
  // or, failed (the drivers' fault or a payload whose bytes fail to decode),
  // starts the flight's loader with refill allowed and no fence (the frame it
  // decoded was visible); a recovery decode rechecks the candidate's age and
  // completes the flight with the value the candidate decodes to or, when it
  // does not serve (a failed decode among the reasons), with the outcome the
  // flight's source recorded (its loader's own error), never publishing.
  pure def settleLoad(state: Held[r], layout: Serving::Layout, load: int, failed: bool): Held[r] = {
    val held = heldLoad(state, load)
    val settled = { loads: state.loads.select(other => other.load != load), ...state }
    if (held.recovery) {
      val snapshot = Recovery::retainedFor(settled, held.flight)
      val outcome = Recovery::recovered(settled, snapshot, failed or Payloads::decodeFails(snapshot.candidate))
      complete(Recovery::recordOutcome(settled, outcome.label), layout, held.flight,
        if (outcome.served) Payloads::valueOf(snapshot.candidate) else settled.sources.nth(held.flight).result)
    } else if (failed or Payloads::decodeFails(held.value)) startLoader(settled, layout, held.flight, held.ttls, true, true)
    else {
      val value = Payloads::valueOf(held.value)
      finish(Serving::warm(settled, layout, state.sources.nth(held.flight), value, held.ttls.localMs), layout, held.flight, value)
    }
  }
}

module remote_io {
  // Remote effects the drivers hold and release by effect index, the position of the read or
  // decode in the drivers' order: the traversal splits again in time at the remote layer.
  //
  // Rules
  // - A release reaching the remote layer dispatches a read and registers the caller's flight, so a
  //   follower released meanwhile joins it (C11); without the remote layer a source starts at once.
  // - A read settles with the state then current: a fresh frame holds a decode, else the flight's
  //   loader starts under the authority the read fixed: no refill after a failed read (C28, C34).
  // - A decoded frame completes the flight, warming local storage for the reply's local TTL (C31);
  //   a failed decode starts the loader with refill allowed and no fence (C27).
  // - A loader settles by the drivers' ordinal: an accepted value publishes and completes; a failed
  //   one completes with its error, or holds a recovery decode over a retained snapshot (C41, C43).
  // - An expired read owns nothing; its late reply drains (C28, C56).
  // Shapes
  // - HeldRead: a pending read: its effect index, its flight and the reply's effective TTLs.
  // - HeldLoad: a pending decode: index, flight, TTLs, the payload code and whether it recovers.
  // - IO: the drivers' io channel: read budgets, aborted reads, per-caller source-error identities.
  // - Held[r]: the layered shape plus held reads and decodes, the loader map, `io` and snapshots.
  // Consumers: admission, dark-layers, effects, independent, recovery, recovery-read, shadow,
  //   shadow-read-deadlines; composed through `deadlines`, `shadow`, `compression`, `diagnostics`,
  //   `metrics`, `adapter_replies`, `shadow_reads`.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import remote_frames as Remote from "./remote-frames"
  import flights as Flights from "./flights"
  import recovery as Recovery from "./recovery"
  import payloads as Payloads from "./payloads"

  // A held read: the drivers' effect index, the flight registered for it at dispatch (NO_OWNER
  // once its deadline was delivered) and the effective TTLs the reply resolved to
  // (`layer_policy::effectiveTtls`: the local TTL a hit warms with, the freshness the frame is
  // judged by, the retention a refill is written with and the recovery maximum).
  type HeldRead = { read: int, flight: int, ttls: Ttls }
  // A held decode: the drivers' index, its flight, the TTLs in force (a
  // recovery decode carries none, `NO_TTLS`: it warms nothing and its maximum
  // is the snapshot's), the bytes (the frame's payload code, decoded when the
  // load settles) and whether it is a recovery decode. A held decode holds the
  // frame's payload code and decodes it when it settles (`Payloads::valueOf`),
  // as does a recovery decode its snapshot's candidate.
  type HeldLoad = { load: int, flight: int, ttls: Ttls, value: int, recovery: bool }
  // The io channel (`s.io` in BEHAVIOR.md, projected by `readIO` in
  // formal/replay/features.mjs) is a mandatory field written by the
  // transitions that have each fact in hand. `budgets` holds one row per
  // dispatched read and `aborted` the expired reads in delivery order.
  // `sourceErrors` holds one row per caller: 0 at admission, and the
  // one-based ordinal of the loader whose ordinary error the caller returned
  // when it completes with SOURCE_ERROR.
  type IO = { budgets: List[int], aborted: List[int], sourceErrors: List[int] }
  pure val NO_IO: IO = { budgets: List(), aborted: List(), sourceErrors: List() }
  // The layered shape with the held effects beside it, each held and released
  // by its effect index, the position of the read or decode in the drivers'
  // invocation order. A flight is one `sources` record from its start (a read
  // dispatch, or a source started at admission or at a release without the
  // remote layer) to its completion. `loaders` maps the drivers' loader
  // ordinal (`o.loaders`) to the flight it runs for, so the length of
  // `sources` counts flights and the length of `loaders` is the drivers'
  // loader count. A source that starts as a new flight takes the next ordinal
  // (`mapLoader`), a loader started later for a held read's flight maps itself
  // (`startLoader`), and a flight whose decode failed restarts a loader under
  // a new ordinal. Held reads and decodes are pending-only records: a settled
  // one leaves nothing behind.
  type Held[r] = Serving::Served[{ reads: List[HeldRead], loads: List[HeldLoad], loaders: List[int], io: IO, retained: List[Recovery::Snapshot] | r }]

  pure def holdsRead(state: Held[r], read: int): bool = state.reads.select(held => held.read == read).length() > 0
  pure def heldRead(state: Held[r], read: int): HeldRead = state.reads.select(held => held.read == read).nth(0)
  pure def holdsLoad(state: Held[r], load: int): bool = state.loads.select(held => held.load == load).length() > 0
  pure def heldLoad(state: Held[r], load: int): HeldLoad = state.loads.select(held => held.load == load).nth(0)
  // The most recently held read and decode (the held lists are in dispatch
  // order) and the newest loader ordinal (NO_OWNER before any loader ran).
  // Profiles whose drivers name the latest effect rather than an index use
  // these; a wrapper guards on the list being non-empty, as it does on
  // `holdsRead`.
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

  // A read held over a flight: counted then, budgeted on the io channel (one
  // row per dispatched read), the record under the drivers' next read index. A
  // caller's read is dispatched here at release; a job's confirmation read is
  // held the same way (`shadow`).
  pure def holdRead(state: Held[r], flight: int, ttls: Ttls, budget: int): Held[r] = {
    reads: state.reads.append({ read: state.o.reads, flight: flight, ttls: ttls }),
    io: { budgets: state.io.budgets.append(budget), ...state.io },
    o: { reads: state.o.reads + 1, ...state.o },
    ...state
  }
  // A read is dispatched for the caller: counted, budgeted on the io channel,
  // and its flight registered (shared when the reply coalesces over a shared
  // layer) so a follower released while it is pending joins it through the
  // registries. The flight's publication authority is fixed when the read
  // settles.
  pure def dispatchRead(state: Held[r], layout: Serving::Layout, judged: Serving::LayeredRelease, ttls: Ttls, budget: int): Held[r] = {
    val call = judged.call
    val registered = Flights::registerSource(state,
      Serving::sourceOf({ instance: call.instance, key: call.key, localMs: 0, fence: NO_FENCE, retentionMs: 0 },
        CALL_PENDING, judged.effective.coalesce and sharedLayers(judged.effective.layers)),
      judged.caller, judged.decision.slot, judged.effective.coalesce, Serving::identity(layout, call))
    holdRead(registered, state.sources.length(), effectiveTtls(judged.effective, ttls), budget)
  }
  // The release applied from a judgment already made on this state
  // (`Serving::judgeRelease` with the remote layer unobserved): a traversal
  // that reaches the remote layer dispatches the read; one that starts a
  // source without it (a reply without the remote layer, or the bypass reply
  // of a scope closed since admission) starts the source at once, under the
  // next ordinal; one that serves or joins is the layered release. A variant
  // that records beside the held release (`diagnostics`) judges once through
  // `Serving::judgeRelease` and applies this; `release` is its composition
  // with the judgment.
  pure def releaseJudged(state: Held[r], layout: Serving::Layout, judged: Serving::LayeredRelease, policyCall: int, ttls: Ttls, budget: int): Held[r] = {
    val applied = Serving::applyRelease(state, layout, judged, policyCall, ttls)
    match judged.decision.outcome {
      | Starts => if (judged.effective.layers.remote) dispatchRead(applied, layout, judged, ttls, budget)
        else mapLoader(applied, Serving::startSource(applied, layout, judged.caller, judged.call, judged.decision.slot, judged.open, judged.effective, ttls, judged.remote))
      | JoinsRequest(_) => applied
      | JoinsProcess(_) => applied
      | ServesMemo(_) => applied
      | ServesLocal(_) => applied
      // The remote layer is unobserved at release; nothing serves from it here.
      | ServesRemote(_) => applied
    }
  }
  pure def release(state: Held[r], layout: Serving::Layout, policyCall: int, resolved: Resolution, ttls: Ttls, budget: int): Held[r] =
    releaseJudged(state, layout, Serving::judgeRelease(state, layout, policyCall, resolved, ttls, false), policyCall, ttls, budget)
  // An immediate policy reply: admission and the held release in one step, like
  // `Serving::begin`.
  pure def begin(state: Held[r], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls, budget: int): Held[r] = {
    val admitted = admit(state, layout, call)
    if (Serving::participating(state, layout, call)) release(admitted, layout, state.o.policyCalls, resolved, ttls, budget) else admitted
  }

  // -- Loaders and decodes ---------------------------------------------------------

  // A loader starts for a flight with the authority its read fixed
  // (`Serving::authority`: refill denied after a failed or expired read, and
  // the fence the read observed): counted against the profile and mapped from
  // the drivers' next ordinal.
  // `startLoaderFenced` takes the fence the refill carries as an argument (a
  // queued adapter reply supplies its own, effects); `startLoader` reads it
  // from the frames the read observed (`Remote::fenceFor`).
  pure def startLoaderFenced(state: Held[r], layout: Serving::Layout, flight: int, ttls: Ttls, readOk: bool, fence: int): Held[r] = {
    val source = state.sources.nth(flight)
    val payload = Serving::authority(state, source, ttls, true, readOk, fence)
    {
      sources: state.sources.replaceAt(flight, Serving::sourceOf(payload, source.result, source.shared)),
      loaders: state.loaders.append(flight),
      ...Serving::started(state, layout, true)
    }
  }
  pure def startLoader(state: Held[r], layout: Serving::Layout, flight: int, ttls: Ttls, readOk: bool, visible: bool): Held[r] =
    startLoaderFenced(state, layout, flight, ttls, readOk, Remote::fenceFor(state, state.sources.nth(flight).key, layout.operationsPerEntity, visible))
  // A decode held over a flight: counted then, under the drivers' next decode
  // index.
  pure def holdLoad(state: Held[r], flight: int, ttls: Ttls, value: int, recovery: bool): Held[r] = {
    loads: state.loads.append({ load: state.o.loads, flight: flight, ttls: ttls, value: value, recovery: recovery }),
    o: { loads: state.o.loads + 1, ...state.o },
    ...state
  }

  // -- Read settlement -----------------------------------------------------------------

  // A settled read that still owns its traversal: a frame the read judged
  // fresh is held for decoding with its payload code; anything else starts
  // the flight's loader with the authority fixed here (refill denied after a
  // failed read), a completed read first retaining the flight's snapshot
  // under the classifier in force. A read expired by its deadline drains
  // without effect.
  //
  // The settlement is applied from a judgment already made (`settleObserved`:
  // what the read observed and the fence a refill it starts carries), so a
  // variant that substitutes the observation (the reply an adapter queued,
  // which the effects drivers hold) applies the same settlement; `settleRead`
  // is its composition with the judgment of the frames (`Remote::observe`,
  // `Remote::fenceFor`). A read that owns nothing is judged as unobserved.
  pure def settleObserved(state: Held[r], layout: Serving::Layout, read: int, judged: Remote::Observed, fence: int, classifier: int): Held[r] = {
    val held = heldRead(state, read)
    val settled = { reads: state.reads.select(other => other.read != read), ...state }
    if (not(owning(held))) settled
    else if (judged.value > NO_VALUE) holdLoad(settled, held.flight, held.ttls, judged.payload, false)
    else {
      val key = state.sources.nth(held.flight).key
      val retained = if (judged.failed) settled else Recovery::retain(settled, held.flight, key, judged.visible, held.ttls, classifier)
      startLoaderFenced(retained, layout, held.flight, held.ttls, not(judged.failed), fence)
    }
  }
  // The adapter's read fault is per release, the `failed` argument: a held
  // read takes its fault as an argument when it settles. A read settled in
  // the step that dispatched it is the budgeted variant's
  // (`deadlines::settleDispatched`), which passes the shape's `readFailed`
  // switch, as the atomic path does. A visible frame whose payload fails the
  // read (`Payloads::readFails`) fails it the same way, judged once in
  // `Remote::observe`.
  pure def settleRead(state: Held[r], layout: Serving::Layout, read: int, failed: bool, classifier: int): Held[r] = {
    val held = heldRead(state, read)
    if (not(owning(held))) settleObserved(state, layout, read, Remote::UNOBSERVED, NO_FENCE, classifier)
    else {
      val key = state.sources.nth(held.flight).key
      val judged = Remote::observe(state, key, layout.operationsPerEntity, held.ttls.freshMs, failed)
      settleObserved(state, layout, read, judged, Remote::fenceFor(state, key, layout.operationsPerEntity, judged.visible), classifier)
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
      val judged = Recovery::failure(recorded, snapshot, error, timeout)
      if (judged.serves) holdLoad(judged.state, flight, NO_TTLS, snapshot.candidate, true)
      else complete(judged.state, layout, flight, error)
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
  // A held decode settles. A fresh decode completes the flight with the value
  // its payload decodes to (`Payloads::valueOf`), warming local storage for
  // the reply's local TTL. Failed (the drivers' fault or a payload whose bytes
  // fail to decode, `Payloads::decodeFails`), it starts the flight's loader
  // under a new ordinal with refill allowed and no fence (the frame it decoded
  // was visible). A recovery decode rechecks the candidate's age and completes
  // the flight with the value the candidate decodes to. When it does not serve
  // (a failed decode among the reasons), it completes with the outcome the
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

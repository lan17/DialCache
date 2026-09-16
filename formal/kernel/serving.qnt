module serving {
  // The serving path: admit a caller, join or consult each enabled layer in
  // order (request memo, local, remote), and otherwise start a source; then
  // settle a source and publish its value to the layers that own it. Every
  // portable rule about ownership, traversal order and publication authority
  // is stated here once; profiles supply bounded state, inputs and layouts.
  //
  // Admission and traversal are two transitions because the drivers can hold
  // a policy reply: `admit` counts the policy call and holds the caller with
  // its call, `release` traverses for it with the state current at release.
  // `begin` is their composition for a profile whose replies are immediate.
  //
  // The traversal comes in three shapes over the same order (`decide`): the
  // layered one (`admit`, `release`, `settle`) over every layer; the local
  // projection (`admitLocal`, `releaseLocal`, `settleLocal`) for a profile
  // without remote storage, whose source record carries the identity it
  // serves and the local TTL it may warm local storage for; and the request-only
  // projection (`admitRequest`,
  // `releaseRequest`, `settleRequest`) for a profile whose only layer is the
  // request memo, which carries no storage, no clock and a source record
  // without publication payload. A projection exists only where the layered
  // shape cannot meet a profile's bytes-per-state bound; it states no rule of
  // its own.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import request_memo as Memo from "./request-memo"
  import local_storage as Local from "./local-storage"
  import remote_frames as Remote from "./remote-frames"
  import flights as Flights from "./flights"
  import policy_gate as Gate from "./policy-gate"

  // How a profile lays out its bounded identities: keys per instance (local
  // storage and process flights), keys per scope row (request memo), how many
  // contexts are persistent scopes, keys per entity, and whether the drivers
  // probe each source for the scope it started under (o.sourceScopes). TTLs
  // are not layout: every release and settlement takes the `Ttls` the reply
  // resolved to (a fixture's constant where replies carry none).
  type Layout = {
    keysPerInstance: int, keysPerScope: int, persistentContexts: int, operationsPerEntity: int, probeSourceScope: bool
  }
  // A source record is flights::Source over the payload the traversal needs to
  // publish, captured from the reply that started it so each source publishes
  // with that reply's TTLs: a layered source carries its publication authority
  // (the identity it serves, the local TTL it may warm local storage for, 0
  // when it may not, whether it refills the remote layer, the fence it
  // observed and the retention its refill is written with, 0 when it does not
  // refill); a local source carries the identity it serves and its local TTL;
  // a request-only source carries none.
  type LayeredPayload = { instance: int, key: int, localMs: int, remote: bool, fence: int, retentionMs: int }
  type LocalPayload = { instance: int, key: int, localMs: int }
  type LayeredSource = Flights::Source[LayeredPayload]
  type LocalSource = Flights::Source[LocalPayload]
  type RequestSource = Flights::Source[{}]
  // The fields the traversal order reads and writes, for either source payload.
  type Traversed[r, p] = {
    o: Observation,
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    sources: List[Flights::Source[p]],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held] | r
  }
  // The layered shape adds the clock with its wall skew (remote frames are
  // stamped on the wall clock and retained on the monotonic one), the
  // environment's remote availability and tracking, the local capacity, the
  // remote adapter's fault switches (a failed read observes nothing, a failed
  // dump dispatches no write, a failed write stores nothing) and the local and
  // remote storage; the local projection adds the clock, the local capacity
  // and local storage; the request-only projection adds nothing.
  type Served[r] = Traversed[{
    now: int,
    skew: int,
    remoteAvailable: bool,
    tracked: bool,
    capacity: int,
    readFailed: bool,
    dumpFailed: bool,
    writeFailed: bool,
    localValues: List[int],
    localExpires: List[int],
    lru: List[List[int]],
    remoteValues: List[int],
    created: List[int],
    expires: List[int],
    watermark: List[int] | r
  }, LayeredPayload]
  // The local projection: the clock, the local capacity and local storage,
  // without a remote layer.
  type LocalServed[r] = Traversed[{
    now: int,
    capacity: int,
    localValues: List[int],
    localExpires: List[int],
    lru: List[List[int]] | r
  }, LocalPayload]
  type RequestServed[r] = Traversed[r, {}]

  // A caller participates when its call is enabled and its scope is open.
  pure def participating(state: Traversed[r, p], layout: Layout, call: Call): bool =
    call.enabled and Memo::scopeOpen(state, call.context, layout.persistentContexts)
  // The process identity a call serves: its instance's row of keys.
  pure def identity(layout: Layout, call: Call): int = call.instance * layout.keysPerInstance + call.key
  // The projections of a reply: without the remote layer, or with the request leaf only.
  pure def localOnly(resolved: Resolution): Resolution =
    { layers: { request: resolved.layers.request, local: resolved.layers.local, remote: false }, coalesce: resolved.coalesce }
  pure def requestOnly(resolved: Resolution): Resolution =
    { layers: { request: resolved.layers.request, local: false, remote: false }, coalesce: resolved.coalesce }

  // -- Traversal order ---------------------------------------------------------

  // What a release does for a caller, decided once for either shape: join the
  // pending request flight in its own scope, else (with no memoized value) the
  // process flight for its identity while a shared layer participates, neither
  // when the call does not coalesce; else serve the request memo, then the
  // local value (a hit renews recency), then the remote value (a hit warms
  // local when local participates); else start a source. The request-only
  // shape passes no layer values.
  type Outcome = JoinsRequest(int) | JoinsProcess(int) | ServesMemo(int) | ServesLocal(int) | ServesRemote(int) | Starts
  type Decision = { slot: int, outcome: Outcome }
  pure def decide(state: Traversed[r, p], layout: Layout, call: Call, resolved: Resolution, localValue: int, remoteValue: int): Decision = {
    val layers = resolved.layers
    val slot = Memo::memoSlot(call.context, call.key, layout.keysPerScope,
      Memo::persistent(call.context, layout.persistentContexts) and layers.request)
    val requestOwner = if (resolved.coalesce) Flights::requestOwner(state, slot) else NO_OWNER
    val memoValue = Memo::memoValue(state, slot)
    val processOwner = if (resolved.coalesce and sharedLayers(layers) and memoValue == NO_VALUE)
      Flights::processOwner(state, identity(layout, call)) else NO_OWNER
    {
      slot: slot,
      outcome: if (requestOwner >= 0) JoinsRequest(requestOwner)
        else if (processOwner >= 0) JoinsProcess(processOwner)
        else if (memoValue > NO_VALUE) ServesMemo(memoValue)
        else if (localValue > NO_VALUE) ServesLocal(localValue)
        else if (remoteValue > NO_VALUE) ServesRemote(remoteValue)
        else Starts
    }
  }
  pure def ownerOf(outcome: Outcome): int = match outcome {
    | JoinsRequest(owner) => owner
    | JoinsProcess(owner) => owner
    | ServesMemo(_) => NO_OWNER
    | ServesLocal(_) => NO_OWNER
    | ServesRemote(_) => NO_OWNER
    | Starts => NO_OWNER
  }

  // A caller returns a layer value; an attached request memoizes it.
  pure def serve(state: Traversed[r, p], layout: Layout, caller: int, slot: int, value: int): Traversed[r, p] =
    Memo::memoize({
      o: { calls: state.o.calls.replaceAt(caller, value), ...state.o },
      ...state
    }, slot, value, layout.keysPerScope)
  // A source counts against the profile; the drivers may probe whether the
  // cache participated when it started.
  pure def started(state: Traversed[r, p], layout: Layout, participating: bool): Traversed[r, p] = {
    o: {
      loaders: state.o.loaders + 1,
      sourceScopes: if (layout.probeSourceScope) state.o.sourceScopes.append(participating) else state.o.sourceScopes,
      ...state.o
    },
    ...state
  }
  // A miss starts a layered source with the layers the call resolved to. Its
  // publication authority is fixed here: a tracked flight that read the remote
  // layer may not warm local storage directly (a later validated remote hit
  // does), and only a flight whose remote read completed may refill it, fenced
  // by the watermark it observed; a flight whose read failed never refills and
  // takes no fence.
  pure def startSource(state: Served[r], layout: Layout, caller: int, call: Call, slot: int, participating: bool, resolved: Resolution, ttls: Ttls): Served[r] = {
    val read = resolved.layers.remote
    val refills = read and not(state.readFailed)
    Flights::registerSource(started(state, layout, participating), {
      instance: call.instance,
      key: call.key,
      localMs: if (resolved.layers.local and not(state.tracked and read)) ttls.localMs else 0,
      remote: refills,
      fence: if (refills) Remote::missFence(state, call.key, layout.operationsPerEntity) else NO_FENCE,
      retentionMs: if (refills) ttls.retentionMs else 0,
      result: CALL_PENDING,
      shared: resolved.coalesce and sharedLayers(resolved.layers)
    }, caller, slot, resolved.coalesce, identity(layout, call))
  }
  pure def startLocalSource(state: LocalServed[r], layout: Layout, caller: int, call: Call, slot: int, participating: bool, resolved: Resolution, ttls: Ttls): LocalServed[r] =
    Flights::registerSource(started(state, layout, participating),
      { instance: call.instance, key: call.key, localMs: if (resolved.layers.local) ttls.localMs else 0, result: CALL_PENDING, shared: resolved.coalesce and sharedLayers(resolved.layers) },
      caller, slot, resolved.coalesce, identity(layout, call))
  pure def startRequestSource(state: RequestServed[r], layout: Layout, caller: int, call: Call, slot: int, participating: bool, resolved: Resolution): RequestServed[r] =
    Flights::registerSource(started(state, layout, participating),
      { result: CALL_PENDING, shared: resolved.coalesce and sharedLayers(resolved.layers) },
      caller, slot, resolved.coalesce, identity(layout, call))

  // -- Admission -----------------------------------------------------------------

  // A participating caller makes a policy call and waits for the reply; any
  // other caller (a closed scope, a disabled context, a call outside every
  // request) bypasses every layer and starts its own unshared source at once (C01).
  pure def entered(state: Traversed[r, p], open: bool): Traversed[r, p] = Flights::admitCaller({
    o: {
      calls: state.o.calls.append(CALL_PENDING),
      policyCalls: state.o.policyCalls + (if (open) 1 else 0),
      ...state.o
    },
    ...state
  })
  pure def admit(state: Served[r], layout: Layout, call: Call): Served[r] = {
    val open = participating(state, layout, call)
    val caller = state.o.calls.length()
    if (open) Gate::hold(entered(state, open), state.o.policyCalls, caller, call)
    else startSource(entered(state, open), layout, caller, call, NO_OWNER, false, BYPASS, NO_TTLS)
  }
  pure def admitLocal(state: LocalServed[r], layout: Layout, call: Call): LocalServed[r] = {
    val open = participating(state, layout, call)
    val caller = state.o.calls.length()
    if (open) Gate::hold(entered(state, open), state.o.policyCalls, caller, call)
    else startLocalSource(entered(state, open), layout, caller, call, NO_OWNER, false, BYPASS, NO_TTLS)
  }
  pure def admitRequest(state: RequestServed[r], layout: Layout, call: Call): RequestServed[r] = {
    val open = participating(state, layout, call)
    val caller = state.o.calls.length()
    if (open) Gate::hold(entered(state, open), state.o.policyCalls, caller, call)
    else startRequestSource(entered(state, open), layout, caller, call, NO_OWNER, false, BYPASS)
  }

  // -- Release -------------------------------------------------------------------

  // Traversal for the caller held under a policy call once its reply resolves;
  // the policy call must be held (a wrapper guards on the gate), an unheld
  // release is a modeling error that fails in the gate's lookup. The scope may
  // have closed since admission: a released caller of a closed scope resolves
  // to the bypass reply, and a layer whose TTL is 0 is off (`gated`). Each
  // caller is attached once, to the flight that completes it or to none; a
  // join happens before any layer is read, so the join arms count no remote
  // read. The remote read is observed only when the traversal reaches it: a
  // failed read observes nothing and still counts, a frame serves while
  // retained, fresh for the reply's freshness and (tracked) fence-cleared, and
  // a remote hit warms local storage for the reply's local TTL.
  pure def release(state: Served[r], layout: Layout, policyCall: int, resolved: Resolution, ttls: Ttls): Served[r] = {
    val held = Gate::entry(state, policyCall)
    val caller = held.caller
    val call = held.call
    val released = Gate::release(state, policyCall)
    val open = participating(released, layout, call)
    val effective = if (open) gated(resolved, ttls) else BYPASS
    val layers = effective.layers
    val localValue = if (layers.local) Local::localValue(released, call.instance, call.key, layout.keysPerInstance) else NO_VALUE
    val remoteValue = if (layers.remote and not(released.readFailed))
      Remote::readableFrame(released, call.key, layout.operationsPerEntity, ttls.freshMs) else NO_VALUE
    val decision = decide(released, layout, call, effective, localValue, remoteValue)
    val slot = decision.slot
    val attached = Flights::attachCaller(released, caller, ownerOf(decision.outcome), slot)
    val observed = if (layers.remote) {
      o: {
        reads: attached.o.reads + 1,
        loads: attached.o.loads + (if (remoteValue > NO_VALUE) 1 else 0),
        ...attached.o
      },
      ...attached
    } else attached
    match decision.outcome {
      // A request-flight join is the attachment alone: the owner came from the
      // caller's own row. A process-flight join also registers that flight under
      // the row when the caller memoizes.
      | JoinsRequest(_) => attached
      | JoinsProcess(owner) => Flights::joinRequestFlight(attached, slot, owner)
      | ServesMemo(value) => serve(attached, layout, caller, slot, value)
      | ServesLocal(value) => serve(Local::promote(attached, call.instance, call.key), layout, caller, slot, value)
      | ServesRemote(value) => serve(if (layers.local)
        Local::putLocal(observed, call.instance, call.key, value, ttls.localMs, layout.keysPerInstance) else observed, layout, caller, slot, value)
      | Starts => startSource(observed, layout, caller, call, slot, open, effective, ttls)
    }
  }
  pure def releaseLocal(state: LocalServed[r], layout: Layout, policyCall: int, resolved: Resolution, ttls: Ttls): LocalServed[r] = {
    val held = Gate::entry(state, policyCall)
    val caller = held.caller
    val call = held.call
    val released = Gate::release(state, policyCall)
    val open = participating(released, layout, call)
    val effective = if (open) localOnly(gated(resolved, ttls)) else BYPASS
    val localValue = if (effective.layers.local) Local::localValue(released, call.instance, call.key, layout.keysPerInstance) else NO_VALUE
    val decision = decide(released, layout, call, effective, localValue, NO_VALUE)
    val slot = decision.slot
    val attached = Flights::attachCaller(released, caller, ownerOf(decision.outcome), slot)
    match decision.outcome {
      | JoinsRequest(_) => attached
      | JoinsProcess(owner) => Flights::joinRequestFlight(attached, slot, owner)
      | ServesMemo(value) => serve(attached, layout, caller, slot, value)
      | ServesLocal(value) => serve(Local::promote(attached, call.instance, call.key), layout, caller, slot, value)
      // No remote value is passed, so the remote layer never serves.
      | ServesRemote(_) => attached
      | Starts => startLocalSource(attached, layout, caller, call, slot, open, effective, ttls)
    }
  }

  // The request-only release, judged once for the traversal and for the
  // diagnostics recorded around it: the held caller and its call, whether its
  // scope is still open, the resolution in effect (the request-only projection
  // of the reply, or the bypass reply once the scope closed) and the decision.
  // It is judged on the state before Gate::release, which edits only the held
  // list, a field decide never reads.
  type RequestRelease = { caller: int, call: Call, open: bool, effective: Resolution, decision: Decision }
  pure def requestRelease(state: RequestServed[r], layout: Layout, policyCall: int, resolved: Resolution): RequestRelease = {
    val held = Gate::entry(state, policyCall)
    val open = participating(state, layout, held.call)
    val effective = if (open) requestOnly(resolved) else BYPASS
    {
      caller: held.caller,
      call: held.call,
      open: open,
      effective: effective,
      decision: decide(state, layout, held.call, effective, NO_VALUE, NO_VALUE)
    }
  }
  pure def releaseRequest(state: RequestServed[r], layout: Layout, policyCall: int, resolved: Resolution): RequestServed[r] = {
    val judged = requestRelease(state, layout, policyCall, resolved)
    val released = Gate::release(state, policyCall)
    val slot = judged.decision.slot
    val attached = Flights::attachCaller(released, judged.caller, ownerOf(judged.decision.outcome), slot)
    match judged.decision.outcome {
      | JoinsRequest(_) => attached
      // No shared layer participates in this shape, so the process registry is
      // never consulted; the arm is the layered one.
      | JoinsProcess(owner) => Flights::joinRequestFlight(attached, slot, owner)
      | ServesMemo(value) => serve(attached, layout, judged.caller, slot, value)
      // No layer value is passed, so no layer serves.
      | ServesLocal(_) => attached
      | ServesRemote(_) => attached
      | Starts => startRequestSource(attached, layout, judged.caller, judged.call, slot, judged.open, judged.effective)
    }
  }

  // An immediate policy reply: admission and traversal in one step with the
  // resolution the profile supplies (`layer_policy::resolution` for the
  // drivers' layer policy codes) and the Ttls the reply resolved to (a
  // fixture's constant where replies carry none).
  pure def begin(state: Served[r], layout: Layout, call: Call, resolved: Resolution, ttls: Ttls): Served[r] = {
    val admitted = admit(state, layout, call)
    if (participating(state, layout, call)) release(admitted, layout, state.o.policyCalls, resolved, ttls) else admitted
  }

  // -- Settlement ----------------------------------------------------------------

  // Every caller the source owns receives its outcome; an accepted value
  // memoizes into each owning caller's still-open scope. Settling clears the
  // registries.
  pure def finish(state: Traversed[r, p], layout: Layout, index: int, value: int): Traversed[r, p] = {
    val settled = Flights::settleSource({
      o: { calls: finishOwnedCalls(state.o.calls, state.owners, index, value), ...state.o },
      ...state
    }, index, value)
    if (not(accepted(value))) settled else Flights::ownedBy(state, index).fold(settled, (out, call) =>
      Memo::memoize(out, state.memoSlots.nth(call), value, layout.keysPerScope))
  }
  // A layered accepted value also refills the remote layer when the flight
  // read it and its fence still allows the write, and warms local storage
  // when the flight may, each for the TTLs its source captured from the reply
  // that started it. A refill serializes (a dump), then dispatches the write,
  // then stores the frame: a dump fault stops the dispatch and a write fault
  // the storage; the dispatched write carries the retention.
  pure def settle(state: Served[r], layout: Layout, index: int, value: int): Served[r] = {
    val source = state.sources.nth(index)
    val success = accepted(value)
    val serializes = success and source.remote and Remote::writeAllowed(state, source.fence)
    val dispatches = serializes and not(state.dumpFailed)
    val stored = dispatches and not(state.writeFailed)
    val frames = if (stored) Remote::seedFrame(state, source.key, value, source.retentionMs) else state
    val recorded = {
      o: {
        dumps: state.o.dumps + (if (serializes) 1 else 0),
        writes: state.o.writes + (if (dispatches) 1 else 0),
        writeTtls: if (dispatches) state.o.writeTtls.append(source.retentionMs) else state.o.writeTtls,
        ...state.o
      },
      ...frames
    }
    val warmed = if (success and source.localMs > 0)
      Local::putLocal(recorded, source.instance, source.key, value, source.localMs, layout.keysPerInstance) else recorded
    finish(warmed, layout, index, value)
  }
  // A local accepted value warms the identity's local slot for the local TTL
  // its source captured, when it captured one.
  pure def settleLocal(state: LocalServed[r], layout: Layout, index: int, value: int): LocalServed[r] = {
    val source = state.sources.nth(index)
    val warmed = if (accepted(value) and source.localMs > 0)
      Local::putLocal(state, source.instance, source.key, value, source.localMs, layout.keysPerInstance) else state
    finish(warmed, layout, index, value)
  }
  pure def settleRequest(state: RequestServed[r], layout: Layout, index: int, value: int): RequestServed[r] =
    finish(state, layout, index, value)

  // -- Scope closure and maintenance ---------------------------------------------

  // Closing a request scope forgets its memo row and its request flights.
  pure def closeScope(state: Traversed[r, p], layout: Layout, context: int): Traversed[r, p] =
    Flights::forgetScope(Memo::closeScope(state, context, layout.keysPerScope), context, layout.keysPerScope)

  // Maintenance: invalidating an entity raises its watermark; without remote
  // storage the request reports the missing layer and changes nothing.
  pure def invalidate(state: Served[r], entity: int): Served[r] =
    if (not(state.remoteAvailable)) {
      o: { maintenance: state.o.maintenance.append("missing_remote"), ...state.o },
      ...state
    } else {
      o: {
        invalidations: state.o.invalidations + 1,
        maintenance: state.o.maintenance.append("ok"),
        ...state.o
      },
      ...Remote::raiseWatermark(state, entity)
    }
}

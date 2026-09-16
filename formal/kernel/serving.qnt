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
  // The traversal comes in two shapes over the same order (`decide`): the
  // layered one (`admit`, `release`, `settle`) over every layer, and the
  // request-only projection (`admitRequest`, `releaseRequest`, `settleRequest`)
  // for a profile whose only layer is the request memo, which carries no
  // storage, no clock and a source record without publication payload. A
  // projection exists only where the layered shape cannot meet a profile's
  // bytes-per-state bound; it states no rule of its own.
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
  // contexts are persistent scopes, keys per entity, the serving TTL written
  // with each remote frame, and whether the drivers probe each source for the
  // scope it started under (o.sourceScopes).
  type Layout = {
    keysPerInstance: int, keysPerScope: int, persistentContexts: int, operationsPerEntity: int,
    servingTtlMs: int, probeSourceScope: bool
  }
  // A layered source carries its publication authority: the identity it
  // serves, whether it may warm local storage, whether it read the remote
  // layer and the fence it observed. A request-only source carries none.
  type LayeredSource = { instance: int, key: int, local: bool, remote: bool, fence: int, result: int, shared: bool }
  type RequestSource = { result: int, shared: bool }
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
  type Served[r] = {
    o: Observation,
    now: int,
    remoteAvailable: bool,
    tracked: bool,
    capacity: int,
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    localValues: List[int],
    lru: List[List[int]],
    remoteValues: List[int],
    created: List[int],
    watermark: List[int],
    sources: List[LayeredSource],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held] | r
  }
  type RequestServed[r] = {
    o: Observation,
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    sources: List[RequestSource],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held] | r
  }

  // A caller participates when its call is enabled and its scope is open.
  pure def participating(state: Traversed[r, p], layout: Layout, call: Call): bool =
    call.enabled and Memo::scopeOpen(state, call.context, layout.persistentContexts)
  // The process identity a call serves: its instance's row of keys.
  pure def identity(layout: Layout, call: Call): int = call.instance * layout.keysPerInstance + call.key
  // The request-only projection of a reply: its request leaf and coalescing.
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
    | _ => NO_OWNER
  }

  // A caller returns a layer value; an attached request memoizes it.
  pure def serve(state: Traversed[r, p], layout: Layout, caller: int, slot: int, value: int): Traversed[r, p] =
    Memo::memoize({
      o: { calls: state.o.calls.replaceAt(caller, value), ...state.o },
      ...state
    }, slot, value, layout.keysPerScope)
  // A joined caller is completed by the flight it joined; a memoizing caller
  // also registers that flight under its own scope.
  pure def join(state: Traversed[r, p], caller: int, slot: int, owner: int): Traversed[r, p] =
    Flights::joinRequestFlight(Flights::attachCaller(state, caller, owner, slot), slot, owner)
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
  // does), and only a flight that read the remote layer may refill it, fenced
  // by the watermark it observed.
  pure def startSource(state: Served[r], layout: Layout, caller: int, call: Call, slot: int, participating: bool, resolved: Resolution): Served[r] = {
    val read = resolved.layers.remote
    Flights::registerSource(started(state, layout, participating), {
      instance: call.instance,
      key: call.key,
      local: resolved.layers.local and not(state.tracked and read),
      remote: read,
      fence: if (read) Remote::missFence(state, call.key, layout.operationsPerEntity) else NO_FENCE,
      result: CALL_PENDING,
      shared: resolved.coalesce and sharedLayers(resolved.layers)
    }, caller, slot, resolved.coalesce, identity(layout, call))
  }
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
    else startSource(entered(state, open), layout, caller, call, NO_OWNER, false, BYPASS)
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
  // release is a modeling error that fails when the caller is attached. The
  // scope may have closed since admission: a released caller of a closed scope
  // resolves to the bypass reply. The remote read is observed only when the
  // traversal reaches it.
  pure def release(state: Served[r], layout: Layout, policyCall: int, resolved: Resolution): Served[r] = {
    val held = Gate::entry(state, policyCall)
    val caller = held.caller
    val call = held.call
    val released = Gate::release(state, policyCall)
    val open = participating(released, layout, call)
    val effective = if (open) resolved else BYPASS
    val layers = effective.layers
    val localValue = if (layers.local) Local::localValue(released, call.instance, call.key, layout.keysPerInstance) else NO_VALUE
    val remoteValue = if (layers.remote) Remote::readableFrame(released, call.key, layout.operationsPerEntity) else NO_VALUE
    val decision = decide(released, layout, call, effective, localValue, remoteValue)
    val slot = decision.slot
    val attached = Flights::attachCaller(released, caller, NO_OWNER, slot)
    val observed = if (layers.remote) {
      o: {
        reads: attached.o.reads + 1,
        loads: attached.o.loads + (if (remoteValue > NO_VALUE) 1 else 0),
        ...attached.o
      },
      ...attached
    } else attached
    match decision.outcome {
      | JoinsRequest(owner) => join(released, caller, slot, owner)
      | JoinsProcess(owner) => join(released, caller, slot, owner)
      | ServesMemo(value) => serve(attached, layout, caller, slot, value)
      | ServesLocal(value) => serve(Local::promote(attached, call.instance, call.key), layout, caller, slot, value)
      | ServesRemote(value) => serve(if (layers.local)
        Local::putLocal(observed, call.instance, call.key, value, layout.keysPerInstance) else observed, layout, caller, slot, value)
      | Starts => startSource(observed, layout, caller, call, slot, open, effective)
    }
  }
  pure def releaseRequest(state: RequestServed[r], layout: Layout, policyCall: int, resolved: Resolution): RequestServed[r] = {
    val held = Gate::entry(state, policyCall)
    val caller = held.caller
    val call = held.call
    val released = Gate::release(state, policyCall)
    val open = participating(released, layout, call)
    val effective = if (open) requestOnly(resolved) else BYPASS
    val decision = decide(released, layout, call, effective, NO_VALUE, NO_VALUE)
    val slot = decision.slot
    val attached = Flights::attachCaller(released, caller, NO_OWNER, slot)
    match decision.outcome {
      | JoinsRequest(owner) => join(released, caller, slot, owner)
      | JoinsProcess(owner) => join(released, caller, slot, owner)
      | ServesMemo(value) => serve(attached, layout, caller, slot, value)
      | Starts => startRequestSource(attached, layout, caller, call, slot, open, effective)
      // No layer value is passed, so no layer serves.
      | _ => attached
    }
  }

  // An immediate policy reply: admission and traversal in one step with the
  // resolution the profile supplies (`layer_policy::resolution` for the
  // drivers' layer policy codes).
  pure def begin(state: Served[r], layout: Layout, call: Call, resolved: Resolution): Served[r] = {
    val admitted = admit(state, layout, call)
    if (participating(state, layout, call)) release(admitted, layout, state.o.policyCalls, resolved) else admitted
  }

  // -- Settlement ----------------------------------------------------------------

  // Every caller the source owns receives its outcome; a success memoizes into
  // each owning caller's still-open scope. Settling clears the registries.
  pure def finish(state: Traversed[r, p], layout: Layout, index: int, value: int): Traversed[r, p] = {
    val settled = Flights::settleSource({
      o: { calls: finishOwnedCalls(state.o.calls, state.owners, index, value), ...state.o },
      ...state
    }, index, value)
    if (value == SOURCE_ERROR) settled else Flights::ownedBy(state, index).fold(settled, (out, call) =>
      Memo::memoize(out, state.memoSlots.nth(call), value, layout.keysPerScope))
  }
  // A layered success also refills the remote layer when the flight read it
  // and its fence still allows the write, and warms local storage when the
  // flight may.
  pure def settle(state: Served[r], layout: Layout, index: int, value: int): Served[r] = {
    val source = state.sources.nth(index)
    val success = value != SOURCE_ERROR
    val write = success and source.remote and Remote::writeAllowed(state, source.fence)
    val recorded = if (write) {
      o: {
        dumps: state.o.dumps + 1,
        writes: state.o.writes + 1,
        writeTtls: state.o.writeTtls.append(layout.servingTtlMs),
        ...state.o
      },
      ...Remote::seedFrame(state, source.key, value)
    } else state
    val warmed = if (success and source.local)
      Local::putLocal(recorded, source.instance, source.key, value, layout.keysPerInstance) else recorded
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

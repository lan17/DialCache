module serving {
  // The serving path: admit a caller, join or consult each enabled layer in
  // order (request memo, local, remote), and otherwise start a source; then
  // settle a source and publish its value to the layers that own it. Every
  // portable rule about ownership, traversal order and publication authority
  // is stated here once; profiles supply bounded state, inputs and layouts.
  //
  // Admission and traversal are two transitions because the drivers can hold
  // a policy reply: `admit` counts the policy call and holds the caller,
  // `release` traverses for it with the state current at release. `begin` is
  // their composition for a profile whose replies are immediate.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import layer_policy.* from "./layer-policy"
  import request_memo as Memo from "./request-memo"
  import local_storage as Local from "./local-storage"
  import remote_frames as Remote from "./remote-frames"
  import flights as Flights from "./flights"
  import policy_gate as Gate from "./policy-gate"

  // How a profile lays out its bounded identities: keys per instance (local
  // storage and process flights), keys per scope row (request memo), how many
  // contexts are persistent scopes, keys per entity, and the serving TTL
  // written with each remote frame.
  type Layout = { keysPerInstance: int, keysPerScope: int, persistentContexts: int, operationsPerEntity: int, servingTtlMs: int }
  // What a caller asks for.
  type Call = { instance: int, key: int, context: int }
  type Served[r] = {
    o: Observation,
    now: int,
    policy: int,
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
    sources: List[Flights::Source],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held],
    lastReleased: int | r
  }

  pure def participating(state: Served[r], layout: Layout, call: Call): bool =
    Memo::scopeOpen(state, call.context, layout.persistentContexts)

  // A caller returns a layer value; an attached request memoizes it.
  pure def serve(state: Served[r], layout: Layout, caller: int, slot: int, value: int): Served[r] =
    Memo::memoize({
      o: { calls: state.o.calls.replaceAt(caller, value), ...state.o },
      ...state
    }, slot, value, layout.keysPerScope)

  // A miss starts a source. Its publication authority is fixed here: a tracked
  // flight that read the remote layer may not warm local storage directly (a
  // later validated remote hit does), and only a flight that read the remote
  // layer may refill it, fenced by the watermark it observed.
  pure def startSource(state: Served[r], layout: Layout, caller: int, call: Call, slot: int,
      participating: bool, read: bool, resolved: Resolution): Served[r] =
    Flights::registerSource({ o: { loaders: state.o.loaders + 1, ...state.o }, ...state }, {
      instance: call.instance,
      key: call.key,
      local: participating and resolved.layers.local and not(state.tracked and read),
      remote: read,
      fence: if (read) Remote::missFence(state, call.key, layout.operationsPerEntity) else NO_FENCE,
      result: CALL_PENDING,
      shared: participating and resolved.coalesce and sharedLayers(resolved.layers)
    }, caller, slot, resolved.coalesce, layout.keysPerInstance)

  // Admission. A caller in an open scope (or a fresh context) makes a policy
  // call and waits for the reply; a caller in a closed scope bypasses every
  // layer and starts its own unshared source at once (C01).
  pure def admit(state: Served[r], layout: Layout, call: Call): Served[r] = {
    val open = participating(state, layout, call)
    val caller = state.o.calls.length()
    val admitted = Flights::admitCaller({
      o: {
        calls: state.o.calls.append(CALL_PENDING),
        policyCalls: state.o.policyCalls + (if (open) 1 else 0),
        ...state.o
      },
      ...state
    }, NO_OWNER, NO_OWNER)
    if (open) Gate::hold(admitted, state.o.policyCalls, caller)
    else startSource(admitted, layout, caller, call, NO_OWNER, false, false, { layers: { request: false, local: false, remote: false }, coalesce: false })
  }

  // Traversal for a held caller once its policy reply resolves. Ownership
  // precedence: a pending request flight in the caller's own scope, else (with
  // no memoized value) the process flight for the instance and key while a
  // shared layer participates; neither registry is consulted when the call
  // does not coalesce. A joined caller consults no layer. Otherwise request
  // memo, then local (a hit renews recency), then remote (a hit warms local
  // when local participates). The scope may have closed since admission: a
  // released caller of a closed scope memoizes nothing and shares nothing.
  pure def release(state: Served[r], layout: Layout, policyCall: int, call: Call, resolved: Resolution): Served[r] = {
    val caller = Gate::heldCaller(state, policyCall)
    val released = Gate::release(state, policyCall)
    val layers = resolved.layers
    val open = participating(state, layout, call)
    val slot = Memo::memoSlot(call.context, call.key, layout.keysPerScope,
      open and Memo::persistent(call.context, layout.persistentContexts) and layers.request)
    val requestOwner = if (resolved.coalesce) Flights::requestOwner(state, slot) else NO_OWNER
    val memoValue = Memo::memoValue(state, slot)
    val sharing = open and resolved.coalesce and sharedLayers(layers)
    val processOwner = if (sharing) Flights::processOwner(state, call.instance, call.key, layout.keysPerInstance) else NO_OWNER
    val owner = if (requestOwner >= 0) requestOwner
      else if (memoValue == NO_VALUE) processOwner else NO_OWNER
    val attached = Flights::ownCaller({ memoSlots: released.memoSlots.replaceAt(caller, slot), ...released }, caller, owner)
    val localValue = if (open and layers.local) Local::localValue(state, call.instance, call.key, layout.keysPerInstance) else NO_VALUE
    val readsRemote = open and layers.remote
    val remoteValue = if (readsRemote) Remote::readableFrame(state, call.key, layout.operationsPerEntity) else NO_VALUE
    val observedRead = if (readsRemote) {
      o: {
        reads: attached.o.reads + 1,
        loads: attached.o.loads + (if (remoteValue > NO_VALUE) 1 else 0),
        ...attached.o
      },
      ...attached
    } else attached
    if (owner >= 0) Flights::joinRequestFlight(attached, slot, owner)
    else if (memoValue > NO_VALUE) serve(attached, layout, caller, slot, memoValue)
    else if (localValue > NO_VALUE) serve(Local::promote(attached, call.instance, call.key), layout, caller, slot, localValue)
    else if (remoteValue > NO_VALUE) serve(if (layers.local)
      Local::putLocal(observedRead, call.instance, call.key, remoteValue, layout.keysPerInstance) else observedRead, layout, caller, slot, remoteValue)
    else startSource(observedRead, layout, caller, call, slot, open, readsRemote, resolved)
  }

  // An immediate policy reply: admission and traversal in one step, with the
  // layers the profile's policy code enables and coalescing on.
  pure def begin(state: Served[r], layout: Layout, instance: int, key: int, context: int): Served[r] = {
    val call = { instance: instance, key: key, context: context }
    val admitted = admit(state, layout, call)
    if (participating(state, layout, call))
      release(admitted, layout, state.o.policyCalls, call, resolution(state.policy, state.remoteAvailable))
    else admitted
  }

  // Settlement. Every caller the source owns receives its outcome. A success
  // refills the remote layer only when the flight read it and its fence still
  // allows the write, warms local storage only when the flight may, and
  // memoizes into each owning caller's still-open scope.
  pure def settle(state: Served[r], layout: Layout, index: int, value: int): Served[r] = {
    val source = state.sources.nth(index)
    val success = value != SOURCE_ERROR
    val write = success and source.remote and Remote::writeAllowed(state, source.fence)
    val settled = Flights::settleSource({
      o: {
        calls: finishOwnedCalls(state.o.calls, state.owners, index, value),
        dumps: state.o.dumps + (if (write) 1 else 0),
        writes: state.o.writes + (if (write) 1 else 0),
        writeTtls: if (write) state.o.writeTtls.append(layout.servingTtlMs) else state.o.writeTtls,
        ...state.o
      },
      ...state
    }, index, value)
    val published = if (write) Remote::seedFrame(settled, source.key, value) else settled
    val warmed = if (success and source.local)
      Local::putLocal(published, source.instance, source.key, value, layout.keysPerInstance) else published
    if (not(success)) warmed else Flights::ownedBy(state, index).fold(warmed, (out, call) =>
      Memo::memoize(out, state.memoSlots.nth(call), value, layout.keysPerScope))
  }

  // Closing a request scope forgets its memo row and its request flights.
  pure def closeScope(state: Served[r], layout: Layout, context: int): Served[r] =
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

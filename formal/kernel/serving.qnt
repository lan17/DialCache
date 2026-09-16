module serving {
  // The serving path: admit a caller, join or consult each enabled layer in
  // order (request memo, local, remote), and otherwise start a source; then
  // settle a source and publish its value to the layers that own it. Every
  // portable rule about ownership, traversal order and publication authority
  // is stated here once; profiles supply bounded state, inputs and layouts.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import layer_policy.* from "./layer-policy"
  import request_memo as Memo from "./request-memo"
  import local_storage as Local from "./local-storage"
  import remote_frames as Remote from "./remote-frames"
  import flights as Flights from "./flights"

  // How a profile lays out its bounded identities: keys per instance and per
  // scope row, how many contexts are persistent scopes, keys per entity, and
  // the serving TTL written with each remote frame.
  type Layout = { keys: int, persistentContexts: int, operationsPerEntity: int, servingTtlMs: int }
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
    callerContexts: List[int],
    callerKeys: List[int] | r
  }

  // The last admitted caller returns a layer value; an attached request memoizes it.
  pure def serve(state: Served[r], layout: Layout, slot: int, value: int): Served[r] =
    Memo::memoize({
      o: { calls: state.o.calls.replaceAt(state.o.calls.length() - 1, value), ...state.o },
      ...state
    }, slot, value, layout.keys)

  // A miss starts a source. Its publication authority is fixed here: a tracked
  // flight that read the remote layer may not warm local storage directly (a
  // later validated remote hit does), and only a flight that read the remote
  // layer may refill it, fenced by the watermark it observed.
  pure def startSource(state: Served[r], layout: Layout, instance: int, key: int, slot: int,
      participating: bool, read: bool, layers: Layers): Served[r] =
    Flights::registerSource({ o: { loaders: state.o.loaders + 1, ...state.o }, ...state }, {
      instance: instance,
      key: key,
      local: participating and layers.local and not(state.tracked and read),
      remote: read,
      fence: if (read) Remote::missFence(state, key, layout.operationsPerEntity) else NO_FENCE,
      result: CALL_PENDING,
      shared: participating and sharedLayers(layers)
    }, slot, layout.keys)

  // Admission and traversal. Ownership precedence: a pending request flight in
  // the caller's own scope, else (with no memoized value) the process flight
  // for the instance and key while a shared layer participates. A joined
  // caller consults no layer. Otherwise request memo, then local (a hit
  // renews recency), then remote (a hit warms local when local participates).
  pure def begin(state: Served[r], layout: Layout, instance: int, key: int, context: int): Served[r] = {
    val layers = enabledLayers(state.policy, state.remoteAvailable)
    val participating = Memo::scopeOpen(state, context, layout.persistentContexts)
    val slot = Memo::memoSlot(context, key, layout.keys,
      participating and Memo::persistent(context, layout.persistentContexts) and layers.request)
    val requestOwner = Memo::requestOwner(state, slot)
    val memoValue = Memo::memoValue(state, slot)
    val sharing = participating and sharedLayers(layers)
    val processOwner = if (sharing) Flights::processOwner(state, instance, key, layout.keys) else NO_OWNER
    val owner = if (requestOwner >= 0) requestOwner
      else if (memoValue == NO_VALUE) processOwner else NO_OWNER
    val admitted = Flights::admitCaller({
      o: {
        calls: state.o.calls.append(CALL_PENDING),
        policyCalls: state.o.policyCalls + (if (participating) 1 else 0),
        ...state.o
      },
      ...state
    }, owner, slot, context, key)
    val localValue = if (participating and layers.local) Local::localValue(state, instance, key, layout.keys) else NO_VALUE
    val readsRemote = participating and layers.remote
    val remoteValue = if (readsRemote) Remote::readableFrame(state, key, layout.operationsPerEntity) else NO_VALUE
    val observedRead = if (readsRemote) {
      o: {
        reads: admitted.o.reads + 1,
        loads: admitted.o.loads + (if (remoteValue > NO_VALUE) 1 else 0),
        ...admitted.o
      },
      ...admitted
    } else admitted
    if (owner >= 0) Memo::joinRequestFlight(admitted, slot, owner)
    else if (memoValue > NO_VALUE) serve(admitted, layout, slot, memoValue)
    else if (localValue > NO_VALUE) serve(Local::promote(admitted, instance, key), layout, slot, localValue)
    else if (remoteValue > NO_VALUE) serve(if (layers.local)
      Local::putLocal(observedRead, instance, key, remoteValue, layout.keys) else observedRead, layout, slot, remoteValue)
    else startSource(observedRead, layout, instance, key, slot, participating, readsRemote, layers)
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
    val published = if (write) Remote::writeFrame(settled, source.key, value) else settled
    val warmed = if (success and source.local)
      Local::putLocal(published, source.instance, source.key, value, layout.keys) else published
    if (not(success)) warmed else Flights::ownedBy(state, index).fold(warmed, (out, call) =>
      Memo::memoize(out, state.memoSlots.nth(call), value, layout.keys))
  }

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

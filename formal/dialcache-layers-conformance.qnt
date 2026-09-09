module dialcache_layers_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Composition boundary: request -> process flight -> local -> remote -> source.
  // Two entities x two operations; two instances; three persistent request scopes.
  // Fresh entries throughout this profile; policy/storage profiles cover expiry.
  type Source = { instance: int, key: int, local: bool, remote: bool, fence: int, result: int, shared: bool }
  type State = {
    o: Observation, now: int, tracked: bool, remoteAvailable: bool, capacity: int, policy: int,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], lru: List[List[int]], remoteValues: List[int], created: List[int], watermark: List[int],
    sources: List[Source], owners: List[int], memoSlots: List[int]
  }
  var s: State
  pure def zeros(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(0))
  pure def slots(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(-1))
  pure def instance(context: int): int = if (context == 2 or context == 4) 1 else 0
  pure def persistent(context: int): bool = context < 3
  pure def active(x: State, context: int): bool = not(persistent(context)) or not(x.closed.nth(context))
  // 0 all; 1 no request; 2 no local; 3 no remote; 4 request only; 5 no layers.
  pure def requestEnabled(x: State): bool = x.policy != 1 and x.policy != 5
  pure def localEnabled(x: State): bool = Set(0, 1, 3).contains(x.policy)
  pure def remoteEnabled(x: State): bool = x.remoteAvailable and Set(0, 1, 2).contains(x.policy)
  pure def touch(order: List[int], key: int): List[int] = order.select(k => k != key).append(key)
  pure def putLocal(x: State, inst: int, key: int, value: int): State = {
    val order = touch(x.lru.nth(inst), key)
    val evicts = order.length() > x.capacity
    val kept = if (evicts) order.slice(1, order.length()) else order
    if (x.capacity == 0) x else {
      lru: x.lru.replaceAt(inst, kept),
      localValues: (if (evicts) x.localValues.replaceAt(inst * 4 + order.nth(0), 0) else x.localValues).replaceAt(inst * 4 + key, value), ...x
    }
  }
  pure def memoize(x: State, slot: int, value: int): State =
    if (slot < 0 or x.closed.nth(slot / 4)) x else { memo: x.memo.replaceAt(slot, value), ...x }
  pure def result(x: State, slot: int, value: int): State =
    memoize({ o: { calls: x.o.calls.replaceAt(x.o.calls.length() - 1, value), ...x.o }, ...x }, slot, value)
  pure def start(x: State, inst: int, key: int, slot: int, participating: bool, read: bool): State = {
    val shared = participating and (localEnabled(x) or remoteEnabled(x))
    val index = x.sources.length()
    { sources: x.sources.append({ instance: inst, key: key,
        local: participating and localEnabled(x) and not(x.tracked and read), remote: read,
        fence: if (x.tracked and read) x.watermark.nth(key / 2) else 0, result: 0, shared: shared }),
      owners: x.owners.replaceAt(x.owners.length() - 1, index),
      requestFlights: if (slot >= 0) x.requestFlights.replaceAt(slot, index) else x.requestFlights,
      processFlights: if (shared) x.processFlights.replaceAt(inst * 4 + key, index) else x.processFlights,
      o: { loaders: x.o.loaders + 1, ...x.o }, ...x }
  }
  pure def begin(x: State, choice: int): State = {
    val context = choice / 4
    val key = choice % 4
    val inst = instance(context)
    val participating = active(x, context)
    val slot = if (participating and persistent(context) and requestEnabled(x)) context * 4 + key else -1
    val requestOwner = if (slot < 0) -1 else x.requestFlights.nth(slot)
    val memo = if (slot < 0) 0 else x.memo.nth(slot)
    val processOwner = if (participating and (localEnabled(x) or remoteEnabled(x))) x.processFlights.nth(inst * 4 + key) else -1
    val owner = if (requestOwner >= 0) requestOwner else if (memo == 0) processOwner else -1
    val y = { owners: x.owners.append(owner), memoSlots: x.memoSlots.append(slot),
      o: { calls: x.o.calls.append(0), policyCalls: x.o.policyCalls + (if (participating) 1 else 0), ...x.o }, ...x }
    val local = if (participating and localEnabled(x)) x.localValues.nth(inst * 4 + key) else 0
    val read = participating and remoteEnabled(x)
    val remote = if (read and (not(x.tracked) or x.created.nth(key) > x.watermark.nth(key / 2))) x.remoteValues.nth(key) else 0
    val z = if (read) { o: { reads: y.o.reads + 1, loads: y.o.loads + (if (remote > 0) 1 else 0), ...y.o }, ...y } else y
    if (owner >= 0) { requestFlights: if (slot < 0) y.requestFlights else y.requestFlights.replaceAt(slot, owner), ...y }
    else if (memo > 0) result(y, slot, memo)
    else if (local > 0) result({ lru: y.lru.replaceAt(inst, touch(y.lru.nth(inst), key)), ...y }, slot, local)
    else if (remote > 0) result(if (localEnabled(x)) putLocal(z, inst, key, remote) else z, slot, remote)
    else start(z, inst, key, slot, participating, read)
  }
  pure def settle(x: State, index: int, value: int): State = {
    val source = x.sources.nth(index)
    val success = value != 3
    val write = success and source.remote and x.now > source.fence
    val y = {
      sources: x.sources.replaceAt(index, { result: value, ...source }),
      processFlights: x.processFlights.foldl(List(), (out, owner) => out.append(if (owner == index) -1 else owner)),
      requestFlights: x.requestFlights.foldl(List(), (out, owner) => out.append(if (owner == index) -1 else owner)),
      remoteValues: if (write) x.remoteValues.replaceAt(source.key, value) else x.remoteValues,
      created: if (write) x.created.replaceAt(source.key, x.now) else x.created,
      o: { calls: x.o.calls.indices().fold(x.o.calls, (out, call) => if (x.owners.nth(call) == index) out.replaceAt(call, value) else out),
        dumps: x.o.dumps + (if (write) 1 else 0), writes: x.o.writes + (if (write) 1 else 0),
        writeTtls: if (write) x.o.writeTtls.append(60000) else x.o.writeTtls, ...x.o }, ...x }
    val z = if (success and source.local) putLocal(y, source.instance, source.key, value) else y
    if (not(success)) z else x.owners.indices().fold(z, (out, call) =>
      if (x.owners.nth(call) == index) memoize(out, x.memoSlots.nth(call), value) else out)
  }
  action init = {
    // The recorded input configures only the fresh external fixture.
    nondet choice = 0.to(4).oneOf()
    s' = { o: empty, now: 10000, tracked: choice % 2 == 1, remoteAvailable: choice != 4, capacity: if (choice < 2 or choice == 4) 2 else 0, policy: 0,
      closed: List(false, false, false), memo: zeros(12), requestFlights: slots(12), processFlights: slots(8),
      localValues: zeros(8), lru: List(List(), List()), remoteValues: zeros(4), created: zeros(4), watermark: zeros(2),
      sources: List(), owners: List(), memoSlots: List() }
  }
  action beginCall = { nondet choice = 0.to(19).oneOf()
    all { s.o.calls.length() < 20, s' = begin(s, choice) } }
  action resolveLoader = {
    nondet choice = 1.to(40).filter(code => (code - 1) / 2 < s.sources.length() and s.sources.nth((code - 1) / 2).result == 0).oneOf()
    s' = settle(s, (choice - 1) / 2, (choice - 1) % 2 + 1)
  }
  action rejectLoader = { nondet choice = s.sources.indices().filter(i => s.sources.nth(i).result == 0).oneOf()
    s' = settle(s, choice, 3) }
  action closeScope = { nondet choice = 0.to(2).filter(scope => not(s.closed.nth(scope))).oneOf()
    s' = { closed: s.closed.replaceAt(choice, true),
      memo: s.memo.indices().fold(s.memo, (out, slot) => if (slot / 4 == choice) out.replaceAt(slot, 0) else out),
      requestFlights: s.requestFlights.indices().fold(s.requestFlights, (out, slot) => if (slot / 4 == choice) out.replaceAt(slot, -1) else out), ...s } }
  action policy = { nondet choice = 0.to(5).oneOf()
    s' = { policy: choice, ...s } }
  action seed = { nondet choice = 0.to(7).oneOf()
    s' = { remoteValues: s.remoteValues.replaceAt(choice / 2, choice % 2 + 1), created: s.created.replaceAt(choice / 2, s.now), ...s } }
  action invalidate = { nondet choice = Set(0, 1).oneOf()
    s' = if (not(s.remoteAvailable)) { o: { maintenance: s.o.maintenance.append("missing_remote"), ...s.o }, ...s }
      else { watermark: s.watermark.replaceAt(choice, s.now),
        o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("ok"), ...s.o }, ...s } }
  action tick = s' = { now: s.now + 1, ...s }
  action step = any {
    beginCall, resolveLoader, any { rejectLoader, policy, seed, invalidate, tick, any { tick, closeScope } }
  }
  val absentRemoteHasNoAdapterEffects = s.remoteAvailable or (s.o.reads == 0 and s.o.writes == 0 and s.o.invalidations == 0)
  val sourceEffectsMatch = s.sources.length() == s.o.loaders and s.owners.length() == s.o.calls.length()
  val capacityIsPerInstance = s.lru.indices().forall(i => s.lru.nth(i).length() <= s.capacity)
  val closedScopesHaveNoMemo = s.memo.indices().forall(slot => not(s.closed.nth(slot / 4)) or s.memo.nth(slot) == 0)
  val registeredSourcesArePending = s.processFlights.indices().forall(identity => {
    val source = s.processFlights.nth(identity)
    source < 0 or (s.sources.nth(source).shared and s.sources.nth(source).result == 0)
  })
  val zeroCapacityHasNoLocalValues = s.capacity != 0 or s.localValues.select(v => v != 0).length() == 0
  val callsKeepSourceOutcome = s.owners.indices().forall(call =>
    s.owners.nth(call) < 0 or s.o.calls.nth(call) == s.sources.nth(s.owners.nth(call)).result)
  val localMembershipMatchesLru = s.localValues.indices().forall(i =>
    (s.localValues.nth(i) > 0) == (s.lru.nth(i / 4).select(key => key == i % 4).length() > 0))

  action untrackedFixture = init.then(s' = { tracked: false, remoteAvailable: true, capacity: 2, ...s })
  action trackedFixture = init.then(s' = { tracked: true, remoteAvailable: true, capacity: 2, ...s })
  run absentRemoteMaintenancePreservesLocalReuseTest = init.then(s' = { remoteAvailable: false, capacity: 2, ...s })
    .then(s' = begin(s, 12)).then(s' = settle(s, 0, 1)).then(invalidate).then(s' = begin(s, 12))
    .expect(s.o.calls == List(1, 1) and s.o.maintenance == List("missing_remote") and s.o.invalidations == 0)
  run absentRemotePreservesLocalReuseTest = init.then(s' = { remoteAvailable: false, capacity: 2, ...s })
    .then(s' = begin(s, 12)).then(s' = settle(s, 0, 1)).then(s' = begin(s, 12))
    .expect(s.o.calls == List(1, 1) and s.o.loaders == 1 and s.o.reads == 0 and s.o.writes == 0)
  run requestMissesShareProcessAndMemoizeSeparatelyTest = untrackedFixture
    .then(s' = begin(s, 0)).then(s' = begin(s, 4)).expect(s.o.loaders == 1)
    .then(s' = settle(s, 0, 1)).then(s' = { policy: 4, ...s })
    .then(s' = begin(s, 0)).then(s' = begin(s, 4))
    .expect(s.o.calls == List(1, 1, 1, 1) and s.o.loaders == 1)
  run localReadPromotesBeforeEvictionTest = untrackedFixture.then(s' = { policy: 3, ...s })
    .then(s' = begin(s, 12)).then(s' = settle(s, 0, 1))
    .then(s' = begin(s, 13)).then(s' = settle(s, 1, 1))
    .then(s' = begin(s, 12)).then(s' = begin(s, 14)).then(s' = settle(s, 2, 1))
    .then(s' = begin(s, 12)).expect(s.o.loaders == 3)
    .then(s' = begin(s, 13)).expect(s.o.loaders == 4 and s.o.calls.nth(5) == 0)
  run zeroCapacityKeepsSharingWithoutStorageTest = untrackedFixture.then(s' = { capacity: 0, policy: 3, ...s })
    .then(s' = begin(s, 12)).then(s' = begin(s, 12)).expect(s.o.loaders == 1)
    .then(s' = settle(s, 0, 1)).then(s' = begin(s, 12)).expect(s.o.loaders == 2)
  run trackedSourceWaitsForValidatedReadToWarmLocalTest = trackedFixture
    .then(s' = begin(s, 12)).then(s' = settle(s, 0, 1)).expect(s.localValues.nth(0) == 0)
    .then(s' = begin(s, 12)).expect(s.o.reads == 2 and s.localValues.nth(0) == 1)
    .then(s' = begin(s, 12)).expect(s.o.reads == 2)
  run invalidationGroupsOperationsButPreservesAcquiredCachesTest = trackedFixture
    .then(s' = { remoteValues: List(1, 2, 0, 0), created: List(10000, 10000, 0, 0), ...s })
    .then(s' = begin(s, 0)).then(s' = begin(s, 1))
    .then(s' = { watermark: List(10000, 0), ...s })
    .then(s' = begin(s, 0)).then(s' = begin(s, 13)).expect(s.o.loaders == 0)
    .then(s' = { policy: 2, ...s }).then(s' = begin(s, 12)).then(s' = begin(s, 13))
    .expect(s.o.loaders == 2)
  run requestMemoExceedsLocalCapacityTest = untrackedFixture.then(s' = { policy: 4, capacity: 0, ...s })
    .then(s' = begin(s, 0)).then(s' = settle(s, 0, 1))
    .then(s' = begin(s, 1)).then(s' = settle(s, 1, 1))
    .then(s' = begin(s, 2)).then(s' = settle(s, 2, 1))
    .then(s' = begin(s, 0)).expect(s.o.loaders == 3 and s.o.calls == List(1, 1, 1, 1))
}

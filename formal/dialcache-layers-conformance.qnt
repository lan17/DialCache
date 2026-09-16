module dialcache_layers_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import remote_frames as Remote from "./kernel/remote-frames"
  import flights as Flights from "./kernel/flights"
  import clock as Clock from "./kernel/clock"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Composition boundary: request -> process flight -> local -> remote -> source.
  // Two entities x two operations; two instances; three persistent request scopes.
  // Fresh entries throughout this profile; policy/storage profiles cover expiry.
  // State: o is the replay projection. Memo/flight ownership, LRU membership,
  // remote frames and watermarks are predictions tested through public calls.
  // Every rule is a kernel transition (formal/kernel); this module owns only the
  // bounded state, the input choices and the environment steps.
  // Environment: explicit request closure, source settlement, remote seeding,
  // invalidation, and 1 ms clock steps. All serving TTLs are 60 seconds.
  // Bounds: four identities (two entities x two operations), two instances,
  // three persistent contexts, two fresh-context choices, twenty callers.

  // -- Fixture, context and identity encodings (policy codes and sentinels are
  // the library's: layer_policy and encodings) --------------------------------

  pure val FIXTURE_UNTRACKED = 0
  pure val FIXTURE_TRACKED = 1
  pure val FIXTURE_ZERO_CAPACITY_UNTRACKED = 2
  pure val FIXTURE_ZERO_CAPACITY_TRACKED = 3
  pure val FIXTURE_WITHOUT_REMOTE = 4
  pure val FIXTURE_TRACKED_WITHOUT_REMOTE = 5
  pure val FIRST_REQUEST_CONTEXT = 0
  pure val SECOND_REQUEST_CONTEXT = 1
  pure val OTHER_INSTANCE_REQUEST_CONTEXT = 2
  pure val FRESH_FIRST_INSTANCE_CONTEXT = 3
  pure val FRESH_OTHER_INSTANCE_CONTEXT = 4
  pure val FIRST_INSTANCE = 0
  pure val OTHER_INSTANCE = 1
  pure val KEY_A = 0
  pure val KEY_A_OTHER_OPERATION = 1
  pure val KEY_B = 2
  pure val KEY_B_OTHER_OPERATION = 3
  pure val KEYS_PER_INSTANCE = 4
  pure val OPERATIONS_PER_ENTITY = 2
  pure val PERSISTENT_CONTEXTS = 3
  pure val DEFAULT_LOCAL_CAPACITY = 2
  pure val NO_LOCAL_CAPACITY = 0
  pure val MAX_CALLERS = 20
  pure val MAX_CONTEXT_KEY_CHOICE = 19
  pure val MAX_RESOLVE_CHOICE = 40
  pure val MAX_SEED_CHOICE = 7
  pure val SOURCE_VALUE_COUNT = 2
  pure val INITIAL_TIME_MS = 10000
  pure val SERVING_TTL_MS = 60000

  // -- Bounded state and layout ----------------------------------------------

  type State = {
    o: Observation,
    now: int,
    tracked: bool,
    remoteAvailable: bool,
    capacity: int,
    policy: int,
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    localValues: List[int],
    lru: List[List[int]],
    remoteValues: List[int],
    created: List[int],
    watermark: List[int],
    sources: List[Serving::LayeredSource],
    owners: List[int],
    memoSlots: List[int],
    callerInstances: List[int],
    callerKeys: List[int],
    held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }
  pure def zeros(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(0))
  pure def slots(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(NO_OWNER))
  // Input decoding: which instance each context lives on, and the call a
  // context-and-key choice asks for.
  pure def instance(context: int): int = if (context == OTHER_INSTANCE_REQUEST_CONTEXT
    or context == FRESH_OTHER_INSTANCE_CONTEXT) OTHER_INSTANCE else FIRST_INSTANCE
  pure def call(choice: int): Call =
    { instance: instance(choice / KEYS_PER_INSTANCE), key: choice % KEYS_PER_INSTANCE, context: choice / KEYS_PER_INSTANCE, enabled: true }
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: KEYS_PER_INSTANCE,
    keysPerScope: KEYS_PER_INSTANCE,
    persistentContexts: PERSISTENT_CONTEXTS,
    operationsPerEntity: OPERATIONS_PER_ENTITY,
    servingTtlMs: SERVING_TTL_MS,
    probeSourceScope: false
  }

  // -- Public fixture inputs and external effects ----------------------------

  action initialize(fixture: int): bool = all {
    s' = {
      o: empty,
      now: INITIAL_TIME_MS,
      tracked: fixture % 2 == FIXTURE_TRACKED,
      remoteAvailable: fixture < FIXTURE_WITHOUT_REMOTE,
      capacity: if (Set(FIXTURE_ZERO_CAPACITY_UNTRACKED, FIXTURE_ZERO_CAPACITY_TRACKED).contains(fixture))
        NO_LOCAL_CAPACITY else DEFAULT_LOCAL_CAPACITY,
      policy: ALL_LAYERS,
      closed: List(false, false, false),
      memo: zeros(12),
      requestFlights: slots(12),
      processFlights: slots(8),
      localValues: zeros(8),
      lru: List(List(), List()),
      remoteValues: zeros(4),
      created: zeros(4),
      watermark: zeros(2),
      sources: List(),
      owners: List(),
      memoSlots: List(),
      callerInstances: List(),
      callerKeys: List(),
      held: List()
    },
    input' = { name: "init", choice: fixture }
  }
  action init = {
    nondet choice = FIXTURE_UNTRACKED.to(FIXTURE_TRACKED_WITHOUT_REMOTE).oneOf()
    initialize(choice)
  }
  action startCall(choice: int): bool = all {
    s.o.calls.length() < MAX_CALLERS,
    s' = Flights::recordIdentity(Serving::begin(s, LAYOUT, call(choice), resolution(s.policy, s.remoteAvailable)),
      instance(choice / KEYS_PER_INSTANCE), choice % KEYS_PER_INSTANCE),
    input' = { name: "beginCall", choice: choice }
  }
  action beginCall = {
    nondet choice = 0.to(MAX_CONTEXT_KEY_CHOICE).oneOf()
    startCall(choice)
  }
  action finishSource(loader: int, value: int): bool = all {
    s' = Serving::settle(s, LAYOUT, loader, value),
    input' = if (value == SOURCE_ERROR) { name: "rejectLoader", choice: loader }
      else { name: "resolveLoader", choice: loader * SOURCE_VALUE_COUNT + value }
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_RESOLVE_CHOICE).filter(code =>
      (code - 1) / SOURCE_VALUE_COUNT < s.sources.length()
      and s.sources.nth((code - 1) / SOURCE_VALUE_COUNT).result == CALL_PENDING
    ).oneOf()
    finishSource((choice - 1) / SOURCE_VALUE_COUNT, (choice - 1) % SOURCE_VALUE_COUNT + VALUE_ONE)
  }
  action rejectLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING).oneOf()
    finishSource(choice, SOURCE_ERROR)
  }
  action closeContext(context: int): bool = all {
    s' = Serving::closeScope(s, LAYOUT, context),
    input' = { name: "closeScope", choice: context }
  }
  action closeScope = {
    nondet choice = FIRST_REQUEST_CONTEXT.to(OTHER_INSTANCE_REQUEST_CONTEXT)
      .filter(scope => not(s.closed.nth(scope))).oneOf()
    closeContext(choice)
  }
  action changePolicy(policy: int): bool = all {
    s' = { policy: policy, ...s },
    input' = { name: "policy", choice: policy }
  }
  action policy = {
    nondet choice = ALL_LAYERS.to(NO_LAYERS).oneOf()
    changePolicy(choice)
  }
  action seedRemote(key: int, value: int): bool = all {
    s' = Remote::seedFrame(s, key, value),
    input' = { name: "seed", choice: key * SOURCE_VALUE_COUNT + value - 1 }
  }
  action seed = {
    nondet choice = 0.to(MAX_SEED_CHOICE).oneOf()
    seedRemote(choice / SOURCE_VALUE_COUNT, choice % SOURCE_VALUE_COUNT + VALUE_ONE)
  }
  action invalidateEntity(entity: int): bool = all {
    s' = Serving::invalidate(s, entity),
    input' = { name: "invalidate", choice: entity }
  }
  action invalidate = {
    nondet choice = Set(0, 1).oneOf()
    invalidateEntity(choice)
  }
  action tick = all {
    s' = Clock::advance(s, 1),
    input' = { name: "tick", choice: -1 }
  }

  // -- Exploration schedule (nesting/order preserve sampling weights) ---------

  action step = any {
    beginCall,
    resolveLoader,
    any {
      rejectLoader,
      policy,
      seed,
      invalidate,
      tick,
      any {
        tick,
        closeScope
      }
    }
  }

  // -- Independently stated safety properties --------------------------------

  val absentRemoteHasNoAdapterEffects = s.remoteAvailable or (s.o.reads == 0 and s.o.writes == 0
    and s.o.invalidations == 0)
  val sourceEffectsMatch = s.sources.length() == s.o.loaders and s.owners.length() == s.o.calls.length()
  val capacityIsPerInstance = s.lru.indices().forall(i => s.lru.nth(i).length() <= s.capacity)
  val closedScopesHaveNoMemo = s.memo.indices().forall(slot => not(s.closed.nth(slot / KEYS_PER_INSTANCE))
    or s.memo.nth(slot) == NO_VALUE)
  val registeredSourcesArePending = s.processFlights.indices().forall(identity => {
    val source = s.processFlights.nth(identity)
    source < 0 or (s.sources.nth(source).shared and s.sources.nth(source).result == CALL_PENDING)
  })
  val zeroCapacityHasNoLocalValues = s.capacity != NO_LOCAL_CAPACITY
    or s.localValues.select(v => v != NO_VALUE).length() == 0
  val callsKeepSourceOutcome = s.owners.indices().forall(call =>
    s.owners.nth(call) < 0 or s.o.calls.nth(call) == s.sources.nth(s.owners.nth(call)).result)
  val sourceOwnershipNeverCrossesKeyOrInstance = s.owners.indices().forall(call => {
    val owner = s.owners.nth(call)
    owner < 0 or (s.sources.nth(owner).key == s.callerKeys.nth(call)
      and s.sources.nth(owner).instance == s.callerInstances.nth(call))
  })
  val localMembershipMatchesLru = s.localValues.indices().forall(i =>
    (s.localValues.nth(i) > 0)
      == (s.lru.nth(i / KEYS_PER_INSTANCE).select(key => key == i % KEYS_PER_INSTANCE).length() > 0))

  // -- Deterministic regression schedules ------------------------------------

  action untrackedFixture = initialize(FIXTURE_UNTRACKED)
  action trackedFixture = initialize(FIXTURE_TRACKED)
  run absentRemoteMaintenancePreservesLocalReuseTest = initialize(FIXTURE_WITHOUT_REMOTE)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(invalidateEntity(0))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.maintenance == List("missing_remote")
      and s.o.invalidations == 0)
  run absentRemotePreservesLocalReuseTest = initialize(FIXTURE_WITHOUT_REMOTE)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.reads == 0 and s.o.writes == 0)
  run requestMissesShareProcessAndMemoizeSeparatelyTest = untrackedFixture
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(SECOND_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 1)
    .then(finishSource(0, VALUE_ONE))
    .then(changePolicy(REQUEST_LAYER_ONLY))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(SECOND_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
  run localReadPromotesBeforeEvictionTest = untrackedFixture.then(changePolicy(NO_REMOTE_LAYER))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(finishSource(1, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_B))
    .then(finishSource(2, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 3)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .expect(s.o.loaders == 4 and s.o.calls.nth(5) == CALL_PENDING)
  run zeroCapacityKeepsSharingWithoutStorageTest = initialize(FIXTURE_ZERO_CAPACITY_UNTRACKED).then(changePolicy(NO_REMOTE_LAYER))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 1)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 2)
  run trackedSourceWaitsForValidatedReadToWarmLocalTest = trackedFixture
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .expect(s.localValues.nth(0) == 0)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.reads == 2 and s.localValues.nth(0) == 1)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.reads == 2)
  run invalidationGroupsOperationsButPreservesAcquiredCachesTest = trackedFixture
    .then(seedRemote(KEY_A, VALUE_ONE)).then(seedRemote(KEY_A_OTHER_OPERATION, VALUE_TWO))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(invalidateEntity(0))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .expect(s.o.loaders == 0)
    .then(changePolicy(NO_LOCAL_LAYER))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .expect(s.o.loaders == 2)
  run requestMemoExceedsLocalCapacityTest = initialize(FIXTURE_ZERO_CAPACITY_UNTRACKED).then(changePolicy(REQUEST_LAYER_ONLY))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(finishSource(1, VALUE_ONE))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_B))
    .then(finishSource(2, VALUE_ONE))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 3 and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE))

  run separateRequestRootsRetainIndependentValuesTest = untrackedFixture
    .then(changePolicy(REQUEST_LAYER_ONLY))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(SECOND_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 2)
    .then(finishSource(0, VALUE_ONE)).then(finishSource(1, VALUE_TWO))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(SECOND_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO) and s.o.loaders == 2)

  run oneInstanceEvictionCannotEvictAnotherInstanceTest = initialize(FIXTURE_WITHOUT_REMOTE)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(finishSource(1, VALUE_ONE))
    .then(startCall(FRESH_OTHER_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(2, VALUE_TWO))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_B))
    .then(finishSource(3, VALUE_ONE))
    .then(startCall(FRESH_OTHER_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO) and s.o.loaders == 4)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 5 and s.o.calls.nth(5) == CALL_PENDING)

  run pendingSourcesKeepEntityAndOperationIdentityTest = untrackedFixture
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_B))
    .expect(s.o.loaders == 3)
    .then(finishSource(1, VALUE_TWO)).then(finishSource(0, VALUE_ONE))
    .then(finishSource(2, VALUE_ONE))
    .then(changePolicy(NO_LOCAL_LAYER))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_B))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_ONE)
      and s.o.loaders == 3 and s.o.loads == 3)

  run settledRequestMemoSurvivesSharedLayerRampDownTest = untrackedFixture
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(changePolicy(REQUEST_LAYER_ONLY))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 1 and s.o.writes == 1)
    .then(startCall(SECOND_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 2 and s.o.reads == 1)

  run untrackedReadsIgnoreGroupedInvalidationTest = untrackedFixture
    .then(seedRemote(KEY_A, VALUE_ONE)).then(seedRemote(KEY_A_OTHER_OPERATION, VALUE_TWO))
    .then(invalidateEntity(0)).then(changePolicy(NO_LOCAL_LAYER))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.loaders == 0
      and s.o.reads == 2 and s.o.loads == 2 and s.o.invalidations == 1)

  run trackedWithoutRemotePublishesReusableLocalTest = initialize(FIXTURE_TRACKED_WITHOUT_REMOTE)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 0 and s.o.writes == 0 and s.o.dumps == 0)

  // One untracked source fills the request memo, the local layer and Redis.
  // Three later callers probe each layer in turn: the same request scope hits
  // its memo, a fresh context on the same instance hits local, and a fresh
  // context on the other instance reads the remote frame. No second source runs.
  run untrackedSourcePublicationIsProbedInAllThreeLayersTest = untrackedFixture
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .expect(s.memo.nth(0) == VALUE_ONE and s.localValues.nth(0) == VALUE_ONE
      and s.remoteValues.nth(KEY_A) == VALUE_ONE)
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(startCall(FRESH_OTHER_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 2 and s.o.loads == 1 and s.o.dumps == 1 and s.o.writes == 1)
}

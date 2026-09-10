module dialcache_policy_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Two logical keys, one process-local slot, untracked Redis. At most one
  // provider reply is held at a time, but accepted sources can overlap and
  // settle in either order. Every source owns its accepted publication policy.
  // State: o is the replay projection. Cache entries, source ownership, and
  // accepted publication policies are predictions checked by later calls.
  // Environment: untracked Redis, separate wall/elapsed clocks, held policy
  // replies and sources, injectable provider/read/dump/write failures.
  // Bounds: two keys, one local slot, twelve callers; no source deadline.

  // -- Stable overlay, outcome, and duration encodings ------------------------

  pure val POLICY_INHERIT = 0
  pure val POLICY_LOCAL_TTL_TWO_SECONDS = 1
  pure val POLICY_REMOTE_TTL_TWO_SECONDS = 2
  pure val POLICY_NO_LOCAL = 3
  pure val POLICY_NO_REMOTE = 4
  pure val POLICY_INVALID_LOCAL_TTL = 5
  pure val POLICY_INVALID_REMOTE_TTL = 6
  pure val POLICY_RECOVERY_TWO_SECONDS = 7
  pure val POLICY_NO_SERVING = 8
  pure val POLICY_REMOTE_FOUR_SECONDS_NO_RECOVERY = 9
  pure val INDEPENDENT_POLICY_OFFSET = 10
  pure val POLICY_INVALID_READ_BUDGET = 20
  pure val POLICY_INVALID_LOCAL_RAMP = 21
  pure val POLICY_INVALID_REMOTE_RAMP = 22
  pure val POLICY_INVALID_RECOVERY_AGE = 23
  pure val POLICY_NEGATIVE_RECOVERY_AGE = 24
  pure val POLICY_INVALID_SHADOW_RAMP = 25
  pure val NO_OWNER = -1
  pure val NO_CACHED_VALUE = 0
  pure val DISABLED_TTL_MS = 0
  pure val HALF_SECOND_MS = 500
  pure val ONE_SECOND_MS = 1000
  pure val TWO_SECONDS_MS = 2000
  pure val FOUR_SECONDS_MS = 4000
  pure val DEFAULT_RETENTION_MS = 5000
  pure val MAX_CALLERS = 12
  pure val SOURCE_VALUE_COUNT = 7
  pure val MAX_RESOLVE_CHOICE = 84
  pure val FAULT_HEALTHY = 0
  pure val FAULT_FAILED = 1

  // -- State and initial environment -----------------------------------------

  type Source = {
    key: int,
    localTtl: int,
    remoteTtl: int,
    retention: int,
    shared: bool,
    result: int
  }
  type State = {
    o: Observation,
    now: int,
    wall: int,
    policyCall: int,
    overlay: int,
    key: int,
    localKey: int,
    localValue: int,
    localExpires: int,
    remoteValues: List[int],
    remoteCreated: List[int],
    remoteExpires: List[int],
    sources: List[Source],
    owners: List[int],
    registered: List[int],
    providerFailed: bool,
    readFailed: bool,
    dumpFailed: bool,
    writeFailed: bool
  }
  var s: State
  action init = s' = {
    o: empty,
    now: 0,
    wall: 100000,
    policyCall: NO_OWNER,
    overlay: POLICY_INHERIT,
    key: 0,
    localKey: 0,
    localValue: NO_CACHED_VALUE,
    localExpires: 0,
    remoteValues: List(NO_CACHED_VALUE, NO_CACHED_VALUE),
    remoteCreated: List(0, 0),
    remoteExpires: List(0, 0),
    sources: List(),
    owners: List(),
    registered: List(NO_OWNER, NO_OWNER),
    providerFailed: false,
    readFailed: false,
    dumpFailed: false,
    writeFailed: false
  }

  // -- Effective policy for the pending provider reply -----------------------

  // Choices 10..19 repeat the same sparse overlays with coalescing disabled.
  val baseOverlay = if (s.overlay < POLICY_INVALID_READ_BUDGET) s.overlay % INDEPENDENT_POLICY_OFFSET
    else POLICY_INHERIT
  val localTtl =
    if (s.providerFailed or s.overlay == POLICY_INVALID_READ_BUDGET
      or s.overlay == POLICY_INVALID_LOCAL_RAMP
      or Set(POLICY_NO_LOCAL, POLICY_INVALID_LOCAL_TTL, POLICY_NO_SERVING).contains(baseOverlay))
      DISABLED_TTL_MS
    else if (baseOverlay == POLICY_LOCAL_TTL_TWO_SECONDS) TWO_SECONDS_MS
    else ONE_SECOND_MS
  val remoteTtl =
    if (s.providerFailed or s.overlay == POLICY_INVALID_READ_BUDGET
      or s.overlay == POLICY_INVALID_REMOTE_RAMP
      or Set(POLICY_NO_REMOTE, POLICY_INVALID_REMOTE_TTL, POLICY_NO_SERVING).contains(baseOverlay))
      DISABLED_TTL_MS
    else if (baseOverlay == POLICY_REMOTE_TTL_TWO_SECONDS) TWO_SECONDS_MS
    else if (baseOverlay == POLICY_REMOTE_FOUR_SECONDS_NO_RECOVERY) FOUR_SECONDS_MS
    else ONE_SECOND_MS
  val retention =
    if (s.overlay == POLICY_INVALID_RECOVERY_AGE or s.overlay == POLICY_NEGATIVE_RECOVERY_AGE)
      ONE_SECOND_MS
    else if (baseOverlay == POLICY_RECOVERY_TWO_SECONDS) TWO_SECONDS_MS
    else if (baseOverlay == POLICY_REMOTE_FOUR_SECONDS_NO_RECOVERY) FOUR_SECONDS_MS else DEFAULT_RETENTION_MS
  val pendingSources = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING)

  // -- Caller admission and layer traversal ----------------------------------

  pure def begin(state: State, key: int): State = {
    key: key,
    policyCall: state.o.calls.length(),
    owners: state.owners.append(NO_OWNER),
    o: {
      calls: state.o.calls.append(CALL_PENDING),
      policyCalls: state.o.policyCalls + 1,
      ...state.o
    },
    ...state
  }
  action beginCall = {
    nondet choice = Set(0, 1).oneOf()
    all {
      s.policyCall == NO_OWNER,
      s.o.calls.length() < MAX_CALLERS,
      s' = begin(s, choice)
    }
  }
  action releasePolicy = all {
    s.policyCall >= 0,
    val shared = (s.overlay < INDEPENDENT_POLICY_OFFSET or s.overlay >= POLICY_INVALID_READ_BUDGET)
      and (localTtl > 0 or remoteTtl > 0)
    val joinsFlight = shared and s.registered.nth(s.key) >= 0
    // Flight admission precedes reading the first participating cache layer.
    val localHit = not(joinsFlight) and localTtl > 0 and s.localKey == s.key and s.localValue > 0
      and s.now < s.localExpires
    val readsRemote = not(joinsFlight) and not(localHit) and remoteTtl > 0
    val remoteHit = readsRemote and not(s.readFailed) and s.remoteValues.nth(s.key) > 0
      and s.now < s.remoteExpires.nth(s.key) and s.wall >= s.remoteCreated.nth(s.key)
      and s.wall - s.remoteCreated.nth(s.key) < remoteTtl
    val hitValue = if (localHit) s.localValue else if (remoteHit) s.remoteValues.nth(s.key) else NO_CACHED_VALUE
    val startsSource = not(joinsFlight) and hitValue == NO_CACHED_VALUE
    val owner = if (joinsFlight) s.registered.nth(s.key) else if (startsSource) s.sources.length() else NO_OWNER
    s' = {
      policyCall: NO_OWNER,
      owners: s.owners.replaceAt(s.policyCall, owner),
      sources: if (startsSource) s.sources.append({
        key: s.key,
        localTtl: localTtl,
        remoteTtl: if (readsRemote and not(s.readFailed)) remoteTtl else DISABLED_TTL_MS,
        retention: retention,
        shared: shared,
        result: CALL_PENDING
      }) else s.sources,
      registered: if (startsSource and shared) s.registered.replaceAt(s.key, owner) else s.registered,
      localKey: if (remoteHit and localTtl > 0) s.key else s.localKey,
      localValue: if (remoteHit and localTtl > 0) hitValue else s.localValue,
      localExpires: if (remoteHit and localTtl > 0) s.now + localTtl else s.localExpires,
      o: {
        calls: s.o.calls.replaceAt(s.policyCall, hitValue),
        reads: s.o.reads + (if (readsRemote) 1 else 0),
        loads: s.o.loads + (if (remoteHit) 1 else 0),
        loaders: s.o.loaders + (if (startsSource) 1 else 0),
        ...s.o
      },
      ...s
    }
  }

  // -- Source settlement and accepted publication policy ---------------------

  pure def settle(state: State, loader: int, value: int): State = {
    val source = state.sources.nth(loader)
    val serializes = value != SOURCE_ERROR and source.remoteTtl > 0
    val dispatchesWrite = serializes and not(state.dumpFailed)
    val writeSucceeded = dispatchesWrite and not(state.writeFailed)
    val publishesLocal = value != SOURCE_ERROR and source.localTtl > 0
    {
      sources: state.sources.replaceAt(loader, { result: value, ...source }),
      registered: if (state.registered.nth(source.key) == loader) state.registered.replaceAt(source.key,
        NO_OWNER) else state.registered,
      localKey: if (publishesLocal) source.key else state.localKey,
      localValue: if (publishesLocal) value else state.localValue,
      localExpires: if (publishesLocal) state.now + source.localTtl else state.localExpires,
      remoteValues: if (writeSucceeded) state.remoteValues.replaceAt(source.key, value) else state.remoteValues,
      remoteCreated: if (writeSucceeded) state.remoteCreated.replaceAt(source.key, state.wall)
        else state.remoteCreated,
      remoteExpires: if (writeSucceeded) state.remoteExpires.replaceAt(source.key,
        state.now + source.retention) else state.remoteExpires,
      o: {
        calls: finishOwnedCalls(state.o.calls, state.owners, loader, value),
        dumps: state.o.dumps + (if (serializes) 1 else 0),
        writes: state.o.writes + (if (dispatchesWrite) 1 else 0),
        writeTtls: if (dispatchesWrite) state.o.writeTtls.append(source.retention) else state.o.writeTtls,
        ...state.o
      },
      ...state
    }
  }
  action resolveLoader = {
    // One portable choice records both the actual source index and its value.
    nondet choice = 1.to(MAX_RESOLVE_CHOICE)
      .filter(code => pendingSources.contains((code - 1) / SOURCE_VALUE_COUNT)).oneOf()
    s' = settle(s, (choice - 1) / SOURCE_VALUE_COUNT, values.nth((choice - 1) % SOURCE_VALUE_COUNT))
  }
  action rejectLoader = {
    nondet choice = pendingSources.oneOf()
    s' = settle(s, choice, SOURCE_ERROR)
  }

  // -- External policy, clocks, storage, and failures -------------------------

  action policy = {
    nondet choice = POLICY_INHERIT.to(POLICY_INVALID_SHADOW_RAMP).oneOf()
    s' = { overlay: choice, ...s }
  }
  pure def advanceTime(state: State, elapsedMs: int): State = {
    now: state.now + elapsedMs,
    wall: state.wall + elapsedMs,
    ...state
  }
  action advance = {
    nondet choice = Set(1, HALF_SECOND_MS, ONE_SECOND_MS, TWO_SECONDS_MS, DEFAULT_RETENTION_MS).oneOf()
    s' = advanceTime(s, choice)
  }
  action seed = {
    nondet choice = 0.to(3).oneOf()
    s' = {
      remoteValues: s.remoteValues.replaceAt(choice / 2, choice % 2 + 1),
      remoteCreated: s.remoteCreated.replaceAt(choice / 2, s.wall),
      remoteExpires: s.remoteExpires.replaceAt(choice / 2, s.now + DEFAULT_RETENTION_MS),
      ...s
    }
  }
  action rollbackWall = s' = { wall: s.wall - ONE_SECOND_MS, ...s }
  action providerFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    s' = { providerFailed: choice == FAULT_FAILED, ...s }
  }
  action readFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    s' = { readFailed: choice == FAULT_FAILED, ...s }
  }
  action dumpFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    s' = { dumpFailed: choice == FAULT_FAILED, ...s }
  }
  action writeFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    s' = { writeFailed: choice == FAULT_FAILED, ...s }
  }

  // -- Exploration schedule (nesting/order preserve sampling weights) ---------

  action step = any {
    any {
      beginCall,
      releasePolicy,
      resolveLoader,
      rejectLoader
    },
    any {
      policy,
      seed,
      advance,
      rollbackWall,
      providerFault,
      readFault,
      dumpFault,
      writeFault
    }
  }

  // -- Independently stated safety properties --------------------------------

  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()
  val hitsSkipSource = s.o.loaders <= s.o.calls.length()
  val callsKeepSourceOutcome = s.o.calls.indices().forall(i =>
    if (s.owners.nth(i) >= 0) s.o.calls.nth(i) == s.sources.nth(s.owners.nth(i)).result
  else (s.o.calls.nth(i) == CALL_PENDING) == (i == s.policyCall))
  val sourceCountsMatchEffects = s.sources.length() == s.o.loaders and s.owners.length() == s.o.calls.length()
  val registeredSourcesArePending = s.registered.indices().forall(key => {
    val loader = s.registered.nth(key)
    loader < 0 or (s.sources.nth(loader).key == key and s.sources.nth(loader).result == CALL_PENDING
      and s.sources.nth(loader).shared)
  })
  val sharedSourcesKeepRegistration = pendingSources.forall(i =>
    not(s.sources.nth(i).shared) or s.registered.nth(s.sources.nth(i).key) == i)

  // -- Deterministic regression schedules ------------------------------------

  run invalidReadBudgetBypassesAllCachingTest = init.then(s' = { overlay: POLICY_INVALID_READ_BUDGET, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.loaders == 2 and s.o.reads == 0)
    .then(s' = settle(s, 0, VALUE_ONE))
    .expect(s.localValue == NO_CACHED_VALUE and s.o.writes == 0)
  run invalidLocalRampPreservesRemoteTest = init.then(s' = { overlay: POLICY_INVALID_LOCAL_RAMP, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ONE))
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.reads == 2 and s.o.loads == 1 and s.localValue == NO_CACHED_VALUE)
  run invalidRemoteRampPreservesLocalTest = init.then(s' = { overlay: POLICY_INVALID_REMOTE_RAMP, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ONE))
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 0)
  run invalidRecoveryUsesOrdinaryRetentionTest = init.then(s' = { overlay: POLICY_INVALID_RECOVERY_AGE, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ONE))
    .expect(s.o.writeTtls == List(ONE_SECOND_MS) and s.remoteExpires == List(ONE_SECOND_MS, 0))
  run invalidShadowPreservesNormalServingTest = init.then(s' = { overlay: POLICY_INVALID_SHADOW_RAMP, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ONE))
    .then(s' = begin(s, 1))
    .then(releasePolicy)
    .then(s' = settle(s, 1, VALUE_TWO))
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loads == 1 and s.o.shadow == List())

  // A hit changes recency, but the insertion deadline stays at 1,000 ms.
  // The final probe distinguishes fixed TTL from renewing it on the middle hit.
  run localHitDoesNotRenewInsertionTtlTest = init
    .then(s' = { overlay: POLICY_NO_REMOTE, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ONE))
    .then(s' = advanceTime(s, HALF_SECOND_MS))
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.localExpires == ONE_SECOND_MS)
    .then(s' = advanceTime(s, HALF_SECOND_MS))
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)

  run wallRollbackDoesNotExtendLocalTtlTest = init.then(s' = { overlay: POLICY_NO_REMOTE, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ONE))
    .then(rollbackWall)
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE))
    .then(s' = {
    now: s.now + ONE_SECOND_MS,
    wall: s.wall + ONE_SECOND_MS,
    ...s
  })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)
  run wallRollbackRejectsFutureRemoteFrameTest = init.then(s' = { overlay: POLICY_NO_LOCAL, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ONE))
    .then(rollbackWall)
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)

  run independentCompletionKeepsRegisteredLeaderTest = init
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = { overlay: INDEPENDENT_POLICY_OFFSET, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 1, VALUE_TWO))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO) and s.registered == List(0, -1))
    .then(s' = { overlay: POLICY_INHERIT, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 2)
    .then(s' = settle(s, 0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE))

  run independentFailureKeepsRegisteredLeaderTest = init
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = { overlay: INDEPENDENT_POLICY_OFFSET, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 1, SOURCE_ERROR))
    .expect(s.o.calls == List(CALL_PENDING, SOURCE_ERROR) and s.registered == List(0, -1))
    .then(s' = { overlay: POLICY_INHERIT, ...s })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR, VALUE_ONE))

  run eachSourceKeepsPublicationPolicyTest = init
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = {
    overlay: INDEPENDENT_POLICY_OFFSET + POLICY_REMOTE_FOUR_SECONDS_NO_RECOVERY,
    ...s
  })
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 1, VALUE_TWO))
    .then(s' = settle(s, 0, VALUE_ONE))
    .expect(s.o.writeTtls == List(FOUR_SECONDS_MS, DEFAULT_RETENTION_MS) and s.remoteValues == List(1, 0))
  run absentValueIsStoredAndReusedTest = init.then(s' = begin(s, 0))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ABSENT))
    .then(s' = begin(s, 0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT) and s.o.loaders == 1 and s.o.writes == 1)
}

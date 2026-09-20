module dialcache_recovery_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import recovery as Recovery from "./kernel/recovery"
  import deadlines as Deadlines from "./kernel/deadlines"
  import diagnostics as Diagnostics from "./kernel/diagnostics"
  import remote_frames as Remote from "./kernel/remote-frames"
  import flights as Flights from "./kernel/flights"
  import clock as Clock from "./kernel/clock"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Model boundary -----------------------------------------------------------
  // One registered tracked remote flight, with coalesced callers in two optional
  // request lifetimes. Selected aspects of C40-C46 cover retained recovery;
  // C03/C43 cover request publication; C57/C58 cover age and error observations.
  // See BEHAVIOR.md: "Generated feature profiles" and its recovery input table.
  // Reads and publication settle at action boundaries; decoding and sources may
  // wait. No local storage, independent same-key flights or shadow work
  // participates. Every rule is a kernel transition (formal/kernel): the held
  // remote traversal (remote_io) with its recovery snapshots (recovery) under
  // the budgeted held lifecycle (deadlines), with the read settled in the step
  // that admits the caller (beginRead: the drivers hold decodes and loaders,
  // never reads), through the diagnosed variants that record the coalesced
  // scope, the failed layer and the recovery age the drivers compare
  // (diagnostics); the frames a seed stores (remote_frames); the wall
  // rollback (clock). This module owns the bounded state, the fixture decoding
  // (the classifier a driver code names, the frame a seed choice stores, the
  // maximum a policy choice sets), the input choices and the guards. `now` is
  // elapsed time; the wall clock is `now` plus a skew a rollback shifts.

  // Trace encodings and fixture bounds ---------------------------------------
  // Keep integer input fields stable; shared caller results come from the import.
  // The drivers' operation classifier codes (beginCall choice % 4).
  pure val ALLOW = 0
  pure val DENY = 1
  pure val ERROR = 2
  pure val INHERIT = 3
  pure val FRESH_AGE_MS = 1000
  pure val INITIAL_MAX_AGE_MS = 5000
  pure val SOURCE_BUDGET_MS = 10
  pure val WALL_ROLLBACK_MS = 1000
  pure val FIXTURE_TTL_MS = 60000
  pure val INITIAL_NOW_MS = 10000
  pure val WALL_SKEW_MS = 90000
  pure val INITIAL_FRAME_AGE_MS = 1000
  pure val MAX_CALLS = 8
  pure val KEY = 0
  pure val ENTITY = 0
  // One key on one instance, two persistent request scopes (contexts 0 and 1),
  // one operation per entity; the drivers never probe a source's scope.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, probeSourceScope: false
  }
  pure def call(context: int): Call = { instance: 0, key: KEY, context: context, enabled: true, keyFailed: false }

  // Input decoding (reads no state) ------------------------------------------
  // Every reply enables the remote layer, the request memo when the fixture
  // enables request-local caching (init choices 4 to 7), and coalesces.
  pure def resolvedFor(request: bool): Resolution = { layers: { request: request, local: false, remote: true }, coalesce: true }
  // The TTLs a reply carries: no local TTL, 1 s freshness and the recovery
  // maximum as the retention a refill is written with.
  pure def ttlsFor(maximum: int): Ttls = { localMs: 0, freshMs: FRESH_AGE_MS, retentionMs: maximum }
  // The kernel classifier a driver code names: a classifier that throws is
  // DENY (recovery's rule, as the implementations treat it). The instance
  // classifier of init choice % 4: the timeout-only default, allow, deny, error.
  pure def operationClassifier(code: int): int = List(Recovery::ALLOW, Recovery::DENY, Recovery::DENY).nth(code)
  pure def instanceClassifierOf(choice: int): int = List(Recovery::TIMEOUT_ONLY, Recovery::ALLOW, Recovery::DENY, Recovery::DENY).nth(choice % 4)
  // Seeds store value 1, or value 2 for choice 6, at the ages the drivers name
  // (-1 is a frame stamped one millisecond in the future).
  pure def seedValue(choice: int): int = if (choice == 6) VALUE_TWO else VALUE_ONE
  pure def seedAge(choice: int): int = List(0, 999, 1000, 4999, 5000, -1, 1000).nth(choice)

  // State: the layered shape with its held decodes, recovery snapshots and
  // loader deadlines, the two driver channels (o, d), the io channel the held
  // shape carries, the policy in force (`ttls`, whose retention is the
  // recovery maximum a later caller is admitted with), the fixture's
  // resolution and instance classifier, and the environment's decode fault.
  type State = {
    o: Observation, d: Diagnostics, io: RemoteIO::IO,
    now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool, loadFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    sourceBudget: int, deadlines: List[Deadlines::Due], drained: List[bool], sourceLayers: List[str],
    ttls: Ttls, resolved: Resolution, instanceClassifier: int
  }
  var s: State
  // Public commands, separate from the state that predicts their consequences.
  var input: { name: str, choice: int }

  // Initial fixture: value 1 stored at age 1,000 ms (stale, never fresh) with
  // a 60 s physical TTL above the zero watermark; the policy's 5 s maximum.
  pure def initialState(choice: int): State = {
    o: empty, d: noDiagnostics, io: RemoteIO::NO_IO,
    now: INITIAL_NOW_MS, skew: WALL_SKEW_MS, remoteAvailable: true, tracked: true, capacity: 0,
    readFailed: false, dumpFailed: false, writeFailed: false, loadFailed: false,
    closed: List(false, false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER),
    localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
    remoteValues: List(VALUE_ONE), created: List(INITIAL_NOW_MS + WALL_SKEW_MS - INITIAL_FRAME_AGE_MS),
    expires: List(INITIAL_NOW_MS + FIXTURE_TTL_MS), watermark: List(0),
    sources: List(), owners: List(), memoSlots: List(), held: List(),
    reads: List(), loads: List(), loaders: List(), retained: List(),
    sourceBudget: SOURCE_BUDGET_MS, deadlines: List(), drained: List(), sourceLayers: List(),
    ttls: ttlsFor(INITIAL_MAX_AGE_MS), resolved: resolvedFor(choice >= 4), instanceClassifier: instanceClassifierOf(choice)
  }
  action initialize(choice: int): bool = all {
    (0.to(7)).contains(choice),
    input' = { name: "init", choice: choice },
    s' = initialState(choice)
  }
  action init = {
    nondet choice = 0.to(7).oneOf()
    initialize(choice)
  }

  // Guards (may read state) ---------------------------------------------------
  // One flight at a time: a caller begins only while no caller is pending and
  // joins only while one is; a decode is released while one is held; a loader
  // settles by its ordinal until its result has arrived (a result arriving
  // after its deadline drains).
  val idle = s.o.calls.select(c => c == CALL_PENDING).length() == 0
  val decoding = s.loads.length() > 0
  val openScopes = 0.to(1).filter(scope => not(s.closed.nth(scope)))
  val unsettledLoaders = s.loaders.indices().filter(i => Deadlines::pending(s, i))

  // Admission, the release and the read in one step (beginRead): a memo hit
  // stops the traversal, otherwise the read is dispatched and settled at once
  // with the classifier the driver code names, retaining the flight's
  // snapshot, holding a fresh decode or starting the loader under the source
  // budget. The classifier is the operation's (choices 0 to 2) or the
  // instance's (choice 3): two wrappers guarded on the input alone.
  action beginClassifiedWith(choice: int): bool = all {
    choice % 4 != INHERIT,
    input' = { name: "beginCall", choice: choice },
    s' = Diagnostics::beginRead(s, LAYOUT, call(choice / 4), s.resolved, s.ttls, Deadlines::UNBOUNDED, operationClassifier(choice % 4))
  }
  action beginInheritedWith(choice: int): bool = all {
    choice % 4 == INHERIT,
    input' = { name: "beginCall", choice: choice },
    s' = Diagnostics::beginRead(s, LAYOUT, call(choice / 4), s.resolved, s.ttls, Deadlines::UNBOUNDED, s.instanceClassifier)
  }
  action beginWith(choice: int): bool = all {
    (0.to(7).filter(code => not(s.closed.nth(code / 4)))).contains(choice),
    idle, s.o.calls.length() < MAX_CALLS,
    any { beginClassifiedWith(choice), beginInheritedWith(choice) }
  }
  action beginCall = {
    nondet choice = 0.to(7).filter(code => not(s.closed.nth(code / 4))).oneOf()
    beginWith(choice)
  }
  // A follower begins in a scope while a flight is pending: it joins the
  // flight (its scope's registered flight, or the process flight) or is served
  // its scope's memo; no read is dispatched, so the classifier passed is the
  // instance's the drivers' plain begin inherits.
  action joinWith(choice: int): bool = all {
    openScopes.contains(choice),
    input' = { name: "joinCall", choice: choice },
    not(idle), s.o.calls.length() < MAX_CALLS,
    s' = Diagnostics::beginRead(s, LAYOUT, call(choice), s.resolved, s.ttls, Deadlines::UNBOUNDED, s.instanceClassifier)
  }
  action joinCall = {
    nondet choice = openScopes.oneOf()
    joinWith(choice)
  }
  action closeWith(choice: int): bool = all {
    openScopes.contains(choice),
    input' = { name: "closeScope", choice: choice },
    s.resolved.layers.request, s.o.calls.length() > 0,
    s' = Serving::closeScope(s, LAYOUT, choice)
  }
  action closeScope = {
    nondet choice = openScopes.oneOf()
    closeWith(choice)
  }

  // Source settlement by the drivers' loader ordinal, and the held decode -----
  action resolveWith(choice: int): bool = all {
    unsettledLoaders.contains(choice),
    input' = { name: "resolveLoader", choice: choice },
    s' = Diagnostics::settleLoader(s, LAYOUT, choice, VALUE_TWO, false)
  }
  action resolveLoader = {
    nondet choice = unsettledLoaders.oneOf()
    resolveWith(choice)
  }
  action rejectWith(choice: int): bool = all {
    unsettledLoaders.contains(choice),
    input' = { name: "rejectLoader", choice: choice },
    s' = Diagnostics::settleLoader(s, LAYOUT, choice, SOURCE_ERROR, false)
  }
  action rejectLoader = {
    nondet choice = unsettledLoaders.oneOf()
    rejectWith(choice)
  }
  action rejectTimeoutWith(choice: int): bool = all {
    unsettledLoaders.contains(choice),
    input' = { name: "rejectTimeout", choice: choice },
    s' = Diagnostics::settleLoader(s, LAYOUT, choice, SOURCE_ERROR, true)
  }
  action rejectTimeout = {
    nondet choice = unsettledLoaders.oneOf()
    rejectTimeoutWith(choice)
  }
  // The drivers release the latest held decode; one is held at a time.
  action releaseLoad = all {
    input' = { name: "releaseLoad", choice: -1 },
    decoding,
    s' = Diagnostics::settleLoad(s, LAYOUT, RemoteIO::latestLoad(s).load, s.loadFailed)
  }

  // Environmental storage, clocks, policy, and faults -------------------------
  action seedWith(choice: int): bool = all {
    (0.to(6)).contains(choice),
    input' = { name: "seed", choice: choice },
    s' = Remote::seedAged(s, KEY, seedValue(choice), seedAge(choice), FIXTURE_TTL_MS)
  }
  action seed = {
    nondet choice = 0.to(6).oneOf()
    seedWith(choice)
  }
  // Time passes through the diagnosed delivery: a loader deadline reached
  // inside the advance completes its flight at the due instant.
  action advanceBy(choice: int): bool = all {
    (Set(1, 10, 1000, 4000)).contains(choice),
    input' = { name: "advance", choice: choice },
    s' = Diagnostics::advance(s, LAYOUT, choice)
  }
  action advance = {
    nondet choice = Set(1, 10, 1000, 4000).oneOf()
    advanceBy(choice)
  }
  action invalidate = all {
    input' = { name: "invalidate", choice: -1 },
    s' = Serving::invalidate(s, ENTITY)
  }
  action rollbackWall = all {
    input' = { name: "rollbackWall", choice: -1 },
    s' = Clock::shiftWall(s, -WALL_ROLLBACK_MS)
  }
  action policyWith(choice: int): bool = all {
    (Set(2000, 5000)).contains(choice),
    input' = { name: "policy", choice: choice },
    s' = { ttls: ttlsFor(choice), ...s }
  }
  action policy = {
    nondet choice = Set(2000, 5000).oneOf()
    policyWith(choice)
  }
  action readFaultWith(choice: int): bool = all {
    (Set(0, 1)).contains(choice),
    input' = { name: "readFault", choice: choice },
    s' = { readFailed: choice == 1, ...s }
  }
  action readFault = {
    nondet choice = Set(0, 1).oneOf()
    readFaultWith(choice)
  }
  action loadFaultWith(choice: int): bool = all {
    (Set(0, 1)).contains(choice),
    input' = { name: "loadFault", choice: choice },
    s' = { loadFailed: choice == 1, ...s }
  }
  action loadFault = {
    nondet choice = Set(0, 1).oneOf()
    loadFaultWith(choice)
  }

  // Exploration schedule: preserve grouping and order for seeded sampling.
  action step = any {
    any { beginCall, joinCall, resolveLoader, any { rejectLoader, rejectTimeout }, releaseLoad },
    any { seed, advance, rollbackWall, invalidate, policy, readFault, loadFault, closeScope }
  }

  // Invariants: independent checks over the public channels and the library records.
  // Over the public channels, verbatim from the former text.
  val singleReadPerFlight = s.o.reads <= s.o.calls.length()
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()
  val agesRequireRecovery = s.d.ages.length() == s.o.recovery.select(x => x == "served").length()
  val closedScopesHaveNoMemo = s.closed.indices().forall(scope => not(s.closed.nth(scope)) or s.memo.nth(scope) == NO_VALUE)
  // Over the library records, one step from the former text: a held recovery
  // decode belongs to a flight that still owns a pending caller; the drivers'
  // loaders are the loader ordinals; a source deadline belongs to a loader
  // exactly while its work is undelivered and its flight's result pending
  // (the former onlyRegisteredSourceOwnsDeadline: a registered source is a
  // pending loader with its deadline, an abandoned one has neither).
  val pendingDecodeHasCall = s.loads.indices().forall(i => not(s.loads.nth(i).recovery) or
    Flights::ownedBy(s, s.loads.nth(i).flight).exists(c => s.o.calls.nth(c) == CALL_PENDING))
  val sourcesMatchEffects = s.loaders.length() == s.o.loaders
  val onlyRegisteredSourceOwnsDeadline = s.loaders.indices().forall(k =>
    Deadlines::deadlinesOf(s, Deadlines::SOURCE, k).length() ==
      (if (Deadlines::pending(s, k) and s.sources.nth(s.loaders.nth(k)).result == CALL_PENDING) 1 else 0))
  // The environment restriction stated: one flight at a time, its read settled
  // in its own step, so no read is held, at most one decode and one snapshot
  // are, and at most one flight is pending.
  val oneExecution = s.reads.length() == 0 and s.loads.length() <= 1 and s.retained.length() <= 1 and
    s.sources.select(source => source.result == CALL_PENDING).length() <= 1
  // A completed caller either owns no flight (it was served its scope's memo)
  // or owns one whose result is recorded and on which no decode is still held.
  val completedCallsHaveNoActiveWork = s.o.calls.indices().forall(c => s.o.calls.nth(c) == CALL_PENDING or {
    val flight = s.owners.nth(c)
    flight < 0 or (s.sources.nth(flight).result != CALL_PENDING and
      s.loads.indices().forall(j => s.loads.nth(j).flight != flight))
  })
  // A pending caller owns a flight that is still working: its source's result
  // is pending, or a decode is held for it (a flight that recovers stays
  // pending until its decode settles). A settlement that completes only some
  // of a flight's owners strands the others (C24).
  val pendingCallersOwnActiveFlights = s.o.calls.indices().forall(c => s.o.calls.nth(c) != CALL_PENDING or {
    val flight = s.owners.nth(c)
    flight >= 0 and (s.sources.nth(flight).result == CALL_PENDING or
      s.loads.indices().exists(j => s.loads.nth(j).flight == flight))
  })
  // The former recoveredValueWasWithinAcceptedAge read a receipt list the held
  // shape does not carry; the connection model states it one step over the
  // snapshot a served recovery decode settles from (dialcache-recovery-connection.qnt).

  // Deterministic public histories ------------------------------------------
  // The same commands drive exploration and implementation replay. Initialization
  // 0 is the timeout-only default, 1 permits ordinary errors, 2 denies recovery;
  // adding 4 enables request memoization. beginWith encodes 4 * scope + classifier.
  // No regression patches private cache state or invents an environment command.

  run futureFrameDoesNotCarryMissFenceTest = initialize(0).then(invalidate).then(seedWith(5))
    .then(beginWith(3)).then(resolveWith(0)).expect(s.o.writes == 1)

  run defaultRecoversOwnTimeoutTest = initialize(0).then(beginWith(3)).then(advanceBy(10)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.classifications == 0 and s.o.recovery == List("served"))
  run explicitDenialReplacesDefaultTest = initialize(0).then(beginWith(1)).then(advanceBy(10))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.classifications == 1 and s.o.loads == 0)
  run defaultRejectsOrdinaryFailureTest = initialize(0).then(beginWith(3)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 0 and s.o.loads == 0)
  run defaultRecoversPropagatedTimeoutTest = initialize(0).then(beginWith(3)).then(rejectTimeoutWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.classifications == 0)
  run lateSuccessCannotReplaceRecoveredValueTest = initialize(0).then(beginWith(3)).then(advanceBy(10))
    .then(resolveWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.writes == 0 and s.o.dumps == 0)
  run failedRecoveryPreservesDeadlineErrorTest = initialize(0).then(beginWith(3)).then(advanceBy(10))
    .then(loadFaultWith(1)).then(releaseLoad)
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.recovery == List("deserialization_error"))
  run recoveredValueMemoizesOnlyInAttachedRequestTest = initialize(5).then(beginWith(3))
    .then(rejectWith(0)).then(releaseLoad).expect(s.memo == List(VALUE_ONE, NO_VALUE) and s.o.writes == 0)
    .then(beginWith(3)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(beginWith(7)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.reads == 2)
  run crossRequestRecoveryMemoizesBothScopesTest = initialize(5).then(beginWith(3))
    .then(joinWith(1)).then(joinWith(0)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.memo == List(VALUE_ONE, VALUE_ONE) and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and
      s.d.coalesced == List("process", "request_local") and s.o.loads == 1)
  // Both request scopes join one flight, then independently reuse its recovered
  // value. These calls make request publication observable without shared writes.
  run recoveredFlightMemoIsReusedByBothRequestsTest = initialize(4)
    .then(beginWith(4)).then(joinWith(0)).then(advanceBy(1000)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.recovery == List("served"))
    .then(beginWith(4)).then(beginWith(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.reads == 1 and s.o.loaders == 1 and s.o.loads == 1
      and s.o.classifications == 1 and s.o.dumps == 0 and s.o.writes == 0)
  run closedRequestCannotReceiveLateRecoveryMemoTest = initialize(5).then(beginWith(3)).then(rejectWith(0))
    .then(closeWith(0)).then(releaseLoad)
    .expect(s.memo == List(NO_VALUE, NO_VALUE) and s.o.calls == List(VALUE_ONE)).then(beginWith(7))
    .expect(s.o.reads == 2 and s.o.calls == List(VALUE_ONE, CALL_PENDING))
  run rollbackCannotLowerInvalidationWatermarkTest = initialize(0).then(invalidate).then(rollbackWall).then(invalidate)
    .expect(s.watermark.nth(ENTITY) == 100000)
    // Probe the retained fence through a real source result and suppressed refill.
    .then(beginWith(3)).then(resolveWith(0))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 0 and s.o.dumps == 0)
  run rollbackDuringRetainedDecodeRejectsFutureSnapshotTest = initialize(0).then(beginWith(3))
    .then(advanceBy(10)).then(rollbackWall).then(rollbackWall).then(releaseLoad)
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.recovery == List("miss") and s.d.ages == List())
  run instanceAllowReplacesTimeoutOnlyDefaultTest = initialize(1)
    .then(beginWith(3)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.classifications == 1)
  run instanceDenialReplacesTimeoutOnlyDefaultTest = initialize(2)
    .then(beginWith(3)).then(advanceBy(10)).expect(s.o.calls == List(DEADLINE_ERROR) and s.o.loads == 0)
  run operationDenialReplacesInstanceAllowTest = initialize(1)
    .then(beginWith(1)).then(rejectWith(0)).expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0)

  run lastFreshReadDoesNotInvokeSourceTest = initialize(1).then(seedWith(1))
    .then(beginWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0
      and s.o.loads == 1 and s.o.recovery == List() and s.o.writes == 0)
  run lastRecoveryMillisecondIsServedTest = initialize(1).then(seedWith(3))
    .then(beginWith(0)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.d.ages == List(4999)
      and s.o.recovery == List("served") and s.o.dumps == 0 and s.o.writes == 0)
  run maximumAgeAtReadDoesNotDecodeTest = initialize(1).then(seedWith(4))
    .then(beginWith(0)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0
      and s.o.reads == 1 and s.o.recovery == List("miss"))
  run fencedInitialBytesNeverRecoverTest = initialize(1).then(invalidate)
    .then(beginWith(0)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0
      and s.o.reads == 1 and s.o.recovery == List("miss"))
  run classifierErrorPreservesSourceWithoutDecodeTest = initialize(1)
    .then(beginWith(2)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 1
      and s.o.loads == 0 and s.o.recovery == List() and s.o.writes == 0)
  run freshDecodeFailureCannotBeRetriedAsRecoveryTest = initialize(1)
    .then(seedWith(0)).then(loadFaultWith(1))
    .then(beginWith(0)).then(releaseLoad).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 1
      and s.o.classifications == 0 and s.o.recovery == List() and s.o.reads == 1)
  run initialReadFailureSkipsRecoveryClassificationTest = initialize(1)
    .then(readFaultWith(1)).then(beginWith(0)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0
      and s.o.classifications == 0 and s.o.recovery == List() and s.o.reads == 1)
  run rollbackBelowFreshCeilingStillRecoversTest = initialize(1)
    .then(beginWith(0)).then(rejectWith(0)).then(rollbackWall).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.d.ages == List(0)
      and s.o.recovery == List("served") and s.o.writes == 0)
  run replacementDoesNotChangeRetainedRecoveryTest = initialize(1)
    .then(beginWith(0)).then(seedWith(6)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.remoteValues.nth(KEY) == VALUE_TWO
      and s.o.reads == 1 and s.o.loads == 1 and s.o.writes == 0)
  run maximumAgeBeforeDecodePreservesSourceTest = initialize(1)
    .then(seedWith(3)).then(beginWith(0)).then(advanceBy(1)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0
      and s.o.reads == 1 and s.o.recovery == List("miss"))
  run maximumAgeAfterDecodePreservesSourceTest = initialize(1)
    .then(beginWith(0)).then(rejectWith(0)).then(advanceBy(4000)).then(releaseLoad)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 1
      and s.o.recovery == List("miss") and s.d.ages == List() and s.o.writes == 0)
  run operationAllowReplacesInstanceDenialTest = initialize(2)
    .then(beginWith(0)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.classifications == 1
      and s.o.loads == 1 and s.o.recovery == List("served") and s.o.writes == 0)
  run coalescedRecoveryClassifiesAndDecodesOnceTest = initialize(5)
    .then(beginWith(3)).then(joinWith(1)).then(joinWith(0))
    .then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.reads == 1 and s.o.loaders == 1 and s.o.classifications == 1
      and s.o.loads == 1 and s.o.recovery == List("served") and s.o.writes == 0)
  run recoveredValueKeepsOriginalFallbackDiagnosticTest = initialize(1)
    .then(beginWith(0)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served")
      and s.d.fallbackErrors == List("remote") and s.o.classifications == 1
      and s.o.loads == 1 and s.o.dumps == 0 and s.o.writes == 0)
}

module dialcache_shadow_layers_conformance {
  import cache_rules.* from "./cache-rules"
  import conformance_observations.* from "./conformance-observations"
  import payloads as Payloads from "./kernel/payloads"
  import cohort_boundaries.* from "./cohort-boundaries"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import remote_frames as Remote from "./kernel/remote-frames"
  import remote_writes as Writes from "./kernel/remote-writes"
  import shadow as Shadow from "./kernel/shadow"
  import deadlines as Deadlines from "./kernel/deadlines"
  import recovery as Recovery from "./kernel/recovery"
  import flights as Flights from "./kernel/flights"
  import clock as Clock from "./kernel/clock"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Composition: request/local reuse, independent caller sources, and one
  // per-instance registry shared by served-hit and ramped-down shadow jobs.
  // C18/C21/C47/C49/C54 govern captured policy, admission, and publication.
  // Sources and serialization/writes can remain pending. Redis acquisition,
  // decoding and comparison are atomic here; their held-work races belong to
  // the shadow/admission profiles. Callers have no source deadline; every job
  // has the library's 60-second budget. A dark job can abandon its source wait
  // without finishing that caller, while a served job retains its raw source.
  // Three keys, two instances, three persistent scopes, twelve caller starts.
  // Coalescing is explicitly off. Ordinary stale-recovery reads are excluded;
  // dark acquisition includes stale bytes to distinguish its lack of recovery.
  // Every rule is a kernel transition (formal/kernel): the layered atomic
  // release with held refills and atomic stale-on-error (remote_writes), the
  // shadow job registry beside it (shadow) with its budgets (deadlines), the
  // frames a seed stores (remote_frames). This module owns the bounded state,
  // the fixture decoding (the layers, TTLs and cohort selection a policy code
  // resolves to, the frame a seed choice names), the input choices and the
  // guards. The explicit input envelope is the portable driver input.

  pure val KEYS = 3
  pure val INSTANCES = 2
  pure val SCOPES = 3
  pure val MAX_CALLS = 12
  pure val JOB_CAPACITY = 2
  pure val JOB_BUDGET_MS = 60000
  pure val LOCAL_TTL_MS = 60000
  pure val SEED_TTL_MS = 180000
  pure val DARK_ALL = 0
  pure val DARK_REQUEST = 1
  pure val DARK_LOCAL = 2
  pure val DARK_NONE = 3
  pure val SERVED_NONE = 4
  pure val SERVED_NO_SHADOW = 5
  pure val DARK_NO_SHADOW = 6
  pure val DARK_INVALID_SHADOW = 7
  pure val DARK_CHANGED_FILL = 8
  pure val COHORT_BELOW = 9
  pure val COHORT_AT = 10
  pure val COHORT_ABOVE = 11
  pure val SERVED_ALL = 12
  pure val SERVED_CHANGED_FILL = 13
  pure val SHADOW_SAMPLE_NUMERATOR = 3203834406
  // Three keys per instance and per scope row, three persistent scopes, one
  // operation per entity; the drivers probe each source's scope.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: KEYS, keysPerScope: KEYS, persistentContexts: SCOPES, operationsPerEntity: 1, probeSourceScope: true, policyProvider: true
  }

  // State: the layered shape with its held refills, recovery snapshots and
  // shadow jobs with their budgets, and the policy in force decoded once at
  // the policy input (the code, for the guards; the layers, TTLs and cohort
  // selection the traversal and the jobs read).
  type State = {
    o: Observation,
    now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    policy: int, resolved: Resolution, ttls: Ttls, shadow: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], retained: List[Recovery::Snapshot],
    jobs: List[Shadow::Job], deadlines: List[Deadlines::Due]
  }
  var s: State
  var input: { name: str, choice: int }

  // Input decoding (reads no state) -------------------------------------------
  pure def zeros(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(0))
  pure def slots(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(NO_OWNER))
  pure def changedFill(choice: int): bool = choice == DARK_CHANGED_FILL or choice == SERVED_CHANGED_FILL
  pure def cohortCode(choice: int): bool = Set(COHORT_BELOW, COHORT_AT, COHORT_ABOVE).contains(choice)
  // The layers a policy code enables; no reply coalesces.
  pure def resolvedFor(choice: int): Resolution = {
    layers: {
      request: Set(DARK_ALL, DARK_REQUEST, DARK_CHANGED_FILL, SERVED_ALL).contains(choice),
      local: Set(DARK_ALL, DARK_LOCAL, DARK_INVALID_SHADOW, DARK_CHANGED_FILL, SERVED_ALL).contains(choice),
      remote: Set(SERVED_NONE, SERVED_NO_SHADOW, SERVED_ALL, SERVED_CHANGED_FILL).contains(choice)
    },
    coalesce: false
  }
  // A 60 s local insertion TTL; the changed-fill codes carry a 120 s freshness
  // and a 180 s retention, the others 60 s and 120 s.
  pure def ttlsFor(choice: int): Ttls = {
    localMs: LOCAL_TTL_MS,
    freshMs: if (changedFill(choice)) 120000 else 60000,
    retentionMs: if (changedFill(choice)) 180000 else 120000
  }
  // Whether the fixture key's cohort is selected: the drivers' shadow ramp is
  // a full ramp, none (an invalid ramp admits nobody), or a cohort boundary
  // compared strictly against the published numerator (C47).
  pure def shadowFor(choice: int): bool =
    if (cohortCode(choice)) cohortAdmits(SHADOW_SAMPLE_NUMERATOR, thresholdForRelation(SHADOW_SAMPLE_NUMERATOR, choice - COHORT_BELOW))
    else not(Set(SERVED_NO_SHADOW, DARK_NO_SHADOW, DARK_INVALID_SHADOW, SERVED_CHANGED_FILL).contains(choice))
  pure def instance(context: int): int = if (context == 2 or context == 4) 1 else 0
  pure def call(choice: int): Call =
    { instance: instance(choice / KEYS), key: choice % KEYS, context: choice / KEYS, enabled: true, keyFailed: false }
  pure def seedValue(choice: int): int = if (choice % 4 == 1) VALUE_TWO else VALUE_ONE
  pure def seedAge(choice: int): int = if (choice % 4 == 2) 59999 else if (choice % 4 == 3) 60000 else 0

  // The initial fixture: the policy of code 0 in force, nothing stored.
  pure val INITIAL: State = {
      o: empty,
      now: 100000, skew: 0, remoteAvailable: true, tracked: true, capacity: KEYS,
      readFailed: false, dumpFailed: false, writeFailed: false,
      policy: DARK_ALL, resolved: resolvedFor(DARK_ALL), ttls: ttlsFor(DARK_ALL), shadow: shadowFor(DARK_ALL),
      closed: List(false, false, false), memo: zeros(SCOPES * KEYS), requestFlights: slots(SCOPES * KEYS), processFlights: slots(INSTANCES * KEYS),
      localValues: zeros(INSTANCES * KEYS), localExpires: zeros(INSTANCES * KEYS), lru: List(List(), List()),
      remoteValues: zeros(KEYS), created: zeros(KEYS), expires: zeros(KEYS), watermark: zeros(KEYS),
      sources: List(), owners: List(), memoSlots: List(), held: List(),
      dumps: List(), writes: List(), retained: List(), jobs: List(), deadlines: List()
  }
  action init = all { input' = { name: "init", choice: -1 }, s' = INITIAL }

  // Guards (may read state) ------------------------------------------------------
  // An ordinary stale-recovery read is excluded: a visible frame past the
  // reply's freshness but inside its retention under a serving policy.
  def ordinaryStaleCandidate(key: int): bool = s.resolved.layers.remote and Remote::visible(s, key, 1)
    and retainedAgeAllowed(s.created.nth(key), Clock::wallOf(s), s.ttls.freshMs, s.ttls.retentionMs)

  action beginAt(choice: int): bool = all {
    s.o.calls.length() < MAX_CALLS,
    not(cohortCode(s.policy)) or choice % KEYS == 0,
    not(ordinaryStaleCandidate(choice % KEYS)),
    input' = { name: "beginCall", choice: choice },
    s' = Shadow::begin(s, LAYOUT, call(choice), s.resolved, s.ttls, Recovery::ALLOW,
      { hook: true, selected: s.shadow, capacity: JOB_CAPACITY, budgetMs: JOB_BUDGET_MS, logging: false })
  }
  action beginCall = {
    nondet choice = 0.to(14).oneOf()
    beginAt(choice)
  }
  action resolveAt(choice: int): bool = {
    val source = (choice - 1) / 2
    all {
      s.sources.indices().contains(source),
      s.sources.nth(source).result == CALL_PENDING,
      input' = { name: "resolveLoader", choice: choice },
      s' = Shadow::settle(s, LAYOUT, source, (choice - 1) % 2 + 1, false)
    }
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_CALLS * 4).oneOf()
    resolveAt(choice)
  }
  action rejectAt(choice: int): bool = all {
    s.sources.indices().contains(choice),
    s.sources.nth(choice).result == CALL_PENDING,
    input' = { name: "rejectLoader", choice: choice },
    s' = Shadow::settle(s, LAYOUT, choice, SOURCE_ERROR, false)
  }
  action rejectLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING).oneOf()
    rejectAt(choice)
  }
  // A propagated timeout settles as a source error; the recovery rules see it
  // as a timeout (under ALLOW the same classification).
  action rejectTimeoutAt(choice: int): bool = all {
    s.sources.indices().contains(choice),
    s.sources.nth(choice).result == CALL_PENDING,
    input' = { name: "rejectTimeout", choice: choice },
    s' = Shadow::settle(s, LAYOUT, choice, SOURCE_ERROR, true)
  }
  action rejectTimeout = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING).oneOf()
    rejectTimeoutAt(choice)
  }
  action releaseDumpAt(choice: int): bool = all {
    Writes::holdsDump(s, choice),
    input' = { name: "releaseDump", choice: choice },
    s' = Shadow::releaseDump(s, LAYOUT, choice, s.dumpFailed)
  }
  action releaseDump = {
    nondet choice = s.dumps.indices().map(i => s.dumps.nth(i).dump).oneOf()
    releaseDumpAt(choice)
  }
  action releaseWriteAt(choice: int): bool = all {
    Writes::holdsWrite(s, choice),
    input' = { name: "releaseWrite", choice: choice },
    s' = Shadow::releaseWrite(s, LAYOUT, choice, s.writeFailed)
  }
  action releaseWrite = {
    nondet choice = s.writes.indices().map(i => s.writes.nth(i).write).oneOf()
    releaseWriteAt(choice)
  }
  action advanceBy(choice: int): bool = all {
    s.now + choice <= 600000,
    input' = { name: "advance", choice: choice },
    s' = Shadow::advance(s, choice)
  }
  action advance = {
    nondet choice = Set(1, JOB_BUDGET_MS, 120000).oneOf()
    advanceBy(choice)
  }
  action setPolicy(choice: int): bool = all {
    input' = { name: "policy", choice: choice },
    s' = { policy: choice, resolved: resolvedFor(choice), ttls: ttlsFor(choice), shadow: shadowFor(choice), ...s }
  }
  action policy = {
    nondet choice = 0.to(SERVED_CHANGED_FILL).oneOf()
    setPolicy(choice)
  }
  action seedAt(choice: int): bool = all {
    input' = { name: "seed", choice: choice },
    s' = Remote::seedAged(s, choice / 4, seedValue(choice), seedAge(choice), SEED_TTL_MS)
  }
  action seed = {
    nondet choice = 0.to(11).oneOf()
    seedAt(choice)
  }
  action step = any { beginCall, resolveLoader, rejectLoader, rejectTimeout,
    releaseDump, releaseWrite, advance, policy, seed }

  // Invariants over the library records ---------------------------------------
  // A job's identity is its source's (instance, key); the registry is
  // pending-only, so every record is a live job.
  def jobInstance(i: int): int = s.sources.nth(s.jobs.nth(i).source).instance
  def jobKey(i: int): int = s.sources.nth(s.jobs.nth(i).source).key
  def owned(source: int): bool = Flights::ownedBy(s, source).size() > 0
  val boundedSharedJobRegistry = 0.to(INSTANCES - 1).forall(inst =>
    s.jobs.indices().filter(i => jobInstance(i) == inst).size() <= JOB_CAPACITY)
  val oneJobPerInstanceKey = s.jobs.indices().forall(a => s.jobs.indices().forall(b =>
    a == b or jobInstance(a) != jobInstance(b) or jobKey(a) != jobKey(b)))
  // Every source is a drivers' loader; a source is probed as participating
  // exactly when a caller owns it (a served job's detached source is not).
  val sourcesRemainIndependentOfJobs = s.o.loaders == s.sources.length()
    and s.o.sourceScopes.length() == s.sources.length()
    and s.sources.indices().forall(i => s.o.sourceScopes.nth(i) == owned(i))
  // A caller its source owns is pending or holds that source's result (a
  // remote caller stays pending until its refill's write is released).
  val callerSourceOwnsItsResult = s.owners.indices().forall(call => {
    val owner = s.owners.nth(call)
    owner < 0 or s.o.calls.nth(call) == CALL_PENDING or s.o.calls.nth(call) == s.sources.nth(owner).result
  })
  // Only a source that read the remote layer (here: one that captured a
  // retention, since every serving reply carries one and no read fails) is
  // classified when it fails, and every such failure reports a miss.
  val darkJobsNeverRecover = {
    val ordinaryFailures = s.sources.select(source => source.retentionMs > 0 and source.result == SOURCE_ERROR).length()
    s.o.classifications == ordinaryFailures
      and s.o.recovery == 0.to(ordinaryFailures - 1).fold(List(), (out, _) => out.append("miss"))
  }
  // A job's held fill carries the retention the reply it was admitted under
  // resolved to, capped for this tracked fixture (C18).
  def captured(source: int): int = Remote::physicalRetention(s, Shadow::jobOf(s, source).ttls.retentionMs)
  val fillKeepsCapturedRetention = s.dumps.indices().forall(i =>
      not(Shadow::holdsJob(s, s.dumps.nth(i).source)) or s.dumps.nth(i).retentionMs == captured(s.dumps.nth(i).source))
    and s.writes.indices().forall(i =>
      not(Shadow::holdsJob(s, s.writes.nth(i).source)) or s.writes.nth(i).retentionMs == captured(s.writes.nth(i).source))
  // A served job carries the hit it was admitted with and never fills.
  val servedJobsNeverWrite = s.jobs.indices().forall(i => s.jobs.nth(i).dark
    or (s.jobs.nth(i).cached > NO_VALUE and s.jobs.nth(i).phase != Shadow::SERIALIZING and s.jobs.nth(i).phase != Shadow::WRITING))
  val timedOutDarkSourceWaitReleases = s.jobs.indices().forall(i =>
    not(s.jobs.nth(i).dark and s.jobs.nth(i).timedOut and s.jobs.nth(i).phase == Shadow::WAITING_SOURCE))
  val unboundedCallerKeepsPendingSource = s.owners.indices().forall(call =>
    s.owners.nth(call) < 0 or s.sources.nth(s.owners.nth(call)).result != CALL_PENDING
      or s.o.calls.nth(call) == CALL_PENDING)
  // A source no caller owns carries no publication authority.
  val detachedSourcesCarryNoAuthority = s.sources.indices().forall(i => owned(i)
    or (s.sources.nth(i).localMs == 0 and s.sources.nth(i).retentionMs == 0 and s.sources.nth(i).fence == NO_FENCE))
  // Every pending deadline is a registered job's whose budget has not
  // expired, and every such job has exactly one.
  val jobBudgetsBelongToLiveJobs = s.deadlines.indices().forall(i => {
    val due = s.deadlines.nth(i)
    due.kind == Deadlines::JOB and Shadow::holdsJob(s, due.index) and not(Shadow::jobOf(s, due.index).timedOut)
  }) and s.jobs.indices().forall(i => s.jobs.nth(i).timedOut
    or Deadlines::deadlinesOf(s, Deadlines::JOB, s.jobs.nth(i).source).length() == 1)
  // Every held dump or write serializes an accepted result.
  val heldWorkHasAcceptedResults = s.dumps.indices().forall(i => accepted(s.sources.nth(s.dumps.nth(i).source).result))
    and s.writes.indices().forall(i => accepted(s.sources.nth(s.writes.nth(i).source).result))

  // Atomic reads and shadow comparisons have no decode-failure settlement.
  val atomicPathSeedsDecodableFrames = Payloads::atomicSafe(s)

  // Each regression uses only public input transitions. Later calls distinguish
  // real storage reuse/publication from a counter or an internal phase alone.
  run darkSourcePublishesLocalBeforeShadowWriteTest = init
    .then(setPolicy(DARK_LOCAL)).then(beginAt(9)).then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 0)
    .then(setPolicy(SERVED_ALL)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 1 and s.o.shadow == List())

  run darkSourcePublishesRequestBeforeShadowWriteTest = init
    .then(setPolicy(DARK_REQUEST)).then(beginAt(0)).then(resolveAt(1))
    .then(setPolicy(SERVED_ALL)).then(beginAt(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 1 and s.o.writes == 0)
    .then(setPolicy(DARK_REQUEST)).then(beginAt(3))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING)
      and s.o.loaders == 2 and s.o.shadow == List("dropped"))

  run darkPresentC0NeverBecomesLocalPublicationTest = init
    .then(setPolicy(DARK_LOCAL)).then(seedAt(0)).then(beginAt(9)).then(beginAt(9))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 2
      and s.o.reads == 1 and s.o.loads == 0 and s.o.shadow == List("dropped"))
    .then(resolveAt(2)).then(setPolicy(SERVED_ALL)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING, VALUE_TWO)
      and s.o.loaders == 2 and s.o.reads == 2 and s.o.writes == 0
      and s.o.shadow == List("dropped", "mismatch"))

  run darkPresentC0NeverBecomesRequestPublicationTest = init
    .then(setPolicy(DARK_REQUEST)).then(seedAt(0)).then(beginAt(0)).then(beginAt(0))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 2
      and s.o.reads == 1 and s.o.loads == 0 and s.o.shadow == List("dropped"))
    .then(resolveAt(2)).then(setPolicy(SERVED_ALL)).then(beginAt(0))
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING, VALUE_TWO)
      and s.o.loaders == 2 and s.o.reads == 2 and s.o.writes == 0)
    .then(setPolicy(DARK_REQUEST)).then(beginAt(3))
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING, VALUE_TWO, CALL_PENDING)
      and s.o.loaders == 3 and s.o.reads == 3)

  run deduplicatedJobKeepsIndependentCallerSourcesTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(9)).then(beginAt(9))
    .expect(s.o.loaders == 2 and s.o.reads == 1 and s.o.shadow == List("dropped"))
    .then(resolveAt(4))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO) and s.o.dumps == 0)
    .then(resolveAt(1)).then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .then(setPolicy(SERVED_NO_SHADOW)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE)
      and s.o.loaders == 2 and s.o.writes == 1 and s.o.shadow == List("dropped", "filled"))

  run darkFailureDoesNotUseEligibleStaleBytesTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(3)).then(beginAt(9)).then(rejectAt(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0 and s.o.dumps == 0
      and s.o.classifications == 0 and s.o.recovery == List() and s.o.shadow == List("source_error"))

  run invalidShadowKeepsLocalPublicationTest = init
    .then(setPolicy(DARK_INVALID_SHADOW)).then(beginAt(9)).then(resolveAt(1))
    .then(setPolicy(SERVED_ALL)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 0 and s.o.writes == 0 and s.o.shadow == List())

  run unboundedCallerSurvivesDarkJobDeadlineTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(9)).then(advanceBy(JOB_BUDGET_MS))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.shadow == List("timeout"))
    .then(beginAt(9))
    .expect(s.o.loaders == 2 and s.o.reads == 2 and s.o.shadow == List("timeout"))
    .then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.dumps == 0)
    .then(resolveAt(4))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.dumps == 1)

  run servedAndDarkJobsShareCapacityButNotSourceOwnershipTest = init
    .then(seedAt(0)).then(setPolicy(SERVED_NONE)).then(beginAt(9))
    .then(setPolicy(DARK_NONE)).then(beginAt(10)).then(beginAt(11))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING, CALL_PENDING)
      and s.o.loaders == 3 and s.o.reads == 2 and s.o.shadow == List("dropped"))
    .then(advanceBy(JOB_BUDGET_MS)).then(beginAt(11))
    .expect(s.o.loaders == 4 and s.o.reads == 3
      and s.o.shadow == List("dropped", "timeout", "timeout"))
    // The new dark key occupies the released dark slot. A further distinct
    // key is still dropped until the served job's raw source settles.
    .then(beginAt(10))
    .expect(s.o.loaders == 5 and s.o.reads == 3
      and s.o.shadow == List("dropped", "timeout", "timeout", "dropped"))
    .then(resolveAt(2)).then(beginAt(10))
    .expect(s.o.loaders == 6 and s.o.reads == 4
      and s.o.shadow == List("dropped", "timeout", "timeout", "dropped"))
    .then(resolveAt(4))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, CALL_PENDING,
        CALL_PENDING, CALL_PENDING, CALL_PENDING)
      and s.o.loads == 1 and s.o.dumps == 0)

  run fullMixedInstanceDoesNotBlockAnotherInstanceTest = init
    .then(seedAt(0)).then(setPolicy(SERVED_NONE)).then(beginAt(9))
    .then(setPolicy(DARK_NONE)).then(beginAt(10)).then(beginAt(11)).then(beginAt(14))
    .expect(s.o.loaders == 4 and s.o.reads == 3 and s.o.shadow == List("dropped")
      and s.o.sourceScopes == List(false, true, true, true))

  run servedDiagnosticSourceDoesNotPopulateLocalTest = init
    .then(seedAt(0)).then(setPolicy(SERVED_NONE)).then(beginAt(9)).then(resolveAt(2))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.writes == 0 and s.o.shadow == List("mismatch"))
    .then(setPolicy(DARK_LOCAL)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)

  run validatedRemoteHitStopsFurtherShadowTest = init
    .then(seedAt(0)).then(setPolicy(SERVED_ALL)).then(beginAt(9)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 1 and s.o.loads == 1 and s.o.shadow == List())
    .then(resolveAt(2)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 2 and s.o.writes == 0 and s.o.shadow == List("mismatch"))

  run ordinaryServingMissDoesNotAdmitDiagnosticSourceTest = init
    .then(setPolicy(SERVED_NONE)).then(beginAt(9))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.loaders == 1
      and s.o.reads == 1 and s.o.sourceScopes == List(true) and s.o.shadow == List())
    .then(resolveAt(2)).then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .then(setPolicy(SERVED_NO_SHADOW)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.loaders == 1
      and s.o.writes == 1 and s.o.shadow == List())

  run shadowCohortBelowDoesNotAdmitTest = init
    .then(setPolicy(COHORT_BELOW)).then(beginAt(9)).then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 0 and s.o.shadow == List())
  run shadowCohortEqualityDoesNotAdmitTest = init
    .then(setPolicy(COHORT_AT)).then(beginAt(9)).then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 0 and s.o.shadow == List())
  run shadowCohortAboveAdmitsTest = init
    .then(setPolicy(COHORT_ABOVE)).then(beginAt(9)).then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.dumps == 1)

  run darkFillRetainsPolicyThroughSerializationTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(9)).then(setPolicy(DARK_CHANGED_FILL))
    .then(resolveAt(1)).then(setPolicy(SERVED_CHANGED_FILL))
    .then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .expect(s.o.writeTtls == List(120000) and s.o.shadow == List("filled"))
    .then(advanceBy(120000)).then(setPolicy(SERVED_CHANGED_FILL)).then(beginAt(9)).then(rejectAt(1))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR) and s.o.recovery == List("miss")
      and s.o.classifications == 1 and s.o.loaders == 2)

  run retainedFreshC0StillComparesAfterFreshnessBoundaryTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(2)).then(beginAt(9))
    .then(advanceBy(1)).then(resolveAt(2))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loads == 1 and s.o.reads == 2
      and s.o.writes == 0 and s.o.shadow == List("mismatch"))

  // The C0 read at exactly the freshness boundary acquires nothing: the job
  // holds a dump at settlement instead of decoding and comparing.
  run expiredC0CanFillAndServeNewValueTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(3)).then(beginAt(9)).then(resolveAt(2))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.reads == 1 and s.o.loads == 0 and s.o.dumps == 1 and s.o.shadow == List())
    .then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .then(setPolicy(SERVED_NO_SHADOW)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.loaders == 1
      and s.o.reads == 2 and s.o.loads == 1 and s.o.shadow == List("filled"))

  run acquiredMissDoesNotRereadBeforeFillTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(9)).then(seedAt(0)).then(resolveAt(2))
    .then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .expect(s.o.reads == 1 and s.o.writes == 1 and s.o.shadow == List("filled"))
    .then(setPolicy(SERVED_NO_SHADOW)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 2 and s.o.loaders == 1)

  // A local entry inserted for the local TTL expires at that instant exactly
  // (the same strict expiry the old text stated): a hit at its insertion, a
  // miss exactly the TTL later; the drivers' 60 s advance after the insertion
  // is the instant the run distinguishes.
  run localEntryExpiresAtItsInsertionTtlTest = init
    .then(setPolicy(DARK_INVALID_SHADOW)).then(beginAt(9)).then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 1 and s.o.shadow == List())
    .then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
    .then(advanceBy(LOCAL_TTL_MS)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)

  run darkPropagatedTimeoutIsSourceFailureTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(9)).then(rejectTimeoutAt(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.shadow == List("source_error"))
  run servedPropagatedTimeoutPreservesHitTest = init
    .then(seedAt(0)).then(setPolicy(SERVED_NONE)).then(beginAt(9)).then(rejectTimeoutAt(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.shadow == List("source_error"))

  // A dark C0 compared against the source: equal decoded values are a match
  // with no confirmation read; unequal ones whose C0 bytes were replaced
  // before the confirmation read are superseded. Neither fills.
  run darkC0EqualToSourceIsAMatchTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(0)).then(beginAt(9)).then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loads == 1 and s.o.reads == 1
      and s.o.dumps == 0 and s.o.shadow == List("match"))
  run darkC0ReplacedBeforeConfirmationIsSupersededTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(0)).then(beginAt(9)).then(seedAt(1)).then(resolveAt(2))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loads == 1 and s.o.reads == 2
      and s.o.dumps == 0 and s.o.shadow == List("superseded"))
}

module dialcache_admission_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import remote_writes as Writes from "./kernel/remote-writes"
  import shadow as Shadow from "./kernel/shadow"
  import deadlines as Deadlines from "./kernel/deadlines"
  import recovery as Recovery from "./kernel/recovery"
  import remote_frames as Remote from "./kernel/remote-frames"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Served Redis hits: three keys, two instances, two shadow slots per instance.
  // Read/decode effects are held explicitly. Only shadow jobs invoke sources.
  // A timed-out job retains its pending external work and its slot until that
  // work settles. Environment: fresh served Redis hits, held reads/decodes,
  // explicit source settlements and elapsed clock steps. Bounds: three keys,
  // two instances, two job slots each, sixteen callers; elapsed time stays
  // below read deadlines and physical Redis expiration.
  // See BEHAVIOR.md "Generated served-hit shadow admission profile" for the
  // drivers' input table.
  // Every rule is a kernel transition (formal/kernel): the held remote
  // traversal with immediate replies (remote_io, through the shadow module's
  // held variants), the served job registry with its budgets (shadow,
  // deadlines), the frames a seed stores (remote_frames). This module owns
  // the bounded state, the fixture decoding (the identity a call choice names,
  // the coalescing and cohort selection a policy code resolves to, the frame
  // a seed choice names, the loader and value a resolve code names), the
  // input choices and the guards. The explicit input envelope is the portable
  // driver input; keep the integer encodings stable.

  // -- Fixture bounds and the drivers' encodings ---------------------------------

  pure val POLICY_DEFAULT = 0
  pure val POLICY_NO_SHADOW = 1
  pure val POLICY_NO_COALESCING = 2
  pure val POLICY_NO_SHADOW_OR_COALESCING = 3
  pure val KEYS = 3
  pure val INSTANCES = 2
  pure val JOB_CAPACITY = 2
  pure val MAX_CALLERS = 16
  pure val MAX_IDENTITY_CHOICE = 5
  pure val SOURCE_VALUE_COUNT = 2
  pure val MAX_RESOLVE_CHOICE = 32
  pure val SHADOW_TIMEOUT_MS = 10
  pure val MAX_ELAPSED_MS = 600
  // The drivers' 60 s Redis TTL: the freshness every reply resolves to and the
  // retention every frame is stored with; the read budget every held read is
  // dispatched under. Neither is reached inside the elapsed-time bound.
  pure val REMOTE_TTL_MS = 60000
  pure val READ_BUDGET_MS = 1000
  // The wall clock's origin: every frame stamped from it clears the zero
  // watermark of its tracked entity.
  pure val WALL_ORIGIN_MS = 100000
  // Three keys per instance and per scope row, no persistent scope, one
  // operation per entity; the drivers probe each source's scope.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: KEYS, keysPerScope: KEYS, persistentContexts: 0, operationsPerEntity: 1, probeSourceScope: true, policyProvider: true
  }
  // Every reply uses the remote layer alone, with the TTLs above.
  pure val REMOTE_LAYERS: Layers = { request: false, local: false, remote: true }
  pure val TTLS: Ttls = { localMs: 0, freshMs: REMOTE_TTL_MS, retentionMs: REMOTE_TTL_MS }
  // The instance's shadow policy as read when a hit is judged: the outcome
  // hook installed, two slots per instance, a 10 ms job budget, no mismatch
  // logging; the cohort selection consulted is the one captured for the flight.
  pure val SHADOWING: Shadow::Shadowing = { hook: true, selected: true, capacity: JOB_CAPACITY, budgetMs: SHADOW_TIMEOUT_MS, logging: false }

  // State: the held remote shape with the served job registry, its budgets
  // and the cohort selections captured for pending flights, and the policy
  // in force decoded once at the policy input (whether replies coalesce,
  // whether they select the cohort). The local layer is off in every reply,
  // so local storage is declared empty; no scope is persistent, so the memo
  // and request registries are empty; served jobs never fill, so the held
  // lifecycle's dumps and writes are declared empty.
  type State = {
    o: Observation, io: RemoteIO::IO,
    now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite],
    jobs: List[Shadow::Job], deadlines: List[Deadlines::Due], selected: List[int],
    coalesce: bool, shadowSelected: bool
  }
  var s: State
  var input: { name: str, choice: int }

  // -- Input decoding (reads no state) --------------------------------------------

  pure def call(choice: int): Call =
    { instance: choice / KEYS, key: choice % KEYS, context: 0, enabled: true, keyFailed: false }
  // 0: defaults; 1: shadow off; 2: coalescing off; 3: both off.
  pure def coalesces(choice: int): bool = choice < POLICY_NO_COALESCING
  pure def selects(choice: int): bool = choice % 2 == POLICY_DEFAULT
  pure def resolvedSource(code: int): int = (code - 1) / SOURCE_VALUE_COUNT
  pure def resolvedValue(code: int): int = (code - 1) % SOURCE_VALUE_COUNT + VALUE_ONE

  // The initial fixture: value 1 stored under every key, stamped at the wall
  // origin and retained for the Redis TTL; the policy of code 0 in force.
  pure val INITIAL: State = {
    o: empty, io: RemoteIO::NO_IO,
    now: 0, skew: WALL_ORIGIN_MS, remoteAvailable: true, tracked: true, capacity: 0,
    readFailed: false, dumpFailed: false, writeFailed: false,
    closed: List(), memo: List(), requestFlights: List(),
    processFlights: List(NO_OWNER, NO_OWNER, NO_OWNER, NO_OWNER, NO_OWNER, NO_OWNER),
    localValues: List(), localExpires: List(), lru: List(List(), List()),
    remoteValues: List(VALUE_ONE, VALUE_ONE, VALUE_ONE), created: List(WALL_ORIGIN_MS, WALL_ORIGIN_MS, WALL_ORIGIN_MS),
    expires: List(REMOTE_TTL_MS, REMOTE_TTL_MS, REMOTE_TTL_MS), watermark: List(0, 0, 0),
    sources: List(), owners: List(), memoSlots: List(), held: List(),
    reads: List(), loads: List(), loaders: List(), retained: List(),
    dumps: List(), writes: List(), jobs: List(), deadlines: List(), selected: List(),
    coalesce: true, shadowSelected: true
  }
  action init = all { input' = { name: "init", choice: -1 }, s' = INITIAL }

  // -- Caller admission: the read dispatched, the selection captured --------------

  action beginWith(choice: int): bool = all {
    (0.to(MAX_IDENTITY_CHOICE)).contains(choice),
    input' = { name: "beginCall", choice: choice },
    s.o.calls.length() < MAX_CALLERS,
    s' = Shadow::beginHeld(s, LAYOUT, call(choice), { layers: REMOTE_LAYERS, coalesce: s.coalesce }, TTLS, READ_BUDGET_MS, s.shadowSelected)
  }
  action beginCall = {
    nondet choice = 0.to(MAX_IDENTITY_CHOICE).oneOf()
    beginWith(choice)
  }

  // -- Held read/decode completion and source settlement, by explicit index -------

  val heldReads = s.reads.indices().map(i => s.reads.nth(i).read)
  val heldLoads = s.loads.indices().map(i => s.loads.nth(i).load)
  val pendingLoaders = s.loaders.indices().filter(k => s.sources.nth(s.loaders.nth(k)).result == CALL_PENDING)
  action readWith(choice: int): bool = all {
    RemoteIO::holdsRead(s, choice),
    input' = { name: "releaseRead", choice: choice },
    s' = Shadow::settleRead(s, LAYOUT, choice, false, Recovery::NONE)
  }
  action releaseRead = {
    nondet choice = heldReads.oneOf()
    readWith(choice)
  }
  action loadWith(choice: int): bool = all {
    RemoteIO::holdsLoad(s, choice),
    input' = { name: "releaseLoad", choice: choice },
    s' = Shadow::settleLoad(s, LAYOUT, choice, false, READ_BUDGET_MS, SHADOWING)
  }
  action releaseLoad = {
    nondet choice = heldLoads.oneOf()
    loadWith(choice)
  }
  action resolveWith(choice: int): bool = all {
    (1.to(MAX_RESOLVE_CHOICE).filter(code => pendingLoaders.contains(resolvedSource(code)))).contains(choice),
    input' = { name: "resolveLoader", choice: choice },
    s' = Shadow::settleLoader(s, LAYOUT, resolvedSource(choice), resolvedValue(choice), false)
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_RESOLVE_CHOICE).filter(code => pendingLoaders.contains(resolvedSource(code))).oneOf()
    resolveWith(choice)
  }
  action rejectWith(choice: int): bool = all {
    pendingLoaders.contains(choice),
    input' = { name: "rejectLoader", choice: choice },
    s' = Shadow::settleLoader(s, LAYOUT, choice, SOURCE_ERROR, false)
  }
  action rejectLoader = {
    nondet choice = pendingLoaders.oneOf()
    rejectWith(choice)
  }

  // -- External time, policy, and remote replacement ------------------------------

  action advanceBy(choice: int): bool = all {
    (Set(1, SHADOW_TIMEOUT_MS)).contains(choice),
    input' = { name: "advance", choice: choice },
    // Stay below read deadlines and Redis expiry even in longer explorations.
    all {
      s.now + choice <= MAX_ELAPSED_MS,
      s' = Shadow::advance(s, choice)
    }
  }
  action advance = {
    nondet choice = Set(1, SHADOW_TIMEOUT_MS).oneOf()
    advanceBy(choice)
  }
  action policyWith(choice: int): bool = all {
    (POLICY_DEFAULT.to(POLICY_NO_SHADOW_OR_COALESCING)).contains(choice),
    input' = { name: "policy", choice: choice },
    s' = { coalesce: coalesces(choice), shadowSelected: selects(choice), ...s }
  }
  action policy = {
    nondet choice = POLICY_DEFAULT.to(POLICY_NO_SHADOW_OR_COALESCING).oneOf()
    policyWith(choice)
  }
  action seedWith(choice: int): bool = all {
    (0.to(MAX_IDENTITY_CHOICE)).contains(choice),
    input' = { name: "seed", choice: choice },
    s' = Remote::seedFrame(s, choice / 2, choice % 2 + VALUE_ONE, REMOTE_TTL_MS)
  }
  action seed = {
    nondet choice = 0.to(MAX_IDENTITY_CHOICE).oneOf()
    seedWith(choice)
  }

  // -- Exploration schedule (nesting/order preserve sampling weights) ---------

  action step = any {
    beginCall,
    releaseRead,
    releaseLoad,
    any {
      resolveLoader,
      rejectLoader
    },
    any {
      advance,
      policy,
      seed
    }
  }

  // -- Independently stated safety properties over the library records --------

  // This served-job shape delivers job budgets, not remote-read deadlines.
  val elapsedStaysBelowReadDeadlines = s.now < READ_BUDGET_MS

  // Job budgets are positive and advances deliver every due timeout before
  // observation. Work admitted later must not inherit elapsed clock uptime.
  val pendingDeadlinesAreFuture = s.deadlines.indices().forall(i => s.deadlines.nth(i).at > s.now)

  // A job's identity is its source's (instance, key); the registry is
  // pending-only, so every record is a live job.
  def jobInstance(i: int): int = s.sources.nth(s.jobs.nth(i).source).instance
  def jobKey(i: int): int = s.sources.nth(s.jobs.nth(i).source).key
  val capacityIsPerInstance = 0.to(INSTANCES - 1).forall(instance =>
    s.jobs.indices().filter(i => jobInstance(i) == instance).size() <= JOB_CAPACITY)
  val oneJobPerIdentity = s.jobs.indices().forall(i => s.jobs.indices().forall(j =>
    i == j or jobInstance(i) != jobInstance(j) or jobKey(i) != jobKey(j)))
  // A flight registered for an identity is a shared, pending flight for it
  // (the former registeredCallsArePending over the process registry).
  val registeredFlightsArePending = s.processFlights.indices().forall(identity => {
    val flight = s.processFlights.nth(identity)
    flight < 0 or (s.sources.nth(flight).result == CALL_PENDING and s.sources.nth(flight).shared
      and s.sources.nth(flight).instance * KEYS + s.sources.nth(flight).key == identity)
  })
  // Every caller owns a flight and holds its recorded result: pending while
  // the flight is, the decoded hit once it completes.
  val callsKeepAcquiredValue = s.owners.indices().forall(c =>
    s.owners.nth(c) >= 0 and s.o.calls.nth(c) == s.sources.nth(s.owners.nth(c)).result)
  val jobsAreDiagnostic = s.o.writes == 0 and s.o.dumps == 0
    and s.o.sourceScopes.indices().forall(i => not(s.o.sourceScopes.nth(i)))
  // Every loader runs a detached source no caller owns (only shadow jobs
  // invoke sources), every registered job runs over a loader's flight and
  // every pending loader flight has its job (a served job keeps its record
  // until its detached source settles); every held effect is one the drivers
  // dispatched; every read counted was budgeted on the io channel (the former
  // effectsMatchRecords over pending-only records and the append-only read
  // budgets: only the decode count has no such twin).
  val effectsMatchRecords = s.o.loaders == s.loaders.length()
    and s.loaders.indices().forall(k => s.owners.indices().forall(c => s.owners.nth(c) != s.loaders.nth(k)))
    and s.jobs.indices().forall(i => s.loaders.indices().exists(k => s.loaders.nth(k) == s.jobs.nth(i).source))
    and s.loaders.indices().forall(k => s.sources.nth(s.loaders.nth(k)).result != CALL_PENDING or Shadow::holdsJob(s, s.loaders.nth(k)))
    and s.reads.indices().forall(i => s.reads.nth(i).read < s.o.reads)
    and s.loads.indices().forall(i => s.loads.nth(i).load < s.o.loads)
    and s.io.budgets.length() == s.o.reads
  // A captured selection belongs to a pending flight whose read or decode is
  // still held: it is consulted when that effect settles and never outlives it.
  val selectionsAwaitTheirHit = s.selected.indices().forall(i => {
    val flight = s.selected.nth(i)
    s.sources.nth(flight).result == CALL_PENDING
      and (s.reads.indices().exists(j => s.reads.nth(j).flight == flight) or s.loads.indices().exists(j => s.loads.nth(j).flight == flight))
  })
  // Every pending deadline is a registered job's whose budget has not
  // expired (keyed by the job's source), and every such job has exactly one.
  val jobBudgetsBelongToLiveJobs = s.deadlines.indices().forall(i => {
    val due = s.deadlines.nth(i)
    due.kind == Deadlines::JOB and Shadow::holdsJob(s, due.index) and not(Shadow::jobOf(s, due.index).timedOut)
  }) and s.jobs.indices().forall(i => s.jobs.nth(i).timedOut
    or Deadlines::deadlinesOf(s, Deadlines::JOB, s.jobs.nth(i).source).length() == 1)

  // -- Deterministic regression schedules ------------------------------------

  run coalescedHitAdmitsOneJobTest = init
    .then(beginWith(0))
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.reads == 1 and s.o.shadow == List())

  // A served hit starts a detached job after the clock has already advanced.
  // A source rejection one millisecond later is still its own source error,
  // not a timeout; the caller keeps the value it acquired from the cache.
  run laterServedShadowKeepsItsWholeBudgetTest = init
    .then(advanceBy(SHADOW_TIMEOUT_MS)).then(beginWith(0)).then(readWith(0)).then(loadWith(0))
    .then(advanceBy(1)).then(rejectWith(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 1 and s.o.loads == 1
      and s.o.shadow == List("source_error"))

  run duplicateDropsBeforeCapacityIsFullTest = init
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .then(beginWith(0))
    .then(readWith(1))
    .then(loadWith(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.shadow == List("dropped"))

  run timeoutRetainsSourceCapacityTest = init
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .then(advanceBy(SHADOW_TIMEOUT_MS))
    .expect(s.jobs.length() == 1 and s.jobs.nth(0).timedOut and s.o.shadow == List("timeout"))
    // A later caller still receives its cache hit, but its duplicate job drops
    // while the timed-out source owns the slot. Settlement permits admission.
    .then(beginWith(0)).then(readWith(1)).then(loadWith(1))
    .expect(s.o.loaders == 1 and s.o.shadow == List("timeout", "dropped"))
    .then(resolveWith(2))
    .expect(s.jobs == List())
    .then(beginWith(0)).then(readWith(2)).then(loadWith(2))
    .expect(s.o.loaders == 2 and s.o.loads == 3 and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.shadow == List("timeout", "dropped"))

  run timeoutRetainsDecodeCapacityTest = init
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .then(resolveWith(2))
    .then(advanceBy(SHADOW_TIMEOUT_MS))
    .expect(s.jobs.length() == 1 and s.jobs.nth(0).timedOut)
    .then(beginWith(0)).then(readWith(1)).then(loadWith(2))
    .expect(s.o.loaders == 1 and s.o.shadow == List("timeout", "dropped"))
    .then(loadWith(1))
    .expect(s.jobs == List() and s.o.reads == 2)
    .then(beginWith(0)).then(readWith(2)).then(loadWith(3))
    .expect(s.o.loaders == 2 and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.shadow == List("timeout", "dropped"))

  run timeoutRetainsConfirmationCapacityTest = init
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .then(resolveWith(2))
    .then(loadWith(1))
    .then(advanceBy(SHADOW_TIMEOUT_MS))
    .expect(s.jobs.length() == 1 and s.jobs.nth(0).timedOut)
    .then(beginWith(0)).then(readWith(2)).then(loadWith(2))
    .expect(s.o.loaders == 1 and s.o.shadow == List("timeout", "dropped"))
    .then(readWith(1))
    .expect(s.jobs == List())
    .then(beginWith(0)).then(readWith(3)).then(loadWith(3))
    .expect(s.o.loaders == 2 and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.shadow == List("timeout", "dropped"))

  run fullInstanceDoesNotBlockOtherInstanceTest = init
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .then(beginWith(1))
    .then(readWith(1))
    .then(loadWith(1))
    .then(beginWith(2))
    .then(readWith(2))
    .then(loadWith(2))
    .expect(s.o.loaders == 2 and s.o.shadow == List("dropped"))
    .then(beginWith(3))
    .then(readWith(3))
    .then(loadWith(3))
    .expect(s.o.loaders == 3 and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.shadow == List("dropped"))

  // The cohort selection a caller's reply resolved is captured when its read
  // is dispatched and consulted when its decode completes the hit (C18): a
  // policy change in between neither revokes an admission nor grants one.
  run capturedShadowPolicySurvivesPolicyChangeTest = init
    .then(beginWith(0)).then(policyWith(POLICY_NO_SHADOW)).then(readWith(0)).then(loadWith(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 1 and s.o.shadow == List())
    .then(beginWith(1)).then(policyWith(POLICY_DEFAULT)).then(readWith(1)).then(loadWith(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.shadow == List())

  // A caller whose reply turns coalescing off starts its own read beside the
  // registered leader (C13) and its hit is judged first: its job is admitted,
  // and the leader's later hit finds a live job for the identity and drops.
  run uncoalescedCallerReadsAloneTest = init
    .then(beginWith(0)).then(policyWith(POLICY_NO_COALESCING)).then(beginWith(0))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.reads == 2 and s.o.policyCalls == 2)
    .then(readWith(1)).then(loadWith(0))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_ONE) and s.o.loaders == 1 and s.o.shadow == List())
    .then(readWith(0)).then(loadWith(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.shadow == List("dropped"))
}

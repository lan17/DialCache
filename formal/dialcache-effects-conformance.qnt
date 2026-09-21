module dialcache_effects_conformance {
  import cache_rules.* from "./cache-rules"
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import remote_writes as Writes from "./kernel/remote-writes"
  import recovery as Recovery from "./kernel/recovery"
  import deadlines as Deadlines from "./kernel/deadlines"
  import diagnostics as Diagnostics from "./kernel/diagnostics"
  import adapter_replies as Replies from "./kernel/adapter-replies"
  import metrics as Metrics from "./kernel/metrics"
  import remote_frames as Remote from "./kernel/remote-frames"
  import flights as Flights from "./kernel/flights"
  import clock as Clock from "./kernel/clock"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Model boundary -----------------------------------------------------------
  // One registered remote-only execution, plus up to eight callers and late
  // external sources/reads. Selected aspects of C23-C28 cover budgets and
  // accepted publication; C33-C36 cover fences/snapshots; C55-C59 cover effects.
  // See BEHAVIOR.md: "Generated pending-effect profile" for the driver mapping.
  // No local storage, recovery, shadow work, or physical expiry participates.
  // Every rule is a kernel transition (formal/kernel): the held remote
  // traversal (remote_io) under the budgeted held lifecycle (deadlines) with
  // its refills held (remote_writes), the queued adapter reply
  // (adapter_replies), the diagnosed channel (diagnostics) and the metric
  // events the drivers compare (metrics); the frames a seed stores
  // (remote_frames); the wall rollback (clock). This module owns the bounded
  // state, the fixture decoding (the read budget a fixture mode or a runtime
  // choice names), the input choices and the guards. `now` is elapsed time;
  // the wall clock is `now` plus a skew a rollback shifts. Adapter effects are
  // environmental settlements, not language executor turns.

  // Trace encodings and fixture bounds ---------------------------------------
  // Keep integer input fields stable; shared caller results come from the import.
  pure val SOURCE_BUDGET_MS = 10
  pure val CLOCK_STEP_MS = 10
  pure val WALL_ROLLBACK_MS = 1000
  pure val FUTURE_BUFFER_MS = 20
  pure val REMOTE_TTL_MS = 60000
  pure val INITIAL_NOW_MS = 10000
  pure val WALL_SKEW_MS = 90000
  pure val PAYLOAD_BYTES = 1
  pure val MAX_CALLS = 8
  pure val KEY = 0
  pure val ENTITY = 0

  // Initial read-budget precedence fixtures; values are recorded input choices.
  pure val FIXTURE_LIBRARY_BUDGET = 0
  pure val FIXTURE_INSTANCE_BUDGET = 1
  pure val FIXTURE_OPERATION_BUDGET = 2
  pure val FIXTURE_RUNTIME_BUDGET = 3
  pure val FIXTURE_NULL_PROVIDER = 4
  pure val FIXTURE_UNTRACKED = 5

  // One key on one instance, no request scope, no local capacity, one
  // operation per entity; the drivers never probe a source's scope.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true
  }
  pure val CALL: Call = { instance: 0, key: KEY, context: 0, enabled: true, keyFailed: false }
  // Every reply enables the remote layer alone and coalesces.
  pure val REMOTE_SHARED: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: true }
  // The TTLs every reply carries: no local TTL, the 60 s remote TTL as freshness and retention.
  pure val TTLS: Ttls = { localMs: 0, freshMs: REMOTE_TTL_MS, retentionMs: REMOTE_TTL_MS }

  // Input decoding (reads no state) ------------------------------------------
  // The read budget a fixture mode resolves to (library 50, instance 20,
  // operation 10, runtime 30, null provider 10, untracked 10), the base a
  // runtime reset inherits, and the runtime budgets of readBudgetPolicy 1..4.
  pure def readBudgetOf(mode: int): int = List(50, 20, 10, 30, 10, 10).nth(mode)
  pure def baseReadBudgetOf(mode: int): int =
    if (mode == FIXTURE_LIBRARY_BUDGET) 50 else if (mode == FIXTURE_INSTANCE_BUDGET) 20 else 10
  pure def runtimeBudgetOf(choice: int): int = List(0, 10, 20, 30, 50).nth(choice)

  // State: the layered shape with its held remote effects and refills, the
  // deadlines and the metered instants, the three driver channels (o, io,
  // events) and the diagnosed channel (d), the queued reply, the read budget
  // in force and the fixture's base.
  type State = {
    o: Observation, d: Diagnostics, io: RemoteIO::IO, events: List[Metrics::Event],
    now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    sourceBudget: int, deadlines: List[Deadlines::Due], drained: List[bool], sourceLayers: List[str],
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite],
    reply: int, replyAt: int,
    readStarted: List[int], decodeStarted: List[int], sourceStarted: List[int], dumpStarted: List[int],
    readBudget: int, baseReadBudget: int
  }
  var s: State
  var input: { name: str, choice: int }

  // Initial fixture: nothing stored, the zero watermark, the fixture's read budget.
  pure def initial(mode: int): State = {
    o: empty, d: noDiagnostics, io: RemoteIO::NO_IO, events: List(),
    now: INITIAL_NOW_MS, skew: WALL_SKEW_MS, remoteAvailable: true, tracked: mode != FIXTURE_UNTRACKED, capacity: 0,
    readFailed: false, dumpFailed: false, writeFailed: false,
    closed: List(), memo: List(), requestFlights: List(), processFlights: List(NO_OWNER),
    localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
    remoteValues: List(NO_VALUE), created: List(0), expires: List(0), watermark: List(0),
    sources: List(), owners: List(), memoSlots: List(), held: List(),
    reads: List(), loads: List(), loaders: List(), retained: List(),
    sourceBudget: SOURCE_BUDGET_MS, deadlines: List(), drained: List(), sourceLayers: List(),
    dumps: List(), writes: List(),
    reply: Replies::NO_REPLY, replyAt: 0,
    readStarted: List(), decodeStarted: List(), sourceStarted: List(), dumpStarted: List(),
    readBudget: readBudgetOf(mode), baseReadBudget: baseReadBudgetOf(mode)
  }
  action initialized(mode: int): bool = all {
    (FIXTURE_LIBRARY_BUDGET.to(FIXTURE_UNTRACKED)).contains(mode),
    input' = { name: "init", choice: mode }, s' = initial(mode)
  }
  action init = {
    nondet choice = FIXTURE_LIBRARY_BUDGET.to(FIXTURE_UNTRACKED).oneOf()
    initialized(choice)
  }

  // Guards (may read state) ---------------------------------------------------
  val heldReads = s.reads.indices().map(i => s.reads.nth(i).read)
  val unsettledLoaders = s.loaders.indices().filter(i => Deadlines::pending(s, i))
  val owningReads = s.reads.select(held => RemoteIO::owning(held))
  // A clock observation without timer delivery is generated during a 10 ms
  // read or outside any read; larger reads use delivered timer steps.
  val tenMillisecondReadOrNone = owningReads.indices().forall(i => s.io.budgets.nth(owningReads.nth(i).read) == 10)

  // Call admission: the read is dispatched under the budget in force, or the
  // caller joins the registered flight. --------------------------------------
  action beginCall = all {
    input' = { name: "beginCall", choice: -1 },
    s.o.calls.length() < MAX_CALLS,
    s' = Metrics::begin(s, LAYOUT, CALL, REMOTE_SHARED, TTLS, s.readBudget)
  }

  // External settlement by explicit read index; the latest decode, dump and
  // write; the loader by its ordinal. -------------------------------------------
  action readAt(index: int): bool = all {
    RemoteIO::holdsRead(s, index),
    input' = { name: "releaseRead", choice: index },
    s' = Metrics::settleRead(s, LAYOUT, index, false, Recovery::NONE, FUTURE_BUFFER_MS)
  }
  action releaseRead = {
    nondet choice = heldReads.oneOf()
    readAt(choice)
  }
  action failReadAt(index: int): bool = all {
    RemoteIO::holdsRead(s, index),
    input' = { name: "failRead", choice: index },
    s' = Metrics::settleRead(s, LAYOUT, index, true, Recovery::NONE, FUTURE_BUFFER_MS)
  }
  action failRead = {
    nondet choice = heldReads.oneOf()
    failReadAt(choice)
  }
  action releaseLoad = all {
    input' = { name: "releaseLoad", choice: -1 },
    s.loads.length() > 0,
    s' = Metrics::settleLoad(s, LAYOUT, RemoteIO::latestLoad(s).load, false)
  }
  action failLoad = all {
    input' = { name: "failLoad", choice: -1 },
    s.loads.length() > 0,
    s' = Metrics::settleLoad(s, LAYOUT, RemoteIO::latestLoad(s).load, true)
  }
  action resolveAt(index: int): bool = all {
    index < s.loaders.length(),
    Deadlines::pending(s, index),
    input' = { name: "resolveLoader", choice: index },
    s' = Metrics::settleLoader(s, LAYOUT, index, VALUE_ONE, false)
  }
  action resolveLoader = {
    nondet choice = unsettledLoaders.oneOf()
    resolveAt(choice)
  }
  action rejectAt(index: int): bool = all {
    index < s.loaders.length(),
    Deadlines::pending(s, index),
    input' = { name: "rejectLoader", choice: index },
    s' = Metrics::settleLoader(s, LAYOUT, index, SOURCE_ERROR, false)
  }
  action rejectLoader = {
    nondet choice = unsettledLoaders.oneOf()
    rejectAt(choice)
  }
  action releaseDump = all {
    input' = { name: "releaseDump", choice: -1 },
    s.dumps.length() > 0,
    s' = Metrics::releaseDump(s, LAYOUT, Writes::latestDump(s).dump, false, PAYLOAD_BYTES)
  }
  action failDump = all {
    input' = { name: "failDump", choice: -1 },
    s.dumps.length() > 0,
    s' = Metrics::releaseDump(s, LAYOUT, Writes::latestDump(s).dump, true, PAYLOAD_BYTES)
  }
  action releaseWrite = all {
    input' = { name: "releaseWrite", choice: -1 },
    s.writes.length() > 0,
    s' = Metrics::releaseWrite(s, LAYOUT, Writes::latestWrite(s).write, false)
  }
  action failWrite = all {
    input' = { name: "failWrite", choice: -1 },
    s.writes.length() > 0,
    s' = Metrics::releaseWrite(s, LAYOUT, Writes::latestWrite(s).write, true)
  }

  // Environmental clock, storage, policy, and failure inputs ------------------
  action tick = all {
    input' = { name: "tick", choice: -1 },
    s' = Metrics::advance(s, LAYOUT, CLOCK_STEP_MS)
  }
  // Clock observation without timer delivery also exercises settlement guards.
  action jumpClock = all {
    input' = { name: "jumpClock", choice: -1 },
    tenMillisecondReadOrNone,
    s' = Clock::advance(s, CLOCK_STEP_MS)
  }
  action rollbackWall = all {
    input' = { name: "rollbackWall", choice: -1 },
    s' = Clock::shiftWall(s, -WALL_ROLLBACK_MS)
  }
  action seedRemote = all {
    input' = { name: "seedRemote", choice: -1 },
    s' = Remote::seedFrame(s, KEY, VALUE_ONE, REMOTE_TTL_MS)
  }
  action invalidate = all {
    input' = { name: "invalidate", choice: -1 },
    s' = Metrics::invalidate(s, ENTITY, 0)
  }
  action futureFence = all {
    input' = { name: "futureFence", choice: -1 },
    s' = Metrics::invalidate(s, ENTITY, FUTURE_BUFFER_MS)
  }
  // One queued external reply, consumed by the next successfully settled raw read,
  // including abandoned reads. A second cannot be queued until the first is consumed.
  action replyWith(code: int): bool = all {
    (1.to(16)).contains(code),
    input' = { name: "adapterReply", choice: code },
    not(Replies::queued(s)),
    s' = Replies::queue(s, code)
  }
  action adapterReply = {
    nondet choice = 1.to(16).oneOf()
    replyWith(choice)
  }
  // Choice zero inherits the fixture's resolved base; 1..4 override it: two
  // wrappers guarded on the input alone.
  action inheritReadBudget = all {
    input' = { name: "readBudgetPolicy", choice: 0 },
    s' = { readBudget: s.baseReadBudget, ...s }
  }
  action overrideReadBudgetWith(choice: int): bool = all {
    (1.to(4)).contains(choice),
    input' = { name: "readBudgetPolicy", choice: choice },
    s' = { readBudget: runtimeBudgetOf(choice), ...s }
  }
  action readBudgetPolicy = {
    nondet choice = 0.to(4).oneOf()
    any { all { choice == 0, inheritReadBudget }, overrideReadBudgetWith(choice) }
  }
  // The observer fault is the drivers' fixture fault (C30): it changes no
  // cache rule, so the model records the input and nothing else.
  action observerFaultWith(code: int): bool = all {
    (Set(0, 1)).contains(code),
    input' = { name: "observerFault", choice: code }, s' = s
  }
  action observerFault = {
    nondet choice = Set(0, 1).oneOf()
    observerFaultWith(choice)
  }

  // Exploration schedule: preserve grouping and order for seeded sampling.
  action step = any {
    beginCall,
    any { releaseRead, releaseLoad, resolveLoader, releaseDump, releaseWrite },
    any { failRead, failLoad, rejectLoader, failDump, failWrite },
    // Favor the narrow second-fence check as well as unrestricted clock changes.
    all { s.dumps.length() > 0 and Writes::latestDump(s).fence > NO_FENCE, rollbackWall },
    any {
      tick, jumpClock, seedRemote,
      any { rollbackWall, invalidate, futureFence, observerFault, readBudgetPolicy, adapterReply }
    }
  }

  // Invariants: independent checks over the public channels and the library records.
  // Over the public channels, verbatim from the former text.
  val oneRequestPerRead = s.events.select(e => e.event == "request").length() == s.o.reads
  val measurementsAreNonnegative = s.events.select(e => e.amount < 0).length() == 0
  val futureOffsetsArePositiveAtObservingLayer = s.events.indices().forall(i => {
    val event = s.events.nth(i)
    event.event != "futureOffset" or (event.location == "remote" and event.amount > 0)
  })
  // Every loader whose flight's outcome is recorded reported one source duration.
  val oneSourceDurationPerSettlement = s.events.select(e => e.event == "fallback").length() ==
    s.loaders.indices().filter(k => s.sources.nth(s.loaders.nth(k)).result != CALL_PENDING).size()
  // Over the library records, one step from the former text.
  // The environment restriction stated: one flight is pending at a time, and
  // at most one loader runs for it (undelivered work whose flight's result is pending).
  val oneRegisteredSource = s.sources.select(source => source.result == CALL_PENDING).length() <= 1 and
    s.loaders.indices().filter(k => Deadlines::pending(s, k) and s.sources.nth(s.loaders.nth(k)).result == CALL_PENDING).size() <= 1
  // A registered flight owns a pending caller (the former phase != IDLE).
  val registeredFlightHasPendingCalls = s.processFlights.nth(0) == NO_OWNER or
    s.o.calls.indices().exists(c => s.owners.nth(c) == s.processFlights.nth(0) and s.o.calls.nth(c) == CALL_PENDING)
  // At most one read owns its traversal, and its flight is pending.
  val registeredReadOwnsFlight = owningReads.length() <= 1 and
    owningReads.indices().forall(i => s.sources.nth(owningReads.nth(i).flight).result == CALL_PENDING)
  // The drivers' effect counts are the library records: a budget row per read,
  // an ordinal and a history row per loader, an instant per flight.
  val effectCountsMatchRecords = s.o.reads == s.io.budgets.length() and s.o.loaders == s.loaders.length() and
    s.loaders.length() == s.sourceStarted.length() and s.sources.length() == s.readStarted.length() and
    s.o.loads == s.decodeStarted.length() and s.o.dumps == s.dumpStarted.length()
  // Every held dump or write serializes an accepted result of a flight that
  // captured a retention, and a held dump's fence was cleared by the wall
  // clock the first fence check sampled (the former writeRequiresAcceptedSource).
  val writeRequiresAcceptedSource = s.dumps.indices().forall(i => {
    val source = s.sources.nth(s.dumps.nth(i).source)
    accepted(source.result) and source.retentionMs > 0 and
      (s.dumps.nth(i).fence == NO_FENCE or fenceAllows(s.dumps.nth(i).sampled, s.dumps.nth(i).fence))
  }) and s.writes.indices().forall(i => {
    val source = s.sources.nth(s.writes.nth(i).source)
    accepted(source.result) and source.retentionMs > 0
  })
  // A loader whose result this step accepted settled inside its budget: the
  // source duration it reported (the latest event, `fallback`) is below the
  // budget (the former acceptedAt < deadline; a late result is a deadline
  // error and a drained one accepts nothing).
  val acceptedSourcesSettledBeforeTheirDeadline = input.name != "resolveLoader" or
    not(accepted(s.sources.nth(s.loaders.nth(input.choice)).result)) or Deadlines::pending(s, input.choice) or {
      val latest = s.events.nth(s.events.length() - 1)
      latest.event == "fallback" and latest.amount < s.sourceBudget
    }

  // Deterministic model regressions ------------------------------------------
  // The former text patched a queued reply or the read budget into private
  // state in five runs; each patch is now the input that produces it
  // (replyWith, overrideReadBudgetWith), so every run is public.
  action tenMillisecondFixture = initialized(FIXTURE_OPERATION_BUDGET)
  def missReasons = s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail))
  def errorReasons = s.events.select(e => e.event == "error").foldl(List(), (out, e) => out.append(e.detail))
  def amounts(name: str): List[int] = s.events.select(e => e.event == name).foldl(List(), (out, e) => out.append(e.amount))
  def latestSource = s.sources.nth(Flights::latest(s))
  def readable = Remote::observe(s, KEY, 1, REMOTE_TTL_MS, false).value > NO_VALUE

  run unknownReasonKeepsValidFenceTest = tenMillisecondFixture.then(beginCall)
    .then(replyWith(Replies::UNKNOWN_REASON_WITH_FENCE)).then(readAt(0)).then(resolveAt(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and missReasons.nth(0) == "unclassified")
  run untrackedReplyCannotCarryFenceTest = initialized(FIXTURE_UNTRACKED).then(beginCall)
    .then(replyWith(Replies::FENCED_WITH_FENCE)).then(readAt(0)).then(resolveAt(0))
    .expect(s.o.dumps == 1 and latestSource.fence == NO_FENCE and missReasons.nth(0) == "unclassified")
  run missDiscriminatorWinsOverFrameFieldsTest = tenMillisecondFixture.then(beginCall)
    .then(replyWith(Replies::MISS_WITH_FRAME_FIELDS)).then(readAt(0))
    .expect(s.o.loads == 0 and s.o.loaders == 1)
  run frameWithoutMissDiscriminatorIgnoresMetadataTest = tenMillisecondFixture.then(beginCall)
    .then(replyWith(Replies::FRAME_WITH_MISS_FIELDS)).then(readAt(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0)
  run readDurationIncludesDecodeTest = tenMillisecondFixture.then(seedRemote).then(beginCall).then(readAt(0))
    .then(tick).then(releaseLoad)
    .expect(amounts("get") == List(10))
  run sourceDurationExcludesPublicationTest = tenMillisecondFixture.then(beginCall).then(readAt(0)).then(resolveAt(0))
    .then(tick).then(releaseDump).then(tick).then(releaseWrite)
    .expect(amounts("fallback") == List(0) and amounts("serialization") == List(10))
  run lateSourceCannotRepeatFailureMetricTest = tenMillisecondFixture.then(beginCall).then(readAt(0))
    .then(tick).then(rejectAt(0)).expect(s.events.select(e => e.event == "error" and e.detail == "fallback").length() == 1)
  run timedOutLoaderOverlapsNewFlightTest = tenMillisecondFixture.then(beginCall).then(readAt(0)).then(tick)
    .then(beginCall).then(readAt(1))
    .expect(s.sources.nth(0).result == DEADLINE_ERROR and s.sources.nth(1).result == CALL_PENDING
      and s.drained == List(false, false) and s.o.calls == List(DEADLINE_ERROR, CALL_PENDING))
  run acceptedWriteOutlivesDeadlineTest = tenMillisecondFixture.then(beginCall).then(readAt(0)).then(resolveAt(0))
    .then(tick).then(releaseDump).then(tick).expect(s.writes.length() == 1 and s.o.calls == List(CALL_PENDING))
    .then(releaseWrite).expect(s.o.calls == List(VALUE_ONE))
  run delayedWriteRemainsFencedTest = tenMillisecondFixture.then(beginCall).then(readAt(0)).then(resolveAt(0))
    .then(releaseDump).then(tick).then(invalidate).then(releaseWrite).then(beginCall).then(readAt(1))
    .expect(not(readable) and s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)
  run readTimeoutStartsIndependentSourceDeadlineTest = tenMillisecondFixture.then(beginCall).then(beginCall).then(tick)
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and Deadlines::deadlineOf(s, Deadlines::SOURCE, 0) == 10020 and s.io.aborted == List(0))
    .then(resolveAt(0)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0)
  run lateReadCannotBecomeHitTest = tenMillisecondFixture.then(seedRemote).then(beginCall).then(jumpClock).then(readAt(0))
    .expect(s.o.loads == 0 and s.o.loaders == 1 and s.io.aborted == List(0))
  run acquiredDecodeSurvivesInvalidationAndDeadlineTest = tenMillisecondFixture.then(seedRemote).then(beginCall)
    .then(readAt(0)).then(tick).then(invalidate).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0 and s.io.aborted == List())
  run readFailureNeverRefillsTest = tenMillisecondFixture.then(beginCall).then(failReadAt(0)).then(resolveAt(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.io.aborted == List())
  run decodeFailureMayRefillTest = tenMillisecondFixture.then(seedRemote).then(beginCall).then(readAt(0)).then(failLoad)
    .then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loads == 1 and s.o.writes == 1)
  run dumpFailurePreservesSourceTest = tenMillisecondFixture.then(beginCall).then(readAt(0)).then(resolveAt(0)).then(failDump)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.writes == 0)
  run writeFailurePreservesSourceTest = tenMillisecondFixture.then(beginCall).then(readAt(0)).then(resolveAt(0))
    .then(releaseDump).then(failWrite).expect(s.o.calls == List(VALUE_ONE) and s.remoteValues.nth(KEY) == NO_VALUE)
  run rollbackDuringDumpRechecksObservedFenceTest = tenMillisecondFixture.then(invalidate).then(tick)
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(rollbackWall).then(releaseDump)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 0)
  run rollbackDoesNotExtendSourceDeadlineTest = tenMillisecondFixture.then(beginCall).then(readAt(0))
    .then(rollbackWall).then(tick).expect(s.o.calls == List(DEADLINE_ERROR))
  run observerFailuresCannotReplaceSourceErrorTest = tenMillisecondFixture.then(observerFaultWith(1))
    .then(beginCall).then(failReadAt(0)).then(rejectAt(0)).expect(s.o.calls == List(SOURCE_ERROR))
  run libraryReadBudgetIsFiftyMillisecondsTest = initialized(FIXTURE_LIBRARY_BUDGET).then(beginCall)
    .then(tick).then(tick).then(tick).then(tick).expect(owningReads.length() == 1 and s.o.loaders == 0)
    .then(tick).expect(owningReads.length() == 0 and Deadlines::deadlineOf(s, Deadlines::SOURCE, 0) == 10060 and s.io.budgets == List(50))
  run followerKeepsAcceptedReadBudgetTest = initialized(FIXTURE_RUNTIME_BUDGET).then(beginCall)
    .then(overrideReadBudgetWith(1)).then(beginCall).then(tick).then(tick)
    .expect(owningReads.length() == 1 and s.io.budgets == List(30) and s.o.calls == List(CALL_PENDING, CALL_PENDING))
    .then(tick).expect(owningReads.length() == 0 and Deadlines::deadlineOf(s, Deadlines::SOURCE, 0) == 10040 and s.io.aborted == List(0))

  // Deadline acceptance is checked when raw work settles, even if timer
  // delivery has not run. Rejection must receive the same deadline treatment
  // as fulfillment, without being recategorized as an ordinary adapter error.
  run lateReadRejectionUsesDeadlineCategoryTest = tenMillisecondFixture
    .then(beginCall).then(jumpClock).then(failReadAt(0))
    .expect(s.io.aborted == List(0) and s.o.loaders == 1 and latestSource.retentionMs == 0 and
      errorReasons == List("cache_read_timeout"))
  // A source result arriving after its deadline is a deadline error, whether
  // it resolves or rejects; the reproducer of the deadlines challenge.
  run lateSourceResultIsADeadlineErrorTest = tenMillisecondFixture
    .then(beginCall).then(readAt(0)).then(jumpClock).then(resolveAt(0))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.dumps == 0 and errorReasons == List("fallback") and amounts("fallback") == List(10))

  run successfulReadClearsDeadlineBeforeDecodeTest = tenMillisecondFixture
    .then(seedRemote).then(beginCall).then(readAt(0)).then(tick).then(tick)
    .then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.io.aborted == List() and s.o.loaders == 0)

  // Each failure has its own diagnostic phase. The result and mutation
  // consequences are checked alongside the label; observing a label alone
  // would not establish fail-open behavior.
  run readFailureKeepsCategoryAndDeniesRefillTest = tenMillisecondFixture
    .then(beginCall).then(failReadAt(0)).then(resolveAt(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0 and errorReasons == List("cache_read"))

  run decodeFailureKeepsCategoryAndAllowsRefillTest = tenMillisecondFixture
    .then(seedRemote).then(beginCall).then(readAt(0)).then(failLoad)
    .then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.writes == 1 and errorReasons == List("serialization_load"))

  run dumpFailureKeepsCategoryAndSourceValueTest = tenMillisecondFixture
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(failDump)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.writes == 0 and errorReasons == List("serialization_dump"))

  run writeFailureKeepsCategoryAndSourceValueTest = tenMillisecondFixture
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(releaseDump).then(failWrite)
    .expect(s.o.calls == List(VALUE_ONE) and s.remoteValues.nth(KEY) == NO_VALUE and errorReasons == List("cache_write"))

  // Observer failure is an external callback condition. Its isolation preserves
  // traversal, public outcomes and accepted publication, not merely event count.
  run observerFailuresCannotPreventCacheHitTest = tenMillisecondFixture
    .then(observerFaultWith(1)).then(seedRemote)
    .then(beginCall).then(readAt(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0 and s.o.loads == 1 and s.o.writes == 0)
  run observerFailuresCannotPreventPublicationTest = tenMillisecondFixture
    .then(observerFaultWith(1)).then(beginCall).then(readAt(0))
    .then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 2 and s.o.loads == 1 and s.o.dumps == 1 and s.o.writes == 1)

  // Source acceptance precedes the native frame stamp. A serialization delay
  // and intervening invalidation make the distinction visible to the next read.
  run writeStampAfterSerializationClearsInterveningFenceTest = tenMillisecondFixture
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(invalidate)
    .then(tick).then(releaseDump).then(releaseWrite)
    .expect(s.created.nth(KEY) == 100010 and s.watermark.nth(ENTITY) == 100000 and s.o.writeTtls == List(REMOTE_TTL_MS))
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.loads == 1 and s.o.writes == 1)

  run instanceReadBudgetOverridesLibraryTest = initialized(FIXTURE_INSTANCE_BUDGET)
    .then(beginCall).then(tick).expect(s.o.calls == List(CALL_PENDING) and s.o.loaders == 0)
    .then(tick).then(resolveAt(0))
    .expect(s.io.budgets == List(20) and s.io.aborted == List(0)
      and s.o.calls == List(VALUE_ONE) and s.o.loaders == 1 and s.o.dumps == 0)
  run operationReadBudgetOverridesInstanceTest = initialized(FIXTURE_OPERATION_BUDGET)
    .then(beginCall).then(tick).then(resolveAt(0))
    .expect(s.io.budgets == List(10) and s.io.aborted == List(0)
      and s.o.calls == List(VALUE_ONE) and s.o.loaders == 1 and s.o.dumps == 0)
  run runtimeReadBudgetOverridesOperationTest = initialized(FIXTURE_RUNTIME_BUDGET)
    .then(beginCall).then(tick).then(tick).expect(s.o.calls == List(CALL_PENDING) and s.o.loaders == 0)
    .then(tick).then(resolveAt(0))
    .expect(s.io.budgets == List(30) and s.io.aborted == List(0)
      and s.o.calls == List(VALUE_ONE) and s.o.loaders == 1 and s.o.dumps == 0)

  // Amounts are model milliseconds, converted once to public seconds by both
  // projections. This is the serving remote location; shadow locations are a
  // separate interaction, not implied by this assertion.
  run futureFrameReportsPositiveObservingOffsetTest = tenMillisecondFixture
    .then(seedRemote).then(rollbackWall).then(beginCall).then(readAt(0)).then(rejectAt(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0 and s.o.loaders == 1
      and s.events.select(e => e.event == "futureOffset") ==
        List({ event: "futureOffset", location: "remote", detail: "", amount: 1000 }))

  run coalescedFailureKeepsOneLeaderAndFollowerTrailTest = tenMillisecondFixture
    .then(beginCall).then(beginCall).then(failReadAt(0)).then(rejectAt(0))
    .expect(s.o.calls == List(SOURCE_ERROR, SOURCE_ERROR)
      and s.o.reads == 1 and s.o.loaders == 1 and s.o.loads == 0 and s.o.writes == 0)
    .expect(s.events.select(e => e.event == "request" or e.event == "coalesced" or e.event == "error") == List(
      { event: "request", location: "remote", detail: "", amount: 0 },
      { event: "coalesced", location: "process", detail: "", amount: 0 },
      { event: "error", location: "remote", detail: "cache_read", amount: 0 },
      { event: "error", location: "remote", detail: "fallback", amount: 0 }))

  run nullReplyRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(1))
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 1
      and s.o.reads == 2 and s.o.dumps == 1 and s.o.writes == 1)
    .expect(missReasons == List("unclassified"))

  run primitiveReplyRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(2))
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 1
      and s.o.reads == 2 and s.o.dumps == 1 and s.o.writes == 1)
    .expect(missReasons == List("unclassified"))

  run legacyReplyRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(3))
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 1
      and s.o.reads == 2 and s.o.dumps == 1 and s.o.writes == 1)
    .expect(missReasons == List("unclassified"))

  run kindlessReplyRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(4))
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 1
      and s.o.reads == 2 and s.o.dumps == 1 and s.o.writes == 1)
    .expect(missReasons == List("unclassified"))

  run missingFenceRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(8))
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 1
      and s.o.reads == 2 and s.o.dumps == 1 and s.o.writes == 1)
    .expect(missReasons == List("unclassified"))

  run negativeFenceRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(9))
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 1
      and s.o.reads == 2 and s.o.dumps == 1 and s.o.writes == 1)
    .expect(missReasons == List("unclassified"))

  run fractionalFenceRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(Replies::FRACTIONAL_FENCE))
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 1
      and s.o.reads == 2 and s.o.dumps == 1 and s.o.writes == 1)
    .expect(missReasons == List("value_absent"))

  run unsafeFenceRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(Replies::UNSAFE_FENCE))
    .then(beginCall).then(readAt(0)).then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 1
      and s.o.reads == 2 and s.o.dumps == 1 and s.o.writes == 1)
    .expect(missReasons == List("value_absent"))

  // Untracked reads demote a fenced-miss reply to an ordinary miss. Observe the
  // consequence through publication and a later hit, using only public inputs.
  run untrackedFencedReplyRefillsAndIsReadableTest = initialized(FIXTURE_UNTRACKED)
    .then(replyWith(Replies::FENCED_WITH_FENCE)).then(beginCall).then(readAt(0))
    .then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.sources.nth(0).fence == NO_FENCE
      and s.o.loads == 1 and s.o.loaders == 1 and s.o.reads == 2 and s.o.dumps == 1 and s.o.writes == 1)
    .expect(missReasons == List("unclassified"))

  // An expired-reason reply with a zero fence keeps its miss cause but retains
  // no fence. One source refill is serialized and written; a later read hits it.
  run expiredZeroFenceReplyRefillsAndIsReadableTest = tenMillisecondFixture
    .then(replyWith(Replies::EXPIRED_ZERO_FENCE)).then(beginCall).then(readAt(0))
    .then(resolveAt(0)).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(readAt(1)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.sources.nth(0).fence == NO_FENCE
      and s.o.loads == 1 and s.o.loaders == 1 and s.o.reads == 2 and s.o.dumps == 1 and s.o.writes == 1)
    .expect(missReasons == List("expired"))

  // A valid future fence survives normalization even with an absent cause. The
  // accepted source is served but never serialized, so the next read misses again.
  run absentReplyWithFutureFenceBlocksRefillTest = tenMillisecondFixture
    .then(replyWith(Replies::ABSENT_WITH_FENCE)).then(beginCall).then(readAt(0))
    .expect(latestSource.fence == Clock::wallOf(s) + FUTURE_BUFFER_MS and latestSource.retentionMs > 0 and s.o.loaders == 1)
    .then(resolveAt(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0)
    .then(beginCall).then(readAt(1))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2
      and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
    .expect(missReasons == List("value_absent", "value_absent"))

  // Stop at the observable decision so both the clean and faulty implementation
  // can complete this boundary history without a later fault-dependent command.
  run fencedSourceSkipsSerializationTest = tenMillisecondFixture
    .then(replyWith(Replies::ABSENT_WITH_FENCE)).then(beginCall).then(readAt(0))
    .expect(latestSource.fence == Clock::wallOf(s) + FUTURE_BUFFER_MS and latestSource.retentionMs > 0 and s.o.loaders == 1)
    .then(resolveAt(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0)
}

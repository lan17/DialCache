module dialcache_shadow_conformance {
  import cache_rules.* from "./cache-rules"
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import remote_writes as Writes from "./kernel/remote-writes"
  import shadow as Shadow from "./kernel/shadow"
  import deadlines as Deadlines from "./kernel/deadlines"
  import diagnostics as Diagnostics from "./kernel/diagnostics"
  import recovery as Recovery from "./kernel/recovery"
  import remote_frames as Remote from "./kernel/remote-frames"
  import payloads as Payloads from "./kernel/payloads"
  import clock as Clock from "./kernel/clock"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Model boundary -----------------------------------------------------------
  // One ramped-down caller source and its selected dark C0/source/C1 job.
  // Selected rules from C47/C49-C54 govern admission, comparison, fill authority,
  // and timeout ownership; C57/C60 cover snapshot age and captured logging.
  // See BEHAVIOR.md: "Generated feature profiles" for fixtures and payloads.
  // Each source/read/decode/serialize/write can remain externally pending. This
  // profile excludes serving hits, request/local storage, and overlapping jobs.
  // `now` is elapsed milliseconds; the wall clock is `now` plus a skew the
  // rollback and the wall jump shift. C0 must be strictly younger than sixty
  // seconds. C1 checks payload bytes independently of logical age;
  // application time may change while it waits.
  // Every rule is a kernel transition (formal/kernel): the dark arm of the
  // held shadow lifecycle (shadow: the dark job's C0 read, decode and
  // confirmation read held in remote_io's lists and released by ordinal, the
  // comparator, the verdict age and the mismatch warning) over the diagnosed
  // budgeted held remote lifecycle (deadlines, remote_io, diagnostics: the
  // caller's source deadline and the layer its failure is attributed to), the
  // held fill (remote_writes), the frames a seed stores and the watermark an
  // invalidation raises with its future buffer (remote_frames, serving), the
  // wall skew (clock). This module owns the bounded state, the fixture
  // decoding (the comparator, its elapsed time and the source work an init
  // choice names; the hook and the default logging; the payload code a seed
  // choice names; the policy facts a runtime overlay sets), the input choices
  // and the guards.

  // Trace encodings and fixture bounds ---------------------------------------
  pure val COMPARATOR_COUNT = 4
  pure val FIRST_LOGGING_FIXTURE = 4
  pure val FIXTURE_NO_HOOK = 8
  pure val FIXTURE_SLOW_EQUAL = 9
  pure val FIXTURE_SLOW_ERROR = 10
  pure val FIXTURE_SOURCE_WORK_BEFORE_DEADLINE = 11
  pure val FIXTURE_SOURCE_WORK_AT_DEADLINE = 12
  pure val SHADOW_ENABLED = 0
  pure val SHADOW_DISABLED = 1
  pure val SHADOW_INVALID = 2
  pure val LOGGING_DISABLED = 0
  pure val LOGGING_ENABLED = 1
  pure val LOGGING_INVALID = 2
  pure val JOB_BUDGET_MS = 10
  pure val SOURCE_BUDGET_MS = 10
  pure val FRESHNESS_MS = 60000
  pure val SEED_RETENTION_MS = 60000
  pure val WALL_ROLLBACK_MS = 1000
  pure val INITIAL_NOW_MS = 10000
  pure val WALL_SKEW_MS = 90000
  pure val MAX_CALLS = 8
  pure val KEY = 0
  pure val ENTITY = 0
  // One key on one instance, no request scope, no local capacity, one
  // operation per entity; the drivers never probe a source's scope.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true
  }
  pure val CALL: Call = { instance: 0, key: KEY, context: 0, enabled: true, keyFailed: false }
  // The fixture's policy: a 60 s remote TTL with the serving ramp at 0, so the
  // caller uses no layer and the job reads the remote layer on its own account.
  pure val DARK: Resolution = { layers: { request: false, local: false, remote: false }, coalesce: false }
  pure val TTLS: Ttls = { localMs: 0, freshMs: FRESHNESS_MS, retentionMs: FRESHNESS_MS }

  // The eight payload representations as payload codes (payloads): the
  // drivers' text JSON `1`/`2` (seeds 1/2), their binary spellings (3/4), the
  // binary and text padded spellings of `1` (5/6), and the text and binary
  // spellings of a JSON string decoding to a value no source returns (7/8).
  // Payload identity is not decoded value identity: text and binary forms
  // share bytes, different bytes can decode to one value.
  pure val DECODED_UNICODE = 3
  pure val TEXT_ONE = VALUE_ONE
  pure val TEXT_TWO = VALUE_TWO
  pure val BINARY_ONE = Payloads::BINARY + VALUE_ONE
  pure val BINARY_TWO = Payloads::BINARY + VALUE_TWO
  pure val BINARY_PADDED_ONE = Payloads::BINARY + Payloads::PADDED + VALUE_ONE
  pure val TEXT_PADDED_ONE = Payloads::PADDED + VALUE_ONE
  pure val TEXT_UNICODE = Payloads::UNICODE + DECODED_UNICODE
  pure val BINARY_UNICODE = Payloads::BINARY + Payloads::UNICODE + DECODED_UNICODE

  // Shadow profile v3 retains explicit external inputs and future timestamp
  // samples as well as verdict age, captured logging, and configuration errors.
  type ShadowDiagnostics = {
    configErrors: int, warnings: int, ages: List[int],
    coalesced: List[str], fallbackErrors: List[str],
    futureOffsets: List[Diagnostics::FutureOffset]
  }

  // State: the layered shape with its held remote effects, deadlines, held
  // fills and jobs, the two driver channels (o, d), the io channel the held
  // shape carries, and the fixture's facts: the comparator, its elapsed time
  // and the source work the init choice names, the hook and the default
  // logging, and the shadow policy in force (the ramp selecting, the ramp
  // malformed, logging on, logging malformed), decoded once at each overlay.
  type State = {
    o: Observation, d: ShadowDiagnostics, io: RemoteIO::IO,
    now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool, loadFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    sourceBudget: int, deadlines: List[Deadlines::Due], drained: List[bool], sourceLayers: List[str],
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], jobs: List[Shadow::Job],
    comparator: int, comparisonMs: int, sourceWorkMs: int, hook: bool, defaultLog: bool,
    selected: bool, rampInvalid: bool, logging: bool, loggingInvalid: bool
  }
  var s: State
  var input: { name: str, choice: int }

  // Input decoding (reads no state) ------------------------------------------
  // Input fixtures: default/equal/unequal/error comparator, then the same four
  // with mismatch logging enabled; fixture 8 omits the outcome hook.
  // Fixtures 9/10 let successful/failing comparison consume the job budget.
  // Fixtures 11/12 consume 9/10 ms of synchronous external source work before
  // deferred job dispatch.
  pure def comparatorOf(choice: int): int =
    if (choice >= FIXTURE_SOURCE_WORK_BEFORE_DEADLINE) Shadow::COMPARE_VALUES
    else if (choice == FIXTURE_SLOW_ERROR) Shadow::COMPARE_ERROR else choice % COMPARATOR_COUNT
  pure def comparisonMsOf(choice: int): int = if (choice == FIXTURE_SLOW_EQUAL or choice == FIXTURE_SLOW_ERROR) JOB_BUDGET_MS else 0
  pure def sourceWorkOf(choice: int): int =
    if (choice == FIXTURE_SOURCE_WORK_AT_DEADLINE) JOB_BUDGET_MS
    else if (choice == FIXTURE_SOURCE_WORK_BEFORE_DEADLINE) JOB_BUDGET_MS - 1 else 0
  pure def hookOf(choice: int): bool = choice != FIXTURE_NO_HOOK
  pure def defaultLogOf(choice: int): bool = choice >= FIRST_LOGGING_FIXTURE and choice < FIXTURE_NO_HOOK
  // The payload a seed choice stores, and the choice naming the other form of
  // a stored payload (the drivers' `reencode`).
  pure def seedPayload(choice: int): int =
    List(NO_VALUE, TEXT_ONE, TEXT_TWO, BINARY_ONE, BINARY_TWO, BINARY_PADDED_ONE, TEXT_PADDED_ONE, TEXT_UNICODE, BINARY_UNICODE).nth(choice)
  pure def alternate(choice: int): int = List(0, 3, 4, 1, 2, 6, 5, 8, 7).nth(choice)
  pure def choiceOf(payload: int): int = 1.to(8).fold(0, (found, choice) => if (seedPayload(choice) == payload) choice else found)

  // Initial fixture: no frame, no watermark, empty storage, the ramp selecting,
  // logging as the fixture defaults it. Policy changes are captured at admission.
  pure def initialState(choice: int): State = {
    o: empty, d: { configErrors: 0, warnings: 0, ages: List(), coalesced: List(), fallbackErrors: List(), futureOffsets: List() },
    io: RemoteIO::NO_IO,
    now: INITIAL_NOW_MS, skew: WALL_SKEW_MS, remoteAvailable: true, tracked: true, capacity: 0,
    readFailed: false, dumpFailed: false, writeFailed: false, loadFailed: false,
    closed: List(), memo: List(), requestFlights: List(), processFlights: List(NO_OWNER),
    localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
    remoteValues: List(NO_VALUE), created: List(0), expires: List(0), watermark: List(0),
    sources: List(), owners: List(), memoSlots: List(), held: List(),
    reads: List(), loads: List(), loaders: List(), retained: List(),
    sourceBudget: SOURCE_BUDGET_MS, deadlines: List(), drained: List(), sourceLayers: List(),
    dumps: List(), writes: List(), jobs: List(),
    comparator: comparatorOf(choice), comparisonMs: comparisonMsOf(choice), sourceWorkMs: sourceWorkOf(choice),
    hook: hookOf(choice), defaultLog: defaultLogOf(choice),
    selected: true, rampInvalid: false, logging: defaultLogOf(choice), loggingInvalid: false
  }
  action initialize(choice: int): bool = all {
    input' = { name: "init", choice: choice },
    s' = initialState(choice)
  }
  action init = {
    nondet choice = 0.to(FIXTURE_SOURCE_WORK_AT_DEADLINE).oneOf()
    initialize(choice)
  }

  // Guards (may read state) ---------------------------------------------------
  // One caller at a time: the previous job has drained and the previous source
  // has settled (a source whose deadline was delivered stays pending until its
  // late result drains); the drivers settle the latest loader and release the
  // latest held read, decode, dump or write.
  val sourcePending = s.loaders.length() > 0 and Deadlines::pending(s, RemoteIO::latestOrdinal(s))

  // Caller source and job admission ------------------------------------------
  action beginCall = all {
    input' = { name: "beginCall", choice: -1 },
    s.jobs.length() == 0, not(sourcePending), s.o.calls.length() < MAX_CALLS,
    s' = Shadow::beginDark(s, LAYOUT, CALL, DARK, TTLS, Deadlines::UNBOUNDED,
      { hook: s.hook, selected: s.selected, capacity: 1, budgetMs: JOB_BUDGET_MS, logging: s.logging },
      { ramp: s.rampInvalid, logging: s.loggingInvalid }, s.sourceWorkMs)
  }
  action resolveAt(choice: int): bool = all {
    input' = { name: "resolveLoader", choice: choice },
    sourcePending,
    s' = Shadow::settleHeld(s, LAYOUT, RemoteIO::latestOrdinal(s), choice, false)
  }
  action resolveLoader = {
    nondet choice = Set(VALUE_ONE, VALUE_TWO).oneOf()
    resolveAt(choice)
  }
  action rejectLoader = all {
    input' = { name: "rejectLoader", choice: -1 },
    sourcePending,
    s' = Shadow::settleHeld(s, LAYOUT, RemoteIO::latestOrdinal(s), SOURCE_ERROR, false)
  }

  // C0 acquisition, retained comparison, C1 confirmation and the held fill ---
  action releaseRead = all {
    input' = { name: "releaseRead", choice: -1 },
    Shadow::latestRead(s) >= 0,
    s' = Shadow::releaseRead(s, LAYOUT, Shadow::latestRead(s), s.readFailed)
  }
  action releaseLoad = all {
    input' = { name: "releaseLoad", choice: -1 },
    Shadow::latestLoad(s) >= 0,
    s' = Shadow::releaseLoad(s, LAYOUT, Shadow::latestLoad(s), s.loadFailed, { comparator: s.comparator, elapsedMs: s.comparisonMs }, Deadlines::UNBOUNDED)
  }
  action releaseDump = all {
    input' = { name: "releaseDump", choice: -1 },
    s.dumps.length() > 0,
    s' = Shadow::releaseDump(s, LAYOUT, Writes::latestDump(s).dump, s.dumpFailed)
  }
  action releaseWrite = all {
    input' = { name: "releaseWrite", choice: -1 },
    s.writes.length() > 0,
    s' = Shadow::releaseWrite(s, LAYOUT, Writes::latestWrite(s).write, s.writeFailed)
  }

  // Environmental clocks, storage, policy, and failures -----------------------
  action advanceBy(choice: int): bool = all {
    input' = { name: "advance", choice: choice },
    s' = Shadow::advanceHeld(s, LAYOUT, choice)
  }
  action advance = {
    // Blocked-source fixtures advance a full job budget so due timers run.
    nondet choice = (if (s.sourceWorkMs > 0) Set(JOB_BUDGET_MS) else Set(1, JOB_BUDGET_MS)).oneOf()
    advanceBy(choice)
  }
  action seedAt(choice: int): bool = all {
    input' = { name: "seed", choice: choice },
    s' = Remote::seedFrame(s, KEY, seedPayload(choice), SEED_RETENTION_MS)
  }
  action seed = {
    nondet choice = 1.to(8).oneOf()
    seedAt(choice)
  }
  // A second external seed choice gives multibyte text/binary identities enough
  // exploration weight alongside the blocked-source fixtures. The ordinary
  // seed action still admits every payload representation.
  action seedUnicode = {
    nondet choice = Set(7, 8).oneOf()
    all {
      input' = { name: "seedUnicode", choice: choice },
      s' = Remote::seedFrame(s, KEY, seedPayload(choice), SEED_RETENTION_MS)
    }
  }
  // External replacement with identical bytes in the other supported form.
  // This targets confirmation's representation boundary, without fixing its outcome.
  action reencode = {
    nondet choice = Set(alternate(choiceOf(s.remoteValues.nth(KEY)))).oneOf()
    all {
      Shadow::confirming(s), s.remoteValues.nth(KEY) > NO_VALUE,
      input' = { name: "reencode", choice: choice },
      s' = Remote::seedFrame(s, KEY, seedPayload(choice), SEED_RETENTION_MS)
    }
  }
  action invalidateAt(choice: int): bool = all {
    input' = { name: "invalidate", choice: choice },
    s' = Serving::invalidate(s, ENTITY, choice)
  }
  action invalidate = {
    nondet choice = Set(0, 20).oneOf()
    invalidateAt(choice)
  }
  action rollbackWall = all {
    input' = { name: "rollbackWall", choice: -1 },
    s' = Clock::shiftWall(s, -WALL_ROLLBACK_MS)
  }
  // Application time is independent of elapsed deadline time and physical TTL.
  // Only an already acquired C0 may encounter this large forward change.
  action advanceWallBy(choice: int): bool = all {
    Shadow::confirming(s),
    input' = { name: "advanceWall", choice: choice },
    s' = Clock::shiftWall(s, choice)
  }
  action advanceWall = {
    nondet choice = Set(1, 60000).oneOf()
    advanceWallBy(choice)
  }
  // A runtime overlay replaces the previous one: a logging overlay leaves the
  // ramp at the fixture's 100, a ramp overlay leaves logging at the fixture's default.
  action setLogging(choice: int): bool = all {
    input' = { name: "logPolicy", choice: choice },
    s' = { logging: choice == LOGGING_ENABLED, loggingInvalid: choice == LOGGING_INVALID, selected: true, rampInvalid: false, ...s }
  }
  action logPolicy = {
    nondet choice = Set(LOGGING_DISABLED, LOGGING_ENABLED, LOGGING_INVALID).oneOf()
    setLogging(choice)
  }
  action shadowPolicyAt(choice: int): bool = all {
    input' = { name: "shadowPolicy", choice: choice },
    s' = { selected: choice == SHADOW_ENABLED, rampInvalid: choice == SHADOW_INVALID, logging: s.defaultLog, loggingInvalid: false, ...s }
  }
  action shadowPolicy = {
    nondet choice = Set(SHADOW_ENABLED, SHADOW_DISABLED, SHADOW_INVALID).oneOf()
    shadowPolicyAt(choice)
  }
  action readFaultAt(choice: int): bool = all {
    input' = { name: "readFault", choice: choice },
    s' = { readFailed: choice == 1, ...s }
  }
  action readFault = {
    nondet choice = Set(0, 1).oneOf()
    readFaultAt(choice)
  }
  action loadFaultAt(choice: int): bool = all {
    input' = { name: "loadFault", choice: choice },
    s' = { loadFailed: choice == 1, ...s }
  }
  action loadFault = {
    nondet choice = Set(0, 1).oneOf()
    loadFaultAt(choice)
  }
  action dumpFaultAt(choice: int): bool = all {
    input' = { name: "dumpFault", choice: choice },
    s' = { dumpFailed: choice == 1, ...s }
  }
  action dumpFault = {
    nondet choice = Set(0, 1).oneOf()
    dumpFaultAt(choice)
  }
  action writeFaultAt(choice: int): bool = all {
    input' = { name: "writeFault", choice: choice },
    s' = { writeFailed: choice == 1, ...s }
  }
  action writeFault = {
    nondet choice = Set(0, 1).oneOf()
    writeFaultAt(choice)
  }

  // Exploration schedule: retain every progress/environment action.
  // At C1, favor completion and logging changes while retaining every
  // replacement, failure, clock, and admission-policy transition. Unicode seed
  // choices add exploration frequency, not another payload representation.
  action step = if (Shadow::confirming(s)) any {
    releaseRead, logPolicy, reencode, advanceWall,
    any { seed, seedUnicode, invalidate, readFault, advance, rollbackWall, shadowPolicy }
  } else any {
    any { beginCall, resolveLoader, rejectLoader, releaseRead, releaseLoad, releaseDump, releaseWrite },
    any { advance, seed, seedUnicode, invalidate, readFault, loadFault, dumpFault, writeFault, rollbackWall, logPolicy, shadowPolicy }
  }

  // Invariants: independent checks over the public channels and the library records.
  // Over the public channels, verbatim from the former text.
  val budgetsAreOneKnob = JOB_BUDGET_MS == s.sourceBudget
  val oneSourcePerCaller = s.o.loaders == s.o.calls.length()
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()
  val missingHookHasNoShadowEffects = s.hook or (s.o.reads == 0 and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
  val agesRequireVerdicts = s.d.ages.length() == s.o.shadow.select(x => x == "match" or x == "mismatch").length()
  val warningsRequireMismatch = s.d.warnings <= s.o.shadow.select(x => x == "mismatch").length()
  val expiredSourceWorkSkipsRedis = s.sourceWorkMs < JOB_BUDGET_MS or s.o.reads == 0
  // The environment restriction stated: an invalid logging value never also
  // enables logging, so no job captures an authority from a malformed value
  // (the former invalidLoggingCannotBeCaptured over the captured pair).
  val invalidLoggingCannotBeCaptured = not(s.loggingInvalid and s.logging)
  // Over the library records, one step from the former text: every held fill
  // belongs to a job whose C0 found nothing and whose source was accepted (the
  // former writesRequireMiss over the fill phase).
  def fillOf(source: int): bool = Shadow::holdsJob(s, source)
    and Shadow::jobOf(s, source).cached == NO_VALUE and accepted(s.sources.nth(source).result)
  val fillsRequireMissAndAcceptedSource = s.dumps.indices().forall(i => fillOf(s.dumps.nth(i).source))
    and s.writes.indices().forall(i => fillOf(s.writes.nth(i).source))
  // Only C0 acquisition classifies freshness (the former receipts list): at
  // the step that releases a read, a job that survives it acquired the frame
  // exactly when the frame was visible and strictly younger than the freshness
  // at that instant (the frame and the wall clock are as the read saw them:
  // no other input moves in this step), and acquired those bytes. Spelled
  // through cache_rules directly, so a fault in the kernel's acquisition or
  // freshness judgment is caught, not restated.
  val c0AcquisitionsRespectFreshness = input.name != "releaseRead" or s.jobs.indices().forall(i => {
    val job = s.jobs.nth(i)
    val fresh = Remote::visible(s, KEY, 1) and freshAgeAllowed(s.created.nth(KEY), Clock::wallOf(s), FRESHNESS_MS)
    (job.cached > NO_VALUE) == fresh and (job.cached == NO_VALUE or job.cached == s.remoteValues.nth(KEY))
  })
  // Every pending job budget is a registered, not yet expired job's and every
  // such job has exactly one; a source deadline belongs to the latest loader
  // exactly while its work is undelivered and its flight's result pending.
  val budgetsBelongToPendingWork = s.deadlines.indices().forall(i => {
    val due = s.deadlines.nth(i)
    if (due.kind == Deadlines::JOB) Shadow::holdsJob(s, due.index) and not(Shadow::jobOf(s, due.index).timedOut)
    else due.kind == Deadlines::SOURCE and Deadlines::pending(s, due.index) and s.sources.nth(s.loaders.nth(due.index)).result == CALL_PENDING
  }) and s.jobs.indices().forall(i => s.jobs.nth(i).timedOut or Deadlines::deadlinesOf(s, Deadlines::JOB, s.jobs.nth(i).source).length() == 1)
    and s.loaders.indices().forall(k => Deadlines::deadlinesOf(s, Deadlines::SOURCE, k).length() ==
      (if (Deadlines::pending(s, k) and s.sources.nth(s.loaders.nth(k)).result == CALL_PENDING) 1 else 0))
  // The drivers' effects are the held ones: every held read or decode is a
  // job's (the caller uses no layer, so no caller read is ever held) under an
  // ordinal the drivers dispatched, a job holds exactly one read while it
  // reads and exactly one decode while it decodes, and the loaders are the
  // loader ordinals.
  val heldEffectsAreTheDrivers = s.o.loaders == s.loaders.length()
    and s.reads.indices().forall(i => Shadow::holdsRead(s, s.reads.nth(i).read) and s.reads.nth(i).read < s.o.reads)
    and s.loads.indices().forall(i => Shadow::holdsLoad(s, s.loads.nth(i).load) and s.loads.nth(i).load < s.o.loads)
    and s.jobs.indices().forall(i => {
      val job = s.jobs.nth(i)
      s.reads.select(held => held.flight == job.source).length() == (if (Shadow::reading(job)) 1 else 0)
        and s.loads.select(held => held.flight == job.source).length() == (if (job.phase == Shadow::DECODING) 1 else 0)
    })
  // A dispatched fill was stamped after the fence its job's C0 read observed
  // (the retired validation model's fencedFillDoesNotWrite): the write carries
  // the stamp of its dump's release, the job the fence, so the fence recheck
  // at dispatch (remote_writes) is judged here one step later.
  val fillsClearTheirFence = s.writes.indices().forall(i => {
    val held = s.writes.nth(i)
    not(Shadow::holdsJob(s, held.source)) or Shadow::jobOf(s, held.source).fence == NO_FENCE
      or fenceAllows(held.stamp, Shadow::jobOf(s, held.source).fence)
  })
  // The environment restriction stated: one job and one pending source at a time.
  val oneExecution = s.jobs.length() <= 1 and s.sources.select(source => source.result == CALL_PENDING).length() <= 1
  // The former warningsRequireValidCapturedPolicy read the authorization list
  // the profile kept per verdict; the fact it stated (a warning exactly at a
  // confirmed mismatch whose admission captured logging on) lives in
  // shadow::recordVerdict and is pinned by
  // explicitInequalityRequiresConfirmationTest,
  // acceptedLoggingSurvivesPolicyChangeTest,
  // invalidLoggingKeepsComparisonWithoutWarningTest,
  // omittedLoggingKeepsMismatchMetricsOnlyTest and
  // explicitFalseLoggingOverridesEnabledDefaultTest, with
  // warningsRequireMismatch bounding the count.

  // Deterministic public histories -------------------------------------------
  // The same commands drive exploration and implementation replay. The former
  // fixtures patched the job's phase, its C0 and the stored frame; each patch
  // is now the input that produces it: a seed, a millisecond of elapsed time
  // for a one-millisecond C0 age, the call, its read and its settlement. Every
  // schedule settles its source with an explicit value, so its export does not
  // depend on the seed.
  // A dark job whose C0 (text `1`, stamped one millisecond before the call) is
  // held for decoding after the source resolved with `value`.
  action compareWith(fixture: int, value: int): bool = initialize(fixture).then(seedAt(1)).then(advanceBy(1))
    .then(beginCall).then(releaseRead).then(resolveAt(value))
  // A dark job over an absent frame whose source resolved: its fill is held.
  action fillFixture = initialize(0).then(beginCall).then(releaseRead).then(resolveAt(VALUE_ONE))

  run identicalTextAndBinaryBytesConfirmMismatchTest = compareWith(2, VALUE_TWO)
    .then(seedAt(3)).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch"))
  run sameDecodedValueWithDifferentBytesIsSupersededTest = compareWith(2, VALUE_TWO)
    .then(seedAt(5)).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("superseded"))
  run binarySnapshotComparesDecodedValueTest = initialize(0).then(seedAt(3)).then(advanceBy(1))
    .then(beginCall).then(releaseRead).then(resolveAt(VALUE_ONE)).then(releaseLoad)
    .expect(s.o.shadow == List("match") and s.o.reads == 1)
  // A comparison that consumes the whole budget times the job out before any
  // verdict, whether the callback would have reported equal or thrown.
  run slowComparisonTimesOutBeforeConfirmationTest = compareWith(FIXTURE_SLOW_EQUAL, VALUE_TWO).then(releaseLoad)
    .expect(s.o.shadow == List("timeout") and s.o.reads == 1 and s.o.comparisons == 1 and s.o.calls == List(VALUE_TWO))
  run slowComparisonFailureStillTimesOutTest = compareWith(FIXTURE_SLOW_ERROR, VALUE_TWO).then(releaseLoad)
    .expect(s.o.shadow == List("timeout") and s.o.comparisons == 1 and s.o.calls == List(VALUE_TWO))
  run missingHookSkipsDarkJobTest = initialize(FIXTURE_NO_HOOK)
    .then(beginCall).then(resolveAt(VALUE_ONE)).expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 0 and s.o.shadow == List())
  run invalidShadowPolicySkipsDarkJobTest = initialize(0).then(shadowPolicyAt(SHADOW_INVALID)).then(beginCall).then(resolveAt(VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 0 and s.o.shadow == List() and s.d.configErrors == 1)
  run admittedComparisonSurvivesPolicyDisableTest = compareWith(1, VALUE_TWO)
    .then(shadowPolicyAt(SHADOW_DISABLED)).then(releaseLoad).expect(s.o.shadow == List("match"))
  run explicitEqualityOverridesValuesTest = compareWith(1, VALUE_TWO).then(releaseLoad)
    .expect(s.o.shadow == List("match") and s.o.comparisons == 1 and s.d.ages == List(1))
  run explicitInequalityRequiresConfirmationTest = compareWith(FIRST_LOGGING_FIXTURE + 2, VALUE_ONE)
    .then(releaseLoad).expect(Shadow::confirming(s) and s.d.warnings == 0).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.o.comparisons == 1 and s.d.warnings == 1)
  run comparisonFailureKeepsCallerTest = compareWith(3, VALUE_TWO).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List("comparison_error") and s.d.ages == List())
  run acceptedLoggingSurvivesPolicyChangeTest = compareWith(FIRST_LOGGING_FIXTURE + 2, VALUE_TWO)
    .then(setLogging(LOGGING_DISABLED)).then(releaseLoad).then(releaseRead).expect(s.d.warnings == 1)
  run ageClampsAfterWallRollbackTest = compareWith(1, VALUE_TWO)
    .then(rollbackWall).then(releaseLoad).expect(s.d.ages == List(0))
  // The verdict age is the C0 frame's, not the confirmation frame's.
  run confirmationKeepsOriginalAgeTest = compareWith(2, VALUE_TWO).then(releaseLoad)
    .then(advanceWallBy(1)).then(seedAt(1)).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.d.ages == List(2))

  run invalidLoggingKeepsComparisonWithoutWarningTest = initialize(2).then(setLogging(LOGGING_INVALID)).then(seedAt(1))
    .then(beginCall).expect(s.d.configErrors == 1 and s.o.reads == 1)
    .then(releaseRead).then(resolveAt(VALUE_ONE)).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.d.warnings == 0 and s.o.comparisons == 1)

  // Omission and an explicit false reply are distinct environment inputs. Both
  // keep diagnostic metrics, while neither authorizes a mismatch warning.
  run omittedLoggingKeepsMismatchMetricsOnlyTest = initialize(2)
    .expect(not(s.defaultLog) and not(s.logging))
    .then(seedAt(1)).then(beginCall).then(releaseRead).then(resolveAt(VALUE_TWO))
    .then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.d.ages == List(0)
      and s.d.warnings == 0 and s.d.configErrors == 0 and s.o.comparisons == 1)

  run explicitFalseLoggingOverridesEnabledDefaultTest = initialize(FIRST_LOGGING_FIXTURE + 2)
    .expect(s.defaultLog and s.logging)
    .then(setLogging(LOGGING_DISABLED)).then(seedAt(1)).then(beginCall)
    .then(releaseRead).then(resolveAt(VALUE_TWO)).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.d.ages == List(0)
      and s.d.warnings == 0 and s.d.configErrors == 0 and s.o.comparisons == 1)
  run sourceWorkBeforeDeadlineStillReadsTest = initialize(FIXTURE_SOURCE_WORK_BEFORE_DEADLINE)
    .then(beginCall).expect(s.o.reads == 1 and s.o.calls == List(CALL_PENDING) and s.o.shadow == List())
    .then(resolveAt(VALUE_ONE)).expect(s.o.calls == List(VALUE_ONE))
  run sourceWorkAtDeadlineSkipsDeferredReadTest = initialize(FIXTURE_SOURCE_WORK_AT_DEADLINE)
    .then(beginCall)
    .expect(s.o.reads == 0 and s.o.calls == List(CALL_PENDING) and s.o.shadow == List("timeout")
      and s.d.fallbackErrors == List())
    .then(resolveAt(VALUE_ONE))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.reads == 0 and s.d.fallbackErrors == List("local"))
  run expiredDeferredJobRetainsSourceRejectionDeadlineTest = initialize(FIXTURE_SOURCE_WORK_AT_DEADLINE)
    .then(beginCall).then(rejectLoader)
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.shadow == List("timeout") and s.o.reads == 0)

  // These histories distinguish failures at C0, decode, C1, serialization and
  // write settlement. Their effects remain subordinate to the caller result.
  run darkReadErrorCannotReplaceCallerSourceTest = initialize(0)
    .then(readFaultAt(1)).then(beginCall).then(releaseRead)
    .expect(s.o.calls == List(CALL_PENDING) and s.o.shadow == List("redis_error"))
    .then(resolveAt(VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.shadow == List("redis_error") and s.o.loads == 0 and s.o.writes == 0)

  run sourceErrorDoesNotDecodePresentDarkBytesTest = initialize(0)
    .then(seedAt(1)).then(beginCall).then(releaseRead).then(rejectLoader)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.shadow == List("source_error")
      and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)

  // A frame fenced by an invalidation a millisecond after its stamp is a
  // semantic miss; the fill stamped a millisecond after the watermark clears it.
  run fencedDarkBytesCanAdmitNewerFillTest = initialize(0)
    .then(seedAt(1)).then(advanceBy(1)).then(invalidateAt(0)).then(advanceBy(1))
    .then(beginCall).then(releaseRead).then(resolveAt(VALUE_ONE)).then(releaseDump).then(releaseWrite)
    .expect(s.o.shadow == List("filled") and s.o.loads == 0 and s.o.writes == 1
      and s.o.writeTtls == List(FRESHNESS_MS) and s.created.nth(KEY) > s.watermark.nth(ENTITY))

  // The fence a miss observed is judged again when the dump is released: a
  // wall rollback below it between settlement and release stops the write.
  run fenceRejudgedAtDumpReleaseAfterRollbackTest = initialize(0)
    .then(invalidateAt(0)).then(advanceBy(1)).then(beginCall).then(releaseRead).then(resolveAt(VALUE_ONE))
    .expect(s.o.dumps == 1 and s.o.writes == 0 and s.o.shadow == List())
    .then(rollbackWall).then(releaseDump)
    .expect(s.o.shadow == List("fill_fenced") and s.o.writes == 0)
    .expect(s.o.calls == List(VALUE_ONE))
  // A dark read that settles before the source waits for it: no verdict, no
  // fill, until the source resolves (the retired validation model's
  // darkReadCanPrecedeCallerResultTest).
  run darkReadBeforeSourceWaitsForItTest = initialize(0).then(beginCall).then(releaseRead)
    .expect(s.o.calls == List(CALL_PENDING) and s.o.shadow == List() and s.o.dumps == 0 and s.o.loads == 0)
    .then(resolveAt(VALUE_TWO)).expect(s.o.calls == List(VALUE_TWO) and s.o.dumps == 1)
    .then(releaseDump).then(releaseWrite)
    .expect(s.o.shadow == List("filled") and s.o.writes == 1 and s.o.loaders == 1)

  run fencedConfirmationNeverRepairsTest = compareWith(2, VALUE_TWO)
    .then(invalidateAt(0)).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("superseded") and s.o.reads == 2
      and s.o.calls == List(VALUE_TWO) and s.o.writes == 0 and s.d.ages == List())

  run futureConfirmationStillComparesBytesTest = compareWith(2, VALUE_TWO)
    .then(seedAt(1)).then(rollbackWall).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.o.reads == 2
      and s.o.calls == List(VALUE_TWO) and s.o.writes == 0)

  run fillSerializationFailureNeverDispatchesWriteTest = fillFixture
    .then(dumpFaultAt(1)).then(releaseDump)
    .expect(s.o.shadow == List("fill_error") and s.o.dumps == 1 and s.o.writes == 0)
    .expect(s.o.calls == List(VALUE_ONE))

  run fillWriteFailurePreservesCallerResultTest = fillFixture.then(releaseDump)
    .then(writeFaultAt(1)).then(releaseWrite)
    .expect(s.o.shadow == List("fill_error") and s.o.dumps == 1 and s.o.writes == 1)
    .expect(s.o.calls == List(VALUE_ONE))

  // The job's budget delivered by a full advance: late held work drains
  // without a second label, a late dump dispatching no write and a late write
  // still storing.
  run lateFillSerializationCannotDispatchWriteTest = fillFixture
    .then(advanceBy(JOB_BUDGET_MS)).then(releaseDump)
    .expect(s.o.shadow == List("timeout") and s.o.dumps == 1 and s.o.writes == 0)

  run lateFillWriteCannotEmitAnotherVerdictTest = fillFixture.then(releaseDump)
    .then(advanceBy(JOB_BUDGET_MS)).then(releaseWrite)
    .expect(s.o.shadow == List("timeout") and s.o.writes == 1)
    .expect(s.o.calls == List(VALUE_ONE))

  run lateDecodeCannotStartConfirmationTest = compareWith(2, VALUE_TWO)
    .then(advanceBy(JOB_BUDGET_MS)).then(releaseLoad)
    .expect(s.o.shadow == List("timeout") and s.o.reads == 1 and s.o.comparisons == 0
      and s.o.calls == List(VALUE_TWO))

  run lateConfirmationCannotEmitAnotherVerdictTest = compareWith(2, VALUE_TWO).then(releaseLoad)
    .then(advanceBy(JOB_BUDGET_MS)).then(releaseRead)
    .expect(s.o.shadow == List("timeout") and s.o.reads == 2 and s.o.writes == 0
      and s.o.calls == List(VALUE_TWO))

  run lateDarkReadCannotStartDecodeOrFillTest = initialize(0)
    .then(beginCall).then(resolveAt(VALUE_ONE)).then(advanceBy(JOB_BUDGET_MS)).then(releaseRead)
    .expect(s.o.shadow == List("timeout") and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
  run confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest = initialize(FIRST_LOGGING_FIXTURE + 2)
    .then(seedAt(1)).then(beginCall).then(releaseRead).then(resolveAt(VALUE_TWO))
    .then(releaseLoad).then(advanceWallBy(60000)).then(releaseRead)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List("mismatch")
      and s.o.reads == 2 and s.o.loads == 1 and s.o.writes == 0
      and s.d.ages == List(60000) and s.d.warnings == 1 and s.d.futureOffsets == List())

  // C1 may finish with its retained bytes at the boundary. The next job's C0
  // must classify those same stored bytes again and refill instead of decoding.
  run c0AtExactFreshnessBoundaryRefillsTest = initialize(2)
    .then(seedAt(1)).then(beginCall).then(releaseRead).then(resolveAt(VALUE_TWO))
    .then(releaseLoad).then(advanceWallBy(FRESHNESS_MS)).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.o.loads == 1 and s.o.writes == 0)
    .then(beginCall).then(releaseRead).then(resolveAt(VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.loads == 1 and s.o.dumps == 1)
    .then(releaseDump).then(releaseWrite)
    .expect(s.o.shadow == List("mismatch", "filled") and s.o.reads == 3
      and s.o.loads == 1 and s.o.writes == 1 and s.d.ages == List(FRESHNESS_MS))

  run confirmationRollbackKeepsPayloadAndClampsAgeTest = initialize(FIRST_LOGGING_FIXTURE + 2)
    .then(seedAt(1)).then(beginCall).then(releaseRead).then(resolveAt(VALUE_TWO))
    .then(releaseLoad).then(rollbackWall).then(releaseRead)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List("mismatch")
      and s.o.reads == 2 and s.o.loads == 1 and s.o.writes == 0
      and s.d.ages == List(0) and s.d.warnings == 1
      and s.d.futureOffsets == List({ layer: "remote_shadow", offsetMs: 1000 }))

  run futureDarkAcquisitionReportsOffsetAndFillsMissTest = initialize(0)
    .then(seedAt(1)).then(rollbackWall).then(beginCall).then(releaseRead)
    .expect(s.o.loads == 0 and s.o.dumps == 0
      and s.d.futureOffsets == List({ layer: "remote_shadow", offsetMs: 1000 }))
    .then(resolveAt(VALUE_TWO))
    .expect(s.o.loads == 0 and s.o.dumps == 1)
    .then(releaseDump).then(releaseWrite)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List("filled")
      and s.o.loads == 0 and s.o.writes == 1
      and s.d.futureOffsets == List({ layer: "remote_shadow", offsetMs: 1000 }))

  run futureLateDarkReadKeepsTimeoutAndReportsOffsetTest = initialize(0)
    .then(seedAt(1)).then(rollbackWall).then(beginCall).then(advanceBy(JOB_BUDGET_MS))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.shadow == List("timeout")
      and s.d.futureOffsets == List())
    .then(releaseRead)
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.shadow == List("timeout")
      and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0
      and s.d.futureOffsets == List({ layer: "remote_shadow", offsetMs: 990 }))

  // Stop at the observable decision so both the clean and faulty implementation
  // can complete this boundary history without a later fault-dependent command.
  run expiredC0BeginsFillBeforePublicationTest = initialize(2)
    .then(seedAt(1)).then(beginCall).then(releaseRead).then(resolveAt(VALUE_TWO))
    .then(releaseLoad).then(advanceWallBy(FRESHNESS_MS)).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.o.loads == 1 and s.o.writes == 0)
    .then(beginCall).then(releaseRead).then(resolveAt(VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.loads == 1 and s.o.dumps == 1)
}

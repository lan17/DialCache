module dialcache_dark_layers_conformance {
  import cache_rules.* from "./cache-rules"
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import remote_frames as Remote from "./kernel/remote-frames"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import remote_writes as Writes from "./kernel/remote-writes"
  import shadow as Shadow from "./kernel/shadow"
  import deadlines as Deadlines from "./kernel/deadlines"
  import diagnostics as Diagnostics from "./kernel/diagnostics"
  import recovery as Recovery from "./kernel/recovery"
  import payloads as Payloads from "./kernel/payloads"
  import flights as Flights from "./kernel/flights"
  import clock as Clock from "./kernel/clock"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Interaction profile: dark shadow work over the layers layout on the held
  // path. Every reply leaves the remote layer off, so a caller traverses the
  // request memo and local storage and starts its own bounded source, while a
  // selected key's dark job reads, decodes, confirms and fills the remote
  // layer through held effects released by index. Two instances, two keys,
  // three persistent scopes and two transient contexts; coalescing on or off
  // per reply; 10 ms source deadlines (the job budget, as the library derives
  // it from the same fallback timeout); tracked invalidation with a future
  // buffer; wall rollbacks; the adapter's read, decode, dump and write
  // faults; decode-fault and read-fault payload classes on the job's held
  // path. Every rule is a kernel transition (formal/kernel): the dark job
  // lifecycle over the diagnosed budgeted held remote traversal (shadow,
  // diagnostics, deadlines, remote_io, remote_writes), the frames a seed
  // stores (remote_frames), the invalidation with its buffer (serving), the
  // wall clock (clock). This module owns the bounded state, the fixture
  // decoding (the layers, coalescing, TTLs and selection a policy code
  // resolves to; the frame a seed choice names), the input choices and the
  // guards. The explicit input envelope is the portable driver input.

  pure val KEYS = 2
  pure val INSTANCES = 2
  pure val SCOPES = 3
  pure val CONTEXTS = 5
  pure val MAX_CALLS = 12
  pure val JOB_CAPACITY = 1
  // One constant: the library derives the job budget from the call's fallback
  // timeout (src/dialcache.ts `timeoutMs: fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS`,
  // go/shadow.go `budget()`), so the two cannot differ (C6 in the exclusions inventory).
  pure val SOURCE_BUDGET_MS = 10
  pure val READ_BUDGET_MS = 30000000
  pure val LOCAL_TTL_MS = 60000
  pure val SEED_TTL_MS = 180000
  pure val FUTURE_BUFFER_MS = 20
  pure val WALL_ROLLBACK_MS = 1000
  pure val WALL_ORIGIN_MS = 100000
  pure val MAX_ELAPSED_MS = 600000
  pure val DARK_ALL = 0
  pure val DARK_REQUEST = 1
  pure val DARK_LOCAL = 2
  pure val DARK_NONE = 3
  pure val DARK_ALL_UNCOALESCED = 4
  pure val DARK_LOCAL_UNCOALESCED = 5
  pure val DARK_ALL_NO_SHADOW = 6
  pure val DARK_ALL_CHANGED_FILL = 7
  pure val DARK_NONE_CHANGED_FILL = 8
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: KEYS, keysPerScope: KEYS, persistentContexts: SCOPES, operationsPerEntity: 1, probeSourceScope: true, policyProvider: true
  }

  type Channel = { configErrors: int, warnings: int, ages: List[int], coalesced: List[str], fallbackErrors: List[str], futureOffsets: List[Diagnostics::FutureOffset] }
  type State = {
    o: Observation, d: Channel, io: RemoteIO::IO,
    now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool, loadFailed: bool,
    policy: int, resolved: Resolution, ttls: Ttls, selected: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    sourceBudget: int, deadlines: List[Deadlines::Due], drained: List[bool], sourceLayers: List[str],
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], jobs: List[Shadow::Job],
    callerInstances: List[int], callerKeys: List[int]
  }
  var s: State
  var input: { name: str, choice: int }

  // Input decoding (reads no state) -------------------------------------------
  pure def zeros(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(0))
  pure def slots(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(NO_OWNER))
  pure def changedFill(choice: int): bool = choice == DARK_ALL_CHANGED_FILL or choice == DARK_NONE_CHANGED_FILL
  // The layers a policy code enables (the remote layer never), and whether the reply coalesces.
  pure def resolvedFor(choice: int): Resolution = {
    layers: {
      request: Set(DARK_ALL, DARK_REQUEST, DARK_ALL_UNCOALESCED, DARK_ALL_NO_SHADOW, DARK_ALL_CHANGED_FILL).contains(choice),
      local: Set(DARK_ALL, DARK_LOCAL, DARK_ALL_UNCOALESCED, DARK_LOCAL_UNCOALESCED, DARK_ALL_NO_SHADOW, DARK_ALL_CHANGED_FILL).contains(choice),
      remote: false
    },
    coalesce: not(Set(DARK_ALL_UNCOALESCED, DARK_LOCAL_UNCOALESCED).contains(choice))
  }
  // A 60 s local insertion TTL; the changed-fill codes carry a 120 s freshness
  // and a 180 s retention, the others 60 s and 120 s (the dark job captures
  // these, C18; the caller's source, with the remote layer off, captures none).
  pure def ttlsFor(choice: int): Ttls = {
    localMs: LOCAL_TTL_MS,
    freshMs: if (changedFill(choice)) 120000 else 60000,
    retentionMs: if (changedFill(choice)) 180000 else 120000
  }
  pure def selectedFor(choice: int): bool = choice != DARK_ALL_NO_SHADOW
  pure def shadowing(selected: bool): Shadow::Shadowing =
    { hook: true, selected: selected, capacity: JOB_CAPACITY, budgetMs: SOURCE_BUDGET_MS, logging: false }
  pure def instance(context: int): int = if (context == 2 or context == 4) 1 else 0
  pure def call(choice: int): Call =
    { instance: instance(choice / KEYS), key: choice % KEYS, context: choice / KEYS, enabled: true, keyFailed: false }
  pure def resolvedSource(code: int): int = (code - 1) / 2
  pure def resolvedValue(code: int): int = (code - 1) % 2 + VALUE_ONE
  // Seeds: per key, a fresh value 1 or 2, value 1 at 59999 ms and at 60000 ms
  // (the freshness boundary), a corrupt frame decoding to 1 (the held decode
  // fails it, C52) and a frame of an unsupported encoding (the read fails).
  pure def seedKey(choice: int): int = choice / 6
  pure def seedPayload(choice: int): int =
    if (choice % 6 == 1) VALUE_TWO
    else if (choice % 6 == 4) Payloads::CORRUPT + VALUE_ONE
    else if (choice % 6 == 5) Payloads::UNSUPPORTED_ENCODING
    else VALUE_ONE
  pure def seedAge(choice: int): int = if (choice % 6 == 2) 59999 else if (choice % 6 == 3) 60000 else 0
  pure def invalidatedEntity(choice: int): int = choice / 2
  pure def invalidationBuffer(choice: int): int = (choice % 2) * FUTURE_BUFFER_MS

  pure val INITIAL: State = {
    o: empty, d: { configErrors: 0, warnings: 0, ages: List(), coalesced: List(), fallbackErrors: List(), futureOffsets: List() },
    io: RemoteIO::NO_IO,
    now: 0, skew: WALL_ORIGIN_MS, remoteAvailable: true, tracked: true, capacity: KEYS,
    readFailed: false, dumpFailed: false, writeFailed: false, loadFailed: false,
    policy: DARK_ALL, resolved: resolvedFor(DARK_ALL), ttls: ttlsFor(DARK_ALL), selected: selectedFor(DARK_ALL),
    closed: List(false, false, false), memo: zeros(SCOPES * KEYS), requestFlights: slots(SCOPES * KEYS), processFlights: slots(INSTANCES * KEYS),
    localValues: zeros(INSTANCES * KEYS), localExpires: zeros(INSTANCES * KEYS), lru: List(List(), List()),
    remoteValues: zeros(KEYS), created: zeros(KEYS), expires: zeros(KEYS), watermark: zeros(KEYS),
    sources: List(), owners: List(), memoSlots: List(), held: List(),
    reads: List(), loads: List(), loaders: List(), retained: List(),
    sourceBudget: SOURCE_BUDGET_MS, deadlines: List(), drained: List(), sourceLayers: List(),
    dumps: List(), writes: List(), jobs: List(),
    callerInstances: List(), callerKeys: List()
  }
  action init = all { input' = { name: "init", choice: -1 }, s' = INITIAL }

  // Wiring: each s' is one library transition ---------------------------------
  action beginAt(choice: int): bool = all {
    s.o.calls.length() < MAX_CALLS,
    input' = { name: "beginCall", choice: choice },
    s' = Flights::recordIdentity(
      Shadow::beginDark(s, LAYOUT, call(choice), s.resolved, s.ttls, READ_BUDGET_MS, shadowing(s.selected), Shadow::WELL_FORMED, 0), call(choice))
  }
  action beginCall = { nondet choice = 0.to(CONTEXTS * KEYS - 1).oneOf(); beginAt(choice) }
  val heldReads = s.reads.indices().map(i => s.reads.nth(i).read)
  val heldLoads = s.loads.indices().map(i => s.loads.nth(i).load)
  action readAt(index: int): bool = all {
    Shadow::holdsRead(s, index),
    input' = { name: "releaseRead", choice: index },
    s' = Shadow::releaseRead(s, LAYOUT, index, s.readFailed)
  }
  action releaseRead = { nondet choice = heldReads.oneOf(); readAt(choice) }
  action loadAt(index: int): bool = all {
    Shadow::holdsLoad(s, index),
    input' = { name: "releaseLoad", choice: index },
    s' = Shadow::releaseLoad(s, LAYOUT, index, s.loadFailed, Shadow::VALUE_COMPARISON, READ_BUDGET_MS)
  }
  action releaseLoad = { nondet choice = heldLoads.oneOf(); loadAt(choice) }
  val pendingLoaders = s.loaders.indices().filter(k => Deadlines::pending(s, k))
  action resolveWith(code: int): bool = all {
    pendingLoaders.contains(resolvedSource(code)),
    input' = { name: "resolveLoader", choice: code },
    s' = Shadow::settleHeld(s, LAYOUT, resolvedSource(code), resolvedValue(code), false)
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_CALLS * 2).filter(code => pendingLoaders.contains(resolvedSource(code))).oneOf()
    resolveWith(choice)
  }
  action rejectAt(ordinal: int): bool = all {
    pendingLoaders.contains(ordinal),
    input' = { name: "rejectLoader", choice: ordinal },
    s' = Shadow::settleHeld(s, LAYOUT, ordinal, SOURCE_ERROR, false)
  }
  action rejectLoader = { nondet choice = pendingLoaders.oneOf(); rejectAt(choice) }
  action releaseDumpAt(index: int): bool = all {
    Writes::holdsDump(s, index),
    input' = { name: "releaseDump", choice: index },
    s' = Shadow::releaseDump(s, LAYOUT, index, s.dumpFailed)
  }
  action releaseDump = { nondet choice = s.dumps.indices().map(i => s.dumps.nth(i).dump).oneOf(); releaseDumpAt(choice) }
  action releaseWriteAt(index: int): bool = all {
    Writes::holdsWrite(s, index),
    input' = { name: "releaseWrite", choice: index },
    s' = Shadow::releaseWrite(s, LAYOUT, index, s.writeFailed)
  }
  action releaseWrite = { nondet choice = s.writes.indices().map(i => s.writes.nth(i).write).oneOf(); releaseWriteAt(choice) }
  action advanceBy(ms: int): bool = all {
    s.now + ms <= MAX_ELAPSED_MS,
    input' = { name: "advance", choice: ms },
    s' = Shadow::advanceHeld(s, LAYOUT, ms)
  }
  action advance = { nondet choice = Set(1, SOURCE_BUDGET_MS, LOCAL_TTL_MS).oneOf(); advanceBy(choice) }
  action setPolicy(choice: int): bool = all {
    input' = { name: "policy", choice: choice },
    s' = { policy: choice, resolved: resolvedFor(choice), ttls: ttlsFor(choice), selected: selectedFor(choice), ...s }
  }
  action policy = { nondet choice = 0.to(DARK_NONE_CHANGED_FILL).oneOf(); setPolicy(choice) }
  action seedAt(choice: int): bool = all {
    input' = { name: "seed", choice: choice },
    s' = Remote::seedAged(s, seedKey(choice), seedPayload(choice), seedAge(choice), SEED_TTL_MS)
  }
  action seed = { nondet choice = 0.to(KEYS * 6 - 1).oneOf(); seedAt(choice) }
  action invalidateAt(choice: int): bool = all {
    input' = { name: "invalidate", choice: choice },
    s' = Serving::invalidate(s, invalidatedEntity(choice), invalidationBuffer(choice))
  }
  action invalidate = { nondet choice = 0.to(KEYS * 2 - 1).oneOf(); invalidateAt(choice) }
  action closeContext(context: int): bool = all {
    not(s.closed.nth(context)),
    input' = { name: "closeScope", choice: context },
    s' = Serving::closeScope(s, LAYOUT, context)
  }
  action closeScope = { nondet choice = 0.to(SCOPES - 1).oneOf(); closeContext(choice) }
  action rollbackWall = all {
    input' = { name: "rollbackWall", choice: -1 },
    s' = Clock::shiftWall(s, -WALL_ROLLBACK_MS)
  }
  action readFaultWith(code: int): bool = all { input' = { name: "readFault", choice: code }, s' = { readFailed: code == 1, ...s } }
  action loadFaultWith(code: int): bool = all { input' = { name: "loadFault", choice: code }, s' = { loadFailed: code == 1, ...s } }
  action dumpFaultWith(code: int): bool = all { input' = { name: "dumpFault", choice: code }, s' = { dumpFailed: code == 1, ...s } }
  action writeFaultWith(code: int): bool = all { input' = { name: "writeFault", choice: code }, s' = { writeFailed: code == 1, ...s } }
  action readFault = { nondet choice = Set(0, 1).oneOf(); readFaultWith(choice) }
  action loadFault = { nondet choice = Set(0, 1).oneOf(); loadFaultWith(choice) }
  action dumpFault = { nondet choice = Set(0, 1).oneOf(); dumpFaultWith(choice) }
  action writeFault = { nondet choice = Set(0, 1).oneOf(); writeFaultWith(choice) }

  action step = any {
    beginCall, releaseRead, releaseLoad,
    any { resolveLoader, rejectLoader },
    any { releaseDump, releaseWrite },
    any { advance, policy, seed, invalidate, closeScope },
    any { rollbackWall, any { readFault, loadFault, dumpFault, writeFault } }
  }

  // Invariants over the library records ---------------------------------------
  def jobInstance(i: int): int = s.sources.nth(s.jobs.nth(i).source).instance
  def jobKey(i: int): int = s.sources.nth(s.jobs.nth(i).source).key
  def owned(source: int): bool = Flights::ownedBy(s, source).size() > 0
  // Carried from shadow-layers: the registry is bounded per instance and holds one job per identity.
  val boundedJobRegistry = 0.to(INSTANCES - 1).forall(inst =>
    s.jobs.indices().filter(i => jobInstance(i) == inst).size() <= JOB_CAPACITY)
  val oneJobPerIdentity = s.jobs.indices().forall(a => s.jobs.indices().forall(b =>
    a == b or jobInstance(a) != jobInstance(b) or jobKey(a) != jobKey(b)))
  // Joint (shadow x layers): every job is dark and runs over a source a caller
  // owns; every source is a caller's (no detached source) and probed as participating
  // exactly when its caller's scope was open (a bypass source is not).
  val darkJobsRunOverOwnedSources = s.jobs.indices().forall(i => s.jobs.nth(i).dark and owned(s.jobs.nth(i).source))
  val sourcesAreCallersOwn = s.o.loaders == s.sources.length() and s.o.sourceScopes.length() == s.sources.length()
    and s.sources.indices().forall(i => owned(i) and (s.o.sourceScopes.nth(i) == (s.sourceLayers.nth(i) != Diagnostics::NO_LAYER)))
  // Joint (shadow x remote_writes): callers never refill (the remote layer is
  // off in every reply), so every held dump or write is a job's fill over an
  // accepted source, carrying the authority the job captured (C18/C58).
  val heldFillsBelongToJobs = s.dumps.indices().forall(i =>
      Shadow::holdsJob(s, s.dumps.nth(i).source) and accepted(s.sources.nth(s.dumps.nth(i).source).result))
    and s.writes.indices().forall(i =>
      Shadow::holdsJob(s, s.writes.nth(i).source) and accepted(s.sources.nth(s.writes.nth(i).source).result))
  def captured(source: int): int = Remote::physicalRetention(s, Shadow::jobOf(s, source).ttls.retentionMs)
  val fillsCarryCapturedAuthority = s.dumps.indices().forall(i =>
      not(Shadow::holdsJob(s, s.dumps.nth(i).source))
      or (s.dumps.nth(i).retentionMs == captured(s.dumps.nth(i).source) and s.dumps.nth(i).fence == Shadow::jobOf(s, s.dumps.nth(i).source).fence))
    and s.writes.indices().forall(i =>
      not(Shadow::holdsJob(s, s.writes.nth(i).source)) or s.writes.nth(i).retentionMs == captured(s.writes.nth(i).source))
  // Joint (shadow x invalidation x clock): a held write's stamp strictly
  // cleared the fence its job's C0 read observed (the second fence check,
  // C33/C34), compared here directly rather than through cache_rules.fenceAllows
  // or the kernel's writeAllowed, so a fault in either is caught, not restated.
  val fillsClearTheirFence = s.writes.indices().forall(i => {
    val fence = Shadow::jobOf(s, s.writes.nth(i).source).fence
    fence == NO_FENCE or s.writes.nth(i).stamp > fence
  })
  // Joint (coalescing x instances, C11): every owner of a source asked for the
  // identity the source serves, so no flight is joined across instances or keys
  // (the layers idiom over the opt-in identity record).
  val sourceOwnersShareTheSourcesIdentity = s.owners.indices().forall(c => {
    val owner = s.owners.nth(c)
    owner < 0 or (s.sources.nth(owner).instance == s.callerInstances.nth(c) and s.sources.nth(owner).key == s.callerKeys.nth(c))
  })
  // Joint (deadlines x shadow): every pending deadline is a live job's budget
  // or a pending loader's source deadline; no read deadline is ever
  // registered (a job's reads are bounded by its budget alone), and every
  // registered job that has not timed out has exactly one budget.
  val deadlinesBelongToPendingWork = s.deadlines.indices().forall(i => {
    val due = s.deadlines.nth(i)
    if (due.kind == Deadlines::JOB) Shadow::holdsJob(s, due.index) and not(Shadow::jobOf(s, due.index).timedOut)
    else due.kind == Deadlines::SOURCE and due.index < s.loaders.length() and Deadlines::pending(s, due.index)
      and s.sources.nth(s.loaders.nth(due.index)).result == CALL_PENDING
  }) and s.jobs.indices().forall(i => s.jobs.nth(i).timedOut
    or Deadlines::deadlinesOf(s, Deadlines::JOB, s.jobs.nth(i).source).length() == 1)
  // Joint (deadlines x diagnostics x scope): every flight whose failure was
  // recorded is attributed to its layer exactly once; a bypass source (a
  // closed scope) is attributed to none.
  val failedFlightsAreAttributedOnce = s.d.fallbackErrors.length() == s.sources.indices().filter(i =>
    s.sources.nth(i).result != CALL_PENDING and not(accepted(s.sources.nth(i).result)) and s.sourceLayers.nth(i) != Diagnostics::NO_LAYER).size()
  // Joint (coalescing x request memo x local): the coalesced labels count the
  // followers, a caller attached to a flight an earlier caller owns.
  val coalescedLabelsCountFollowers = s.d.coalesced.length() == s.owners.indices().filter(c =>
    s.owners.nth(c) >= 0 and s.owners.indices().exists(e => e < c and s.owners.nth(e) == s.owners.nth(c))).size()
  // Joint (local x shadow x source errors, C27): a live local entry is the
  // accepted result of a caller's source for that identity that captured a
  // local TTL; a dark fill never warms local storage and a rejected source
  // never seeds it (the consequence the M37 partition never read).
  val localEntriesHoldAcceptedOwnedValues = s.localValues.indices().forall(slot =>
    s.localValues.nth(slot) == NO_VALUE or s.sources.indices().exists(i =>
      s.sources.nth(i).instance * KEYS + s.sources.nth(i).key == slot and s.sources.nth(i).result == s.localValues.nth(slot)
        and accepted(s.sources.nth(i).result) and s.sources.nth(i).localMs > 0))
  val memoHoldsAcceptedValues = s.memo.indices().forall(slot => s.memo.nth(slot) == NO_VALUE or accepted(s.memo.nth(slot)))
  // Carried: a caller its source owns is pending or holds that source's result.
  val callersOwnTheirResults = s.owners.indices().forall(c => {
    val owner = s.owners.nth(c)
    owner < 0 or s.o.calls.nth(c) == CALL_PENDING or s.o.calls.nth(c) == s.sources.nth(owner).result
  })
  // Joint (clock x shadow read): a future offset is reported only after a wall rollback.
  val futureOffsetsFollowRollbacks = s.d.futureOffsets.length() == 0 or s.skew < WALL_ORIGIN_MS
  // The profile's own restrictions, executable: no mismatch logging and no
  // malformed policy, so the channel's warnings and configuration errors stay zero.
  val channelRestrictionsHold = s.d.warnings == 0 and s.d.configErrors == 0
  val agesRequireVerdicts = s.d.ages.length() == s.o.shadow.select(label => label == "match" or label == "mismatch").length()
  // Every reply the decoder produces is one the library can be configured with (C10).
  // One knob (C6): the job budget is the source budget, as the library derives it from the call's fallback timeout.
  val budgetsAreOneKnob = shadowing(s.selected).budgetMs == s.sourceBudget

  // Both finite budgets are positive, and advances deliver due work before
  // observation. A newly started source or job cannot inherit clock uptime.
  val pendingDeadlinesAreFuture = s.deadlines.indices().forall(i => s.deadlines.nth(i).at > s.now)

  // Regressions: public input schedules ---------------------------------------
  // A rejected dark source seeds neither local storage nor the request memo:
  // the next caller of the same scope and key starts its own source and its
  // own dark read (M25). M37's native publication site is outside this path.
  run rejectedDarkSourceSeedsNoLayerTest = init
    .then(setPolicy(DARK_ALL)).then(beginAt(0)).then(readAt(0)).then(rejectAt(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.shadow == List("source_error") and s.d.fallbackErrors == List("local"))
    .then(beginAt(0))
    .expect(s.o.calls == List(SOURCE_ERROR, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 2 and s.d.coalesced == List())

  // A non-coalescing caller starts beside the registered leader and its dark
  // job is dropped for the live identity; its local publication does not
  // preempt a later coalescing caller's join; the leader completes both owners.
  run uncoalescedPublicationDoesNotPreemptTheRegisteredLeaderTest = init
    .then(setPolicy(DARK_ALL)).then(beginAt(0))
    .then(setPolicy(DARK_LOCAL_UNCOALESCED)).then(beginAt(2))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 1 and s.o.shadow == List("dropped"))
    .then(resolveWith(4))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO) and s.localValues.nth(0) == VALUE_TWO)
    .then(setPolicy(DARK_ALL)).then(beginAt(6))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO, CALL_PENDING) and s.o.loaders == 2 and s.d.coalesced == List("process"))
    .then(resolveWith(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  // The dark fill on the held path carries the retention the job captured at
  // admission, whatever the policy says when the source settles and when the
  // dump is released (C18, the shadow-layers boundary on the held path).
  run darkFillCarriesCapturedRetentionOnTheHeldPathTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(0)).then(readAt(0))
    .then(setPolicy(DARK_ALL_CHANGED_FILL)).then(resolveWith(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 0)
    .then(releaseDumpAt(0))
    .expect(s.o.writeTtls == List(120000) and s.o.writes == 1)
    .then(releaseWriteAt(0))
    .expect(s.o.shadow == List("filled") and s.remoteValues.nth(0) == VALUE_ONE)

  // A fill whose fence is the watermark raised at this very instant is fenced
  // before serializing: the fence is strict (W04, cache_rules.fenceAllows).
  run fillAtTheWatermarkInstantIsFencedTest = init
    .then(invalidateAt(0)).then(setPolicy(DARK_NONE)).then(beginAt(0)).then(readAt(0)).then(resolveWith(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.shadow == List("fill_fenced") and s.o.dumps == 0)

  // A frame stamped at the watermark's instant is fenced from the dark read
  // (the strict fence on the read side, W04): the job acquires nothing and
  // fills once the wall has moved; an inclusive read fence would acquire the
  // frame as the C0 and decode instead of filling.
  run frameAtTheWatermarkIsFencedFromTheDarkReadTest = init
    .then(invalidateAt(0)).then(seedAt(0)).then(setPolicy(DARK_NONE)).then(beginAt(0)).then(readAt(0))
    .then(advanceBy(1)).then(resolveWith(2))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.dumps == 1 and s.o.loads == 0)

  // A fill fenced at settlement is judged again at dump release: a wall
  // rollback below the fence stops the write (C33/C34).
  run fillFenceIsRejudgedAfterAWallRollbackTest = init
    .then(invalidateAt(0)).then(advanceBy(1)).then(setPolicy(DARK_NONE)).then(beginAt(0)).then(readAt(0)).then(resolveWith(1))
    .expect(s.o.dumps == 1 and s.o.shadow == List())
    .then(rollbackWall).then(releaseDumpAt(0))
    .expect(s.o.shadow == List("fill_fenced") and s.o.writes == 0)

  // A visible frame the dark read declined as stale carries no fence (C58): a
  // watermark raised with a future buffer after the read fences the fill's
  // frame from readers but not the write itself.
  run staleVisibleFrameDeclinedByTheDarkReadFillsUnfencedTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(3)).then(beginAt(0)).then(readAt(0))
    .then(invalidateAt(1)).then(resolveWith(2))
    .expect(s.o.dumps == 1 and s.jobs.nth(0).fence == NO_FENCE)
    .then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .expect(s.o.writes == 1 and s.o.shadow == List("filled") and s.remoteValues.nth(0) == VALUE_TWO)
    .then(beginAt(0)).then(readAt(1))
    .expect(s.o.reads == 2 and s.jobs.nth(0).cached == NO_VALUE and s.jobs.nth(0).fence == s.watermark.nth(0))
    .then(resolveWith(3))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_ONE) and s.o.shadow == List("filled", "fill_fenced") and s.o.dumps == 1 and s.o.writes == 1)

  // A present C0 that fails to decode is never repaired: the held decode ends
  // the job without a fill (C52 on the held dark path).
  run undecodableDarkC0IsNeverRepairedTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(4)).then(beginAt(0)).then(readAt(0)).then(resolveWith(2))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loads == 1 and s.o.dumps == 0)
    .then(loadAt(0))
    .expect(s.o.shadow == List("deserialization_error") and s.o.dumps == 0 and s.o.reads == 1)

  // A frame of an unsupported encoding fails the dark read: the job ends at
  // once and the caller's source still completes it.
  run unsupportedEncodingFailsTheDarkReadTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(5)).then(beginAt(0)).then(readAt(0))
    .expect(s.o.shadow == List("redis_error") and s.jobs == List())
    .then(resolveWith(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.o.loads == 0)

  // The caller's source deadline and the job's budget are delivered in one
  // round: the caller completes with a deadline error attributed to the
  // local layer, the job times out once, its late read drains, and
  // the deadline error is memoized nowhere.
  run sourceDeadlineExpiresTheDarkJobAndAttributesToTheLocalLayerTest = init
    .then(setPolicy(DARK_ALL)).then(beginAt(0)).then(advanceBy(SOURCE_BUDGET_MS))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.shadow == List("timeout") and s.d.fallbackErrors == List("local"))
    .then(readAt(0))
    .expect(s.jobs == List() and s.o.shadow == List("timeout") and s.o.dumps == 0)
    .then(beginAt(0))
    .expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING) and s.o.loaders == 2 and s.d.coalesced == List())

  // Earlier clock uptime belongs to neither budget. An immediately resolved
  // later source publishes for another request scope while its dark read is
  // still held; neither caller nor job should have already timed out.
  run laterDarkSourceKeepsItsWholeBudgetTest = init
    .then(advanceBy(SOURCE_BUDGET_MS)).then(setPolicy(DARK_ALL)).then(beginAt(0))
    .then(resolveWith(1)).then(beginAt(2))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.reads == 1
      and s.o.dumps == 0 and s.o.shadow == List() and s.d.fallbackErrors == List())

  // Same-key callers on two instances keep separate flights and separate jobs
  // (C11): the identity a flight is registered under includes the instance.
  run sameKeyCallersOnTwoInstancesKeepSeparateFlightsTest = init
    .then(setPolicy(DARK_ALL)).then(beginAt(0)).then(beginAt(4))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 2 and s.o.shadow == List() and s.d.coalesced == List())
    .then(resolveWith(2))
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING) and s.localValues == List(VALUE_TWO, NO_VALUE, NO_VALUE, NO_VALUE))

  // A caller in a closed scope bypasses every layer and admits no job (C01):
  // no policy call, no read, an unbounded source probed as not participating.
  run closedScopeCallerBypassesLayersAndAdmitsNoJobTest = init
    .then(setPolicy(DARK_ALL)).then(closeContext(0)).then(beginAt(0))
    .expect(s.o.policyCalls == 0 and s.o.reads == 0 and s.o.shadow == List() and s.o.sourceScopes == List(false))
    .then(advanceBy(SOURCE_BUDGET_MS))
    .expect(s.o.calls == List(CALL_PENDING) and s.d.fallbackErrors == List())

  // While a job holds its C0 read, another key's job on the full instance is
  // dropped and a job on the other instance is admitted (C47/C54).
  run fullInstanceDropsAnotherKeyWhileTheC0ReadIsHeldTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(0)).then(beginAt(1))
    .expect(s.o.reads == 1 and s.o.shadow == List("dropped") and s.jobs.length() == 1)
    .then(beginAt(4))
    .expect(s.o.reads == 2 and s.o.shadow == List("dropped") and s.jobs.length() == 2)

  // A dump fault ends the fill without a write; the caller's result stands (C53).
  run dumpFaultEndsTheFillWithoutReplacingTheCallerResultTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(0)).then(readAt(0)).then(resolveWith(1)).then(dumpFaultWith(1)).then(releaseDumpAt(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.shadow == List("fill_error") and s.o.writes == 0)

  // A local publication by the dark caller's source stops later shadow work
  // for the key: the next caller is served locally, no read and no job.
  run localPublicationStopsLaterDarkWorkTest = init
    .then(setPolicy(DARK_LOCAL)).then(beginAt(0)).then(readAt(0)).then(resolveWith(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1)
    .then(beginAt(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.reads == 1 and s.o.shadow == List())

  // The C0 frame's age is sampled at the verdict's wall clock: a frame
  // acquired one millisecond inside freshness is confirmed a mismatch at the
  // boundary and its age is the boundary (C51/C57).
  run retainedC0AgeIsSampledAtTheVerdictTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(2)).then(beginAt(0)).then(readAt(0)).then(advanceBy(1)).then(resolveWith(2))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loads == 1)
    .then(loadAt(0))
    .expect(s.o.reads == 2 and s.o.shadow == List())
    .then(readAt(1))
    .expect(s.o.shadow == List("mismatch") and s.d.ages == List(60000) and s.o.dumps == 0)

  // A wall rollback makes a seeded frame future-dated: the dark read declines
  // it, reports its offset on the shadow layer, and the fill overwrites it.
  run rollbackMakesTheSeededFrameFutureAndReportsItsOffsetTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(0)).then(rollbackWall).then(beginAt(0)).then(readAt(0))
    .expect(s.d.futureOffsets == List({ layer: "remote_shadow", offsetMs: WALL_ROLLBACK_MS }) and s.jobs.nth(0).cached == NO_VALUE and s.jobs.nth(0).fence == NO_FENCE)
    .then(resolveWith(2)).then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .expect(s.o.shadow == List("filled") and s.remoteValues.nth(0) == VALUE_TWO)

  // With no active shared layer, a transient request still attributes its
  // failed source to request_local although it has no persistent memo slot.
  run transientRequestOnlySourceFailureIsAttributedToRequestLayerTest = init
    .then(setPolicy(DARK_REQUEST)).then(beginAt(6)).then(readAt(0)).then(rejectAt(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.shadow == List("source_error") and s.d.fallbackErrors == List("request_local"))
}

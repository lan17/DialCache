module dialcache_shadow_read_deadlines_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import remote_frames as Remote from "./kernel/remote-frames"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import remote_writes as Writes from "./kernel/remote-writes"
  import shadow as Shadow from "./kernel/shadow"
  import shadow_reads as ShadowReads from "./kernel/shadow-reads"
  import deadlines as Deadlines from "./kernel/deadlines"
  import diagnostics as Diagnostics from "./kernel/diagnostics"
  import recovery as Recovery from "./kernel/recovery"
  import policy_gate as Gate from "./kernel/policy-gate"
  // C54/C56: separate Redis-read and whole-job deadlines, raw read ownership,
  // cancellation and captured read policy. Every call is dark: its source is
  // caller-owned, while C0 and C1 are diagnostic reads. Two keys, one instance,
  // one job slot, eight callers; 10 ms source/job budget and 5 or 20 ms reads.
  // All external effects are held by ordinal. Time advances deliver timers;
  // reads can ignore cancellation until the explicit raw release. No request
  // or local cache, stale recovery, runtime invalidity or wall-clock shifts.

  pure val KEYS = 2
  pure val MAX_CALLS = 8
  pure val SOURCE_BUDGET = 10
  pure val TTL = 60000
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: KEYS, keysPerScope: KEYS, persistentContexts: 0,
    operationsPerEntity: 1, probeSourceScope: true, policyProvider: true
  }
  pure val DARK: Resolution = { layers: { request: false, local: false, remote: false }, coalesce: true }
  pure val TTLS: Ttls = { localMs: 0, freshMs: TTL, retentionMs: TTL }
  pure val SHADOW: Shadow::Shadowing = { hook: true, selected: true, capacity: 1, budgetMs: SOURCE_BUDGET, logging: false }
  pure def call(key: int): Call = { instance: 0, key: key, context: 0, enabled: true, keyFailed: false }

  type Channel = { configErrors: int, warnings: int, ages: List[int], coalesced: List[str], fallbackErrors: List[str], futureOffsets: List[Diagnostics::FutureOffset] }
  type State = {
    o: Observation, d: Channel, io: RemoteIO::IO,
    now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool, readBudget: int,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    sourceBudget: int, deadlines: List[Deadlines::Due], drained: List[bool], sourceLayers: List[str],
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], jobs: List[Shadow::Job],
    expiredReads: List[int], capturedReadBudgets: List[ShadowReads::ReadBudget]
  }
  var s: State
  var input: { name: str, choice: int }
  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty, d: { configErrors: 0, warnings: 0, ages: List(), coalesced: List(), fallbackErrors: List(), futureOffsets: List() }, io: RemoteIO::NO_IO,
      now: 0, skew: 100000, remoteAvailable: true, tracked: true, capacity: 0,
      readFailed: false, dumpFailed: false, writeFailed: false, readBudget: 5,
      closed: List(), memo: List(), requestFlights: List(), processFlights: List(NO_OWNER, NO_OWNER),
      localValues: List(), localExpires: List(), lru: List(List()),
      remoteValues: List(NO_VALUE, NO_VALUE), created: List(0, 0), expires: List(0, 0), watermark: List(0, 0),
      sources: List(), owners: List(), memoSlots: List(), held: List(), reads: List(), loads: List(), loaders: List(), retained: List(),
      sourceBudget: SOURCE_BUDGET, deadlines: List(), drained: List(), sourceLayers: List(),
      dumps: List(), writes: List(), jobs: List(), expiredReads: List(), capturedReadBudgets: List()
    }
  }
  action beginAt(key: int): bool = all {
    s.o.calls.length() < MAX_CALLS,
    input' = { name: "beginCall", choice: key },
    s' = ShadowReads::begin(s, LAYOUT, call(key), DARK, TTLS, s.readBudget, SHADOW)
  }
  action beginCall = { nondet choice = Set(0, 1).oneOf(); beginAt(choice) }
  action readAt(index: int): bool = all {
    RemoteIO::holdsRead(s, index), input' = { name: "releaseRead", choice: index },
    s' = ShadowReads::releaseRead(s, LAYOUT, index, false)
  }
  action releaseRead = { nondet choice = s.reads.indices().map(i => s.reads.nth(i).read).oneOf(); readAt(choice) }
  action loadAt(index: int): bool = all {
    Shadow::holdsLoad(s, index), input' = { name: "releaseLoad", choice: index },
    s' = ShadowReads::releaseLoad(s, LAYOUT, index, false, Shadow::VALUE_COMPARISON)
  }
  action releaseLoad = { nondet choice = s.loads.indices().map(i => s.loads.nth(i).load).oneOf(); loadAt(choice) }
  action resolveWith(code: int): bool = all {
    (code - 1) / 2 < s.loaders.length(), Deadlines::pending(s, (code - 1) / 2),
    input' = { name: "resolveLoader", choice: code },
    s' = Shadow::settleHeld(s, LAYOUT, (code - 1) / 2, (code - 1) % 2 + 1, false)
  }
  action resolveLoader = { nondet choice = 1.to(MAX_CALLS * 2).oneOf(); resolveWith(choice) }
  action rejectAt(index: int): bool = all {
    index < s.loaders.length(), Deadlines::pending(s, index),
    input' = { name: "rejectLoader", choice: index },
    s' = Shadow::settleHeld(s, LAYOUT, index, SOURCE_ERROR, false)
  }
  action rejectLoader = { nondet choice = 0.to(MAX_CALLS - 1).oneOf(); rejectAt(choice) }
  action dumpAt(index: int): bool = all {
    Writes::holdsDump(s, index), input' = { name: "releaseDump", choice: index },
    s' = Shadow::releaseDump(s, LAYOUT, index, false)
  }
  action releaseDump = { nondet choice = s.dumps.indices().map(i => s.dumps.nth(i).dump).oneOf(); dumpAt(choice) }
  action writeAt(index: int): bool = all {
    Writes::holdsWrite(s, index), input' = { name: "releaseWrite", choice: index },
    s' = Shadow::releaseWrite(s, LAYOUT, index, false)
  }
  action releaseWrite = { nondet choice = s.writes.indices().map(i => s.writes.nth(i).write).oneOf(); writeAt(choice) }
  action advanceBy(ms: int): bool = all {
    s.now + ms <= 100, input' = { name: "advance", choice: ms },
    s' = ShadowReads::advance(s, LAYOUT, ms)
  }
  action advance = { nondet choice = Set(1, 4, 5, 10, 20).oneOf(); advanceBy(choice) }
  action policyWith(budget: int): bool = all { input' = { name: "policy", choice: budget }, s' = { readBudget: budget, ...s } }
  action policy = { nondet choice = Set(5, 20).oneOf(); policyWith(choice) }
  action seedAt(code: int): bool = all {
    input' = { name: "seed", choice: code }, s' = Remote::seedFrame(s, code / 2, code % 2 + 1, TTL)
  }
  action seed = { nondet choice = 0.to(3).oneOf(); seedAt(choice) }
  action step = any { beginCall, releaseRead, releaseLoad, resolveLoader, rejectLoader, releaseDump, releaseWrite, advance, policy, seed }

  // Independent consequences over ownership, time and observations.
  val capacityIsBounded = s.jobs.length() <= 1
  val rawReadsKeepTheirRegistration = s.reads.indices().forall(i =>
    s.jobs.indices().exists(j => s.jobs.nth(j).source == s.reads.nth(i).flight))
  val abortedReadsHaveEndedTheirResult = s.reads.indices().forall(i =>
    not(s.io.aborted.select(read => read == s.reads.nth(i).read).length() > 0) or s.expiredReads.select(read => read == s.reads.nth(i).read).length() > 0)
  val endedReadsHaveNoJobTimer = s.expiredReads.indices().forall(i => {
    val read = s.expiredReads.nth(i)
    s.reads.indices().exists(j => s.reads.nth(j).read == read)
      and not(s.deadlines.indices().exists(j => s.deadlines.nth(j).kind == Deadlines::JOB
        and s.deadlines.nth(j).index == RemoteIO::heldRead(s, read).flight))
  })
  val liveReadDeadlinesAreOwned = s.deadlines.indices().forall(i => {
    val due = s.deadlines.nth(i)
    due.kind != ShadowReads::SHADOW_READ or (
      s.reads.indices().exists(j => s.reads.nth(j).read == due.index) and not(s.expiredReads.select(read => read == due.index).length() > 0))
  })
  val callerResultsBelongToTheirSources = s.owners.indices().forall(c =>
    s.o.calls.nth(c) == s.sources.nth(s.owners.nth(c)).result)

  run c0ReadDeadlineKeepsRawCapacityTest = init.then(beginAt(0)).then(resolveWith(1)).then(advanceBy(5))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.shadow == List("redis_error") and s.io.aborted == List(0))
    .then(beginAt(1))
    .expect(s.o.reads == 1 and s.o.shadow == List("redis_error", "dropped"))
    .then(resolveWith(3)).then(advanceBy(10))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.shadow == List("redis_error", "dropped"))
    .then(readAt(0)).then(beginAt(1))
    .expect(s.o.reads == 2 and s.o.loaders == 3 and s.o.loads == 0 and s.o.dumps == 0 and s.o.shadow == List("redis_error", "dropped"))

  run c1ReadDeadlineKeepsRawCapacityTest = init.then(seedAt(0)).then(beginAt(0)).then(readAt(0)).then(resolveWith(2)).then(loadAt(0)).then(advanceBy(5))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List("confirmation_error") and s.io.aborted == List(1))
    .then(beginAt(1))
    .expect(s.o.reads == 2 and s.o.shadow == List("confirmation_error", "dropped"))
    .then(resolveWith(3)).then(advanceBy(10))
    .expect(s.o.shadow == List("confirmation_error", "dropped"))
    .then(readAt(1)).then(beginAt(1))
    .expect(s.o.reads == 3 and s.o.loaders == 3 and s.o.dumps == 0 and s.o.shadow == List("confirmation_error", "dropped"))

  run jobDeadlineThenReadDeadlineReportsOneVerdictTest = init.then(policyWith(20)).then(beginAt(0)).then(resolveWith(1)).then(advanceBy(10))
    .expect(s.o.shadow == List("timeout") and s.io.aborted == List())
    .then(beginAt(1))
    .expect(s.o.reads == 1 and s.o.shadow == List("timeout", "dropped"))
    .then(resolveWith(3)).then(advanceBy(10))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.io.aborted == List(0) and s.o.shadow == List("timeout", "dropped"))
    .then(readAt(0)).then(beginAt(1))
    .expect(s.o.reads == 2 and s.o.loaders == 3 and s.o.shadow == List("timeout", "dropped"))

  run confirmationKeepsCapturedReadBudgetTest = init.then(seedAt(0)).then(beginAt(0)).then(readAt(0)).then(policyWith(20))
    .then(resolveWith(2)).then(loadAt(0))
    .expect(s.io.budgets == List(5, 5))
    .then(advanceBy(5))
    .expect(s.o.shadow == List("confirmation_error") and s.io.aborted == List(1))
    .then(readAt(1)).then(beginAt(1))
    .expect(s.io.budgets == List(5, 5, 20) and s.o.reads == 3)

  run confirmationReadBudgetStartsAtItsOwnDispatchTest = init.then(seedAt(0)).then(beginAt(0)).then(readAt(0)).then(advanceBy(4))
    .then(resolveWith(2)).then(loadAt(0)).then(advanceBy(4))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List() and s.io.aborted == List())
    .then(advanceBy(1))
    .expect(s.o.shadow == List("confirmation_error") and s.io.aborted == List(1))

  run readBeforeDeadlineCanFillAndCancelsItsTimerTest = init.then(beginAt(0)).then(resolveWith(1)).then(advanceBy(4)).then(readAt(0))
    .then(dumpAt(0)).then(writeAt(0)).then(advanceBy(10))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.shadow == List("filled") and s.o.writes == 1 and s.io.aborted == List())
}

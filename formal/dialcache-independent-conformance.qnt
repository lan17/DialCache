module dialcache_independent_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import recovery as Recovery from "./kernel/recovery"
  import deadlines as Deadlines from "./kernel/deadlines"
  import remote_frames as Remote from "./kernel/remote-frames"
  import clock as Clock from "./kernel/clock"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Model boundary -----------------------------------------------------------
  // Six same-key callers with coalescing disabled exercise selected aspects of
  // C24/C56: each owns its read and source deadline. Read failure denies only
  // that caller's refill (C28); recovery keeps its captured policy, snapshot,
  // and original error (selected aspects of C36/C40-C46/C58).
  // See BEHAVIOR.md: "Generated feature profiles" and its independent input table.
  // No local/request storage, shadow work, or publication failures participate.
  // Every rule is a kernel transition (formal/kernel): the held remote
  // traversal (remote_io) with its recovery snapshots (recovery) under the
  // budgeted held lifecycle (deadlines), over the layered shape. This module
  // owns the bounded state, the fixture decoding (the read budget and recovery
  // maximum a policy code resolves to, the frame a seed choice names, the
  // loader and value a resolve code names), the input choices and the guards.
  // `now` is elapsed time; the wall clock is `now` plus a fixed skew. An
  // expired read stays held until its late reply drains and a loader stays
  // pending until its late result drains, so late settlement can be observed
  // without regaining ownership of a completed caller.

  // Trace encodings and fixture bounds ---------------------------------------
  // Keep integer input fields stable; shared results come from the import.
  pure val FRESH_AGE_MS = 1000
  pure val SOURCE_BUDGET_MS = 10
  pure val SHORT_READ_BUDGET_MS = 5
  pure val LONG_READ_BUDGET_MS = 10
  pure val SHORT_RETENTION_MS = 2000
  pure val LONG_RETENTION_MS = 5000
  pure val FIXTURE_TTL_MS = 60000
  pure val WALL_SKEW_MS = 100000
  pure val MAX_CALLS = 6
  pure val SOURCE_RESULT_COUNT = 2
  // One key on one instance, no request scope, no local capacity, one
  // operation per entity; the drivers never probe a source's scope.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true
  }
  pure val CALL: Call = { instance: 0, key: 0, context: 0, enabled: true, keyFailed: false }
  // Every reply enables the remote layer alone and never coalesces.
  pure val REMOTE_ONLY: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: false }

  // State: the layered shape with its held remote effects, recovery
  // snapshots and deadlines, plus the policy reply in force (`ttls`, whose
  // retention is the recovery maximum a later caller is admitted with) and
  // the read budget in force.
  type State = {
    o: Observation, io: RemoteIO::IO, now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    sourceBudget: int, deadlines: List[Deadlines::Due], drained: List[bool],
    ttls: Ttls, readBudget: int
  }
  var s: State
  var input: { name: str, choice: int }

  // Input decoding (reads no state) ------------------------------------------
  // The TTLs a reply carries under the policy in force: no local TTL, 1 s
  // freshness and the recovery maximum as retention. Wire choices 0/1 use the
  // long retention; parity chooses the read budget. Seeds store fresh values
  // and values just inside each admitted recovery age bound. A resolve code
  // 1..12 pairs each loader ordinal with result VALUE_ONE/VALUE_TWO.
  pure def ttlsFor(retentionMs: int): Ttls = { localMs: 0, freshMs: FRESH_AGE_MS, retentionMs: retentionMs }
  pure def readBudgetOf(choice: int): int = if (choice % 2 == 0) SHORT_READ_BUDGET_MS else LONG_READ_BUDGET_MS
  pure def retentionOf(choice: int): int = if (choice < 2) LONG_RETENTION_MS else SHORT_RETENTION_MS
  pure def seedValue(choice: int): int = if (choice == 2 or choice == 4) VALUE_TWO else VALUE_ONE
  pure def seedAge(choice: int): int =
    if (choice == 0 or choice == 4) 0 else if (choice == 3) 4999 else if (choice == 5) 1999 else 1000
  pure def resolvedSource(code: int): int = (code - 1) / SOURCE_RESULT_COUNT
  pure def resolvedValue(code: int): int = (code - 1) % SOURCE_RESULT_COUNT + 1

  // Initial fixture: value 1 stored at age 1,000 ms (stale, never fresh) with
  // a 60 s physical TTL above the zero watermark.
  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty, io: RemoteIO::NO_IO, now: 0, skew: WALL_SKEW_MS, remoteAvailable: true, tracked: true, capacity: 0,
      readFailed: false, dumpFailed: false, writeFailed: false,
      closed: List(), memo: List(), requestFlights: List(), processFlights: List(NO_OWNER),
      localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
      remoteValues: List(VALUE_ONE), created: List(WALL_SKEW_MS - FRESH_AGE_MS), expires: List(FIXTURE_TTL_MS), watermark: List(0),
      sources: List(), owners: List(), memoSlots: List(), held: List(),
      reads: List(), loads: List(), loaders: List(), retained: List(),
      sourceBudget: SOURCE_BUDGET_MS, deadlines: List(), drained: List(),
      ttls: ttlsFor(LONG_RETENTION_MS), readBudget: SHORT_READ_BUDGET_MS
    }
  }

  // Admission: the read is dispatched under the budget in force and its
  // flight carries the recovery maximum in force, both captured here. -------
  action beginCall = all {
    s.o.calls.length() < MAX_CALLS,
    input' = { name: "beginCall", choice: -1 },
    s' = Deadlines::begin(s, LAYOUT, CALL, REMOTE_ONLY, s.ttls, s.readBudget)
  }

  // External settlement by explicit effect index: the drivers release a held
  // read or decode by its index and settle a loader by its ordinal. ---------
  val heldReads = s.reads.indices().map(i => s.reads.nth(i).read)
  val heldLoads = s.loads.indices().map(i => s.loads.nth(i).load)
  action readAt(index: int): bool = all {
    RemoteIO::holdsRead(s, index),
    input' = { name: "releaseRead", choice: index },
    s' = Deadlines::settleRead(s, LAYOUT, index, false, Recovery::ALLOW)
  }
  action releaseRead = {
    nondet choice = heldReads.oneOf()
    readAt(choice)
  }
  action failReadAt(index: int): bool = all {
    RemoteIO::holdsRead(s, index),
    input' = { name: "failRead", choice: index },
    s' = Deadlines::settleRead(s, LAYOUT, index, true, Recovery::ALLOW)
  }
  action failRead = {
    nondet choice = heldReads.oneOf()
    failReadAt(choice)
  }
  action resolveWith(code: int): bool = all {
    resolvedSource(code) < s.loaders.length(),
    Deadlines::pending(s, resolvedSource(code)),
    input' = { name: "resolveLoader", choice: code },
    s' = Deadlines::settleLoader(s, LAYOUT, resolvedSource(code), resolvedValue(code), false)
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_CALLS * SOURCE_RESULT_COUNT).filter(code =>
      resolvedSource(code) < s.loaders.length() and Deadlines::pending(s, resolvedSource(code))).oneOf()
    resolveWith(choice)
  }
  action rejectAt(index: int): bool = all {
    index < s.loaders.length(),
    Deadlines::pending(s, index),
    input' = { name: "rejectLoader", choice: index },
    s' = Deadlines::settleLoader(s, LAYOUT, index, SOURCE_ERROR, false)
  }
  action rejectLoader = {
    nondet choice = s.loaders.indices().filter(i => Deadlines::pending(s, i)).oneOf()
    rejectAt(choice)
  }
  action loadAt(index: int): bool = all {
    RemoteIO::holdsLoad(s, index),
    input' = { name: "releaseLoad", choice: index },
    s' = Deadlines::settleLoad(s, LAYOUT, index, false)
  }
  action releaseLoad = {
    nondet choice = heldLoads.oneOf()
    loadAt(choice)
  }
  action failLoadAt(index: int): bool = all {
    RemoteIO::holdsLoad(s, index),
    input' = { name: "failLoad", choice: index },
    s' = Deadlines::settleLoad(s, LAYOUT, index, true)
  }
  action failLoad = {
    nondet choice = heldLoads.oneOf()
    failLoadAt(choice)
  }

  // Environmental clocks, storage, and policy --------------------------------
  action advanceBy(ms: int): bool = all {
    input' = { name: "advance", choice: ms }, s' = Deadlines::advance(s, LAYOUT, ms)
  }
  action advance = {
    nondet choice = Set(1, 5, 10, 1000).oneOf()
    advanceBy(choice)
  }
  action seedWith(choice: int): bool = all {
    (0.to(5)).contains(choice),
    input' = { name: "seed", choice: choice },
    s' = Remote::seedAged(s, 0, seedValue(choice), seedAge(choice), FIXTURE_TTL_MS)
  }
  action seed = {
    nondet choice = 0.to(5).oneOf()
    seedWith(choice)
  }
  action invalidate = all {
    input' = { name: "invalidate", choice: -1 },
    s' = Serving::invalidate(s, 0)
  }
  action policyWith(choice: int): bool = all {
    (0.to(3)).contains(choice),
    input' = { name: "policy", choice: choice },
    s' = { readBudget: readBudgetOf(choice), ttls: ttlsFor(retentionOf(choice)), ...s }
  }
  action policy = {
    nondet choice = 0.to(3).oneOf()
    policyWith(choice)
  }

  // Exploration schedule: preserve grouping and order for seeded sampling.
  action step = any {
    beginCall, releaseRead, any { resolveLoader, rejectLoader, releaseLoad },
    any { policy, seed }, any { advance, invalidate, failRead, failLoad }
  }

  // Invariants: independent checks over ownership and observed history. -----
  // Over the public channels, verbatim from the former text.
  val oneReadPerCall = s.o.reads == s.o.calls.length() and
    s.io.budgets.length() == s.o.reads and s.io.sourceErrors.length() == s.o.calls.length()
  val abortsAreUnique = s.io.aborted.indices().forall(i =>
    s.io.aborted.indices().forall(j => i == j or s.io.aborted.nth(i) != s.io.aborted.nth(j)))
  val writesKeepCapturedRetention = s.o.writeTtls.indices().forall(i =>
    s.o.writeTtls.nth(i) == SHORT_RETENTION_MS or s.o.writeTtls.nth(i) == LONG_RETENTION_MS)
  // Over the library records: the drivers' loaders are the loader ordinals,
  // and every held effect is one the drivers dispatched.
  val effectsMatchOwners = s.o.loaders == s.loaders.length() and
    s.reads.indices().forall(i => s.reads.nth(i).read < s.o.reads) and
    s.loads.indices().forall(i => s.loads.nth(i).load < s.o.loads)
  // A completed caller owns a flight whose result is recorded and on which no
  // read or decode is still held (a read whose deadline was delivered owns no
  // flight and is accepted).
  val completedCallsHaveNoActiveWork = s.o.calls.indices().forall(c => s.o.calls.nth(c) == CALL_PENDING or {
    val flight = s.owners.nth(c)
    flight >= 0 and s.sources.nth(flight).result != CALL_PENDING and
      s.reads.indices().forall(j => s.reads.nth(j).flight != flight) and
      s.loads.indices().forall(j => s.loads.nth(j).flight != flight)
  })
  // A candidate is retained only from a frame stale by at least the freshness
  // (its age only grows afterwards) and, at the read settlement that captured
  // it, inside the maximum admitted for its caller: read index i is caller i
  // in this profile (every caller dispatches exactly one read at admission),
  // so the snapshot judged at a releaseRead step is that of the read's
  // caller's flight.
  val retainedSnapshotsWereEligible = s.retained.indices().forall(i => {
    val snapshot = s.retained.nth(i)
    val age = Clock::wallOf(s) - snapshot.created
    snapshot.candidate == NO_VALUE or (age >= FRESH_AGE_MS and
      (input.name != "releaseRead" or snapshot.flight != s.owners.nth(input.choice) or age < snapshot.maximum))
  })
  // Every loader ordinal has exactly one source deadline while its work is
  // undelivered and its flight's result is pending, none otherwise: a
  // deadline belongs to its loader until that loader settles or expires. The
  // instant of each deadline (its loader's own start plus the configured
  // budget) is checked by the connection monitor's origins clause.
  val eachSourceKeepsItsFullBudget = s.loaders.indices().forall(k =>
    Deadlines::deadlinesOf(s, Deadlines::SOURCE, k).length() ==
      (if (Deadlines::pending(s, k) and s.sources.nth(s.loaders.nth(k)).result == CALL_PENDING) 1 else 0))
  // The former sourceSettlementsRespectOwnDeadline read a settlement instant
  // the held shape does not carry. Its statement is carried in writing: a
  // loader's outcome is DEADLINE_ERROR exactly when the fold delivered its
  // deadline at an instant at or after it (deadlines::deliver) or arrival
  // substituted it at a reached deadline (deadlines::arrival); any other
  // outcome is applied only while the deadline is pending. The connection
  // monitor's independentSourceOriginsMatchContract checks the deadline
  // instant while pending and the acceptance instant at each resolve; the
  // regressions staggeredSourcesExpireAtTheirOwnDeadlineTest and
  // staggeredSourceStartsKeepIndependentBudgetsTest and the kernel fixture
  // run readExpiryChainsIntoTheSameAdvanceTest pin the boundary.

  // Deterministic model regressions ------------------------------------------
  // Three former regressions patched private state (the stored frame, its
  // stamp, the policy maximum); each patch is now the input that produces it:
  // seedWith(2) stores value 2 at age 1000 (the former frame swap kept the
  // 1000 ms stamp), seedWith(0) stores value 1 at age 0 (the former
  // created := wall), policyWith(2) sets the short maximum with the read
  // budget unchanged (the former maxAge patch).
  run independentReadDeadlinesStartSeparateSourcesTest = init.then(beginCall).then(advanceBy(1)).then(beginCall)
    .then(advanceBy(1)).then(advanceBy(1)).then(advanceBy(1)).then(advanceBy(1))
    .expect(s.io.aborted == List(0) and s.o.loaders == 1)
    .then(advanceBy(1)).expect(s.io.aborted == List(0, 1) and s.o.loaders == 2)
  run independentRecoveryKeepsDistinctSnapshotsTest = init.then(beginCall).then(readAt(0))
    .then(seedWith(2)).then(beginCall).then(readAt(1))
    .then(rejectAt(0)).then(rejectAt(1)).then(invalidate)
    .then(loadAt(1)).then(loadAt(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.reads == 2 and s.o.writes == 0)
  run timedOutReadCannotAffectAnotherCallTest = init.then(beginCall).then(advanceBy(5))
    .then(beginCall).then(readAt(1)).then(readAt(0))
    .expect(s.o.loads == 0 and s.o.loaders == 2 and s.io.aborted == List(0))
  run acceptedFreshDecodeSurvivesOtherInvalidationTest = init.then(seedWith(0)).then(beginCall)
    .then(readAt(0)).then(invalidate).then(beginCall).then(readAt(1))
    .then(loadAt(0)).expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 1)
  run readFailureCannotBorrowAnotherCallsRefillTest = init.then(beginCall).then(beginCall)
    .then(failReadAt(0)).then(readAt(1))
    .then(resolveWith(4)).then(resolveWith(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.writes == 1 and s.remoteValues == List(VALUE_TWO))
  run recoveryPolicyIsCapturedPerCallerTest = init.then(beginCall).then(readAt(0))
    .then(policyWith(2)).then(beginCall).then(readAt(1))
    .then(rejectAt(0)).then(rejectAt(1)).then(advanceBy(1000))
    .then(loadAt(0)).then(loadAt(1))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR) and s.io.sourceErrors == List(0, 2) and s.o.recovery == List("served", "miss"))

  // Release the shorter-policy decode first, while the longer-policy caller
  // still waits. At exactly its captured maximum it preserves its own error;
  // the other caller can still recover the same acquired bytes.
  run independentRecoveryAtCapturedAgeBoundaryTest = init
    .then(beginCall).then(readAt(0)).then(policyWith(2))
    .then(beginCall).then(readAt(1)).then(rejectAt(0)).then(rejectAt(1))
    .then(advanceBy(1000)).then(loadAt(1))
    .expect(s.o.calls == List(CALL_PENDING, SOURCE_ERROR)
      and s.o.recovery == List("miss") and s.io.sourceErrors == List(0, 2))
    .then(loadAt(0))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR)
      and s.o.recovery == List("miss", "served") and s.o.reads == 2
      and s.o.loaders == 2 and s.o.loads == 2 and s.o.dumps == 0 and s.o.writes == 0)

  // Fenced storage removes recovery as a competing explanation. The later
  // source succeeds after the earlier caller's deadline, within its own budget.
  run staggeredSourceStartsKeepIndependentBudgetsTest = init.then(invalidate)
    .then(beginCall).then(readAt(0)).then(advanceBy(5)).then(beginCall).then(readAt(1))
    .then(advanceBy(5)).expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING))
    .then(advanceBy(1)).then(resolveWith(4))
    .expect(s.o.calls == List(DEADLINE_ERROR, VALUE_TWO) and s.o.loaders == 2
      and s.o.loads == 0 and s.o.writes == 1 and s.o.recovery == List("miss"))
  run staggeredSourcesExpireAtTheirOwnDeadlineTest = init.then(invalidate)
    .then(beginCall).then(readAt(0)).then(advanceBy(5)).then(beginCall).then(readAt(1))
    .then(advanceBy(5)).expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING))
    .then(advanceBy(1)).then(advanceBy(1)).then(advanceBy(1)).then(advanceBy(1))
    .expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING))
    .then(advanceBy(1)).expect(s.o.calls == List(DEADLINE_ERROR, DEADLINE_ERROR)
      and s.o.loaders == 2 and s.o.loads == 0 and s.o.writes == 0 and s.o.recovery == List("miss", "miss"))

  // Each caller retains the stale bytes its own read acquired. Replacing the
  // stored frame between the reads, then invalidating, changes neither served
  // recovery: both callers get their captured snapshot, and nothing is written.
  run independentRecoveriesServeDistinctAcquiredSnapshotsTest = init
    .then(beginCall).then(readAt(0)).then(seedWith(2))
    .then(beginCall).then(readAt(1)).then(rejectAt(0)).then(rejectAt(1)).then(invalidate)
    .then(loadAt(1)).then(loadAt(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.recovery == List("served", "served")
      and s.o.reads == 2 and s.o.loaders == 2 and s.o.loads == 2 and s.o.dumps == 0 and s.o.writes == 0)

  // A fresh hit retains nothing: when its decode fails, the loader it starts
  // cannot recover, and a rejection completes with the source error and the
  // loader's identity, unclassified.
  run freshDecodeFailureCannotRecoverTest = init.then(seedWith(0)).then(beginCall).then(readAt(0))
    .expect(s.o.loads == 1 and s.o.loaders == 0)
    .then(failLoadAt(0)).expect(s.o.loaders == 1 and s.o.calls == List(CALL_PENDING))
    .then(rejectAt(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 0 and s.o.recovery == List() and s.io.sourceErrors == List(1))
  // The loader a failed fresh decode starts carries no fence (C58): the frame
  // the read accepted had cleared the watermark, so a watermark raised since
  // the read does not fence its refill. The loader's value replaces the frame
  // with the reply's retention and the caller completes with it.
  run freshDecodeFailureRefillsUnfencedUnderARaisedWatermarkTest = init.then(seedWith(0)).then(beginCall).then(readAt(0))
    .then(invalidate).then(failLoadAt(0))
    .expect(s.o.loaders == 1 and s.sources.nth(0).fence == NO_FENCE and s.watermark.nth(0) == Clock::wallOf(s))
    .then(resolveWith(2))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 1 and s.o.writeTtls == List(LONG_RETENTION_MS)
      and s.remoteValues == List(VALUE_TWO) and s.o.recovery == List())
  // A visible frame the read declined as stale carries no fence (C58): the
  // frame itself cleared the watermark, so its miss refills unfenced, and the
  // refill is fresh for the next caller's read.
  run visibleStaleMissCarriesNoFenceAndRefillsTest = init.then(invalidate)
    .then(advanceBy(1000)).then(advanceBy(1000)).then(seedWith(1))
    .then(beginCall).then(readAt(0)).expect(s.o.loaders == 1 and s.o.loads == 0 and s.sources.nth(0).fence == NO_FENCE)
    .then(resolveWith(2))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 1 and s.o.writeTtls == List(LONG_RETENTION_MS))
    .then(beginCall).then(readAt(1)).expect(s.o.loads == 1 and s.o.loaders == 1)
  // A read left pending expires inside one long advance and starts its loader
  // at the read's own due instant, so the loader's deadline, measured from
  // there, is delivered inside the same advance: the caller completes with a
  // deadline error, the read is aborted and its loader counted before the
  // advance ends. Delivering at the advance's end instead would leave the
  // caller pending with its loader due after the advance.
  run readExpiryStartsItsLoaderAtTheReadsDueInstantTest = init.then(beginCall).then(advanceBy(1000))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.io.aborted == List(0) and s.o.loaders == 1 and s.o.loads == 0 and s.now == 1000)
}

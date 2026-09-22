// The held remote traversal (remote_io) with its recovery snapshots and
// budgeted variants (deadlines): one key, one instance, two persistent
// contexts, replies immediate unless a run holds one, reads and decodes held
// and released by index, loaders settled by ordinal. Pins the seams the
// scheduled profiles reach only through their own fixtures: the read counted
// at dispatch and the frame judged at settlement; a follower joining a
// pending read, or a flight holding its recovery decode, and completing with
// its leader; a shared miss running one loader; the drivers' loader ordinal
// mapped to its flight, for a loader started at a read's settlement, for a
// source a release starts without the remote layer and for the bypass source
// of a scope closed between admission and release; a failed read denying only
// its own refill; a visible stale frame carrying no fence while an absent one
// carries the watermark; a failed fresh decode restarting a loader without
// recovery, unfenced under a watermark raised since the read so its refill
// writes; a read expiry inside an advance starting a loader whose own
// deadline the same advance delivers, the late replies draining afterwards,
// also under a zero source budget; an undelivered read deadline cancelling on
// arrival; a late result settling as a deadline error and recovering; a
// delivered loader deadline holding a recovery decode; a failed recovery
// decode completing with the loader's own error; an overdue deadline
// delivered at the next visited instant; the timeout-only, DENY and NONE
// classifiers, a deadline error counting as a timeout for the timeout-only
// one whether delivered (`deliveredDeadlineIsATimeoutForTimeoutOnlyTest`) or
// arriving late (`lateResultIsATimeoutForTimeoutOnlyTest`); a recovery decode
// released at exactly the captured maximum; a held decode and an untracked
// loader warming local storage for the reply's local TTL while a tracked
// loader waits for a validated read, and warming nothing under a reply that
// leaves the local layer off (`replyWithoutLocalLayerWarmsNothingTest`); a
// bypass admission source taking an ordinal. Every step keeps the drivers'
// loader ordinals aligned with the flights they run for
// (`ordinalsMatchLoaders`).
module held_remote {
  import conformance_observations.* from "../../conformance-observations"
  import encodings.* from "../../kernel/encodings"
  import calls.* from "../../kernel/calls"
  import layer_policy.* from "../../kernel/layer-policy"
  import serving as Serving from "../../kernel/serving"
  import remote_io as RemoteIO from "../../kernel/remote-io"
  import recovery as Recovery from "../../kernel/recovery"
  import deadlines as Deadlines from "../../kernel/deadlines"
  import remote_frames as Remote from "../../kernel/remote-frames"
  import clock as Clock from "../../kernel/clock"
  import policy_gate as Gate from "../../kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true }
  pure val SHARED: Resolution = { layers: { request: true, local: false, remote: true }, coalesce: true }
  pure val ALONE: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: false }
  // Replies with the local layer on: over every layer, and without the remote layer.
  pure val WITH_LOCAL: Resolution = { layers: { request: true, local: true, remote: true }, coalesce: true }
  pure val LOCAL_ALONE: Resolution = { layers: { request: false, local: true, remote: false }, coalesce: false }
  pure val TTLS: Ttls = { localMs: 0, freshMs: 1000, retentionMs: 5000 }
  pure val LOCAL_TTLS: Ttls = { localMs: 1000, freshMs: 1000, retentionMs: 5000 }
  pure val READ_BUDGET = 5
  pure val SOURCE_BUDGET = 10
  pure def call(context: int): Call = { instance: 0, key: 0, context: context, enabled: true, keyFailed: false }
  // A caller that makes no policy call: a disabled context, or a key that failed to construct.
  pure def bypass(keyFailed: bool): Call = { instance: 0, key: 0, context: 0, enabled: false, keyFailed: keyFailed }

  type State = {
    o: Observation, io: RemoteIO::IO, now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    sourceBudget: int, deadlines: List[Deadlines::Due], drained: List[bool]
  }
  var s: State
  var input: { name: str, choice: int }

  // A stale frame (age 1000 at freshness 1000, stamped above the zero
  // watermark) is present at init: visible, never fresh. The tracked
  // reader has no local capacity; `localInit` and `untrackedLocalInit` give
  // it one slot; `zeroBudgetInit` starts every loader with a zero budget.
  pure def initial(tracked: bool, capacity: int, sourceBudget: int): State = {
    o: empty, io: RemoteIO::NO_IO, now: 0, skew: 100000, remoteAvailable: true, tracked: tracked, capacity: capacity,
    readFailed: false, dumpFailed: false, writeFailed: false,
    closed: List(false, false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER),
    localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
    remoteValues: List(VALUE_ONE), created: List(99000), expires: List(60000), watermark: List(0),
    sources: List(), owners: List(), memoSlots: List(), held: List(),
    reads: List(), loads: List(), loaders: List(), retained: List(),
    sourceBudget: sourceBudget, deadlines: List(), drained: List()
  }
  action initialize(tracked: bool, capacity: int, sourceBudget: int): bool = all {
    s' = initial(tracked, capacity, sourceBudget), input' = { name: "init", choice: -1 }
  }
  action init = initialize(true, 0, SOURCE_BUDGET)
  action localInit = initialize(true, 1, SOURCE_BUDGET)
  action untrackedLocalInit = initialize(false, 1, SOURCE_BUDGET)
  action zeroBudgetInit = initialize(true, 0, 0)

  // The drivers' loader ordinals are the flights' loaders: one ordinal and one
  // drained flag per counted loader, after every step.
  val ordinalsMatchLoaders = s.loaders.length() == s.o.loaders and s.drained.length() == s.o.loaders

  action beginWith(context: int, resolved: Resolution, ttls: Ttls): bool = all {
    s' = Deadlines::begin(s, LAYOUT, call(context), resolved, ttls, READ_BUDGET),
    input' = { name: "beginCall", choice: context }
  }.expect(ordinalsMatchLoaders)
  action begin(context: int, resolved: Resolution): bool = beginWith(context, resolved, TTLS)
  action beginBypass(keyFailed: bool): bool = all {
    s' = Deadlines::begin(s, LAYOUT, bypass(keyFailed), ALONE, TTLS, READ_BUDGET),
    input' = { name: "beginCall", choice: if (keyFailed) 1 else 0 }
  }.expect(ordinalsMatchLoaders)
  // A policy reply the drivers hold: admission alone, then the release by its
  // policy call (the drivers' `release policy <index>`).
  action admitHeld(context: int): bool = all {
    s' = Deadlines::admit(s, LAYOUT, call(context)),
    input' = { name: "beginCall", choice: context }
  }.expect(ordinalsMatchLoaders)
  action releaseHeld(policyCall: int, resolved: Resolution): bool = all {
    s' = Deadlines::release(s, LAYOUT, policyCall, resolved, TTLS, READ_BUDGET),
    input' = { name: "releasePolicy", choice: policyCall }
  }.expect(ordinalsMatchLoaders)
  action closeScope(context: int): bool = all {
    s' = Serving::closeScope(s, LAYOUT, context),
    input' = { name: "closeScope", choice: context }
  }.expect(ordinalsMatchLoaders)
  action readWith(index: int, failed: bool, classifier: int): bool = all {
    s' = Deadlines::settleRead(s, LAYOUT, index, failed, classifier),
    input' = { name: if (failed) "failRead" else "releaseRead", choice: index }
  }.expect(ordinalsMatchLoaders)
  action read(index: int, failed: bool): bool = readWith(index, failed, Recovery::ALLOW)
  action load(index: int, failed: bool): bool = all {
    s' = Deadlines::settleLoad(s, LAYOUT, index, failed),
    input' = { name: if (failed) "failLoad" else "releaseLoad", choice: index }
  }.expect(ordinalsMatchLoaders)
  action settle(ordinal: int, value: int): bool = all {
    s' = Deadlines::settleLoader(s, LAYOUT, ordinal, value, false),
    input' = { name: "resolveLoader", choice: ordinal }
  }.expect(ordinalsMatchLoaders)
  // A propagated timeout the profile names (the recovery drivers' rejectTimeout).
  action timeout(ordinal: int): bool = all {
    s' = Deadlines::settleLoader(s, LAYOUT, ordinal, SOURCE_ERROR, true),
    input' = { name: "rejectTimeout", choice: ordinal }
  }.expect(ordinalsMatchLoaders)
  action advance(ms: int): bool = all { s' = Deadlines::advance(s, LAYOUT, ms), input' = { name: "advance", choice: ms } }.expect(ordinalsMatchLoaders)
  // A clock move without timer delivery (effects' jumpClock).
  action jump(ms: int): bool = all { s' = Clock::advance(s, ms), input' = { name: "jumpClock", choice: ms } }
  action seed(value: int, age: int): bool = all { s' = Remote::seedAged(s, 0, value, age, 60000), input' = { name: "seed", choice: value } }
  action invalidate = all { s' = Serving::invalidate(s, 0, 0), input' = { name: "invalidate", choice: -1 } }

  // The read is counted at dispatch with its budget and registers its flight
  // without a loader; the frame is judged at settlement, so a fresh seed
  // between the two turns the stale read into a held decode, whose value is
  // the one it was held with whatever is stored when it settles.
  run frameIsJudgedAtSettlementTest = init.then(begin(0, ALONE))
    .expect(s.o.reads == 1 and s.o.loads == 0 and s.io.budgets == List(READ_BUDGET) and s.sources.length() == 1 and s.o.loaders == 0
      and RemoteIO::holdsRead(s, 0) and Deadlines::bounded(s, Deadlines::READ, 0))
    .then(seed(VALUE_TWO, 0)).then(read(0, false))
    .expect(s.o.loads == 1 and s.o.loaders == 0 and RemoteIO::heldLoad(s, 0).value == VALUE_TWO and not(RemoteIO::holdsRead(s, 0)) and s.deadlines == List())
    .then(seed(VALUE_ONE, 0)).then(load(0, false))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 0 and not(RemoteIO::holdsLoad(s, 0)))
  // A follower released while the leader's read is pending joins its flight
  // (no read of its own) and completes with it at decode settlement; both
  // memoize into their scopes and the flight leaves the registries.
  run followerJoinsPendingReadTest = init.then(seed(VALUE_ONE, 0)).then(begin(0, SHARED)).then(begin(1, SHARED))
    .expect(s.o.reads == 1 and s.o.policyCalls == 2 and s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.owners == List(0, 0)
      and s.processFlights == List(0) and s.sources.length() == 1)
    .then(read(0, false)).expect(s.o.loads == 1 and s.o.loaders == 0)
    .then(load(0, false))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.memo == List(VALUE_ONE, VALUE_ONE) and s.processFlights == List(NO_OWNER) and s.o.loaders == 0)
  // A shared miss starts one loader when its read settles, bounded from then;
  // its settlement completes every joined caller and writes once.
  run sharedMissStartsOneLoaderTest = init.then(begin(0, SHARED)).then(begin(1, SHARED)).then(read(0, false))
    .expect(s.o.loaders == 1 and s.loaders == List(0) and s.sources.length() == 1 and s.sources.nth(0).retentionMs == TTLS.retentionMs
      and Deadlines::bounded(s, Deadlines::SOURCE, 0) and Deadlines::deadlineOf(s, Deadlines::SOURCE, 0) == SOURCE_BUDGET)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.writes == 1 and s.memo == List(VALUE_TWO, VALUE_TWO) and s.retained == List())
  // A hit flight runs no loader, so the next flight's loader is ordinal 0 and
  // maps to flight 1: settling ordinal 0 completes flight 1.
  run ordinalMapsToFlightTest = init.then(seed(VALUE_ONE, 0)).then(begin(0, SHARED)).then(read(0, false)).then(load(0, false))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0 and s.sources.length() == 1)
    .then(advance(1000)).then(begin(1, SHARED)).then(read(1, false))
    .expect(s.o.loaders == 1 and s.loaders == List(1) and s.sources.length() == 2 and s.sources.nth(1).result == CALL_PENDING)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.writes == 1 and s.sources.nth(1).result == VALUE_TWO)
  // A failed read denies its own flight's refill and nothing else.
  run failedReadDeniesOnlyItsRefillTest = init.then(begin(0, ALONE)).then(begin(0, ALONE))
    .expect(s.o.reads == 2 and s.io.budgets == List(READ_BUDGET, READ_BUDGET))
    .then(read(0, true)).then(read(1, false))
    .expect(s.o.loaders == 2 and s.loaders == List(0, 1) and s.sources.nth(0).retentionMs == 0
      and s.sources.nth(1).retentionMs == TTLS.retentionMs and s.sources.nth(1).fence == NO_FENCE
      and Recovery::retainedFor(s, 1).candidate == VALUE_ONE and Recovery::retainedFor(s, 0).flight == NO_OWNER)
    .then(settle(1, VALUE_TWO)).then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.writes == 1 and s.o.writeTtls == List(TTLS.retentionMs)
      and s.remoteValues == List(VALUE_TWO) and s.retained == List())
  // A visible stale frame (stamped after the watermark, past freshness)
  // carries no fence and is the recovery candidate; an absent frame's read
  // carries the watermark it observed, which refuses a write at that same
  // wall instant, and retains no candidate.
  run visibleStaleMissCarriesNoFenceTest = init.then(invalidate).then(advance(1500)).then(seed(VALUE_ONE, 1000))
    .then(begin(0, ALONE)).then(read(0, false))
    .expect(s.o.loaders == 1 and s.sources.nth(0).fence == NO_FENCE and s.sources.nth(0).retentionMs == TTLS.retentionMs
      and Recovery::retainedFor(s, 0).candidate == VALUE_ONE)
    .then(advance(1)).then(invalidate).then(begin(0, ALONE)).then(read(1, false))
    .expect(s.watermark == List(101501) and s.sources.nth(1).fence == 101501 and Recovery::retainedFor(s, 1).candidate == NO_VALUE)
    .then(settle(1, VALUE_TWO)).expect(s.o.calls == List(CALL_PENDING, VALUE_TWO) and s.o.writes == 0)
    .then(settle(0, VALUE_TWO)).expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.writes == 1 and s.o.writeTtls == List(TTLS.retentionMs))
  // A failed fresh decode starts a loader on the same flight with refill
  // allowed, unfenced (the frame it decoded was visible) and without a
  // snapshot: under a watermark raised between the read and the decode, its
  // refill still writes at the invalidation's own wall instant, where a miss
  // fence would refuse it. Its ordinary error completes the flight
  // unclassified with the loader's identity.
  run failedFreshDecodeRestartsWithoutRecoveryTest = init.then(seed(VALUE_ONE, 0)).then(begin(0, ALONE)).then(read(0, false)).then(invalidate).then(load(0, true))
    .expect(s.o.loaders == 1 and s.loaders == List(0) and s.watermark == List(100000) and s.sources.nth(0).retentionMs == TTLS.retentionMs
      and s.sources.nth(0).fence == NO_FENCE and s.retained == List() and Deadlines::bounded(s, Deadlines::SOURCE, 0))
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 1 and s.remoteValues == List(VALUE_TWO) and s.io.sourceErrors == List(0))
    .then(advance(1)).then(seed(VALUE_ONE, 0)).then(begin(0, ALONE)).then(read(1, false)).then(load(1, true))
    .expect(s.o.loaders == 2 and s.loaders == List(0, 1) and s.retained == List())
    .then(settle(1, SOURCE_ERROR))
    .expect(s.o.calls == List(VALUE_TWO, SOURCE_ERROR) and s.o.classifications == 0 and s.o.recovery == List() and s.io.sourceErrors == List(0, 2))
  // A read deadline delivered inside an advance aborts the read, starts a
  // loader with refill denied at that instant, and the same advance delivers
  // that loader's own deadline; the expired read stays until its late reply
  // drains, and the loader's late result drains its work.
  run readExpiryChainsIntoTheSameAdvanceTest = init.then(begin(0, ALONE)).then(advance(1000))
    .expect(s.io.aborted == List(0) and s.o.loaders == 1 and s.o.calls == List(DEADLINE_ERROR) and s.sources.nth(0).retentionMs == 0
      and s.deadlines == List() and RemoteIO::holdsRead(s, 0) and Deadlines::pending(s, 0) and s.now == 1000 and s.o.classifications == 0)
    .then(read(0, false)).expect(not(RemoteIO::holdsRead(s, 0)) and s.o.loads == 0 and s.o.loaders == 1)
    .then(settle(0, VALUE_ONE)).expect(s.o.calls == List(DEADLINE_ERROR) and s.o.writes == 0 and not(Deadlines::pending(s, 0)))
  // A read deadline the clock passed without delivery cancels the read when
  // its reply arrives: the reply drains and the loader starts with refill denied.
  run undeliveredReadDeadlineCancelsOnArrivalTest = init.then(begin(0, ALONE)).then(jump(5)).then(read(0, false))
    .expect(s.io.aborted == List(0) and s.o.loaders == 1 and s.o.loads == 0 and s.sources.nth(0).retentionMs == 0
      and not(RemoteIO::holdsRead(s, 0)) and Deadlines::deadlineOf(s, Deadlines::SOURCE, 0) == 5 + SOURCE_BUDGET)
  // A result arriving after a deadline the clock passed without delivery is a
  // deadline error, classified once and recovered from the retained candidate;
  // the flight's recorded outcome stays the loader's.
  run lateResultIsADeadlineErrorTest = init.then(begin(0, ALONE)).then(read(0, false)).then(jump(10)).then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(CALL_PENDING) and s.sources.nth(0).result == DEADLINE_ERROR and s.o.classifications == 1 and s.o.loads == 1
      and s.o.writes == 0 and not(Deadlines::pending(s, 0)))
    .then(load(0, false))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.o.writes == 0 and s.retained == List()
      and s.sources.nth(0).result == DEADLINE_ERROR and s.io.sourceErrors == List(0))
  // A deadline the clock passed without delivery is delivered at the first
  // instant the next advance visits, not before the move: the candidate that
  // was still within its maximum at the jump has aged out by then.
  run overdueDeadlineDeliversAtTheNextInstantTest = init.then(seed(VALUE_ONE, 4982)).then(begin(0, ALONE)).then(read(0, false))
    .expect(Recovery::retainedFor(s, 0).candidate == VALUE_ONE and Deadlines::deadlineOf(s, Deadlines::SOURCE, 0) == SOURCE_BUDGET)
    .then(jump(15)).then(advance(5))
    .expect(s.now == 20 and s.o.calls == List(DEADLINE_ERROR) and s.o.classifications == 1 and s.o.recovery == List("miss") and s.o.loads == 0
      and s.deadlines == List())
  // The timeout-only classifier recovers a propagated timeout but not an
  // ordinary error, and is never counted.
  run timeoutOnlyClassifierTest = init.then(begin(0, ALONE)).then(readWith(0, false, Recovery::TIMEOUT_ONLY)).then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 0 and s.o.recovery == List() and s.io.sourceErrors == List(1))
    .then(begin(0, ALONE)).then(readWith(1, false, Recovery::TIMEOUT_ONLY)).then(timeout(1))
    .expect(s.o.calls == List(SOURCE_ERROR, CALL_PENDING) and s.o.classifications == 0 and s.o.loads == 1)
    .then(load(0, false))
    .expect(s.o.calls == List(SOURCE_ERROR, VALUE_ONE) and s.o.recovery == List("served") and s.io.sourceErrors == List(1, 0))
  // A deadline error is a timeout for the recovery rules: under the
  // timeout-only classifier a delivered loader deadline holds a recovery
  // decode, uncounted, and the candidate serves.
  run deliveredDeadlineIsATimeoutForTimeoutOnlyTest = init.then(begin(0, ALONE)).then(readWith(0, false, Recovery::TIMEOUT_ONLY)).then(advance(SOURCE_BUDGET))
    .expect(s.now == SOURCE_BUDGET and s.o.calls == List(CALL_PENDING) and s.o.loads == 1 and s.o.classifications == 0
      and s.sources.nth(0).result == DEADLINE_ERROR and Deadlines::pending(s, 0))
    .then(load(0, false))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.o.classifications == 0 and s.io.sourceErrors == List(0))
  // So does a result arriving after a deadline the clock passed undelivered.
  run lateResultIsATimeoutForTimeoutOnlyTest = init.then(begin(0, ALONE)).then(readWith(0, false, Recovery::TIMEOUT_ONLY)).then(jump(SOURCE_BUDGET)).then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.loads == 1 and s.o.classifications == 0 and s.sources.nth(0).result == DEADLINE_ERROR
      and s.o.writes == 0 and not(Deadlines::pending(s, 0)))
    .then(load(0, false))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.o.classifications == 0 and s.io.sourceErrors == List(0))
  // A recovery decode released at exactly the captured maximum misses and
  // keeps the loader's error and identity.
  run recoveryAtCapturedMaximumMissesTest = init.then(begin(0, ALONE)).then(read(0, false)).then(settle(0, SOURCE_ERROR))
    .expect(s.o.loads == 1 and s.o.classifications == 1)
    .then(advance(1000)).then(advance(1000)).then(advance(1000)).then(advance(1000)).then(load(0, false))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.recovery == List("miss") and s.io.sourceErrors == List(1) and s.retained == List())
  // An expired read released later drains: no second effect.
  run expiredReadDrainsTest = init.then(begin(0, ALONE)).then(advance(5)).then(read(0, false))
    .expect(s.o.loaders == 1 and s.o.loads == 0 and s.o.reads == 1 and s.io.aborted == List(0) and not(RemoteIO::holdsRead(s, 0)) and s.sources.length() == 1)
  // A profile without stale-on-error passes NONE: a stale visible frame is
  // never retained, and the loader's error completes without classification
  // or a miss.
  run noneClassifierNeverRetainsTest = init.then(begin(0, ALONE)).then(readWith(0, false, Recovery::NONE))
    .expect(s.o.loaders == 1 and s.retained == List())
    .then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 0 and s.o.recovery == List() and s.io.sourceErrors == List(1))
  // A DENY classifier retains the candidate and counts its classification,
  // but never recovers and reports no miss: the flight completes with the
  // loader's error and identity, for an ordinary error and for a propagated
  // timeout alike.
  run denyClassifierClassifiesWithoutRecoveringTest = init.then(begin(0, ALONE)).then(readWith(0, false, Recovery::DENY))
    .expect(s.o.loaders == 1 and Recovery::retainedFor(s, 0).candidate == VALUE_ONE)
    .then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 1 and s.o.recovery == List() and s.o.loads == 0
      and s.retained == List() and s.io.sourceErrors == List(1))
    .then(begin(0, ALONE)).then(readWith(1, false, Recovery::DENY)).then(timeout(1))
    .expect(s.o.calls == List(SOURCE_ERROR, SOURCE_ERROR) and s.o.classifications == 2 and s.o.recovery == List() and s.o.loads == 0
      and s.retained == List() and s.io.sourceErrors == List(1, 2))
  // A follower released while the leader's flight holds its recovery decode
  // joins the flight (still registered, no read of its own) and completes
  // with the recovered value; both memoize and the flight then leaves the
  // registries.
  run followerJoinsRecoveringFlightTest = init.then(begin(0, SHARED)).then(read(0, false)).then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.loads == 1 and s.o.classifications == 1 and s.processFlights == List(0)
      and s.sources.nth(0).result == SOURCE_ERROR and RemoteIO::heldLoad(s, 0).recovery and RemoteIO::heldLoad(s, 0).ttls == NO_TTLS)
    .then(begin(1, SHARED))
    .expect(s.o.reads == 1 and s.o.loaders == 1 and s.owners == List(0, 0) and s.o.calls == List(CALL_PENDING, CALL_PENDING))
    .then(load(0, false))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.recovery == List("served") and s.processFlights == List(NO_OWNER)
      and s.memo == List(VALUE_ONE, VALUE_ONE) and s.io.sourceErrors == List(0, 0) and s.o.writes == 0)
  // A delivered loader deadline is a timeout the flight recovers from: the
  // decode is held with the callers pending and the work undrained; the late
  // result then drains without effect.
  run deliveredDeadlineHoldsRecoveryDecodeTest = init.then(begin(0, ALONE)).then(read(0, false)).then(advance(SOURCE_BUDGET))
    .expect(s.now == SOURCE_BUDGET and s.o.calls == List(CALL_PENDING) and s.o.loads == 1 and s.o.classifications == 1
      and s.sources.nth(0).result == DEADLINE_ERROR and s.deadlines == List() and Deadlines::pending(s, 0))
    .then(load(0, false))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.io.sourceErrors == List(0) and s.retained == List())
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.writes == 0 and not(Deadlines::pending(s, 0)))
  // A failed recovery decode completes the flight with the outcome its source
  // recorded: the loader's ordinary error with its identity, or the deadline
  // error of a late result without one.
  run failedRecoveryDecodeKeepsLoaderErrorTest = init.then(begin(0, ALONE)).then(read(0, false)).then(settle(0, SOURCE_ERROR))
    .expect(s.o.loads == 1 and s.o.calls == List(CALL_PENDING))
    .then(load(0, true))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.recovery == List("deserialization_error") and s.io.sourceErrors == List(1) and s.retained == List())
    .then(begin(0, ALONE)).then(read(1, false)).then(jump(SOURCE_BUDGET)).then(settle(1, VALUE_TWO))
    .expect(s.o.calls == List(SOURCE_ERROR, CALL_PENDING) and s.o.loads == 2 and s.sources.nth(1).result == DEADLINE_ERROR)
    .then(load(1, true))
    .expect(s.o.calls == List(SOURCE_ERROR, DEADLINE_ERROR) and s.o.recovery == List("deserialization_error", "deserialization_error")
      and s.io.sourceErrors == List(1, 0))
  // A held fresh decode warms local storage for the reply's local TTL, and the
  // next caller is served locally without a read.
  run heldDecodeWarmsLocalForTheReplysLocalTtlTest = localInit.then(seed(VALUE_TWO, 0)).then(beginWith(0, WITH_LOCAL, LOCAL_TTLS))
    .expect(s.o.reads == 1 and RemoteIO::heldRead(s, 0).ttls == LOCAL_TTLS)
    .then(read(0, false)).expect(s.o.loads == 1 and s.localValues == List(NO_VALUE))
    .then(load(0, false))
    .expect(s.o.calls == List(VALUE_TWO) and s.localValues == List(VALUE_TWO) and s.localExpires == List(LOCAL_TTLS.localMs) and s.o.loaders == 0)
    .then(beginWith(1, WITH_LOCAL, LOCAL_TTLS))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 1 and s.o.loads == 1)
  // A tracked flight that read the remote layer may not warm local storage
  // from its loader; the next caller's validated remote hit does.
  run trackedLoaderWaitsForAValidatedReadToWarmLocalTest = localInit.then(beginWith(0, WITH_LOCAL, LOCAL_TTLS)).then(read(0, false))
    .expect(s.o.loaders == 1 and s.sources.nth(0).localMs == 0 and s.sources.nth(0).retentionMs == LOCAL_TTLS.retentionMs)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 1 and s.localValues == List(NO_VALUE))
    .then(beginWith(1, WITH_LOCAL, LOCAL_TTLS)).then(read(1, false)).then(load(0, false))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 2 and s.o.loads == 1 and s.localValues == List(VALUE_TWO))
  // An untracked flight's loader warms local storage for the reply's local TTL.
  run untrackedLoaderWarmsLocalForTheReplysLocalTtlTest = untrackedLocalInit.then(beginWith(0, WITH_LOCAL, LOCAL_TTLS)).then(read(0, false))
    .expect(s.o.loaders == 1 and s.sources.nth(0).localMs == LOCAL_TTLS.localMs)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 1 and s.localValues == List(VALUE_TWO))
    .then(beginWith(1, WITH_LOCAL, LOCAL_TTLS))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 1)
  // A reply that leaves the local layer off resolves its held read to a zero
  // local TTL whatever the policy's (`effectiveTtls`): neither the held fresh
  // decode nor the untracked loader of the next miss warms local storage.
  run replyWithoutLocalLayerWarmsNothingTest = untrackedLocalInit.then(seed(VALUE_TWO, 0)).then(beginWith(0, ALONE, LOCAL_TTLS))
    .expect(RemoteIO::heldRead(s, 0).ttls == { localMs: 0, freshMs: LOCAL_TTLS.freshMs, retentionMs: LOCAL_TTLS.retentionMs })
    .then(read(0, false)).then(load(0, false))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loaders == 0 and s.localValues == List(NO_VALUE))
    .then(advance(1000)).then(beginWith(1, ALONE, LOCAL_TTLS)).then(read(1, false))
    .expect(s.o.loaders == 1 and s.sources.nth(1).localMs == 0 and s.sources.nth(1).retentionMs == LOCAL_TTLS.retentionMs)
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_ONE) and s.o.writes == 1 and s.localValues == List(NO_VALUE))
  // A loader started by a read expiry under a zero source budget is due at
  // the instant it starts and is delivered inside the same advance, at the
  // next instant the fold visits.
  run zeroBudgetLoaderStartedByExpiryDeliversInTheSameAdvanceTest = zeroBudgetInit.then(begin(0, ALONE)).then(advance(READ_BUDGET))
    .expect(s.now == READ_BUDGET and s.io.aborted == List(0) and s.o.loaders == 1 and s.o.calls == List(DEADLINE_ERROR)
      and s.o.classifications == 0 and s.o.recovery == List() and s.deadlines == List() and Deadlines::pending(s, 0))
  // A reply without the remote layer starts its source at release under the
  // next loader ordinal, bounded by the source budget from its own start:
  // each such source expires at its own deadline, and a settled one completes
  // its caller and warms local storage for the reply's local TTL.
  run releaseWithoutRemoteTakesAnOrdinalTest = localInit.then(beginWith(0, LOCAL_ALONE, LOCAL_TTLS))
    .expect(s.o.loaders == 1 and s.loaders == List(0) and s.o.reads == 0 and s.sources.nth(0).localMs == LOCAL_TTLS.localMs
      and s.sources.nth(0).retentionMs == 0 and Deadlines::deadlineOf(s, Deadlines::SOURCE, 0) == SOURCE_BUDGET)
    .then(advance(5)).then(beginWith(0, LOCAL_ALONE, LOCAL_TTLS))
    .expect(s.o.loaders == 2 and s.loaders == List(0, 1) and Deadlines::deadlineOf(s, Deadlines::SOURCE, 1) == 5 + SOURCE_BUDGET)
    .then(advance(5))
    .expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING) and s.deadlines == List({ kind: Deadlines::SOURCE, index: 1, at: 5 + SOURCE_BUDGET }))
    .then(settle(1, VALUE_ONE))
    .expect(s.o.calls == List(DEADLINE_ERROR, VALUE_ONE) and s.o.writes == 0 and s.localValues == List(VALUE_ONE)
      and s.localExpires == List(SOURCE_BUDGET + LOCAL_TTLS.localMs))
  // A scope closed between admission and a held release resolves to the
  // bypass reply: the source starts unshared under the next ordinal with no
  // publication authority, bounded like every release-started source, and
  // its value completes the caller without memoizing into the closed scope.
  run closedScopeReleaseBypassesWithAnOrdinalTest = init.then(admitHeld(1))
    .expect(s.o.policyCalls == 1 and Gate::holds(s, 0) and s.o.loaders == 0)
    .then(closeScope(1)).then(releaseHeld(0, SHARED))
    .expect(s.o.loaders == 1 and s.loaders == List(0) and s.o.reads == 0 and not(Gate::holding(s))
      and s.sources.nth(0).retentionMs == 0 and s.sources.nth(0).localMs == 0 and not(s.sources.nth(0).shared)
      and Deadlines::deadlineOf(s, Deadlines::SOURCE, 0) == SOURCE_BUDGET)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 0 and s.memo == List(NO_VALUE, NO_VALUE) and s.remoteValues == List(VALUE_ONE))
  // A caller that makes no policy call starts its bypass source at admission:
  // the source takes the next loader ordinal, no read, and the admission
  // budget (unbounded unless its key failed to construct).
  run admissionSourceHasAnOrdinalTest = init.then(beginBypass(false))
    .expect(s.o.loaders == 1 and s.loaders == List(0) and s.o.reads == 0 and s.o.policyCalls == 0 and s.deadlines == List()
      and Deadlines::pending(s, 0) and s.io.sourceErrors == List(0))
    .then(beginBypass(true))
    .expect(s.o.loaders == 2 and s.loaders == List(0, 1) and Deadlines::deadlineOf(s, Deadlines::SOURCE, 1) == SOURCE_BUDGET
      and not(Deadlines::bounded(s, Deadlines::SOURCE, 0)))
    .then(settle(1, SOURCE_ERROR)).expect(s.o.calls == List(CALL_PENDING, SOURCE_ERROR) and s.io.sourceErrors == List(0, 2))
    .then(settle(0, VALUE_ONE)).expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR) and s.o.writes == 0)
}

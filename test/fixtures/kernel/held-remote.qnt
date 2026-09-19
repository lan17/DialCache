// The held remote traversal (remote_io) with its recovery snapshots and
// budgeted variants (deadlines): one key, one instance, two persistent
// contexts, replies immediate, reads and decodes held and released by index,
// loaders settled by ordinal. Pins the seams the scheduled profiles reach only
// through their own fixtures: the read counted at dispatch and the frame
// judged at settlement; a follower joining a pending read and completing with
// its leader; a shared miss running one loader; the drivers' loader ordinal
// mapped to its flight; a failed read denying only its own refill; a visible
// stale frame carrying no fence while an absent one carries the watermark; a
// failed fresh decode restarting a loader without recovery; a read expiry
// inside an advance starting a loader whose own deadline the same advance
// delivers, the late replies draining afterwards; an undelivered read deadline
// cancelling on arrival; a late result settling as a deadline error and
// recovering; an overdue deadline delivered at the next visited instant; the
// timeout-only and NONE classifiers; a recovery decode released at exactly
// the captured maximum; a bypass admission source taking an ordinal.
module held_remote {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_io as RemoteIO from "../../../formal/kernel/remote-io"
  import recovery as Recovery from "../../../formal/kernel/recovery"
  import deadlines as Deadlines from "../../../formal/kernel/deadlines"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import clock as Clock from "../../../formal/kernel/clock"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, probeSourceScope: false }
  pure val SHARED: Resolution = { layers: { request: true, local: false, remote: true }, coalesce: true }
  pure val ALONE: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: false }
  pure val TTLS: Ttls = { localMs: 0, freshMs: 1000, retentionMs: 5000 }
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
  // watermark) is present at init: visible, never fresh.
  pure val INITIAL: State = {
    o: empty, io: RemoteIO::NO_IO, now: 0, skew: 100000, remoteAvailable: true, tracked: true, capacity: 0,
    readFailed: false, dumpFailed: false, writeFailed: false,
    closed: List(false, false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER),
    localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
    remoteValues: List(VALUE_ONE), created: List(99000), expires: List(60000), watermark: List(0),
    sources: List(), owners: List(), memoSlots: List(), held: List(),
    reads: List(), loads: List(), loaders: List(), retained: List(),
    sourceBudget: SOURCE_BUDGET, deadlines: List(), drained: List()
  }
  action init = all { s' = INITIAL, input' = { name: "init", choice: -1 } }

  action begin(context: int, resolved: Resolution): bool = all {
    s' = Deadlines::begin(s, LAYOUT, call(context), resolved, TTLS, READ_BUDGET),
    input' = { name: "beginCall", choice: context }
  }
  action beginBypass(keyFailed: bool): bool = all {
    s' = Deadlines::begin(s, LAYOUT, bypass(keyFailed), ALONE, TTLS, READ_BUDGET),
    input' = { name: "beginCall", choice: if (keyFailed) 1 else 0 }
  }
  action readWith(index: int, failed: bool, classifier: int): bool = all {
    s' = Deadlines::settleRead(s, LAYOUT, index, failed, classifier),
    input' = { name: if (failed) "failRead" else "releaseRead", choice: index }
  }
  action read(index: int, failed: bool): bool = readWith(index, failed, Recovery::ALLOW)
  action load(index: int, failed: bool): bool = all {
    s' = Deadlines::settleLoad(s, LAYOUT, index, failed),
    input' = { name: if (failed) "failLoad" else "releaseLoad", choice: index }
  }
  action settle(ordinal: int, value: int): bool = all {
    s' = Deadlines::settleLoader(s, LAYOUT, ordinal, value, false),
    input' = { name: "resolveLoader", choice: ordinal }
  }
  // A propagated timeout the profile names (the recovery drivers' rejectTimeout).
  action timeout(ordinal: int): bool = all {
    s' = Deadlines::settleLoader(s, LAYOUT, ordinal, SOURCE_ERROR, true),
    input' = { name: "rejectTimeout", choice: ordinal }
  }
  action advance(ms: int): bool = all { s' = Deadlines::advance(s, LAYOUT, ms), input' = { name: "advance", choice: ms } }
  // A clock move without timer delivery (effects' jumpClock).
  action jump(ms: int): bool = all { s' = Clock::advance(s, ms), input' = { name: "jumpClock", choice: ms } }
  action seed(value: int, age: int): bool = all { s' = Remote::seedAged(s, 0, value, age, 60000), input' = { name: "seed", choice: value } }
  action invalidate = all { s' = Serving::invalidate(s, 0), input' = { name: "invalidate", choice: -1 } }

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
      and s.sources.nth(1).retentionMs == TTLS.retentionMs and s.sources.nth(1).fence == NO_FENCE and s.retained.length() == 1)
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
  // allowed, unfenced and without a snapshot; its ordinary error completes
  // the flight unclassified with the loader's identity.
  run failedFreshDecodeRestartsWithoutRecoveryTest = init.then(seed(VALUE_ONE, 0)).then(begin(0, ALONE)).then(read(0, false)).then(load(0, true))
    .expect(s.o.loaders == 1 and s.loaders == List(0) and s.sources.nth(0).retentionMs == TTLS.retentionMs and s.sources.nth(0).fence == NO_FENCE
      and s.retained == List() and Deadlines::bounded(s, Deadlines::SOURCE, 0))
    .then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 0 and s.o.recovery == List() and s.io.sourceErrors == List(1))
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

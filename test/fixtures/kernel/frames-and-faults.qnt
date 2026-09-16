// Remote frames on the wall clock and the remote adapter's fault switches,
// over one key on one instance with immediate replies and no persistent
// scope, so the remote layer is the first layer a call reaches. Exercises the
// seams the scheduled profiles hold fixed (their wall clock follows the
// monotonic clock, their replies carry the layout's TTLs and their faults are
// off): the retention and freshness boundaries, writes and fences with the two
// clocks apart, a watermark that never lowers, each fault along a refill with
// and without a local layer, per-reply freshness and per-source TTLs.
module frames_and_faults {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import clock as Clock from "../../../formal/kernel/clock"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val INITIAL_TIME_MS = 10000
  pure val FRESH_MS = 1000
  pure val LOCAL_MS = 1000
  pure val RETENTION_MS = 1000
  pure val SHORT_RETENTION_MS = 500
  pure val LONG_RETENTION_MS = 5000
  pure val SHORT_LOCAL_MS = 250
  pure val SHORT_FRESH_MS = 250
  pure val LONG_FRESH_MS = 2000
  pure val ROLLBACK_MS = 1000
  // The layout's TTLs: a 1 s freshness, a 1 s retention and a 1 s local TTL.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 1,
    ttls: { localMs: LOCAL_MS, freshMs: FRESH_MS, retentionMs: RETENTION_MS }, probeSourceScope: false
  }
  pure val TTLS: Ttls = LAYOUT.ttls
  pure val REMOTE_ONLY: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: true }
  pure val LOCAL_AND_REMOTE: Resolution = { layers: { request: false, local: true, remote: true }, coalesce: true }
  pure val CALL: Call = { instance: 0, key: 0, context: 0, enabled: true, keyFailed: false }

  type State = {
    o: Observation, now: int, wall: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }

  action initialize(tracked: bool): bool = all {
    s' = {
      o: empty, now: INITIAL_TIME_MS, wall: INITIAL_TIME_MS, remoteAvailable: true, tracked: tracked, capacity: 1,
      readFailed: false, dumpFailed: false, writeFailed: false,
      closed: List(), memo: List(), requestFlights: List(), processFlights: List(NO_OWNER),
      localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
      remoteValues: List(NO_VALUE), created: List(0), expires: List(0), watermark: List(0),
      sources: List(), owners: List(), memoSlots: List(), held: List()
    },
    input' = { name: "init", choice: if (tracked) 1 else 0 }
  }
  action init = initialize(false)
  action trackedInit = initialize(true)
  // An immediate reply with the resolution and TTLs a profile would decode.
  action begin(resolved: Resolution, ttls: Ttls): bool = all {
    s' = Serving::begin(s, LAYOUT, CALL, resolved, ttls),
    input' = { name: "beginCall", choice: 0 }
  }
  // Settlement with the TTLs the source's reply resolved to.
  action settle(index: int, value: int, ttls: Ttls): bool = all {
    s' = Serving::settle(s, LAYOUT, index, value, ttls),
    input' = { name: "resolveLoader", choice: index }
  }
  action seed(value: int, retentionMs: int): bool = all {
    s' = Remote::seedFrame(s, 0, value, retentionMs),
    input' = { name: "seed", choice: value }
  }
  action elapse(ms: int): bool = all {
    s' = Clock::elapse(s, ms),
    input' = { name: "advance", choice: ms }
  }
  // A wall-clock jump; negative is a rollback.
  action shiftWall(ms: int): bool = all {
    s' = Clock::shiftWall(s, ms),
    input' = { name: "shiftWall", choice: ms }
  }
  action fault(name: str, failed: bool): bool = all {
    s' = if (name == "readFault") { readFailed: failed, ...s }
      else if (name == "dumpFault") { dumpFailed: failed, ...s }
      else { writeFailed: failed, ...s },
    input' = { name: name, choice: if (failed) 1 else 0 }
  }
  action invalidate = all {
    s' = Serving::invalidate(s, 0),
    input' = { name: "invalidate", choice: 0 }
  }

  // -- Retention and freshness -------------------------------------------------

  // A frame still fresh but past its retention is gone: a source starts and
  // loads do not move, where one millisecond earlier the frame was served.
  run retainedFrameServesUntilItsRetentionTest = init
    .then(seed(VALUE_ONE, SHORT_RETENTION_MS))
    .then(elapse(SHORT_RETENTION_MS - 1))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0)
    .then(elapse(1))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.reads == 2 and s.o.loads == 1 and s.o.loaders == 1
      and not(Remote::retained(s, 0)) and Remote::fresh(s, 0, FRESH_MS))

  // Freshness is strict at the boundary: an age one millisecond under the
  // reply's freshness serves, an age equal to it starts a source although the
  // frame is still retained.
  run freshBoundaryStartsSourceTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(elapse(FRESH_MS - 1))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 0)
    .then(elapse(1))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.reads == 2 and s.o.loads == 1 and s.o.loaders == 1
      and s.wall - s.created.nth(0) == FRESH_MS and Remote::retained(s, 0))

  // Freshness is the reply's, not the layout's: a shorter freshness misses a
  // retained frame the layout would serve.
  run shorterReplyFreshnessMissesTheLayoutsFreshFrameTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(elapse(SHORT_FRESH_MS))
    .then(begin(REMOTE_ONLY, { localMs: LOCAL_MS, freshMs: SHORT_FRESH_MS, retentionMs: RETENTION_MS }))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1
      and Remote::retained(s, 0) and Remote::fresh(s, 0, FRESH_MS) and not(Remote::fresh(s, 0, SHORT_FRESH_MS)))

  // A longer freshness serves a retained frame the layout's freshness rejects.
  run longerReplyFreshnessServesTheLayoutsStaleFrameTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(elapse(FRESH_MS))
    .then(begin(REMOTE_ONLY, { localMs: LOCAL_MS, freshMs: LONG_FRESH_MS, retentionMs: RETENTION_MS }))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0
      and not(Remote::fresh(s, 0, FRESH_MS)) and Remote::fresh(s, 0, LONG_FRESH_MS))

  // -- The two clocks apart ------------------------------------------------------

  // After a wall rollback a retained frame's stamp lies in the future; a
  // future frame is not fresh and misses.
  run rolledBackWallRejectsFutureFrameTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(shiftWall(-1))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.created.nth(0) > s.wall and Remote::retained(s, 0) and not(Remote::fresh(s, 0, FRESH_MS))
      and s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1)

  // A refill written while the clocks are apart is stamped with the wall clock
  // and retained from the monotonic clock, and the next call is served by it.
  run refillAfterRollbackStampsTheWallAndRetainsOnTheMonotonicClockTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(shiftWall(-ROLLBACK_MS))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.loads == 0 and s.o.loaders == 1)
    .then(settle(0, VALUE_TWO, TTLS))
    .expect(s.wall != s.now and s.created == List(s.wall) and s.expires == List(s.now + RETENTION_MS)
      and s.created == List(INITIAL_TIME_MS - ROLLBACK_MS) and s.expires == List(INITIAL_TIME_MS + RETENTION_MS))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.loads == 1 and s.o.loaders == 1)

  // Retention is on the monotonic clock: a rollback neither extends nor
  // shortens it. A frame retained one millisecond before the rollback is still
  // retained after it, and gone one millisecond later.
  run rollbackDoesNotExtendRetentionTest = init
    .then(seed(VALUE_ONE, SHORT_RETENTION_MS))
    .then(elapse(SHORT_RETENTION_MS - 1))
    .then(shiftWall(-ROLLBACK_MS))
    .expect(Remote::retained(s, 0) and s.now < s.expires.nth(0) and not(Remote::fresh(s, 0, FRESH_MS)))
    .then(elapse(1))
    .expect(not(Remote::retained(s, 0)))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1)

  // A frame written after a rollback lives for exactly its retention on the
  // monotonic clock while its wall stamp keeps it fresh throughout.
  run frameWrittenAfterRollbackLivesForItsRetentionTest = init
    .then(shiftWall(-ROLLBACK_MS))
    .then(seed(VALUE_ONE, SHORT_RETENTION_MS))
    .then(elapse(SHORT_RETENTION_MS - 1))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 0)
    .then(elapse(1))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loads == 1 and s.o.loaders == 1
      and not(Remote::retained(s, 0)) and Remote::fresh(s, 0, FRESH_MS))

  // -- Watermarks and fences ---------------------------------------------------

  // A tracked miss carries the watermark it observed; a refill stamped at that
  // same wall instant would not clear it, so it neither dumps nor writes,
  // while the caller still receives the value.
  run fencedTrackedRefillNeitherDumpsNorWritesTest = trackedInit
    .then(invalidate)
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.reads == 1 and s.o.loaders == 1 and s.o.invalidations == 1 and s.sources.nth(0).fence == INITIAL_TIME_MS)
    .then(settle(0, VALUE_ONE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0 and s.remoteValues == List(NO_VALUE))

  // One millisecond later the same refill clears its fence and is stored.
  run trackedRefillClearsItsFenceAfterAMillisecondTest = trackedInit
    .then(invalidate)
    .then(begin(REMOTE_ONLY, TTLS))
    .then(elapse(1))
    .then(settle(0, VALUE_ONE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 1
      and s.remoteValues == List(VALUE_ONE) and s.created == List(INITIAL_TIME_MS + 1))

  // The fence is checked against the wall clock the stamp would carry: with
  // the monotonic clock past the fence but the wall clock equal to it, the
  // refill is not stored.
  run fenceIsCheckedAgainstTheWallClockTest = trackedInit
    .then(invalidate)
    .then(shiftWall(-1))
    .then(begin(REMOTE_ONLY, TTLS))
    .then(elapse(1))
    .then(settle(0, VALUE_ONE, TTLS))
    .expect(s.wall == s.sources.nth(0).fence and s.now > s.sources.nth(0).fence
      and s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0 and s.remoteValues == List(NO_VALUE))

  // An invalidation stamps the watermark with the wall clock, not the
  // monotonic clock: on a rolled-back wall clock a frame written one
  // millisecond after the invalidation already clears the watermark.
  run watermarkIsStampedWithTheWallClockTest = trackedInit
    .then(shiftWall(-ROLLBACK_MS))
    .then(invalidate)
    .expect(s.watermark == List(INITIAL_TIME_MS - ROLLBACK_MS) and s.wall < s.now)
    .then(elapse(1))
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0)

  // A watermark never lowers: an invalidation after a wall rollback keeps the
  // earlier watermark, its fenced refill is not stored, and once the wall
  // clock is past the frame's stamp again the frame is still fenced although
  // it is retained and fresh.
  run watermarkNeverLowersAfterWallRollbackTest = trackedInit
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(elapse(1))
    .then(invalidate)
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.watermark == List(INITIAL_TIME_MS + 1) and s.o.loads == 0 and s.o.loaders == 1)
    .then(shiftWall(-ROLLBACK_MS))
    .then(invalidate)
    .expect(s.watermark == List(INITIAL_TIME_MS + 1) and s.o.invalidations == 2)
    .then(settle(0, VALUE_TWO, TTLS))
    .expect(s.o.dumps == 0 and s.remoteValues == List(VALUE_ONE))
    .then(elapse(ROLLBACK_MS))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.watermark == List(INITIAL_TIME_MS + 1) and s.o.calls == List(VALUE_TWO, CALL_PENDING)
      and s.o.loads == 0 and s.o.loaders == 2 and Remote::retained(s, 0) and Remote::fresh(s, 0, FRESH_MS))

  // -- Faults along a refill ---------------------------------------------------

  // A failed read is counted and observes nothing, so a source starts over a
  // readable frame; that source never refills, even once the adapter is
  // healthy again: no dump, no write, the frame keeps its value.
  run readFaultCountsTheReadAndNeverRefillsTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(fault("readFault", true))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1
      and not(s.sources.nth(0).remote) and s.sources.nth(0).fence == NO_FENCE)
    .then(fault("readFault", false))
    .then(settle(0, VALUE_TWO, TTLS))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.dumps == 0 and s.o.writes == 0 and s.remoteValues == List(VALUE_ONE))

  // With a local layer, the source a failed read starts still warms local
  // storage at settlement and the next call is served locally without a read.
  run readFaultSourceStillWarmsLocalTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(fault("readFault", true))
    .then(begin(LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1
      and s.sources.nth(0).local and not(s.sources.nth(0).remote))
    .then(settle(0, VALUE_TWO, TTLS))
    .expect(s.o.calls == List(VALUE_TWO) and s.localValues == List(VALUE_TWO) and s.localExpires == List(INITIAL_TIME_MS + LOCAL_MS)
      and s.remoteValues == List(VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0)
    .then(begin(LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 1 and s.o.loaders == 1)

  // A dump fault: the refill serializes (one dump) but dispatches no write and
  // stores nothing.
  run dumpFaultStopsTheDispatchTest = init
    .then(fault("dumpFault", true))
    .then(begin(REMOTE_ONLY, TTLS))
    .then(settle(0, VALUE_ONE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 0 and s.o.writeTtls == List()
      and s.remoteValues == List(NO_VALUE) and s.expires == List(0))

  // A write fault: the refill serializes and dispatches (one dump, one write
  // carrying the retention) but stores nothing.
  run writeFaultStoresNothingTest = init
    .then(fault("writeFault", true))
    .then(begin(REMOTE_ONLY, TTLS))
    .then(settle(0, VALUE_ONE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 1 and s.o.writeTtls == List(RETENTION_MS)
      and s.remoteValues == List(NO_VALUE) and s.created == List(0) and s.expires == List(0))

  // -- Per-source TTLs -----------------------------------------------------------

  // A source settled with its own TTLs writes that retention and stamps the
  // frame with the wall clock at settlement, retained for that long.
  run settleWritesTheSourcesRetentionTest = init
    .then(begin(REMOTE_ONLY, TTLS))
    .then(elapse(1))
    .then(settle(0, VALUE_ONE, { localMs: LOCAL_MS, freshMs: FRESH_MS, retentionMs: LONG_RETENTION_MS }))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 1 and s.o.writeTtls == List(LONG_RETENTION_MS)
      and s.remoteValues == List(VALUE_ONE) and s.created == List(INITIAL_TIME_MS + 1)
      and s.expires == List(INITIAL_TIME_MS + 1 + LONG_RETENTION_MS))

  // A source settled with its own local TTL warms local storage for that TTL,
  // not the layout's: the entry serves one millisecond before it and the call
  // after that reads the remote frame.
  run settlementWarmsLocalForTheSourcesLocalTtlTest = init
    .then(begin(LOCAL_AND_REMOTE, TTLS))
    .then(settle(0, VALUE_ONE, { localMs: SHORT_LOCAL_MS, freshMs: FRESH_MS, retentionMs: RETENTION_MS }))
    .expect(s.localValues == List(VALUE_ONE) and s.localExpires == List(INITIAL_TIME_MS + SHORT_LOCAL_MS)
      and s.remoteValues == List(VALUE_ONE) and s.o.writes == 1)
    .then(elapse(SHORT_LOCAL_MS - 1))
    .then(begin(LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(elapse(1))
    .then(begin(LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.reads == 2 and s.o.loads == 1 and s.o.loaders == 1)

  // A remote hit warms local storage for the reply's local TTL, not the
  // layout's: the entry serves one millisecond before that TTL and a later
  // remote hit under the layout's TTLs warms it for the layout's.
  run remoteHitWarmsLocalForTheReplysLocalTtlTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(begin(LOCAL_AND_REMOTE, { localMs: SHORT_LOCAL_MS, freshMs: FRESH_MS, retentionMs: RETENTION_MS }))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1
      and s.localValues == List(VALUE_ONE) and s.localExpires == List(INITIAL_TIME_MS + SHORT_LOCAL_MS))
    .then(elapse(SHORT_LOCAL_MS - 1))
    .then(begin(LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(elapse(1))
    .then(begin(LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.reads == 2 and s.o.loads == 2 and s.o.loaders == 0
      and s.localExpires == List(INITIAL_TIME_MS + SHORT_LOCAL_MS + LOCAL_MS))
}

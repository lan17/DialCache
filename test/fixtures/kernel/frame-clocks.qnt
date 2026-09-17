// Remote frames on the two clocks, over two keys of one entity on one
// instance with immediate remote-only replies and no persistent scope, so the
// remote layer is the first layer a call reaches. Exercises the seams the
// scheduled profiles hold fixed (their wall skew is 0 and their replies carry
// constant TTLs): the retention and freshness boundaries, per-reply freshness,
// writes and fences with the two clocks apart, unfenced refills at a wall
// clock of zero, and a watermark stamped with the wall clock that never lowers.
module frame_clocks {
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
  pure val SHORT_FRESH_MS = 250
  pure val LONG_FRESH_MS = 2000
  pure val ROLLBACK_MS = 1000
  pure val KEY = 0
  pure val LAYOUT: Serving::Layout =
    { keysPerInstance: 2, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 2, probeSourceScope: false }
  // The fixture's TTLs: a 1 s freshness, a 1 s retention and a 1 s local TTL.
  pure val TTLS: Ttls = { localMs: LOCAL_MS, freshMs: FRESH_MS, retentionMs: RETENTION_MS }
  pure val REMOTE_ONLY: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: true }
  pure val CALL: Call = { instance: 0, key: KEY, context: 0, enabled: true, keyFailed: false }

  type State = {
    o: Observation, now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
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
      o: empty, now: INITIAL_TIME_MS, skew: 0, remoteAvailable: true, tracked: tracked, capacity: 1,
      readFailed: false, dumpFailed: false, writeFailed: false,
      closed: List(), memo: List(), requestFlights: List(), processFlights: List(NO_OWNER, NO_OWNER),
      localValues: List(NO_VALUE, NO_VALUE), localExpires: List(0, 0), lru: List(List()),
      remoteValues: List(NO_VALUE, NO_VALUE), created: List(0, 0), expires: List(0, 0), watermark: List(0),
      sources: List(), owners: List(), memoSlots: List(), held: List()
    },
    input' = { name: "init", choice: if (tracked) 1 else 0 }
  }
  action init = initialize(false)
  action trackedInit = initialize(true)
  // An immediate remote-only reply with the TTLs a profile would decode.
  action begin(ttls: Ttls): bool = all {
    s' = Serving::begin(s, LAYOUT, CALL, REMOTE_ONLY, ttls),
    input' = { name: "beginCall", choice: KEY }
  }
  action settle(index: int, value: int): bool = all {
    s' = Serving::settle(s, LAYOUT, index, value),
    input' = { name: "resolveLoader", choice: index }
  }
  action seed(value: int, retentionMs: int): bool = all {
    s' = Remote::seedFrame(s, KEY, value, retentionMs),
    input' = { name: "seed", choice: value }
  }
  action elapse(ms: int): bool = all {
    s' = Clock::advance(s, ms),
    input' = { name: "advance", choice: ms }
  }
  // A wall-clock jump; negative is a rollback.
  action shiftWall(ms: int): bool = all {
    s' = Clock::shiftWall(s, ms),
    input' = { name: "shiftWall", choice: ms }
  }
  action invalidate = all {
    s' = Serving::invalidate(s, 0),
    input' = { name: "invalidate", choice: 0 }
  }

  // -- Retention and freshness -------------------------------------------------

  // A frame still fresh but past its retention is gone: a source starts and
  // loads do not move, where one millisecond earlier the frame was served. A
  // remote-only reply's hit warms no local storage although its TTLs carry a
  // local TTL: the layer flag gates the warming, not the TTL alone.
  run retainedFrameServesUntilItsRetentionTest = init
    .then(seed(VALUE_ONE, SHORT_RETENTION_MS))
    .then(elapse(SHORT_RETENTION_MS - 1))
    .then(begin(TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0
      and s.localValues == List(NO_VALUE, NO_VALUE) and s.lru == List(List()))
    .then(elapse(1))
    .then(begin(TTLS))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.reads == 2 and s.o.loads == 1 and s.o.loaders == 1
      and not(Remote::retained(s, KEY)) and Remote::fresh(s, KEY, FRESH_MS))

  // Freshness is strict at the boundary: an age one millisecond under the
  // reply's freshness serves, an age equal to it starts a source although the
  // frame is still retained.
  run freshBoundaryStartsSourceTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(elapse(FRESH_MS - 1))
    .then(begin(TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 0)
    .then(elapse(1))
    .then(begin(TTLS))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.reads == 2 and s.o.loads == 1 and s.o.loaders == 1
      and Clock::wallOf(s) - s.created.nth(KEY) == FRESH_MS and Remote::retained(s, KEY))

  // Freshness is the reply's, not the fixture's: a shorter freshness misses a
  // retained frame the fixture's TTLs would serve.
  run shorterReplyFreshnessMissesTheFixturesFreshFrameTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(elapse(SHORT_FRESH_MS))
    .then(begin({ localMs: LOCAL_MS, freshMs: SHORT_FRESH_MS, retentionMs: RETENTION_MS }))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1
      and Remote::retained(s, KEY) and Remote::fresh(s, KEY, FRESH_MS) and not(Remote::fresh(s, KEY, SHORT_FRESH_MS)))

  // A longer freshness serves a retained frame the fixture's freshness rejects.
  run longerReplyFreshnessServesTheFixturesStaleFrameTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(elapse(FRESH_MS))
    .then(begin({ localMs: LOCAL_MS, freshMs: LONG_FRESH_MS, retentionMs: RETENTION_MS }))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0
      and not(Remote::fresh(s, KEY, FRESH_MS)) and Remote::fresh(s, KEY, LONG_FRESH_MS))

  // -- The two clocks apart ------------------------------------------------------

  // After a wall rollback a retained frame's stamp lies in the future; a
  // future frame is not fresh and misses.
  run rolledBackWallRejectsFutureFrameTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(shiftWall(-1))
    .then(begin(TTLS))
    .expect(s.created.nth(KEY) > Clock::wallOf(s) and Remote::retained(s, KEY) and not(Remote::fresh(s, KEY, FRESH_MS))
      and s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1)

  // A refill written while the clocks are apart is stamped with the wall clock
  // and retained from the monotonic clock, and the next call is served by it.
  run refillAfterRollbackStampsTheWallAndRetainsOnTheMonotonicClockTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(shiftWall(-ROLLBACK_MS))
    .then(begin(TTLS))
    .expect(s.o.loads == 0 and s.o.loaders == 1)
    .then(settle(0, VALUE_TWO))
    .expect(Clock::wallOf(s) != s.now and s.created == List(Clock::wallOf(s), 0) and s.expires == List(s.now + RETENTION_MS, 0)
      and s.created == List(INITIAL_TIME_MS - ROLLBACK_MS, 0) and s.expires == List(INITIAL_TIME_MS + RETENTION_MS, 0))
    .then(begin(TTLS))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.loads == 1 and s.o.loaders == 1)

  // Retention is on the monotonic clock: a rollback neither extends nor
  // shortens it. A frame retained one millisecond before the rollback is still
  // retained after it, and gone one millisecond later.
  run rollbackDoesNotExtendRetentionTest = init
    .then(seed(VALUE_ONE, SHORT_RETENTION_MS))
    .then(elapse(SHORT_RETENTION_MS - 1))
    .then(shiftWall(-ROLLBACK_MS))
    .expect(Remote::retained(s, KEY) and s.now < s.expires.nth(KEY) and not(Remote::fresh(s, KEY, FRESH_MS)))
    .then(elapse(1))
    .expect(not(Remote::retained(s, KEY)))
    .then(begin(TTLS))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1)

  // A frame written after a rollback lives for exactly its retention on the
  // monotonic clock while its wall stamp keeps it fresh throughout.
  run frameWrittenAfterRollbackLivesForItsRetentionTest = init
    .then(shiftWall(-ROLLBACK_MS))
    .then(seed(VALUE_ONE, SHORT_RETENTION_MS))
    .then(elapse(SHORT_RETENTION_MS - 1))
    .then(begin(TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 0)
    .then(elapse(1))
    .then(begin(TTLS))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loads == 1 and s.o.loaders == 1
      and not(Remote::retained(s, KEY)) and Remote::fresh(s, KEY, FRESH_MS))

  // An unfenced refill is written whatever the wall clock reads: with the wall
  // clock at zero an untracked miss refills, the frame is stamped 0 and serves
  // the next call.
  run unfencedRefillIsWrittenAtWallZeroTest = init
    .then(shiftWall(-INITIAL_TIME_MS))
    .expect(Clock::wallOf(s) == 0)
    .then(begin(TTLS))
    .expect(s.o.loaders == 1 and s.sources.nth(0).fence == NO_FENCE)
    .then(settle(0, VALUE_ONE))
    .expect(s.o.dumps == 1 and s.o.writes == 1 and s.remoteValues == List(VALUE_ONE, NO_VALUE)
      and s.created == List(0, 0) and s.expires == List(INITIAL_TIME_MS + RETENTION_MS, 0))
    .then(begin(TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loads == 1 and s.o.loaders == 1)

  // A tracked miss on an entity never invalidated carries the zero watermark as
  // its fence and refills the same way.
  run trackedUnfencedRefillIsWrittenAtWallZeroTest = trackedInit
    .then(shiftWall(-INITIAL_TIME_MS))
    .then(begin(TTLS))
    .expect(s.o.loaders == 1 and s.watermark == List(0) and s.sources.nth(0).fence == NO_FENCE)
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 1
      and s.remoteValues == List(VALUE_ONE, NO_VALUE) and s.created == List(0, 0))

  // -- Watermarks and fences ---------------------------------------------------

  // A tracked miss carries the watermark it observed; a refill stamped at that
  // same wall instant would not clear it, so it neither dumps nor writes,
  // while the caller still receives the value.
  run fencedTrackedRefillNeitherDumpsNorWritesTest = trackedInit
    .then(invalidate)
    .then(begin(TTLS))
    .expect(s.o.reads == 1 and s.o.loaders == 1 and s.o.invalidations == 1 and s.sources.nth(0).fence == INITIAL_TIME_MS)
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0 and s.remoteValues == List(NO_VALUE, NO_VALUE))

  // One millisecond later the same refill clears its fence and is stored.
  run trackedRefillClearsItsFenceAfterAMillisecondTest = trackedInit
    .then(invalidate)
    .then(begin(TTLS))
    .then(elapse(1))
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 1
      and s.remoteValues == List(VALUE_ONE, NO_VALUE) and s.created == List(INITIAL_TIME_MS + 1, 0))

  // The fence is checked against the wall clock the stamp would carry: with
  // the monotonic clock past the fence but the wall clock equal to it, the
  // refill is not stored.
  run fenceIsCheckedAgainstTheWallClockTest = trackedInit
    .then(invalidate)
    .then(shiftWall(-1))
    .then(begin(TTLS))
    .then(elapse(1))
    .then(settle(0, VALUE_ONE))
    .expect(Clock::wallOf(s) == s.sources.nth(0).fence and s.now > s.sources.nth(0).fence
      and s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0 and s.remoteValues == List(NO_VALUE, NO_VALUE))

  // An invalidation stamps the watermark with the wall clock, not the
  // monotonic clock: on a rolled-back wall clock a frame written one
  // millisecond after the invalidation already clears the watermark.
  run watermarkIsStampedWithTheWallClockTest = trackedInit
    .then(shiftWall(-ROLLBACK_MS))
    .then(invalidate)
    .expect(s.watermark == List(INITIAL_TIME_MS - ROLLBACK_MS) and Clock::wallOf(s) < s.now)
    .then(elapse(1))
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(begin(TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0)

  // A watermark never lowers: an invalidation after a wall rollback keeps the
  // earlier watermark, its fenced refill is not stored, and once the wall
  // clock is past the frame's stamp again the frame is still fenced although
  // it is retained and fresh.
  run watermarkNeverLowersAfterWallRollbackTest = trackedInit
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(elapse(1))
    .then(invalidate)
    .then(begin(TTLS))
    .expect(s.watermark == List(INITIAL_TIME_MS + 1) and s.o.loads == 0 and s.o.loaders == 1)
    .then(shiftWall(-ROLLBACK_MS))
    .then(invalidate)
    .expect(s.watermark == List(INITIAL_TIME_MS + 1) and s.o.invalidations == 2)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.dumps == 0 and s.remoteValues == List(VALUE_ONE, NO_VALUE))
    .then(elapse(ROLLBACK_MS))
    .then(begin(TTLS))
    .expect(s.watermark == List(INITIAL_TIME_MS + 1) and s.o.calls == List(VALUE_TWO, CALL_PENDING)
      and s.o.loads == 0 and s.o.loaders == 2 and Remote::retained(s, KEY) and Remote::fresh(s, KEY, FRESH_MS))
}

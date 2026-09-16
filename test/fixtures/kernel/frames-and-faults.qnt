// Remote frames on the wall clock and the remote adapter's fault switches,
// over one key on one instance with immediate replies and no persistent
// scope, so the remote layer is the first layer a call reaches. Exercises the
// seams the scheduled profiles hold fixed (their wall clock follows the
// monotonic clock and their faults are off): the retention and freshness
// boundaries, a stamp from after a wall rollback, each fault along a refill,
// a per-source retention, a remote hit warming local for the reply's local
// TTL rather than the layout's, and a fenced tracked refill.
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
  pure val SHORT_RETENTION_MS = 500
  pure val LONG_RETENTION_MS = 5000
  pure val SHORT_LOCAL_MS = 250
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 1,
    servingTtlMs: FRESH_MS, localTtlMs: LOCAL_MS, probeSourceScope: false
  }
  // The layout's TTLs: a 1 s freshness, a 1 s retention and a 1 s local TTL.
  pure val TTLS: Ttls = Serving::ttlsOf(LAYOUT)
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
  action settle(index: int, value: int): bool = all {
    s' = Serving::settle(s, LAYOUT, index, value),
    input' = { name: "resolveLoader", choice: index }
  }
  action settleWith(index: int, value: int, ttls: Ttls): bool = all {
    s' = Serving::settleWith(s, LAYOUT, index, value, ttls),
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
  action rollbackWall(ms: int): bool = all {
    s' = Clock::shiftWall(s, -ms),
    input' = { name: "rollbackWall", choice: ms }
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

  // After a wall rollback a retained frame's stamp lies in the future; a
  // future frame is not fresh and misses.
  run rolledBackWallRejectsFutureFrameTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(rollbackWall(1))
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.created.nth(0) > s.wall and Remote::retained(s, 0) and not(Remote::fresh(s, 0, FRESH_MS))
      and s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1)

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
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.dumps == 0 and s.o.writes == 0 and s.remoteValues == List(VALUE_ONE))

  // A dump fault: the refill serializes (one dump) but dispatches no write and
  // stores nothing.
  run dumpFaultStopsTheDispatchTest = init
    .then(fault("dumpFault", true))
    .then(begin(REMOTE_ONLY, TTLS))
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 0 and s.o.writeTtls == List()
      and s.remoteValues == List(NO_VALUE) and s.expires == List(0))

  // A write fault: the refill serializes and dispatches (one dump, one write
  // carrying the retention) but stores nothing.
  run writeFaultStoresNothingTest = init
    .then(fault("writeFault", true))
    .then(begin(REMOTE_ONLY, TTLS))
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 1 and s.o.writeTtls == List(FRESH_MS)
      and s.remoteValues == List(NO_VALUE) and s.created == List(0) and s.expires == List(0))

  // A source settled with its own TTLs writes that retention and stamps the
  // frame with the wall clock at settlement, retained for that long.
  run settleWithWritesTheSourcesRetentionTest = init
    .then(begin(REMOTE_ONLY, TTLS))
    .then(elapse(1))
    .then(settleWith(0, VALUE_ONE, { localMs: LOCAL_MS, freshMs: FRESH_MS, retentionMs: LONG_RETENTION_MS }))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 1 and s.o.writeTtls == List(LONG_RETENTION_MS)
      and s.remoteValues == List(VALUE_ONE) and s.created == List(INITIAL_TIME_MS + 1)
      and s.expires == List(INITIAL_TIME_MS + 1 + LONG_RETENTION_MS))

  // A remote hit warms local storage for the reply's local TTL, not the
  // layout's: the entry serves one millisecond before that TTL and a later
  // remote hit under the layout's TTLs warms it for the layout's.
  run remoteHitWarmsLocalForTheReplysLocalTtlTest = init
    .then(seed(VALUE_ONE, LONG_RETENTION_MS))
    .then(begin(LOCAL_AND_REMOTE, { localMs: SHORT_LOCAL_MS, freshMs: FRESH_MS, retentionMs: FRESH_MS }))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1
      and s.localValues == List(VALUE_ONE) and s.localExpires == List(INITIAL_TIME_MS + SHORT_LOCAL_MS))
    .then(elapse(SHORT_LOCAL_MS - 1))
    .then(begin(LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(elapse(1))
    .then(begin(LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.reads == 2 and s.o.loads == 2 and s.o.loaders == 0
      and s.localExpires == List(INITIAL_TIME_MS + SHORT_LOCAL_MS + LOCAL_MS))

  // A tracked miss carries the watermark it observed; a refill stamped at that
  // same wall instant would not clear it, so it neither dumps nor writes,
  // while the caller still receives the value.
  run fencedTrackedRefillNeitherDumpsNorWritesTest = trackedInit
    .then(invalidate)
    .then(begin(REMOTE_ONLY, TTLS))
    .expect(s.o.reads == 1 and s.o.loaders == 1 and s.o.invalidations == 1 and s.sources.nth(0).fence == INITIAL_TIME_MS)
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0 and s.remoteValues == List(NO_VALUE))

  // One millisecond later the same refill clears its fence and is stored.
  run trackedRefillClearsItsFenceAfterAMillisecondTest = trackedInit
    .then(invalidate)
    .then(begin(REMOTE_ONLY, TTLS))
    .then(elapse(1))
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 1
      and s.remoteValues == List(VALUE_ONE) and s.created == List(INITIAL_TIME_MS + 1))
}

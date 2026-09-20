// The remote adapter's fault switches and the TTLs a reply carries, over two
// keys of one entity on one instance with one local slot, immediate replies
// and no persistent scope: the remote-only runs reach the remote layer first,
// the local-and-remote runs pass through local storage on the way. Exercises
// the seams the scheduled profiles hold fixed (their replies carry constant
// TTLs and their faults are off): a layer turned off by a zero TTL, each fault
// along a refill with and without a local layer, an invalidation under a write
// fault, and sources started under different replies publishing with the TTLs
// each captured.
module frames_and_faults {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import clock as Clock from "../../../formal/kernel/clock"
  import flights as Flights from "../../../formal/kernel/flights"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val INITIAL_TIME_MS = 10000
  pure val FRESH_MS = 1000
  pure val LOCAL_MS = 1000
  pure val RETENTION_MS = 1000
  pure val LONG_RETENTION_MS = 5000
  pure val SHORT_LOCAL_MS = 250
  pure val KEY = 0
  pure val OTHER_KEY = 1
  pure val LAYOUT: Serving::Layout =
    { keysPerInstance: 2, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 2, probeSourceScope: false, policyProvider: true }
  // The fixture's TTLs: a 1 s freshness, a 1 s retention and a 1 s local TTL.
  pure val TTLS: Ttls = { localMs: LOCAL_MS, freshMs: FRESH_MS, retentionMs: RETENTION_MS }
  pure val NO_REMOTE_TTLS: Ttls = { localMs: LOCAL_MS, freshMs: 0, retentionMs: RETENTION_MS }
  pure val NO_LOCAL_TTLS: Ttls = { localMs: 0, freshMs: FRESH_MS, retentionMs: RETENTION_MS }
  pure val SHORT_LOCAL_TTLS: Ttls = { localMs: SHORT_LOCAL_MS, freshMs: FRESH_MS, retentionMs: RETENTION_MS }
  pure val LONG_RETENTION_TTLS: Ttls = { localMs: LOCAL_MS, freshMs: FRESH_MS, retentionMs: LONG_RETENTION_MS }
  pure val REMOTE_ONLY: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: true }
  pure val LOCAL_AND_REMOTE: Resolution = { layers: { request: false, local: true, remote: true }, coalesce: true }
  pure def call(key: int): Call = { instance: 0, key: key, context: 0, enabled: true, keyFailed: false }

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
  // An immediate reply with the resolution and TTLs a profile would decode.
  action begin(key: int, resolved: Resolution, ttls: Ttls): bool = all {
    s' = Serving::begin(s, LAYOUT, call(key), resolved, ttls),
    input' = { name: "beginCall", choice: key }
  }
  // Settlement publishes with the TTLs the source captured from its reply.
  action settle(index: int, value: int): bool = all {
    s' = Serving::settle(s, LAYOUT, index, value),
    input' = { name: "resolveLoader", choice: index }
  }
  // A source no caller owns, started beside the traversal.
  action startDetached(key: int): bool = all {
    s' = Serving::startDetachedSource(s, LAYOUT, call(key)),
    input' = { name: "detached", choice: key }
  }
  action seed(key: int, value: int, retentionMs: int): bool = all {
    s' = Remote::seedFrame(s, key, value, retentionMs),
    input' = { name: "seed", choice: key * 2 + value }
  }
  action elapse(ms: int): bool = all {
    s' = Clock::advance(s, ms),
    input' = { name: "advance", choice: ms }
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

  // -- A zero TTL turns its layer off ------------------------------------------

  // A reply enabling the remote layer with a zero freshness reads nothing: no
  // read is counted over a seeded frame, the source it starts captures no
  // retention, neither refills nor shares, and its settlement writes nothing.
  run zeroFreshnessTurnsTheRemoteLayerOffTest = init
    .then(seed(KEY, VALUE_ONE, LONG_RETENTION_MS))
    .then(begin(KEY, REMOTE_ONLY, NO_REMOTE_TTLS))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.reads == 0 and s.o.loads == 0 and s.o.loaders == 1
      and s.sources.nth(0).localMs == 0 and s.sources.nth(0).retentionMs == 0
      and not(s.sources.nth(0).shared) and s.sources.nth(0).fence == NO_FENCE)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.dumps == 0 and s.o.writes == 0 and s.remoteValues == List(VALUE_ONE, NO_VALUE))

  // A reply enabling local storage with a zero local TTL uses no local
  // storage: the source captures no local TTL, so neither its settlement nor
  // the reply's remote hit warms the slot and the other key's live entry is not
  // evicted.
  run zeroLocalTtlTurnsTheLocalLayerOffTest = init
    .then(begin(OTHER_KEY, LOCAL_AND_REMOTE, TTLS))
    .then(settle(0, VALUE_ONE))
    .expect(s.localValues == List(NO_VALUE, VALUE_ONE) and s.lru == List(List(OTHER_KEY)))
    .then(begin(KEY, LOCAL_AND_REMOTE, NO_LOCAL_TTLS))
    .expect(s.o.reads == 2 and s.o.loaders == 2 and s.sources.nth(1).localMs == 0 and s.sources.nth(1).retentionMs == RETENTION_MS)
    .then(settle(1, VALUE_TWO))
    .expect(s.localValues == List(NO_VALUE, VALUE_ONE) and s.lru == List(List(OTHER_KEY))
      and s.remoteValues == List(VALUE_TWO, VALUE_ONE) and s.o.writes == 2)
    .then(begin(KEY, LOCAL_AND_REMOTE, NO_LOCAL_TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.reads == 3 and s.o.loads == 1
      and s.localValues == List(NO_VALUE, VALUE_ONE) and s.lru == List(List(OTHER_KEY)))

  // -- Faults along a refill ---------------------------------------------------

  // A failed read is counted and observes nothing, so a source starts over a
  // readable frame; that source captures no retention and never refills, even
  // once the adapter is healthy again: no dump, no write, the frame keeps its
  // value.
  run readFaultCountsTheReadAndNeverRefillsTest = init
    .then(seed(KEY, VALUE_ONE, LONG_RETENTION_MS))
    .then(fault("readFault", true))
    .then(begin(KEY, REMOTE_ONLY, TTLS))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1
      and s.sources.nth(0).fence == NO_FENCE and s.sources.nth(0).retentionMs == 0)
    .then(fault("readFault", false))
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.dumps == 0 and s.o.writes == 0 and s.remoteValues == List(VALUE_ONE, NO_VALUE))

  // Refill authority is fixed when the source starts: a read fault raised
  // afterwards does not stop its settlement from refilling.
  run laterReadFaultDoesNotStopTheRefillTest = init
    .then(begin(KEY, REMOTE_ONLY, TTLS))
    .expect(s.sources.nth(0).retentionMs == RETENTION_MS)
    .then(fault("readFault", true))
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 1
      and s.remoteValues == List(VALUE_ONE, NO_VALUE) and s.created == List(INITIAL_TIME_MS, 0))

  // Untracked, with a local layer, the source a failed read starts still warms
  // local storage at settlement and the next call is served locally without a read.
  run readFaultSourceStillWarmsLocalTest = init
    .then(seed(KEY, VALUE_ONE, LONG_RETENTION_MS))
    .then(fault("readFault", true))
    .then(begin(KEY, LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1
      and s.sources.nth(0).localMs == LOCAL_MS and s.sources.nth(0).retentionMs == 0)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.localValues == List(VALUE_TWO, NO_VALUE) and s.localExpires == List(INITIAL_TIME_MS + LOCAL_MS, 0)
      and s.remoteValues == List(VALUE_ONE, NO_VALUE) and s.o.dumps == 0 and s.o.writes == 0)
    .then(begin(KEY, LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 1 and s.o.loaders == 1)

  // Tracked, the source a failed read starts publishes nowhere, as the
  // implementation does (a read error never reaches the write path, and only
  // an untracked key warms local storage fail-open): it captures no TTL,
  // settlement warms nothing and writes nothing, and the next call reads the
  // remote layer again and starts a second source.
  run trackedReadFaultSourcePublishesNowhereTest = trackedInit
    .then(fault("readFault", true))
    .then(begin(KEY, LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.reads == 1 and s.o.loaders == 1 and s.sources.nth(0).localMs == 0
      and s.sources.nth(0).retentionMs == 0)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.localValues == List(NO_VALUE, NO_VALUE)
      and s.remoteValues == List(NO_VALUE, NO_VALUE) and s.o.dumps == 0 and s.o.writes == 0)
    .then(fault("readFault", false))
    .then(begin(KEY, LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING) and s.o.reads == 2 and s.o.loads == 0 and s.o.loaders == 2)

  // A dump fault: the refill serializes (one dump) but dispatches no write and
  // stores nothing.
  run dumpFaultStopsTheDispatchTest = init
    .then(fault("dumpFault", true))
    .then(begin(KEY, REMOTE_ONLY, TTLS))
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 0 and s.o.writeTtls == List()
      and s.remoteValues == List(NO_VALUE, NO_VALUE) and s.expires == List(0, 0))

  // A write fault: the refill serializes and dispatches (one dump, one write
  // carrying the retention) but stores nothing.
  run writeFaultStoresNothingTest = init
    .then(fault("writeFault", true))
    .then(begin(KEY, REMOTE_ONLY, TTLS))
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 1 and s.o.writeTtls == List(RETENTION_MS)
      and s.remoteValues == List(NO_VALUE, NO_VALUE) and s.created == List(0, 0) and s.expires == List(0, 0))

  // An invalidation under a write fault is counted and reports the mutation
  // error, and the watermark does not move although the wall clock is ahead of
  // it; once the fault clears, the next invalidation reports ok and raises the
  // watermark to the wall clock.
  run writeFaultInvalidationIsCountedAndKeepsTheWatermarkTest = trackedInit
    .then(invalidate)
    .then(elapse(1000))
    .then(fault("writeFault", true))
    .expect(not(Serving::maintains(s)) and Clock::wallOf(s) > s.watermark.nth(0))
    .then(invalidate)
    .expect(s.o.invalidations == 2 and s.o.maintenance == List("ok", "mutation_error") and s.watermark == List(INITIAL_TIME_MS))
    .then(fault("writeFault", false))
    .expect(Serving::maintains(s))
    .then(invalidate)
    .expect(s.o.invalidations == 3 and s.o.maintenance == List("ok", "mutation_error", "ok")
      and s.watermark == List(INITIAL_TIME_MS + 1000))

  // -- Each source publishes with the TTLs of the reply that started it ----------

  // Two sources started under replies with different retentions each write
  // their own: the second settles first with the long retention, the first
  // then with the short one, both stamped with the wall clock at settlement.
  run eachSourceWritesItsOwnRetentionTest = init
    .then(begin(KEY, REMOTE_ONLY, TTLS))
    .then(begin(OTHER_KEY, REMOTE_ONLY, LONG_RETENTION_TTLS))
    .expect(s.o.loaders == 2 and s.sources.nth(0).retentionMs == RETENTION_MS and s.sources.nth(1).retentionMs == LONG_RETENTION_MS)
    .then(elapse(1))
    .then(settle(1, VALUE_TWO))
    .expect(s.o.writeTtls == List(LONG_RETENTION_MS) and s.remoteValues == List(NO_VALUE, VALUE_TWO)
      and s.created == List(0, INITIAL_TIME_MS + 1) and s.expires == List(0, INITIAL_TIME_MS + 1 + LONG_RETENTION_MS))
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.dumps == 2 and s.o.writes == 2
      and s.o.writeTtls == List(LONG_RETENTION_MS, RETENTION_MS) and s.remoteValues == List(VALUE_ONE, VALUE_TWO)
      and s.expires == List(INITIAL_TIME_MS + 1 + RETENTION_MS, INITIAL_TIME_MS + 1 + LONG_RETENTION_MS))

  // Two sources started under replies with different local TTLs each warm
  // local storage for their own; with one slot the second settlement evicts
  // the first entry, and the second entry serves one millisecond before its
  // own TTL and misses locally after it (the frame written at the same
  // settlement is then at its own retention boundary too, so a source starts).
  run eachSourceWarmsLocalForItsOwnLocalTtlTest = init
    .then(begin(KEY, LOCAL_AND_REMOTE, SHORT_LOCAL_TTLS))
    .then(begin(OTHER_KEY, LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.loaders == 2 and s.sources.nth(0).localMs == SHORT_LOCAL_MS and s.sources.nth(1).localMs == LOCAL_MS)
    .then(settle(0, VALUE_ONE))
    .expect(s.localValues == List(VALUE_ONE, NO_VALUE) and s.localExpires == List(INITIAL_TIME_MS + SHORT_LOCAL_MS, 0))
    .then(settle(1, VALUE_TWO))
    .expect(s.localValues == List(NO_VALUE, VALUE_TWO) and s.localExpires == List(0, INITIAL_TIME_MS + LOCAL_MS)
      and s.lru == List(List(OTHER_KEY)) and s.o.writes == 2)
    .then(elapse(LOCAL_MS - 1))
    .then(begin(OTHER_KEY, LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.reads == 2)
    .then(elapse(1))
    .then(begin(OTHER_KEY, LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO, CALL_PENDING) and s.o.reads == 3 and s.o.loads == 0 and s.o.loaders == 3
      and not(Remote::retained(s, OTHER_KEY)))

  // A remote hit warms local storage for the reply's local TTL, not the
  // fixture's: the entry serves one millisecond before that TTL and a later
  // remote hit under the fixture's TTLs warms it for the fixture's.
  run remoteHitWarmsLocalForTheReplysLocalTtlTest = init
    .then(seed(KEY, VALUE_ONE, LONG_RETENTION_MS))
    .then(begin(KEY, LOCAL_AND_REMOTE, SHORT_LOCAL_TTLS))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1
      and s.localValues == List(VALUE_ONE, NO_VALUE) and s.localExpires == List(INITIAL_TIME_MS + SHORT_LOCAL_MS, 0))
    .then(elapse(SHORT_LOCAL_MS - 1))
    .then(begin(KEY, LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(elapse(1))
    .then(begin(KEY, LOCAL_AND_REMOTE, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.reads == 2 and s.o.loads == 2 and s.o.loaders == 0
      and s.localExpires == List(INITIAL_TIME_MS + SHORT_LOCAL_MS + LOCAL_MS, 0))
  // A detached source counts against the profile, owns nobody and carries no
  // authority: its settlement completes no caller, warms nothing, refills nothing.
  run detachedSourceOwnsNobodyTest = trackedInit.then(startDetached(KEY))
    .expect(s.o.loaders == 1 and s.o.calls == List() and Flights::ownedBy(s, 0) == Set()
      and s.sources.nth(0).localMs == 0 and s.sources.nth(0).retentionMs == 0 and s.sources.nth(0).fence == NO_FENCE)
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List() and s.o.dumps == 0 and s.o.writes == 0 and s.sources.nth(0).result == VALUE_ONE
      and s.localValues == List(NO_VALUE, NO_VALUE) and s.remoteValues == List(NO_VALUE, NO_VALUE))
}

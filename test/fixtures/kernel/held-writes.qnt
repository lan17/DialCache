// The held remote lifecycle with held refills, queued adapter replies and the
// metric events (remote_writes over deadlines, adapter_replies, metrics): one
// tracked key on one instance, no request scope, replies immediate, reads,
// decodes, dumps and writes held. Pins the seams the effects profile reaches
// only through its own fixtures and the ones it never reaches: an accepted
// loader that refills holds its dump and completes nobody until the write is
// released; the pre-serialization fence check reads the wall clock it sampled
// (`HeldDump.sampled`) and a rollback before the release lets the second check
// stop the write; a queued miss reply is consumed by the next successful read
// completion, owning or abandoned, and left by a failed one; a fenced reply's
// fence is kept only on a tracked key; a frame reply is a hit while fresh, a
// declined future frame when its stamp is ahead of the wall clock and an
// expired miss once its age reaches the freshness; a stored frame the
// watermark hides is a `watermark_fenced` miss and an absent one `value_absent`;
// a late loader result reports its duration and its failure once and a
// drained one nothing; the read's duration includes its fresh decode; an
// invalidation with a buffer proposes the wall clock plus the buffer.
module held_writes {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_io as RemoteIO from "../../../formal/kernel/remote-io"
  import remote_writes as Writes from "../../../formal/kernel/remote-writes"
  import recovery as Recovery from "../../../formal/kernel/recovery"
  import deadlines as Deadlines from "../../../formal/kernel/deadlines"
  import diagnostics as Diagnostics from "../../../formal/kernel/diagnostics"
  import adapter_replies as Replies from "../../../formal/kernel/adapter-replies"
  import metrics as Metrics from "../../../formal/kernel/metrics"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import clock as Clock from "../../../formal/kernel/clock"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true }
  pure val REMOTE_SHARED: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: true }
  pure val TTLS: Ttls = { localMs: 0, freshMs: 60000, retentionMs: 60000 }
  pure val READ_BUDGET = 10
  pure val SOURCE_BUDGET = 10
  pure val BUFFER = 20
  pure val CALL: Call = { instance: 0, key: 0, context: 0, enabled: true, keyFailed: false }

  type State = {
    o: Observation, d: Diagnostics, io: RemoteIO::IO, events: List[Metrics::Event],
    now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    sourceBudget: int, deadlines: List[Deadlines::Due], drained: List[bool], sourceLayers: List[str],
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], reply: int, replyAt: int,
    readStarted: List[int], decodeStarted: List[int], sourceStarted: List[int], dumpStarted: List[int]
  }
  var s: State
  var input: { name: str, choice: int }

  pure def initial(tracked: bool): State = {
    o: empty, d: noDiagnostics, io: RemoteIO::NO_IO, events: List(),
    now: 10000, skew: 90000, remoteAvailable: true, tracked: tracked, capacity: 0,
    readFailed: false, dumpFailed: false, writeFailed: false,
    closed: List(), memo: List(), requestFlights: List(), processFlights: List(NO_OWNER),
    localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
    remoteValues: List(NO_VALUE), created: List(0), expires: List(0), watermark: List(0),
    sources: List(), owners: List(), memoSlots: List(), held: List(),
    reads: List(), loads: List(), loaders: List(), retained: List(),
    sourceBudget: SOURCE_BUDGET, deadlines: List(), drained: List(), sourceLayers: List(),
    dumps: List(), writes: List(), reply: Replies::NO_REPLY, replyAt: 0,
    readStarted: List(), decodeStarted: List(), sourceStarted: List(), dumpStarted: List()
  }
  action init = all { s' = initial(true), input' = { name: "init", choice: -1 } }
  action untrackedInit = all { s' = initial(false), input' = { name: "init", choice: 5 } }
  // Every step keeps the drivers' counts aligned with the records.
  val consistent = s.loaders.length() == s.o.loaders and s.sourceStarted.length() == s.o.loaders and
    s.sources.length() == s.readStarted.length() and s.dumpStarted.length() == s.o.dumps

  action begin = all { s' = Metrics::begin(s, LAYOUT, CALL, REMOTE_SHARED, TTLS, READ_BUDGET), input' = { name: "beginCall", choice: -1 } }.expect(consistent)
  action read(index: int, failed: bool): bool = all {
    s' = Metrics::settleRead(s, LAYOUT, index, failed, Recovery::NONE, BUFFER), input' = { name: "releaseRead", choice: index }
  }.expect(consistent)
  action load(failed: bool): bool = all { s' = Metrics::settleLoad(s, LAYOUT, RemoteIO::latestLoad(s).load, failed), input' = { name: "releaseLoad", choice: -1 } }.expect(consistent)
  action settle(ordinal: int, value: int): bool = all { s' = Metrics::settleLoader(s, LAYOUT, ordinal, value, false), input' = { name: "resolveLoader", choice: ordinal } }.expect(consistent)
  action dump(failed: bool): bool = all { s' = Metrics::releaseDump(s, LAYOUT, Writes::latestDump(s).dump, failed, 1), input' = { name: "releaseDump", choice: -1 } }.expect(consistent)
  action write(failed: bool): bool = all { s' = Metrics::releaseWrite(s, LAYOUT, Writes::latestWrite(s).write, failed), input' = { name: "releaseWrite", choice: -1 } }.expect(consistent)
  action advance(ms: int): bool = all { s' = Metrics::advance(s, LAYOUT, ms), input' = { name: "tick", choice: ms } }.expect(consistent)
  action jump(ms: int): bool = all { s' = Clock::advance(s, ms), input' = { name: "jumpClock", choice: ms } }
  action rollback(ms: int): bool = all { s' = Clock::shiftWall(s, -ms), input' = { name: "rollbackWall", choice: ms } }
  action seed = all { s' = Remote::seedFrame(s, 0, VALUE_ONE, 60000), input' = { name: "seedRemote", choice: -1 } }
  action invalidate(bufferMs: int): bool = all { s' = Metrics::invalidate(s, 0, bufferMs), input' = { name: "invalidate", choice: bufferMs } }
  action reply(code: int): bool = all { s' = Replies::queue(s, code), input' = { name: "adapterReply", choice: code } }
  def names = s.events.foldl(List(), (out, e) => out.append(e.event))
  def details = s.events.foldl(List(), (out, e) => out.append(e.detail))
  def amounts(name: str): List[int] = s.events.select(e => e.event == name).foldl(List(), (out, e) => out.append(e.amount))
  def missReasons = s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail))

  // A refill holds its dump at acceptance and completes the callers at the write.
  run heldRefillCompletesAtTheWriteTest = init.then(begin).then(begin).then(read(0, false)).then(settle(0, VALUE_ONE))
    .expect(s.o.dumps == 1 and s.dumps.length() == 1 and s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.sources.nth(0).result == VALUE_ONE)
    .then(dump(false)).expect(s.o.writes == 1 and s.writes.length() == 1 and s.o.calls == List(CALL_PENDING, CALL_PENDING))
    .then(write(false)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.remoteValues == List(VALUE_ONE) and s.processFlights == List(NO_OWNER))
  // The dump's fence was cleared at the sampled wall clock; a rollback before
  // the release makes the second check stop the write, and the callers complete.
  run rollbackBeforeReleaseStopsTheWriteTest = init.then(invalidate(0)).then(advance(10)).then(begin).then(read(0, false)).then(settle(0, VALUE_ONE))
    .expect(s.dumps.nth(0).fence == 100000 and s.dumps.nth(0).sampled == 100010)
    .then(rollback(1000)).then(dump(false))
    .expect(s.o.writes == 0 and s.o.calls == List(VALUE_ONE) and s.dumps == List()
      and names == List("invalidation", "disabled", "request", "miss", "get", "fallback", "serialization", "size", "storedSize"))
  // A source fenced at acceptance (the miss observed a watermark ahead of the
  // wall clock) is served without a dump: the first fence check.
  run fencedAcceptanceHoldsNoDumpTest = init.then(invalidate(BUFFER)).then(begin).then(read(0, false)).then(settle(0, VALUE_ONE))
    .expect(s.o.dumps == 0 and s.o.calls == List(VALUE_ONE) and missReasons == List("value_absent") and s.sources.nth(0).fence == 100020)
  // A dump fault dispatches no write; a write fault stores nothing; both complete.
  run dumpFaultCompletesWithoutWriteTest = init.then(begin).then(read(0, false)).then(settle(0, VALUE_ONE)).then(dump(true))
    .expect(s.o.writes == 0 and s.o.calls == List(VALUE_ONE) and details.select(d => d == "serialization_dump").length() == 1)
  run writeFaultStoresNothingTest = init.then(begin).then(read(0, false)).then(settle(0, VALUE_ONE)).then(dump(false)).then(write(true))
    .expect(s.remoteValues == List(NO_VALUE) and s.o.calls == List(VALUE_ONE) and details.select(d => d == "cache_write").length() == 1)
  // A queued miss reply is consumed by a successful completion, owning or
  // abandoned, and left queued by a failed one.
  run failedReadLeavesTheReplyQueuedTest = init.then(reply(1)).then(begin).then(read(0, true))
    .expect(Replies::queued(s) and details.select(d => d == "cache_read").length() == 1)
    .then(settle(0, VALUE_ONE)).then(begin).then(read(1, false))
    .expect(not(Replies::queued(s)) and details.select(d => d == "unclassified").length() == 1)
  run abandonedReadConsumesTheReplyTest = init.then(begin).then(advance(10)).then(reply(1)).then(read(0, false))
    .expect(not(Replies::queued(s)) and s.o.loaders == 1 and names.select(n => n == "miss").length() == 0)
  // A fenced reply keeps its fence only on a tracked key; the untracked read
  // demotes it to an unclassified miss without a fence.
  run fencedReplyKeepsItsFenceOnATrackedKeyTest = init.then(reply(Replies::FENCED_WITH_FENCE)).then(begin).then(read(0, false))
    .expect(s.sources.nth(0).fence == 100000 + BUFFER and missReasons == List("watermark_fenced"))
  run untrackedReplyCarriesNoFenceTest = untrackedInit.then(reply(Replies::FENCED_WITH_FENCE)).then(begin).then(read(0, false))
    .expect(s.sources.nth(0).fence == NO_FENCE and missReasons == List("unclassified"))
  // A frame reply is a hit when its stamp is not in the future and a declined
  // future frame (offset, unclassified, no fence) otherwise; the frames are untouched.
  run frameReplyIsAHitTest = init.then(reply(Replies::FRAME_WITH_MISS_FIELDS)).then(begin).then(read(0, false))
    .expect(s.o.loads == 1 and s.o.loaders == 0 and s.remoteValues == List(NO_VALUE))
    .then(load(false)).expect(s.o.calls == List(VALUE_ONE) and names == List("disabled", "request", "serialization", "get"))
  run futureFrameReplyIsDeclinedTest = init.then(reply(Replies::FRAME_WITH_MISS_FIELDS)).then(rollback(1000)).then(begin).then(read(0, false))
    .expect(s.o.loads == 0 and s.o.loaders == 1 and s.sources.nth(0).fence == NO_FENCE and names == List("disabled", "request", "futureOffset", "miss", "get")
      and amounts("futureOffset") == List(1000) and missReasons == List("unclassified"))
  // A frame reply is judged by its stamp like a stored frame, the freshness
  // boundary inclusive: at the last fresh millisecond it is a hit, one
  // millisecond later an expired miss with no offset and no fence, and stamped
  // one millisecond ahead of the wall clock an unclassified miss after its offset.
  run staleFrameReplyMissIsExpiredTest = init.then(reply(Replies::FRAME_WITH_MISS_FIELDS)).then(jump(TTLS.freshMs - 1)).then(begin).then(read(0, false))
    .expect(s.o.loads == 1 and s.o.loaders == 0).then(load(false)).expect(s.o.calls == List(VALUE_ONE))
    .then(reply(Replies::FRAME_WITH_MISS_FIELDS)).then(jump(TTLS.freshMs)).then(begin).then(read(1, false))
    .expect(s.o.loads == 1 and s.o.loaders == 1 and s.sources.nth(1).fence == NO_FENCE and s.remoteValues == List(NO_VALUE)
      and names == List("disabled", "request", "serialization", "get", "disabled", "request", "miss", "get") and missReasons == List("expired"))
  run futureDatedFrameReplyMissIsUnclassifiedTest = init.then(reply(Replies::FRAME_WITH_MISS_FIELDS)).then(rollback(1)).then(begin).then(read(0, false))
    .expect(s.o.loads == 0 and s.o.loaders == 1 and s.sources.nth(0).fence == NO_FENCE
      and names == List("disabled", "request", "futureOffset", "miss", "get") and amounts("futureOffset") == List(1) and missReasons == List("unclassified"))
  // A stored frame the watermark hides is a fenced miss carrying the
  // watermark; an absent frame is a plain miss.
  run hiddenFrameIsAFencedMissTest = init.then(seed).then(invalidate(0)).then(begin).then(read(0, false))
    .expect(missReasons == List("watermark_fenced") and s.sources.nth(0).fence == 100000)
  run absentFrameIsAValueAbsentMissTest = init.then(begin).then(read(0, false))
    .expect(missReasons == List("value_absent") and s.sources.nth(0).fence == NO_FENCE)
  // A late result is a deadline error reported once with its duration; the
  // drained settlement of an already delivered loader reports nothing.
  run lateResultReportsOnceTest = init.then(begin).then(read(0, false)).then(jump(10)).then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(DEADLINE_ERROR) and amounts("fallback") == List(10) and details.select(d => d == "fallback").length() == 1)
  run drainedResultReportsNothingTest = init.then(begin).then(read(0, false)).then(advance(10))
    .expect(s.o.calls == List(DEADLINE_ERROR) and amounts("fallback") == List(10))
    .then(settle(0, VALUE_ONE)).expect(amounts("fallback") == List(10) and s.o.calls == List(DEADLINE_ERROR) and s.o.dumps == 0)
  // The read's duration includes the fresh decode it held.
  run readDurationIncludesTheDecodeTest = init.then(seed).then(begin).then(read(0, false)).then(advance(10)).then(load(false))
    .expect(amounts("get") == List(10) and names == List("disabled", "request", "serialization", "get"))
  // A read expired inside an advance reports the deadline error and its duration at the due instant.
  run expiredReadReportsAtItsDueInstantTest = init.then(begin).then(advance(30))
    .expect(s.io.aborted == List(0) and amounts("get") == List(10) and details.select(d => d == "cache_read_timeout").length() == 1 and s.o.loaders == 1)
  // A follower reports the singleflight it joined; a leader its read.
  run followerReportsTheScopeItJoinedTest = init.then(begin).then(begin)
    .expect(names == List("disabled", "request", "disabled", "coalesced") and s.events.nth(3).location == "process" and s.d.coalesced == List("process"))
  // An invalidation with a buffer proposes the wall clock plus the buffer.
  run bufferedInvalidationProposesAheadTest = init.then(invalidate(BUFFER)).expect(s.watermark == List(100020) and names == List("invalidation"))
    .then(invalidate(0)).expect(s.watermark == List(100020) and s.o.invalidations == 2)
}

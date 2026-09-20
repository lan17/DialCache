// Payload validity classes on both remote paths and the tracked retention
// cap, over the held remote traversal (remote_io, replies immediate through
// `RemoteIO::begin`) and the atomic one (serving): one key, one instance, two
// persistent contexts. Pins what the payloads module says once for both
// paths: a compressed fresh frame decodes to its value at the held decode and
// warms local with it; a corrupt fresh frame fails its decode by its code
// alone and restarts the loader unfenced; a corrupt recovery candidate keeps
// the loader's error with the deserialization label; a code of a class the
// module names no rule for is readable but decodes to nothing, so a stale
// frame storing it is no recovery candidate and the flight misses; a bare
// class code (Payloads::CORRUPT, value 0) decodes to nothing and is routed
// as a declined visible frame, the constraint the payloads header states; an
// unsupported encoding fails the held read like an adapter fault (no
// snapshot, no refill, no fence, while an untracked loader still warms
// local), so the loader failure that follows is unclassified and reports no
// recovery label, but a fenced or expired one is never seen and misses like
// an absent frame; the atomic read of an unsupported encoding denies the refill
// (`readOk`) and the atomic release serves a compressed frame's decoded
// value; and the documented
// limit that the atomic release, having no decode step, serves the value a
// fresh corrupt frame would have carried. The cap: a tracked refill is
// written with the capped retention while the recovery snapshot keeps the
// reply's maximum, an untracked refill is not capped, an atomic tracked
// refill is, and a candidate older than the cap but inside the maximum still
// serves. The compression channel (compression): the variants of the two
// transitions that hold a decode report the outcome its payload code decodes
// with, "decompressed" for a fresh compressed read and "fallback_raw" for a
// corrupt recovery candidate at the loader's failure, nothing for an
// uncompressed decode or a step that holds none. The held runs keep the
// drivers' loader ordinals aligned with the flights they run for
// (`ordinalsMatchLoaders`); the atomic runs settle a source by its index and
// hold no effect, so the loader map is not kept there.
module payload_classes {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_io as RemoteIO from "../../../formal/kernel/remote-io"
  import recovery as Recovery from "../../../formal/kernel/recovery"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import payloads as Payloads from "../../../formal/kernel/payloads"
  import compression as Compression from "../../../formal/kernel/compression"
  import clock as Clock from "../../../formal/kernel/clock"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, probeSourceScope: false }
  pure val ALONE: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: false }
  pure val WITH_LOCAL: Resolution = { layers: { request: true, local: true, remote: true }, coalesce: true }
  pure val TTLS: Ttls = { localMs: 0, freshMs: 1000, retentionMs: 5000 }
  pure val LOCAL_TTLS: Ttls = { localMs: 1000, freshMs: 1000, retentionMs: 5000 }
  // A reply whose retention lies above the tracked cap.
  pure val LONG_RETENTION_MS = 7200000
  pure val LONG_TTLS: Ttls = { localMs: 0, freshMs: 1000, retentionMs: LONG_RETENTION_MS }
  pure val READ_BUDGET = 5
  // The band's codes for the fixture's bytes: a compressed and a corrupt frame
  // carrying VALUE_ONE, and a code of a class the module names no rule for
  // (the hundred above UNSUPPORTED_ENCODING).
  pure val COMPRESSED_ONE = Payloads::COMPRESSED + VALUE_ONE
  pure val CORRUPT_ONE = Payloads::CORRUPT + VALUE_ONE
  pure val UNNAMED_CLASS = Payloads::UNSUPPORTED_ENCODING + 100
  pure val WALL_SKEW_MS = 100000
  pure val KEY = 0
  pure def call(context: int): Call = { instance: 0, key: KEY, context: context, enabled: true, keyFailed: false }

  type State = {
    o: Observation, io: RemoteIO::IO, now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    compression: List[str]
  }
  var s: State
  var input: { name: str, choice: int }

  // A stale VALUE_ONE frame (age 1000 at freshness 1000, stamped above the
  // zero watermark) is present at init: visible, never fresh, a recovery
  // candidate. The tracked reader has no local capacity; `localInit` and
  // `untrackedLocalInit` give it one slot.
  pure def initial(tracked: bool, capacity: int): State = {
    o: empty, io: RemoteIO::NO_IO, now: 0, skew: WALL_SKEW_MS, remoteAvailable: true, tracked: tracked, capacity: capacity,
    readFailed: false, dumpFailed: false, writeFailed: false,
    closed: List(false, false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER),
    localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
    remoteValues: List(VALUE_ONE), created: List(WALL_SKEW_MS - 1000), expires: List(60000), watermark: List(0),
    sources: List(), owners: List(), memoSlots: List(), held: List(),
    reads: List(), loads: List(), loaders: List(), retained: List(),
    compression: List()
  }
  action initialize(tracked: bool, capacity: int): bool = all {
    s' = initial(tracked, capacity), input' = { name: "init", choice: -1 }
  }
  action init = initialize(true, 0)
  action localInit = initialize(true, 1)
  action untrackedInit = initialize(false, 0)
  action untrackedLocalInit = initialize(false, 1)

  // The drivers' loader ordinals are the flights' loaders after every held step.
  val ordinalsMatchLoaders = s.loaders.length() == s.o.loaders

  // -- The held path -------------------------------------------------------------

  action beginWith(context: int, resolved: Resolution, ttls: Ttls): bool = all {
    s' = RemoteIO::begin(s, LAYOUT, call(context), resolved, ttls, READ_BUDGET),
    input' = { name: "beginCall", choice: context }
  }.expect(ordinalsMatchLoaders)
  action begin(context: int, resolved: Resolution): bool = beginWith(context, resolved, TTLS)
  // The drivers release a read or a decode by its index without a fault of
  // their own: whatever fails is the payload's doing.
  action read(index: int): bool = all {
    s' = RemoteIO::settleRead(s, LAYOUT, index, false, Recovery::ALLOW),
    input' = { name: "releaseRead", choice: index }
  }.expect(ordinalsMatchLoaders)
  action load(index: int): bool = all {
    s' = RemoteIO::settleLoad(s, LAYOUT, index, false),
    input' = { name: "releaseLoad", choice: index }
  }.expect(ordinalsMatchLoaders)
  action settle(ordinal: int, value: int): bool = all {
    s' = RemoteIO::settleLoader(s, LAYOUT, ordinal, value, false),
    input' = { name: "resolveLoader", choice: ordinal }
  }.expect(ordinalsMatchLoaders)
  // The same two settlements through the compression variants, which report
  // the outcome of the decode a step holds.
  action readReported(index: int): bool = all {
    s' = Compression::settleRead(s, LAYOUT, index, false, Recovery::ALLOW),
    input' = { name: "releaseRead", choice: index }
  }.expect(ordinalsMatchLoaders)
  action settleReported(ordinal: int, value: int): bool = all {
    s' = Compression::settleLoader(s, LAYOUT, ordinal, value, false),
    input' = { name: "resolveLoader", choice: ordinal }
  }.expect(ordinalsMatchLoaders)

  // -- The atomic path -------------------------------------------------------------

  action atomicBeginWith(resolved: Resolution, ttls: Ttls): bool = all {
    s' = Serving::begin(s, LAYOUT, call(0), resolved, ttls),
    input' = { name: "beginCall", choice: 0 }
  }
  action atomicBegin = atomicBeginWith(ALONE, TTLS)
  action atomicSettle(index: int, value: int): bool = all {
    s' = Serving::settle(s, LAYOUT, index, value),
    input' = { name: "resolveLoader", choice: index }
  }

  // -- Environment -----------------------------------------------------------------

  action advance(ms: int): bool = all { s' = Clock::advance(s, ms), input' = { name: "advance", choice: ms } }
  // A seed stores a payload code at an age, retained for the given TTL.
  action seedWith(payload: int, age: int, retentionMs: int): bool = all {
    s' = Remote::seedAged(s, KEY, payload, age, retentionMs), input' = { name: "seed", choice: payload }
  }
  action seed(payload: int, age: int): bool = seedWith(payload, age, 60000)
  action invalidate = all { s' = Serving::invalidate(s, 0), input' = { name: "invalidate", choice: -1 } }

  // -- Payload classes on the held path --------------------------------------------

  // A compressed fresh frame is held for decoding with its code; the decode
  // completes the caller with the value the bytes decode to and warms local
  // storage with that value, not the code.
  run compressedFreshFrameDecodesToItsValueTest = localInit.then(seed(COMPRESSED_ONE, 0)).then(beginWith(0, WITH_LOCAL, LOCAL_TTLS))
    .expect(s.o.reads == 1 and s.o.loads == 0 and RemoteIO::latestRead(s).read == 0 and RemoteIO::latestRead(s).flight == 0
      and RemoteIO::latestOrdinal(s) == NO_OWNER)
    .then(read(0))
    .expect(s.o.loads == 1 and s.o.loaders == 0 and RemoteIO::latestLoad(s).value == COMPRESSED_ONE
      and not(RemoteIO::latestLoad(s).recovery) and s.localValues == List(NO_VALUE))
    .then(load(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.localValues == List(VALUE_ONE) and s.localExpires == List(LOCAL_TTLS.localMs)
      and s.o.writes == 0 and s.o.loaders == 0 and s.memo == List(VALUE_ONE, NO_VALUE))
  // A corrupt fresh frame is held like any fresh frame; its decode fails by
  // its code alone (the drivers release it without a fault) and restarts the
  // flight's loader with refill allowed, unfenced under a watermark raised
  // since the read, and without a snapshot; the loader's value refills.
  run corruptFreshFrameFailsItsDecodeAndRestartsUnfencedTest = init.then(seed(CORRUPT_ONE, 0)).then(begin(0, ALONE)).then(read(0))
    .expect(s.o.loads == 1 and s.o.loaders == 0 and RemoteIO::latestLoad(s).value == CORRUPT_ONE and not(RemoteIO::latestLoad(s).recovery))
    .then(invalidate).then(load(0))
    .expect(s.o.loaders == 1 and s.loaders == List(0) and RemoteIO::latestOrdinal(s) == 0 and s.watermark == List(WALL_SKEW_MS) and s.retained == List()
      and s.sources.nth(0).retentionMs == TTLS.retentionMs and s.sources.nth(0).fence == NO_FENCE and s.o.calls == List(CALL_PENDING))
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 1 and s.remoteValues == List(VALUE_TWO) and s.o.recovery == List()
      and s.o.classifications == 0 and s.io.sourceErrors == List(0))
  // A stale corrupt frame is the recovery candidate; the recovery decode
  // fails by its code and the flight completes with the loader's own error
  // and identity under the deserialization label.
  run corruptRecoveryCandidateKeepsTheLoadersErrorTest = init.then(seed(CORRUPT_ONE, 1000)).then(begin(0, ALONE)).then(read(0))
    .expect(s.o.loaders == 1 and s.o.loads == 0 and Recovery::retainedFor(s, 0).candidate == CORRUPT_ONE
      and s.sources.nth(0).retentionMs == TTLS.retentionMs and s.sources.nth(0).fence == NO_FENCE)
    .then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.loads == 1 and s.o.classifications == 1 and RemoteIO::latestLoad(s).recovery)
    .then(load(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.recovery == List("deserialization_error") and s.io.sourceErrors == List(1)
      and s.retained == List() and s.o.writes == 0)
  // A code of a class the module names no rule for (UNNAMED_CLASS) is
  // readable and fails no decode, but decodes to nothing: a stale frame
  // storing it is no recovery candidate, so the loader's failure is classified
  // and reports a miss with the loader's own error and identity, holding no
  // recovery decode; no caller completes with the NO_VALUE it decodes to.
  run codeWithoutADecodedValueIsNoRecoveryCandidateTest = init
    .expect(Payloads::valueOf(UNNAMED_CLASS) == NO_VALUE and not(Payloads::readFails(UNNAMED_CLASS)) and not(Payloads::decodeFails(UNNAMED_CLASS)))
    .then(seed(UNNAMED_CLASS, 1000)).then(begin(0, ALONE)).then(read(0))
    .expect(s.o.loaders == 1 and s.o.loads == 0 and Recovery::retainedFor(s, 0).flight == 0 and Recovery::retainedFor(s, 0).candidate == NO_VALUE
      and s.sources.nth(0).retentionMs == TTLS.retentionMs and s.sources.nth(0).fence == NO_FENCE)
    .then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0 and s.o.classifications == 1 and s.o.recovery == List("miss")
      and s.io.sourceErrors == List(1) and s.retained == List() and s.o.writes == 0)
  // A bare class code carries no value: a fresh frame spelled Payloads::CORRUPT
  // (value 0) decodes to NO_VALUE, so `observe` routes it as a visible frame
  // the traversal declined, not as a decode that fails: no decode is held, no
  // compression outcome is reported, the snapshot's candidate is NO_VALUE and
  // the loader starts with refill allowed and no fence; its value refills. The
  // constraint the payloads header states: a compressed or corrupt code
  // reaches a decode step only with a positive value.
  run bareCorruptCodeIsADeclinedFrameTest = init
    .expect(Payloads::valueOf(Payloads::CORRUPT) == NO_VALUE and Payloads::decodeFails(Payloads::CORRUPT))
    .then(seed(Payloads::CORRUPT, 0)).then(begin(0, ALONE)).then(readReported(0))
    .expect(s.o.loads == 0 and s.o.loaders == 1 and s.compression == List() and Recovery::retainedFor(s, 0).candidate == NO_VALUE
      and s.sources.nth(0).retentionMs == TTLS.retentionMs and s.sources.nth(0).fence == NO_FENCE)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 1 and s.remoteValues == List(VALUE_TWO) and s.o.recovery == List()
      and s.o.classifications == 0 and s.compression == List())
  // A visible frame whose encoding the adapter does not know fails the read
  // like an adapter fault: nothing is held, no snapshot is retained, and the
  // loader starts with refill denied and no fence, where a miss under the
  // same watermark would carry it. The frame stays as it was.
  run unsupportedEncodingFailsTheHeldReadTest = init.then(invalidate).then(advance(1)).then(seed(Payloads::UNSUPPORTED_ENCODING, 0)).then(begin(0, ALONE))
    .expect(s.o.reads == 1 and s.watermark == List(WALL_SKEW_MS) and Remote::visible(s, KEY, LAYOUT.operationsPerEntity))
    .then(read(0))
    .expect(s.o.loaders == 1 and s.o.loads == 0 and s.retained == List() and s.sources.nth(0).retentionMs == 0
      and s.sources.nth(0).fence == NO_FENCE and s.io.sourceErrors == List(0))
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 0 and s.remoteValues == List(Payloads::UNSUPPORTED_ENCODING))
  // The failed read denies the refill only: an untracked flight's loader
  // still warms local storage for the reply's local TTL.
  run unsupportedEncodingWithAnUntrackedLoaderStillWarmsLocalTest = untrackedLocalInit.then(seed(Payloads::UNSUPPORTED_ENCODING, 0))
    .then(beginWith(0, WITH_LOCAL, LOCAL_TTLS)).then(read(0))
    .expect(s.o.loaders == 1 and s.o.loads == 0 and s.sources.nth(0).localMs == LOCAL_TTLS.localMs and s.sources.nth(0).retentionMs == 0
      and s.retained == List())
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 0 and s.localValues == List(VALUE_TWO) and s.localExpires == List(LOCAL_TTLS.localMs))
  // The failed read retains no snapshot, so the loader failure that follows
  // is unclassified: the caller completes with the loader's own error, no
  // recovery label is reported, no decode is held and nothing is written.
  run encodingFailedReadLeavesNoCandidateForTheLoadersFailureTest = init.then(seed(Payloads::UNSUPPORTED_ENCODING, 0)).then(begin(0, ALONE)).then(read(0))
    .expect(s.o.loaders == 1 and s.o.loads == 0 and s.retained == List() and s.sources.nth(0).retentionMs == 0)
    .then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.io.sourceErrors == List(1) and s.o.classifications == 0 and s.o.recovery == List()
      and s.o.loads == 0 and s.o.writes == 0 and s.retained == List() and s.remoteValues == List(Payloads::UNSUPPORTED_ENCODING))
  // The class is judged only on a frame the adapter returns: a fenced
  // unsupported frame, and an expired one, are ordinary misses, whose reads
  // complete, retain an empty snapshot and refill under the watermark's fence.
  run fencedOrExpiredUnsupportedFrameIsAnOrdinaryMissTest = init.then(seed(Payloads::UNSUPPORTED_ENCODING, 0)).then(advance(1)).then(invalidate)
    .expect(s.watermark == List(WALL_SKEW_MS + 1) and not(Remote::visible(s, KEY, LAYOUT.operationsPerEntity)))
    .then(begin(0, ALONE)).then(read(0))
    .expect(s.o.loaders == 1 and s.o.loads == 0 and s.sources.nth(0).retentionMs == TTLS.retentionMs and s.sources.nth(0).fence == WALL_SKEW_MS + 1
      and Recovery::retainedFor(s, 0).flight == 0 and Recovery::retainedFor(s, 0).candidate == NO_VALUE)
    .then(advance(1)).then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 1 and s.remoteValues == List(VALUE_TWO))
    .then(seedWith(Payloads::UNSUPPORTED_ENCODING, 0, 1000)).then(advance(1000))
    .expect(not(Remote::retained(s, KEY)) and s.remoteValues == List(Payloads::UNSUPPORTED_ENCODING))
    .then(begin(0, ALONE)).then(read(1))
    .expect(s.o.loaders == 2 and s.o.loads == 0 and RemoteIO::latestOrdinal(s) == 1 and s.sources.nth(1).retentionMs == TTLS.retentionMs
      and s.sources.nth(1).fence == WALL_SKEW_MS + 1 and Recovery::retainedFor(s, 1).candidate == NO_VALUE)
    .then(settle(1, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.writes == 2 and s.remoteValues == List(VALUE_TWO))

  // -- Payload classes on the atomic path ------------------------------------------

  // The same judgment at the atomic release: a stale frame's miss refills,
  // an unsupported encoding's read counts, fails and denies its refill.
  run atomicReadOfAnUnsupportedEncodingDeniesTheRefillTest = init.then(atomicBegin)
    .expect(s.o.reads == 1 and s.o.loads == 0 and s.o.loaders == 1 and s.o.calls == List(CALL_PENDING) and s.sources.nth(0).retentionMs == TTLS.retentionMs)
    .then(seed(Payloads::UNSUPPORTED_ENCODING, 0)).then(atomicBegin)
    .expect(s.o.reads == 2 and s.o.loads == 0 and s.o.loaders == 2 and s.sources.nth(1).retentionMs == 0 and s.sources.nth(1).fence == NO_FENCE)
    .then(atomicSettle(1, VALUE_TWO))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO) and s.o.writes == 0 and s.remoteValues == List(Payloads::UNSUPPORTED_ENCODING))
    .then(atomicSettle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.writes == 1 and s.o.writeTtls == List(TTLS.retentionMs) and s.remoteValues == List(VALUE_TWO))
  // The atomic release serves a fresh compressed frame's decoded value, its
  // decode counted.
  run atomicReleaseServesACompressedFramesDecodedValueTest = init.then(seed(COMPRESSED_ONE, 0)).then(atomicBegin)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0 and s.remoteValues == List(COMPRESSED_ONE))
  // The documented limit (payloads.qnt): the atomic release has no decode
  // step, so a fresh corrupt frame serves the value its bytes would have
  // carried; a profile composed over the atomic path must not seed
  // decode-fault payloads.
  run atomicReleaseOfAFreshCorruptFrameServesWithoutADecodeStepTest = init.then(seed(CORRUPT_ONE, 0)).then(atomicBegin)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0)

  // -- The tracked retention cap -----------------------------------------------------

  // A tracked flight's refill is written with the capped retention while its
  // snapshot keeps the reply's maximum.
  run trackedRefillIsCappedWhileTheSnapshotMaximumIsNotTest = init.then(beginWith(0, ALONE, LONG_TTLS)).then(read(0))
    .expect(s.o.loaders == 1 and s.sources.nth(0).retentionMs == Remote::TRACKED_RETENTION_CAP_MS
      and Recovery::retainedFor(s, 0).maximum == LONG_RETENTION_MS and Recovery::retainedFor(s, 0).candidate == VALUE_ONE)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writeTtls == List(Remote::TRACKED_RETENTION_CAP_MS) and s.expires == List(Remote::TRACKED_RETENTION_CAP_MS))
  // An untracked flight's refill is retained for the reply's full retention.
  run untrackedRefillIsNotCappedTest = untrackedInit.then(beginWith(0, ALONE, LONG_TTLS)).then(read(0))
    .expect(s.o.loaders == 1 and s.sources.nth(0).retentionMs == LONG_RETENTION_MS and Recovery::retainedFor(s, 0).maximum == LONG_RETENTION_MS)
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writeTtls == List(LONG_RETENTION_MS) and s.expires == List(LONG_RETENTION_MS))
  // The atomic path caps the same way.
  run atomicTrackedRefillIsCappedTest = init.then(atomicBeginWith(ALONE, LONG_TTLS))
    .expect(s.o.loaders == 1 and s.sources.nth(0).retentionMs == Remote::TRACKED_RETENTION_CAP_MS)
    .then(atomicSettle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writeTtls == List(Remote::TRACKED_RETENTION_CAP_MS) and s.expires == List(Remote::TRACKED_RETENTION_CAP_MS))
  // The cap is physical: a candidate one millisecond older than the cap but
  // inside the reply's maximum still serves, and nothing is written.
  run capDoesNotClampTheRecoveryMaximumTest = init.then(beginWith(0, ALONE, LONG_TTLS)).then(read(0)).then(settle(0, SOURCE_ERROR))
    .expect(s.o.loads == 1 and s.o.classifications == 1 and RemoteIO::latestLoad(s).recovery)
    .then(advance(Remote::TRACKED_RETENTION_CAP_MS + 1 - 1000))
    .expect(Clock::wallOf(s) - s.retained.nth(0).created == 3600001 and s.retained.nth(0).maximum == 7200000 and s.sources.nth(0).retentionMs == 3600000)
    .then(load(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.o.writeTtls == List() and s.o.writes == 0 and s.retained == List())

  // -- The judgments themselves --------------------------------------------------------

  // The compression outcome a decode reports, the value each class decodes
  // to, and which classes fail the read or the decode; the class is the
  // code's hundred, the value its remainder.
  run decodeOutcomeAndValueOfTest = init
    .expect(Payloads::decodeOutcome(COMPRESSED_ONE) == List("decompressed") and Payloads::decodeOutcome(CORRUPT_ONE) == List("fallback_raw")
      and Payloads::decodeOutcome(VALUE_ABSENT) == List() and Payloads::decodeOutcome(Payloads::UNSUPPORTED_ENCODING) == List()
      and Payloads::valueOf(VALUE_ABSENT) == VALUE_ABSENT and Payloads::valueOf(NO_VALUE) == NO_VALUE
      and Payloads::valueOf(COMPRESSED_ONE) == VALUE_ONE and Payloads::valueOf(CORRUPT_ONE) == VALUE_ONE
      and Payloads::valueOf(Payloads::UNSUPPORTED_ENCODING) == NO_VALUE
      and Payloads::readFails(Payloads::UNSUPPORTED_ENCODING) and not(Payloads::readFails(CORRUPT_ONE))
      and Payloads::decodeFails(CORRUPT_ONE) and not(Payloads::decodeFails(COMPRESSED_ONE))
      and Payloads::classOf(VALUE_ONE) == 0 and Payloads::classOf(COMPRESSED_ONE) == 1 and Payloads::classOf(CORRUPT_ONE) == 2
      and Payloads::classOf(Payloads::UNSUPPORTED_ENCODING) == 3 and Payloads::valueOf(Payloads::COMPRESSED) == NO_VALUE)
  // The class rules do not depend on the value: a compressed frame carrying
  // VALUE_TWO is judged like one carrying VALUE_ONE, and its held decode
  // completes the caller with VALUE_TWO and warms local with it.
  run compressedFrameCarryingAnotherValueDecodesToItTest = init
    .expect(Payloads::valueOf(Payloads::COMPRESSED + VALUE_TWO) == VALUE_TWO and Payloads::valueOf(Payloads::CORRUPT + VALUE_TWO) == VALUE_TWO
      and Payloads::decodeOutcome(Payloads::COMPRESSED + VALUE_TWO) == List("decompressed") and Payloads::decodeOutcome(Payloads::CORRUPT + VALUE_TWO) == List("fallback_raw")
      and not(Payloads::decodeFails(Payloads::COMPRESSED + VALUE_TWO)) and Payloads::decodeFails(Payloads::CORRUPT + VALUE_TWO)
      and not(Payloads::readFails(Payloads::COMPRESSED + VALUE_TWO)) and not(Payloads::readFails(Payloads::CORRUPT + VALUE_TWO)))
    .then(localInit).then(seed(Payloads::COMPRESSED + VALUE_TWO, 0)).then(beginWith(0, WITH_LOCAL, LOCAL_TTLS)).then(read(0))
    .expect(s.o.loads == 1 and RemoteIO::latestLoad(s).value == Payloads::COMPRESSED + VALUE_TWO)
    .then(load(0))
    .expect(s.o.calls == List(VALUE_TWO) and s.localValues == List(VALUE_TWO) and s.o.writes == 0 and s.o.loaders == 0)

  // -- The compression channel -----------------------------------------------------

  // A read that holds a fresh compressed frame's decode reports "decompressed"
  // as the decode is held, once; the decode's settlement adds nothing, an
  // uncompressed fresh frame's decode reports nothing, and a read that holds
  // no decode (a stale frame's miss) reports nothing.
  run freshCompressedReadReportsDecompressedTest = init.then(seed(COMPRESSED_ONE, 0)).then(begin(0, ALONE)).then(readReported(0))
    .expect(s.o.loads == 1 and s.compression == List("decompressed") and RemoteIO::latestLoad(s).value == COMPRESSED_ONE)
    .then(load(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.compression == List("decompressed"))
    .then(seed(VALUE_TWO, 0)).then(begin(1, ALONE)).then(readReported(1))
    .expect(s.o.loads == 2 and s.compression == List("decompressed"))
    .then(load(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO))
    .then(seed(VALUE_TWO, 1000)).then(begin(0, ALONE)).then(readReported(2))
    .expect(s.o.loads == 2 and s.o.loaders == 1 and s.compression == List("decompressed") and Recovery::retainedFor(s, 2).candidate == VALUE_TWO)
  // A recovery decode's outcome is reported at the loader's failure that
  // holds it, not at the read that retained the candidate: "fallback_raw" for
  // a corrupt candidate, nothing for an uncompressed one; the failed recovery
  // decode's settlement adds nothing.
  run corruptRecoveryCandidateReportsFallbackRawAtTheLoadersFailureTest = init.then(begin(0, ALONE)).then(readReported(0)).then(settleReported(0, SOURCE_ERROR))
    .expect(s.o.loads == 1 and RemoteIO::latestLoad(s).recovery and s.compression == List())
    .then(load(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.compression == List())
    .then(seed(CORRUPT_ONE, 1000)).then(begin(1, ALONE)).then(readReported(1))
    .expect(s.o.loads == 1 and s.compression == List() and Recovery::retainedFor(s, 1).candidate == CORRUPT_ONE)
    .then(settleReported(1, SOURCE_ERROR))
    .expect(s.o.loads == 2 and s.compression == List("fallback_raw") and RemoteIO::latestLoad(s).recovery
      and RemoteIO::latestLoad(s).value == CORRUPT_ONE)
    .then(load(1))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR) and s.o.recovery == List("served", "deserialization_error")
      and s.compression == List("fallback_raw") and s.io.sourceErrors == List(0, 2))
}

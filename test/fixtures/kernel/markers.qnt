// Invalidation markers (markers) over the held remote traversal (remote_io,
// replies immediate through `RemoteIO::begin`): one key, one entity, one
// instance, two persistent contexts, a tracked reader whose wall clock runs
// ahead of the monotonic one by the drivers' origin. Pins the schedules a
// scheduled profile cannot reach (its seeds never outlive the two-hour floor
// and its wall never rolls back): the floor lifetime; the lifetime covering
// the cap past a cutoff left ahead of the wall by a rollback; the longer
// remaining lifetime kept when a later invalidation asks for less; an expired
// marker un-fencing a day-retained frame under a long maximum, having fenced
// it until its last millisecond, so the frame becomes a recovery candidate; a
// write fault (`mutation_error`) and a missing remote layer (`missing_remote`)
// stamping no marker; a frame stamped at the cutoff fenced while stored and
// visible and retained after expiry; `observe` reporting NO_MARKER after
// expiry and a floor marker on the next invalidation; and the
// `mutation_error` outcome fields (the invalidation counted, the watermark
// unmoved) through `Serving::invalidate` itself. Every held step keeps the
// drivers' loader ordinals aligned with the flights they run for
// (`ordinalsMatchLoaders`).
module marker_lifetimes {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_io as RemoteIO from "../../../formal/kernel/remote-io"
  import recovery as Recovery from "../../../formal/kernel/recovery"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import markers as Markers from "../../../formal/kernel/markers"
  import clock as Clock from "../../../formal/kernel/clock"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, probeSourceScope: false }
  pure val ALONE: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: false }
  pure val HOUR_MS = 3600000
  pure val DAY_MS = 86400000
  // A reply whose retention (the recovery maximum) is a day, far above the cap.
  pure val TTLS: Ttls = { localMs: 0, freshMs: 1000, retentionMs: DAY_MS }
  pure val READ_BUDGET = 5
  // The wall clock runs this far ahead of the monotonic clock; the drivers
  // report cutoffs against it.
  pure val WALL_ORIGIN_MS = 100000
  pure val KEY = 0
  pure val ENTITY = 0
  pure def call(context: int): Call = { instance: 0, key: KEY, context: context, enabled: true, keyFailed: false }

  type State = {
    o: Observation, io: RemoteIO::IO, now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    markerExpires: List[int], markers: List[Markers::Marker]
  }
  var s: State
  var input: { name: str, choice: int }

  // No frame, no watermark and no marker at init.
  pure def initial(remoteAvailable: bool, writeFailed: bool): State = {
    o: empty, io: RemoteIO::NO_IO, now: 0, skew: WALL_ORIGIN_MS, remoteAvailable: remoteAvailable, tracked: true, capacity: 0,
    readFailed: false, dumpFailed: false, writeFailed: writeFailed,
    closed: List(false, false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER),
    localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
    remoteValues: List(NO_VALUE), created: List(0), expires: List(0), watermark: List(0),
    sources: List(), owners: List(), memoSlots: List(), held: List(),
    reads: List(), loads: List(), loaders: List(), retained: List(),
    markerExpires: List(0), markers: List()
  }
  action initialize(remoteAvailable: bool, writeFailed: bool): bool = all {
    s' = initial(remoteAvailable, writeFailed), input' = { name: "init", choice: -1 }
  }
  action init = initialize(true, false)
  action noRemoteInit = initialize(false, false)
  action writeFaultInit = initialize(true, true)

  // The drivers' loader ordinals are the flights' loaders after every held step.
  val ordinalsMatchLoaders = s.loaders.length() == s.o.loaders

  // -- The held path -------------------------------------------------------------

  action begin(context: int): bool = all {
    s' = RemoteIO::begin(s, LAYOUT, call(context), ALONE, TTLS, READ_BUDGET),
    input' = { name: "beginCall", choice: context }
  }.expect(ordinalsMatchLoaders)
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

  // -- Markers and maintenance -----------------------------------------------------

  action invalidate = all { s' = Markers::invalidate(s, ENTITY), input' = { name: "invalidate", choice: ENTITY } }
  // The outcome rule alone, without the marker.
  action servingInvalidate = all { s' = Serving::invalidate(s, ENTITY), input' = { name: "invalidate", choice: ENTITY } }
  action observe = all { s' = Markers::observe(s, ENTITY, WALL_ORIGIN_MS), input' = { name: "observeMarker", choice: ENTITY } }

  // -- Environment -----------------------------------------------------------------

  // Time passes through the markers' advance, which expires lapsed markers.
  action advance(ms: int): bool = all { s' = Markers::advance(s, ms), input' = { name: "advance", choice: ms } }
  // A wall-clock jump; negative is a rollback.
  action shiftWall(ms: int): bool = all { s' = Clock::shiftWall(s, ms), input' = { name: "shiftWall", choice: ms } }
  // A frame stamped at an age, retained for the given TTL.
  action seed(value: int, age: int, retentionMs: int): bool = all {
    s' = Remote::seedAged(s, KEY, value, age, retentionMs), input' = { name: "seed", choice: value }
  }
  action failWrites = all { s' = { writeFailed: true, ...s }, input' = { name: "writeFault", choice: 1 } }

  // -- Lifetimes ---------------------------------------------------------------------

  // An invalidation at the wall clock asks for the floor: twice the tracked
  // cap, two hours, which the marker reports in force from the cutoff.
  run floorLifetimeTest = init
    .expect(Markers::MARKER_FLOOR_MS == 2 * HOUR_MS and Markers::lifetime(WALL_ORIGIN_MS, WALL_ORIGIN_MS) == Markers::MARKER_FLOOR_MS
      and not(Markers::inForce(s, ENTITY)))
    .then(invalidate)
    .expect(s.o.invalidations == 1 and s.o.maintenance == List("ok") and s.watermark == List(WALL_ORIGIN_MS)
      and s.markerExpires == List(Markers::MARKER_FLOOR_MS) and Markers::inForce(s, ENTITY))
    .then(observe)
    .expect(s.markers == List({ cutoffMs: 0, ttlMs: 2 * HOUR_MS }))
  // After a two-hour wall rollback the watermark stays two hours ahead of the
  // wall (an invalidation never lowers it); the lifetime then covers the cap
  // past the cutoff, two hours plus the cap plus the margin, above the floor.
  run lifetimeCoversTheCapPastACutoffAheadOfTheWallTest = init.then(invalidate).then(shiftWall(-2 * HOUR_MS)).then(invalidate)
    .expect(s.o.invalidations == 2 and s.watermark == List(WALL_ORIGIN_MS) and Clock::wallOf(s) == WALL_ORIGIN_MS - 2 * HOUR_MS
      and Markers::lifetime(WALL_ORIGIN_MS, Clock::wallOf(s)) == 2 * HOUR_MS + Remote::TRACKED_RETENTION_CAP_MS + Markers::MARKER_MARGIN_MS
      and s.markerExpires == List(10860000))
    .then(observe)
    .expect(s.markers == List({ cutoffMs: 0, ttlMs: 10860000 }))
  // A later invalidation that asks for the floor keeps the longer remaining
  // lifetime, as the script keeps the larger existing PTTL, while the
  // watermark still rises to the wall.
  run longerRemainingLifetimeIsKeptWhenALaterInvalidationAsksForLessTest = init.then(invalidate).then(shiftWall(-2 * HOUR_MS)).then(invalidate)
    .then(shiftWall(2 * HOUR_MS)).then(advance(1000)).then(invalidate)
    .expect(s.o.invalidations == 3 and s.watermark == List(WALL_ORIGIN_MS + 1000)
      and Markers::lifetime(WALL_ORIGIN_MS + 1000, Clock::wallOf(s)) == Markers::MARKER_FLOOR_MS and s.markerExpires == List(10860000))
    .then(observe)
    .expect(s.markers == List({ cutoffMs: 1000, ttlMs: 10860000 - 1000 }))

  // -- Expiry and the fence ----------------------------------------------------------

  // A frame retained for a day is fenced by a watermark stamped a millisecond
  // after it until the marker's last millisecond (a miss retaining no
  // candidate, refilling under the watermark's fence), and un-fenced by the
  // marker's expiry: the read then finds it visible and stale inside the
  // day's maximum, retains it as the candidate with no fence, and the flight
  // recovers it when its loader fails.
  run expiredMarkerUnfencesADayRetainedFrameUnderALongMaximumTest = init.then(seed(VALUE_ONE, 0, DAY_MS)).then(advance(1)).then(invalidate)
    .expect(s.watermark == List(WALL_ORIGIN_MS + 1) and s.markerExpires == List(1 + 2 * HOUR_MS) and not(Remote::visible(s, KEY, LAYOUT.operationsPerEntity)))
    .then(advance(2 * HOUR_MS - 1))
    .expect(s.now == 2 * HOUR_MS and Markers::inForce(s, ENTITY) and Remote::retained(s, KEY) and not(Remote::visible(s, KEY, LAYOUT.operationsPerEntity)))
    .then(begin(0)).then(read(0))
    .expect(s.o.loaders == 1 and Recovery::retainedFor(s, 0).flight == 0 and Recovery::retainedFor(s, 0).candidate == NO_VALUE
      and s.sources.nth(0).fence == WALL_ORIGIN_MS + 1 and s.sources.nth(0).retentionMs == Remote::TRACKED_RETENTION_CAP_MS)
    .then(advance(1))
    .expect(not(Markers::inForce(s, ENTITY)) and s.watermark == List(0) and Remote::visible(s, KEY, LAYOUT.operationsPerEntity)
      and Remote::retained(s, KEY) and s.remoteValues == List(VALUE_ONE))
    .then(begin(1)).then(read(1))
    .expect(s.o.loaders == 2 and Recovery::retainedFor(s, 1).candidate == VALUE_ONE and Recovery::retainedFor(s, 1).maximum == DAY_MS
      and s.sources.nth(1).fence == NO_FENCE and s.sources.nth(1).retentionMs == Remote::TRACKED_RETENTION_CAP_MS)
    .then(settle(1, SOURCE_ERROR))
    .expect(s.o.loads == 1 and RemoteIO::latestLoad(s).recovery and s.o.calls == List(CALL_PENDING, CALL_PENDING))
    .then(load(0))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_ONE) and s.o.recovery == List("served") and s.o.writes == 0)
    .then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(SOURCE_ERROR, VALUE_ONE) and s.o.recovery == List("served", "miss") and s.io.sourceErrors == List(1, 0))
  // A frame stamped at the cutoff is fenced while stored (the fence is strict
  // against the watermark) and visible, retained, once the marker expires.
  run frameStampedAtTheCutoffIsFencedWhileStoredAndVisibleAfterExpiryTest = init.then(seed(VALUE_ONE, 0, DAY_MS)).then(invalidate)
    .expect(s.remoteValues == List(VALUE_ONE) and s.created == List(WALL_ORIGIN_MS) and s.watermark == List(WALL_ORIGIN_MS)
      and Remote::retained(s, KEY) and not(Remote::fenceCleared(s, KEY, LAYOUT.operationsPerEntity)) and not(Remote::visible(s, KEY, LAYOUT.operationsPerEntity)))
    .then(advance(2 * HOUR_MS))
    .expect(not(Markers::inForce(s, ENTITY)) and s.watermark == List(0) and Remote::retained(s, KEY) and Remote::visible(s, KEY, LAYOUT.operationsPerEntity))
    .then(begin(0)).then(read(0))
    .expect(Recovery::retainedFor(s, 0).candidate == VALUE_ONE and s.sources.nth(0).fence == NO_FENCE)

  // -- Outcomes that stamp nothing ---------------------------------------------------

  // Under a write fault the invalidation is counted and reports the mutation
  // error; the watermark does not move and no marker is stamped.
  run mutationErrorStampsNoMarkerTest = writeFaultInit
    .expect(not(Serving::maintains(s)))
    .then(invalidate)
    .expect(s.o.invalidations == 1 and s.o.maintenance == List("mutation_error") and s.watermark == List(0) and s.markerExpires == List(0)
      and not(Markers::inForce(s, ENTITY)))
    .then(observe)
    .expect(s.markers == List(Markers::NO_MARKER))
  // Without remote storage the request reports the missing layer, counts
  // nothing and stamps nothing.
  run missingRemoteStampsNoMarkerTest = noRemoteInit
    .expect(not(Serving::maintains(s)))
    .then(invalidate)
    .expect(s.o.invalidations == 0 and s.o.maintenance == List("missing_remote") and s.watermark == List(0) and s.markerExpires == List(0))
    .then(observe)
    .expect(s.markers == List(Markers::NO_MARKER))
  // The outcome rule itself (`Serving::invalidate`): a write fault after an
  // effective invalidation counts the invalidation, reports the mutation error
  // and leaves the watermark where it was although the wall clock is ahead;
  // the marker it never touched keeps its lifetime.
  run mutationErrorCountsTheInvalidationAndKeepsTheWatermarkTest = init.then(invalidate).then(advance(1000)).then(failWrites)
    .expect(not(Serving::maintains(s)) and Clock::wallOf(s) > s.watermark.nth(ENTITY))
    .then(servingInvalidate)
    .expect(s.o.invalidations == 2 and s.o.maintenance == List("ok", "mutation_error") and s.watermark == List(WALL_ORIGIN_MS)
      and s.markerExpires == List(2 * HOUR_MS))
    .then(observe)
    .expect(s.markers == List({ cutoffMs: 0, ttlMs: 2 * HOUR_MS - 1000 }))

  // -- The observed marker -------------------------------------------------------------

  // The marker reports its cutoff against the origin and its remaining
  // lifetime down to the last millisecond, NO_MARKER once expired (PTTL -2 on
  // a missing key), and a fresh floor marker from the zero baseline on the
  // next invalidation.
  run observeReportsNoMarkerAfterExpiryTest = init.then(observe)
    .expect(s.markers == List(Markers::NO_MARKER))
    .then(invalidate).then(observe).then(advance(1000)).then(observe).then(advance(2 * HOUR_MS - 1000 - 1)).then(observe)
    .expect(s.markers == List(Markers::NO_MARKER, { cutoffMs: 0, ttlMs: 2 * HOUR_MS }, { cutoffMs: 0, ttlMs: 2 * HOUR_MS - 1000 }, { cutoffMs: 0, ttlMs: 1 })
      and s.watermark == List(WALL_ORIGIN_MS))
    .then(advance(1)).then(observe)
    .expect(s.markers.nth(4) == Markers::NO_MARKER and s.watermark == List(0) and s.markerExpires == List(2 * HOUR_MS))
    .then(invalidate).then(observe)
    .expect(s.o.invalidations == 2 and s.watermark == List(WALL_ORIGIN_MS + 2 * HOUR_MS) and s.markerExpires == List(4 * HOUR_MS)
      and s.markers.nth(5) == { cutoffMs: 2 * HOUR_MS, ttlMs: 2 * HOUR_MS })
}

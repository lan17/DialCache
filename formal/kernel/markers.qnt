module markers {
  // Invalidation markers: the lifetime of an entity's watermark. The
  // implementations keep a watermark as a Redis key with a TTL. The
  // invalidation script writes the larger of the current and the proposed
  // watermark with `SET ... PX` for the larger of the key's remaining PTTL
  // and a desired lifetime: a floor of twice the tracked retention cap, or
  // the span from the invalidation's wall clock to the watermark plus the cap
  // and a minute's margin, whichever is longer, so the watermark outlives
  // every frame it may fence (`src/internal/redis-scripts.ts`
  // `INVALIDATE_CACHE_SCRIPT`: `MIN_WATERMARK_TTL_MS = 2 *
  // MAX_TRACKED_REDIS_VALUE_TTL_MS`, `WATERMARK_TTL_MARGIN_MS = 60000`, keep
  // the larger existing PTTL; `go/redis_adapter.go` `InvalidationScript`).
  // Once the key lapses a read sees no watermark.
  //
  // Marker expiry is a time transition that zeroes the watermark (`expire`,
  // applied by `advance`), not a judgment threaded through the fence: the
  // watermark field is what a read sees at each instant, so
  // `remote_frames::fenceCleared` and `missFence` keep reading the raw
  // watermark and the fence stays stated once. An invalidation never lowers a
  // watermark (`remote_frames::raiseWatermark`); only a marker's expiry
  // lowers one, to zero, and the next invalidation raises it from there, as
  // the script sees a missing key. A marker's expiry is kept per entity on
  // the monotonic clock, like every retention; its lifetime is computed on
  // the wall clock, the script's `invalidated_at_ms`. An invalidation stamps
  // a marker only when it takes effect (`serving::maintains`: remote storage
  // present and no write fault), the one judgment this module reads beside
  // `serving::invalidate`'s outcome rule, which it does not restate. `expire`
  // is its own definition so a profile that composes markers with deadlines
  // can apply it inside the per-instant walk. `observe` appends the marker the
  // drivers read, the cutoff against the origin the drivers report cutoffs
  // from (an explicit argument, not the skew, which diverges from it after a
  // wall rollback) and the remaining lifetime, or NO_MARKER (Redis PTTL -2 on
  // a missing key). One consumer today, recovery-read.
  import cache_rules.* from "../cache-rules"
  import clock as Clock from "./clock"
  import remote_frames as Remote from "./remote-frames"
  import serving as Serving from "./serving"

  type Marker = { cutoffMs: int, ttlMs: int }
  pure val NO_MARKER: Marker = { cutoffMs: -1, ttlMs: -2 }
  pure val MARKER_FLOOR_MS = 2 * Remote::TRACKED_RETENTION_CAP_MS
  pure val MARKER_MARGIN_MS = 60000

  type Marked[r] = Remote::Frames[{ markerExpires: List[int] | r }]
  type Observing[r] = Marked[{ markers: List[Marker] | r }]
  type Maintained[r] = Serving::Served[{ markerExpires: List[int] | r }]

  pure def inForce(state: Marked[r], entity: int): bool = deadlinePendingAt(state.now, state.markerExpires.nth(entity))
  // The lifetime the script asks for a watermark at `cutoff` written at `wall`.
  pure def lifetime(cutoff: int, wall: int): int = {
    val covering = cutoff - wall + Remote::TRACKED_RETENTION_CAP_MS + MARKER_MARGIN_MS
    if (covering > MARKER_FLOOR_MS) covering else MARKER_FLOOR_MS
  }
  // A marker no longer in force fences nothing: its entity's watermark
  // returns to the zero baseline (`Remote::clearWatermark`).
  pure def expire(state: Marked[r]): Marked[r] =
    state.watermark.indices().fold(state, (out, entity) =>
      if (inForce(state, entity)) out else Remote::clearWatermark(out, entity))
  pure def advance(state: Marked[r], ms: int): Marked[r] = expire(Clock::advance(state, ms))
  // The invalidation outcome (`serving::invalidate`) and, when it took
  // effect, the entity's marker kept for the larger of its remaining lifetime
  // and the lifetime the raised watermark asks for.
  pure def invalidate(state: Maintained[r], entity: int, bufferMs: int): Maintained[r] = {
    val invalidated = Serving::invalidate(state, entity, bufferMs)
    if (Serving::maintains(state)) {
      val current = state.markerExpires.nth(entity)
      val asked = state.now + lifetime(invalidated.watermark.nth(entity), Clock::wallOf(state))
      { markerExpires: state.markerExpires.replaceAt(entity, if (asked > current) asked else current), ...invalidated }
    } else invalidated
  }
  pure def observe(state: Observing[r], entity: int, originMs: int): Observing[r] = {
    val marker = if (inForce(state, entity))
      { cutoffMs: state.watermark.nth(entity) - originMs, ttlMs: state.markerExpires.nth(entity) - state.now }
      else NO_MARKER
    { markers: state.markers.append(marker), ...state }
  }
}

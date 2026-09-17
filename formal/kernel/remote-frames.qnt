module remote_frames {
  // Remote frames with wall-clock creation stamps, physical retention and
  // per-entity watermarks. A frame is written with the wall clock's stamp and
  // retained until an instant on the monotonic clock; it serves while retained
  // (`cache_rules.deadlinePendingAt`), logically fresh for the freshness the
  // reply resolved to (`cache_rules.freshAgeAllowed` on the wall clock, which
  // rejects a stamp from after a rollback) and, for a tracked reader, when its
  // stamp clears the entity's watermark (`cache_rules.fenceAllows`); an
  // untracked reader ignores watermarks. A watermark never lowers: an
  // invalidation raises it to the wall clock only when the wall clock is
  // ahead, as the implementation's invalidation script keeps the larger of the
  // current and the proposed watermark. A tracked miss carries the watermark
  // it observed as its refill fence. A frame stamped at a wall clock of zero
  // or below is never served to a tracked reader (`fenceAllows` is strict
  // against the zero watermark), as the implementation treats a zero createdAt.
  import cache_rules.* from "../cache-rules"
  import encodings.* from "./encodings"
  import clock as Clock from "./clock"

  type Frames[r] = {
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int], tracked: bool, now: int, skew: int | r
  }

  pure def entityOf(key: int, operationsPerEntity: int): int = key / operationsPerEntity
  // A write (a seed or a refill) is stamped with the wall clock and retained for its TTL.
  pure def seedFrame(state: Frames[r], key: int, value: int, retentionMs: int): Frames[r] = {
    remoteValues: state.remoteValues.replaceAt(key, value),
    created: state.created.replaceAt(key, Clock::wallOf(state)),
    expires: state.expires.replaceAt(key, state.now + retentionMs),
    ...state
  }
  pure def raiseWatermark(state: Frames[r], entity: int): Frames[r] = {
    val current = state.watermark.nth(entity)
    val wall = Clock::wallOf(state)
    { watermark: state.watermark.replaceAt(entity, if (wall > current) wall else current), ...state }
  }
  pure def retained(state: Frames[r], key: int): bool = deadlinePendingAt(state.now, state.expires.nth(key))
  pure def fresh(state: Frames[r], key: int, freshMs: int): bool =
    freshAgeAllowed(state.created.nth(key), Clock::wallOf(state), freshMs)
  pure def readableFrame(state: Frames[r], key: int, operationsPerEntity: int, freshMs: int): int =
    if ((not(state.tracked) or fenceAllows(state.created.nth(key), state.watermark.nth(entityOf(key, operationsPerEntity))))
      and retained(state, key) and fresh(state, key, freshMs)) state.remoteValues.nth(key) else NO_VALUE
  pure def missFence(state: Frames[r], key: int, operationsPerEntity: int): int =
    if (state.tracked) state.watermark.nth(entityOf(key, operationsPerEntity)) else NO_FENCE
  // An unfenced refill is always written: an untracked miss, or a tracked miss
  // on an entity never invalidated, whose watermark and fence are still 0. A
  // fenced one is written only while its fence still allows it: the frame it
  // would stamp now must clear the watermark the miss observed.
  pure def writeAllowed(state: Frames[r], fence: int): bool = fence == NO_FENCE or fenceAllows(Clock::wallOf(state), fence)
}

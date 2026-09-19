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
  // current and the proposed watermark. A frame stamped at a wall clock of zero
  // or below is never served to a tracked reader (`fenceAllows` is strict
  // against the zero watermark), as the implementation treats a zero createdAt.
  //
  // A frame is visible when it is present, retained and (tracked) fence-cleared,
  // whatever its age: what the adapter returned a frame for. It serves when it
  // is also fresh. A refill's fence is the watermark the read observed only
  // when it found no visible frame (`fenceFor`, C58): a visible frame the
  // traversal declined (stale, or stamped in the future) carries none, as the
  // implementations refill unfenced after a reply that carried a frame which
  // itself cleared the watermark. `storeFrame` is the write with an explicit
  // stamp (a held write stores the stamp captured when its dump was released;
  // an aged seed stamps the wall clock minus its age); `seedFrame` stamps the
  // wall clock now.
  import cache_rules.* from "../cache-rules"
  import encodings.* from "./encodings"
  import clock as Clock from "./clock"

  type Frames[r] = {
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int], tracked: bool, now: int, skew: int | r
  }

  pure def entityOf(key: int, operationsPerEntity: int): int = key / operationsPerEntity
  // A write is stored with the stamp its writer captured and retained for its TTL.
  pure def storeFrame(state: Frames[r], key: int, value: int, stamp: int, retentionMs: int): Frames[r] = {
    remoteValues: state.remoteValues.replaceAt(key, value),
    created: state.created.replaceAt(key, stamp),
    expires: state.expires.replaceAt(key, state.now + retentionMs),
    ...state
  }
  // A write (a seed or a refill) is stamped with the wall clock and retained for its TTL.
  pure def seedFrame(state: Frames[r], key: int, value: int, retentionMs: int): Frames[r] =
    storeFrame(state, key, value, Clock::wallOf(state), retentionMs)
  // A seed the drivers stamp at a non-negative age: the wall clock minus that age.
  pure def seedAged(state: Frames[r], key: int, value: int, ageMs: int, retentionMs: int): Frames[r] =
    storeFrame(state, key, value, Clock::wallOf(state) - ageMs, retentionMs)
  pure def raiseWatermark(state: Frames[r], entity: int): Frames[r] = {
    val current = state.watermark.nth(entity)
    val wall = Clock::wallOf(state)
    { watermark: state.watermark.replaceAt(entity, if (wall > current) wall else current), ...state }
  }
  pure def retained(state: Frames[r], key: int): bool = deadlinePendingAt(state.now, state.expires.nth(key))
  pure def fresh(state: Frames[r], key: int, freshMs: int): bool =
    freshAgeAllowed(state.created.nth(key), Clock::wallOf(state), freshMs)
  pure def fenceCleared(state: Frames[r], key: int, operationsPerEntity: int): bool =
    not(state.tracked) or fenceAllows(state.created.nth(key), state.watermark.nth(entityOf(key, operationsPerEntity)))
  // A frame the adapter returns: present, retained and (tracked) fence-cleared, whatever its age.
  pure def visible(state: Frames[r], key: int, operationsPerEntity: int): bool =
    state.remoteValues.nth(key) > NO_VALUE and retained(state, key) and fenceCleared(state, key, operationsPerEntity)
  // What one remote read observes, judged once for the atomic release and the
  // held read settlement: a failed read observes nothing; otherwise whether
  // the adapter returned a frame (`visible`) and the value the traversal
  // serves, the frame's when it is also fresh for the reply's freshness.
  type Observed = { visible: bool, value: int }
  pure def observe(state: Frames[r], key: int, operationsPerEntity: int, freshMs: int, failed: bool): Observed = {
    val seen = not(failed) and visible(state, key, operationsPerEntity)
    { visible: seen, value: if (seen and fresh(state, key, freshMs)) state.remoteValues.nth(key) else NO_VALUE }
  }
  pure def missFence(state: Frames[r], key: int, operationsPerEntity: int): int =
    if (state.tracked) state.watermark.nth(entityOf(key, operationsPerEntity)) else NO_FENCE
  // The fence a refill carries: the watermark a tracked read observed when it
  // found no visible frame; a visible frame the traversal declined carries none.
  pure def fenceFor(state: Frames[r], key: int, operationsPerEntity: int, visible: bool): int =
    if (visible) NO_FENCE else missFence(state, key, operationsPerEntity)
  // An unfenced refill is always written: an untracked miss, or a tracked miss
  // on an entity never invalidated, whose watermark and fence are still 0. A
  // fenced one is written only while its fence still allows it: the frame it
  // would stamp now must clear the watermark the miss observed.
  pure def writeAllowed(state: Frames[r], fence: int): bool = fence == NO_FENCE or fenceAllows(Clock::wallOf(state), fence)
}

module remote_frames {
  // Remote frames with creation stamps and per-entity watermarks. A tracked
  // reader sees a frame only when its stamp clears the entity's watermark
  // (cache_rules.fenceAllows); an untracked reader ignores watermarks. A
  // tracked miss carries the watermark it observed as its refill fence.
  import cache_rules.* from "../cache-rules"
  import encodings.* from "./encodings"

  type Frames[r] = { remoteValues: List[int], created: List[int], watermark: List[int], tracked: bool, now: int | r }

  pure def entityOf(key: int, operationsPerEntity: int): int = key / operationsPerEntity
  pure def seedFrame(state: Frames[r], key: int, value: int): Frames[r] = {
    remoteValues: state.remoteValues.replaceAt(key, value),
    created: state.created.replaceAt(key, state.now),
    ...state
  }
  pure def raiseWatermark(state: Frames[r], entity: int): Frames[r] =
    { watermark: state.watermark.replaceAt(entity, state.now), ...state }
  pure def readableFrame(state: Frames[r], key: int, operationsPerEntity: int): int =
    if (not(state.tracked) or fenceAllows(state.created.nth(key),
      state.watermark.nth(entityOf(key, operationsPerEntity)))) state.remoteValues.nth(key) else NO_VALUE
  pure def missFence(state: Frames[r], key: int, operationsPerEntity: int): int =
    if (state.tracked) state.watermark.nth(entityOf(key, operationsPerEntity)) else NO_FENCE
  // A refill is written only while its fence still allows it; the write is a
  // seedFrame, stamped now.
  pure def writeAllowed(state: Frames[r], fence: int): bool = fenceAllows(state.now, fence)
}

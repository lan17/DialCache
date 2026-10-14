module remote_frames {
  // Remote frames stamped on the wall clock, retained until a monotonic instant and fenced by
  // per-entity watermarks, and what one remote read observes, judged once for both remote paths.
  //
  // Rules
  // - A frame is visible while present, retained and, for a tracked reader, fence-cleared,
  //   whatever its age; it serves only while also fresh for the reply's freshness (C22).
  // - A tracked reader serves a stamp only when it strictly clears the entity's watermark; an
  //   untracked reader ignores watermarks (C32, C33, C35; `fenceCleared`).
  // - An invalidation never lowers a watermark: it raises it to the wall clock plus the future
  //   buffer only when that is ahead. Only a marker's expiry lowers one, to zero (C38).
  // - A refill's fence is the watermark a read observed when it found no visible frame; a
  //   visible frame the traversal declined carries none (C34; `fenceFor`).
  // - A fenced refill is written only while the frame it would stamp now still clears that
  //   fence; an unfenced refill is always written (C34; `writeAllowed`).
  // - A tracked write's physical retention is capped at one hour; the logical maximum a
  //   recovery snapshot carries is not (C37; `physicalRetention`).
  // Shapes
  // - Frames[r]: values, stamps, expiries and watermarks beside the tracking flag and clocks;
  //   `serving::Served` is one, and `markers` and `recovery` take it too.
  // - Observed: what one read observed (visible, failed, payload, value); `observe` builds it.
  // Consumers: admission, dark-layers, effects, independent, layers, local-failure, policy,
  //   recovery, recovery-read, shadow, shadow-layers, shadow-read-deadlines; composed through
  //   `serving`, `remote_io`, `remote_writes`, `recovery`, `deadlines`, `markers`, `metrics`,
  //   `adapter_replies`, `shadow`.
  // Ports: typescript/src/internal/redis-payload.ts `decodeTrackedRedisReadResult`.
  import cache_rules.* from "../cache-rules"
  import encodings.* from "./encodings"
  import clock as Clock from "./clock"
  import payloads as Payloads from "./payloads"

  type Frames[r] = {
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int], tracked: bool, now: int, skew: int | r
  }

  // A tracked write's retention is clamped to one hour so the entity's
  // watermark, kept for twice that, outlives every frame it may fence
  // (`typescript/src/internal/duration.ts` `MAX_TRACKED_REDIS_VALUE_TTL_MS`,
  // `typescript/src/internal/redis-cache.ts` `putWithLayer`, `go/engine.go` `putRemote`
  // with its `tracked_ttl_clamped` event, `go/protocol.go`
  // `MaxTrackedValueTTLMS`); an untracked write is retained for its full TTL.
  pure val TRACKED_RETENTION_CAP_MS = 3600000
  pure def physicalRetention(state: Frames[r], retentionMs: int): int =
    if (state.tracked and retentionMs > TRACKED_RETENTION_CAP_MS) TRACKED_RETENTION_CAP_MS else retentionMs

  pure def entityOf(key: int, operationsPerEntity: int): int = key / operationsPerEntity
  // A write is stored with the stamp its writer captured and retained for its
  // TTL, until an instant on the monotonic clock. This is the write with an
  // explicit stamp: a held write stores the stamp captured when its dump was
  // released, and an aged seed stamps the wall clock minus its age.
  pure def storeFrame(state: Frames[r], key: int, value: int, stamp: int, retentionMs: int): Frames[r] = {
    remoteValues: state.remoteValues.replaceAt(key, value),
    created: state.created.replaceAt(key, stamp),
    expires: state.expires.replaceAt(key, state.now + retentionMs),
    ...state
  }
  // A write (a seed or a refill) is stamped with the wall clock and retained for its TTL.
  pure def seedFrame(state: Frames[r], key: int, value: int, retentionMs: int): Frames[r] =
    storeFrame(state, key, value, Clock::wallOf(state), retentionMs)
  // A seed the drivers stamp at an age, negative for a stamp in the future: the wall clock minus that age.
  pure def seedAged(state: Frames[r], key: int, value: int, ageMs: int, retentionMs: int): Frames[r] =
    storeFrame(state, key, value, Clock::wallOf(state) - ageMs, retentionMs)
  // An invalidation raises the watermark to the wall clock plus the
  // invalidator's future buffer (`futureBufferMs`, application-owned: the
  // window in which a stale write may still become visible) only when that
  // is ahead of the current watermark. It never lowers one, as the
  // implementation's invalidation script keeps the larger of the current and
  // the proposed watermark (C38).
  pure def raiseWatermark(state: Frames[r], entity: int, bufferMs: int): Frames[r] = {
    val current = state.watermark.nth(entity)
    val proposed = Clock::wallOf(state) + bufferMs
    { watermark: state.watermark.replaceAt(entity, if (proposed > current) proposed else current), ...state }
  }
  // The zero baseline of an entity's watermark, the one a profile's init
  // starts from and the one NO_FENCE and an unfenced `writeAllowed` refer to:
  // where a marker's expiry (`markers::expire`) returns the entity. Only a
  // marker's expiry lowers a watermark.
  pure def clearWatermark(state: Frames[r], entity: int): Frames[r] =
    { watermark: state.watermark.replaceAt(entity, 0), ...state }
  // A frame is retained until its expiry, an instant on the monotonic clock
  // (`cache_rules.deadlinePendingAt`).
  pure def retained(state: Frames[r], key: int): bool = deadlinePendingAt(state.now, state.expires.nth(key))
  // A frame is fresh for the freshness the reply resolved to, measured on the
  // wall clock (`cache_rules.freshAgeAllowed`, which rejects a stamp from after
  // a rollback).
  pure def fresh(state: Frames[r], key: int, freshMs: int): bool =
    freshAgeAllowed(state.created.nth(key), Clock::wallOf(state), freshMs)
  // A tracked reader serves a stamp only when it clears the entity's watermark
  // (`cache_rules.readFenceAllows` over the strict `fenceAllows`); an untracked
  // reader ignores watermarks. A frame stamped at a wall clock of zero or below
  // is never served to a tracked reader, as `fenceAllows` is strict against the
  // zero watermark and the implementation treats a zero createdAt as a miss.
  pure def fenceCleared(state: Frames[r], key: int, operationsPerEntity: int): bool =
    readFenceAllows(state.tracked, state.created.nth(key), state.watermark.nth(entityOf(key, operationsPerEntity)))
  // A frame the adapter returns: present, retained and (tracked) fence-cleared,
  // whatever its age. It serves when it is also fresh.
  pure def visible(state: Frames[r], key: int, operationsPerEntity: int): bool =
    state.remoteValues.nth(key) > NO_VALUE and retained(state, key) and fenceCleared(state, key, operationsPerEntity)
  // What one remote read observes, judged once for the atomic release and the
  // held read settlement: whether the read failed (the caller's fault, or a
  // visible frame whose payload fails the read); a failed read observes
  // nothing; otherwise whether the adapter returned a frame (`visible`), its
  // payload code, and the value the traversal serves, what the code decodes
  // to when the frame is also fresh for the reply's freshness.
  type Observed = { visible: bool, failed: bool, payload: int, value: int }
  // What a read not made observes: nothing.
  pure val UNOBSERVED: Observed = { visible: false, failed: true, payload: NO_VALUE, value: NO_VALUE }
  // A frame stores a payload code (`payloads`): the drivers' value codes decode
  // to themselves, an enveloped class from 100 up says what its bytes do.
  // `observe` judges the class once for both remote paths: a visible frame
  // whose code fails the read (`Payloads::readFails`) fails the read like an
  // adapter fault. The value a fresh frame serves is what its code decodes to
  // (`Payloads::valueOf`).
  pure def observe(state: Frames[r], key: int, operationsPerEntity: int, freshMs: int, failed: bool): Observed = {
    val present = not(failed) and visible(state, key, operationsPerEntity)
    val code = if (present) state.remoteValues.nth(key) else NO_VALUE
    val fails = failed or (present and Payloads::readFails(code))
    val seen = present and not(fails)
    {
      visible: seen,
      failed: fails,
      payload: if (seen) code else NO_VALUE,
      value: if (seen and fresh(state, key, freshMs)) Payloads::valueOf(code) else NO_VALUE
    }
  }
  pure def missFence(state: Frames[r], key: int, operationsPerEntity: int): int =
    if (state.tracked) state.watermark.nth(entityOf(key, operationsPerEntity)) else NO_FENCE
  // The fence a refill carries: the watermark a tracked read observed when it
  // found no visible frame (C34). A visible frame the traversal declined (stale,
  // or stamped in the future) carries none, as the implementations refill
  // unfenced after a reply that carried a frame which itself cleared the
  // watermark.
  pure def fenceFor(state: Frames[r], key: int, operationsPerEntity: int, visible: bool): int =
    if (visible) NO_FENCE else missFence(state, key, operationsPerEntity)
  // An unfenced refill is always written: an untracked miss, or a tracked miss
  // on an entity never invalidated, whose watermark and fence are still 0. A
  // fenced one is written only while its fence still allows it: the frame it
  // would stamp now must clear the watermark the miss observed.
  pure def writeAllowed(state: Frames[r], fence: int): bool = fence == NO_FENCE or fenceAllows(Clock::wallOf(state), fence)
}

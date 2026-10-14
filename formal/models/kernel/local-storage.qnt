module local_storage {
  // Per-instance local storage with LRU eviction and insertion expiry; a hit renews recency, not
  // insertion.
  //
  // Rules
  // - Capacity is per instance and least-recently-used (C08): `lru` holds each instance's key
  //   order, oldest first, and a publication over capacity evicts the oldest key (`putLocal`).
  // - Local TTL starts at insertion and a read does not renew it (C09): `localExpires` holds the
  //   instant each entry stops serving, judged strictly by `cache_rules.localEntryLiveAt`.
  // - Zero capacity stores nothing but never fails (C10).
  // - An expired entry keeps its slot until it is overwritten or evicted; it serves nothing.
  // Shapes
  // - Local[r]: the instant, values and expiries by slot (one per instance and key, 0 absent),
  //   each instance's LRU order and the capacity.
  // Consumers: none directly; composed through `serving`.
  import cache_rules.* from "../cache-rules"
  import encodings.* from "./encodings"

  type Local[r] = { now: int, localValues: List[int], localExpires: List[int], lru: List[List[int]], capacity: int | r }

  pure def touch(order: List[int], key: int): List[int] = order.select(k => k != key).append(key)
  // A live entry's value; absent or expired entries serve nothing. A key's
  // slot is its instance's block of `keysPerInstance` slots, then the key.
  pure def localValue(state: Local[r], instance: int, key: int, keysPerInstance: int): int = {
    val slot = instance * keysPerInstance + key
    if (localEntryLiveAt(state.now, state.localExpires.nth(slot))) state.localValues.nth(slot) else NO_VALUE
  }
  // A hit renews recency, never insertion.
  pure def promote(state: Local[r], instance: int, key: int): Local[r] =
    { lru: state.lru.replaceAt(instance, touch(state.lru.nth(instance), key)), ...state }
  // A publication stamps its expiry from the current instant and the layer's TTL.
  pure def putLocal(state: Local[r], instance: int, key: int, value: int, ttlMs: int, keysPerInstance: int): Local[r] = {
    val order = touch(state.lru.nth(instance), key)
    val evicts = order.length() > state.capacity
    val kept = if (evicts) order.slice(1, order.length()) else order
    val evicted = instance * keysPerInstance + order.nth(0)
    val slot = instance * keysPerInstance + key
    if (state.capacity == 0) state else {
      lru: state.lru.replaceAt(instance, kept),
      localValues: (if (evicts) state.localValues.replaceAt(evicted, NO_VALUE) else state.localValues).replaceAt(slot, value),
      localExpires: (if (evicts) state.localExpires.replaceAt(evicted, 0) else state.localExpires).replaceAt(slot, state.now + ttlMs),
      ...state
    }
  }
}

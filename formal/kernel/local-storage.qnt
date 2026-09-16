module local_storage {
  // Per-instance local storage with LRU eviction. Values are indexed by
  // instance * keysPerInstance + key (0 absent); `lru` holds each instance's
  // key order, oldest first. Zero capacity stores nothing but never fails.
  // Insertion expiry is a separate concern layered on by profiles that age.
  import encodings.* from "./encodings"

  type Local[r] = { localValues: List[int], lru: List[List[int]], capacity: int | r }

  pure def touch(order: List[int], key: int): List[int] = order.select(k => k != key).append(key)
  pure def localValue(state: Local[r], instance: int, key: int, keysPerInstance: int): int =
    state.localValues.nth(instance * keysPerInstance + key)
  // A hit renews recency, never insertion.
  pure def promote(state: Local[r], instance: int, key: int): Local[r] =
    { lru: state.lru.replaceAt(instance, touch(state.lru.nth(instance), key)), ...state }
  pure def putLocal(state: Local[r], instance: int, key: int, value: int, keysPerInstance: int): Local[r] = {
    val order = touch(state.lru.nth(instance), key)
    val evicts = order.length() > state.capacity
    val kept = if (evicts) order.slice(1, order.length()) else order
    if (state.capacity == 0) state else {
      lru: state.lru.replaceAt(instance, kept),
      localValues: (if (evicts) state.localValues.replaceAt(instance * keysPerInstance + order.nth(0),
        NO_VALUE) else state.localValues).replaceAt(instance * keysPerInstance + key, value),
      ...state
    }
  }
}

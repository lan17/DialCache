module request_memo {
  // Request-scoped memo rows and scope lifetime. A persistent context owns one
  // memo row of `keysPerScope` slots (slot = context * keysPerScope + key) and
  // one row of request flights; fresh contexts have no row. Closing a scope
  // forgets its memo and its request flights, and a late settlement can no
  // longer memoize into it. Values are the driver's outcome codes; 0 is absent.
  import encodings.* from "./encodings"

  type Scoped[r] = { memo: List[int], closed: List[bool], requestFlights: List[int] | r }

  pure def persistent(context: int, persistentContexts: int): bool = context < persistentContexts
  pure def scopeOpen(state: Scoped[r], context: int, persistentContexts: int): bool =
    not(persistent(context, persistentContexts)) or not(state.closed.nth(context))
  // A call memoizes only inside an open persistent scope with the request layer enabled.
  pure def memoSlot(context: int, key: int, keysPerScope: int, memoizes: bool): int =
    if (memoizes) context * keysPerScope + key else NO_OWNER
  pure def memoValue(state: Scoped[r], slot: int): int =
    if (slot < 0) NO_VALUE else state.memo.nth(slot)
  pure def requestOwner(state: Scoped[r], slot: int): int =
    if (slot < 0) NO_OWNER else state.requestFlights.nth(slot)
  pure def memoize(state: Scoped[r], slot: int, value: int, keysPerScope: int): Scoped[r] =
    if (slot < 0 or state.closed.nth(slot / keysPerScope)) state else {
      memo: state.memo.replaceAt(slot, value),
      ...state
    }
  pure def joinRequestFlight(state: Scoped[r], slot: int, owner: int): Scoped[r] =
    if (slot < 0) state else { requestFlights: state.requestFlights.replaceAt(slot, owner), ...state }
  pure def closeScope(state: Scoped[r], context: int, keysPerScope: int): Scoped[r] = {
    closed: state.closed.replaceAt(context, true),
    memo: state.memo.indices().fold(state.memo, (out, slot) =>
      if (slot / keysPerScope == context) out.replaceAt(slot, NO_VALUE) else out),
    requestFlights: state.requestFlights.indices().fold(state.requestFlights, (out, slot) =>
      if (slot / keysPerScope == context) out.replaceAt(slot, NO_OWNER) else out),
    ...state
  }
}

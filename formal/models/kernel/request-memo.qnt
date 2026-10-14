module request_memo {
  // Request-scoped memo rows and scope lifetime: which contexts own a memo row,
  // how a key finds its slot and what closing a scope forgets.
  //
  // Rules
  // - A persistent context owns one memo row of `keysPerScope` slots, isolated from every
  //   other context's row (C07); a fresh context has no row.
  // - A call memoizes only inside an open persistent scope with the request layer enabled
  //   (`memoSlot`); a bypass leaves the row as it is, for later reenablement (C19).
  // - Closing a scope forgets its memo, and a late settlement can no longer memoize into it
  //   (C03); the request flight registry the scope also forgets belongs to `flights`.
  // Shapes
  // - Scoped[r]: the memo rows and closed flags; values are the driver's outcome codes, 0 absent.
  // - Opened[r]: which contexts an input has created; read by guards and input domains only.
  // Consumers: scope; composed through `serving`.
  import encodings.* from "./encodings"

  // The memo rows (values are the driver's outcome codes; 0 is absent) and
  // each persistent context's closed flag.
  type Scoped[r] = { memo: List[int], closed: List[bool] | r }
  // Which contexts the environment has created, for a profile whose scopes are
  // opened by an input; read only by guards and input domains.
  type Opened[r] = { opened: List[bool] | r }

  // A persistent context owns a memo row; a fresh context has none.
  pure def persistent(context: int, persistentContexts: int): bool = context < persistentContexts
  pure def scopeOpen(state: Scoped[r], context: int, persistentContexts: int): bool =
    not(persistent(context, persistentContexts)) or not(state.closed.nth(context))
  // A call memoizes only inside an open persistent scope with the request layer enabled.
  // Its slot is the key's position in the context's row: the context times
  // `keysPerScope`, plus the key.
  pure def memoSlot(context: int, key: int, keysPerScope: int, memoizes: bool): int =
    if (memoizes) context * keysPerScope + key else NO_OWNER
  pure def memoValue(state: Scoped[r], slot: int): int =
    if (slot < 0) NO_VALUE else state.memo.nth(slot)
  // A late settlement can no longer memoize into a closed scope (C03).
  pure def memoize(state: Scoped[r], slot: int, value: int, keysPerScope: int): Scoped[r] =
    if (slot < 0 or state.closed.nth(slot / keysPerScope)) state else {
      memo: state.memo.replaceAt(slot, value),
      ...state
    }
  pure def openScope(state: Opened[r], context: int): Opened[r] =
    { opened: state.opened.replaceAt(context, true), ...state }
  // Closing a scope forgets its memo; the request flight registry the scope
  // also forgets belongs to `flights`.
  pure def closeScope(state: Scoped[r], context: int, keysPerScope: int): Scoped[r] = {
    closed: state.closed.replaceAt(context, true),
    memo: state.memo.indices().fold(state.memo, (out, slot) =>
      if (slot / keysPerScope == context) out.replaceAt(slot, NO_VALUE) else out),
    ...state
  }
}

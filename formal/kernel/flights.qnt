module flights {
  // Source executions, their registries and the callers they own. A shared
  // source is registered under its process identity (the process registry)
  // and, when the caller memoizes and coalesces, under its request memo slot
  // (the request registry, which a scope's closure forgets); a caller's owner
  // is the source that will complete it (NO_OWNER for a caller served from a
  // layer). Settling a source clears every registry slot that named it, so a
  // finished flight never coalesces a later caller.
  //
  // A source record carries what the registries read (its outcome and whether
  // it is process-shared); the traversal that starts it adds the payload it
  // needs to publish (`serving::LayeredSource`) or nothing (`serving::RequestSource`).
  //
  // A record a profile composes only when a property of its own needs it:
  // the identity each caller asked for (recordIdentity, the layers ownership
  // property).

  import encodings.* from "./encodings"
  import calls.* from "./calls"

  type Source[p] = { result: int, shared: bool | p }
  // Per caller, parallel to the callers' outcomes: the owner that will
  // complete it and the memo slot it fills.
  type Registry[r, p] = {
    sources: List[Source[p]],
    owners: List[int],
    memoSlots: List[int],
    processFlights: List[int],
    requestFlights: List[int] | r
  }
  type Identified[r] = { callerInstances: List[int], callerKeys: List[int] | r }

  pure def processOwner(state: Registry[r, p], identity: int): int = state.processFlights.nth(identity)
  pure def requestOwner(state: Registry[r, p], slot: int): int =
    if (slot < 0) NO_OWNER else state.requestFlights.nth(slot)
  // Every caller is recorded at admission; its owner and memo slot are
  // attached when the traversal serves it.
  pure def admitCaller(state: Registry[r, p]): Registry[r, p] = {
    owners: state.owners.append(NO_OWNER),
    memoSlots: state.memoSlots.append(NO_OWNER),
    ...state
  }
  pure def attachCaller(state: Registry[r, p], caller: int, owner: int, slot: int): Registry[r, p] = {
    owners: state.owners.replaceAt(caller, owner),
    memoSlots: state.memoSlots.replaceAt(caller, slot),
    ...state
  }
  // A caller that memoizes and coalesces registers its owner under its request memo slot.
  pure def joinRequestFlight(state: Registry[r, p], slot: int, owner: int): Registry[r, p] =
    if (slot < 0) state else { requestFlights: state.requestFlights.replaceAt(slot, owner), ...state }
  // Starting a source makes it the caller's owner and registers it with the
  // request scope (when the call memoizes and coalesces) and, when shared,
  // with the process under the identity (instance and key) it serves.
  pure def registerSource(state: Registry[r, p], source: Source[p], caller: int, slot: int, coalesce: bool, identity: int): Registry[r, p] = {
    val index = state.sources.length()
    joinRequestFlight({
      sources: state.sources.append(source),
      owners: state.owners.replaceAt(caller, index),
      processFlights: if (source.shared) state.processFlights.replaceAt(identity, index) else state.processFlights,
      ...state
    }, if (coalesce) slot else NO_OWNER, index)
  }
  // A closed scope forgets its request flights along with its memo row.
  pure def forgetScope(state: Registry[r, p], context: int, keysPerScope: int): Registry[r, p] = {
    requestFlights: state.requestFlights.indices().fold(state.requestFlights, (out, slot) =>
      if (slot / keysPerScope == context) out.replaceAt(slot, NO_OWNER) else out),
    ...state
  }
  pure def settleSource(state: Registry[r, p], index: int, result: int): Registry[r, p] = {
    sources: state.sources.replaceAt(index, { result: result, ...state.sources.nth(index) }),
    processFlights: state.processFlights.foldl(List(), (out, owner) => out.append(if (owner == index) NO_OWNER else owner)),
    requestFlights: state.requestFlights.foldl(List(), (out, owner) => out.append(if (owner == index) NO_OWNER else owner)),
    ...state
  }
  pure def ownedBy(state: Registry[r, p], index: int): Set[int] =
    state.owners.indices().filter(call => state.owners.nth(call) == index)

  // Opt-in record: the identity of the last admitted caller, for a property
  // that no source completes a caller for another instance or key.
  pure def recordIdentity(state: Identified[r], call: Call): Identified[r] = {
    callerInstances: state.callerInstances.append(call.instance),
    callerKeys: state.callerKeys.append(call.key),
    ...state
  }
}

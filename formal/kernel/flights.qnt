module flights {
  // Source executions, their registries and the callers they own. A shared
  // source is registered under its instance and key (the process registry)
  // and, when the caller memoizes and coalesces, under its request memo slot
  // (the request registry, which a scope's closure forgets); a caller's owner
  // is the source that will complete it (NO_OWNER for a caller served from a
  // layer). Settling a source clears every registry slot that named it, so a
  // finished flight never coalesces a later caller.
  //
  // A record a profile composes only when a property of its own needs it:
  // the identity each caller asked for (recordIdentity, the layers ownership
  // property).

  import encodings.* from "./encodings"

  type Source = {
    instance: int,
    key: int,
    local: bool,
    remote: bool,
    fence: int,
    result: int,
    shared: bool
  }
  // Per caller, parallel to the callers' outcomes: the owner that will
  // complete it and the memo slot it fills.
  type Registry[r] = {
    sources: List[Source],
    owners: List[int],
    memoSlots: List[int],
    processFlights: List[int],
    requestFlights: List[int] | r
  }
  type Identified[r] = { callerInstances: List[int], callerKeys: List[int] | r }

  pure def processOwner(state: Registry[r], instance: int, key: int, keysPerInstance: int): int =
    state.processFlights.nth(instance * keysPerInstance + key)
  pure def requestOwner(state: Registry[r], slot: int): int =
    if (slot < 0) NO_OWNER else state.requestFlights.nth(slot)
  // Every caller is recorded with its owner and memo slot at admission.
  pure def admitCaller(state: Registry[r], owner: int, slot: int): Registry[r] = {
    owners: state.owners.append(owner),
    memoSlots: state.memoSlots.append(slot),
    ...state
  }
  // A caller that memoizes and coalesces registers its owner under its request memo slot.
  pure def joinRequestFlight(state: Registry[r], slot: int, owner: int): Registry[r] =
    if (slot < 0) state else { requestFlights: state.requestFlights.replaceAt(slot, owner), ...state }
  pure def ownCaller(state: Registry[r], caller: int, owner: int): Registry[r] =
    { owners: state.owners.replaceAt(caller, owner), ...state }
  // Starting a source makes it the caller's owner and registers it with the
  // request scope (when the call memoizes and coalesces) and the process (when shared).
  pure def registerSource(state: Registry[r], source: Source, caller: int, slot: int, coalesce: bool, keysPerInstance: int): Registry[r] = {
    val index = state.sources.length()
    joinRequestFlight({
      sources: state.sources.append(source),
      owners: state.owners.replaceAt(caller, index),
      processFlights: if (source.shared) state.processFlights.replaceAt(source.instance * keysPerInstance + source.key, index)
        else state.processFlights,
      ...state
    }, if (coalesce) slot else NO_OWNER, index)
  }
  // A closed scope forgets its request flights along with its memo row.
  pure def forgetScope(state: Registry[r], context: int, keysPerScope: int): Registry[r] = {
    requestFlights: state.requestFlights.indices().fold(state.requestFlights, (out, slot) =>
      if (slot / keysPerScope == context) out.replaceAt(slot, NO_OWNER) else out),
    ...state
  }
  pure def settleSource(state: Registry[r], index: int, result: int): Registry[r] = {
    sources: state.sources.replaceAt(index, { result: result, ...state.sources.nth(index) }),
    processFlights: state.processFlights.foldl(List(), (out, owner) => out.append(if (owner == index) NO_OWNER else owner)),
    requestFlights: state.requestFlights.foldl(List(), (out, owner) => out.append(if (owner == index) NO_OWNER else owner)),
    ...state
  }
  pure def ownedBy(state: Registry[r], index: int): Set[int] =
    state.owners.indices().filter(call => state.owners.nth(call) == index)

  // Opt-in record: the identity of the last admitted caller, for a property
  // that no source completes a caller for another instance or key.
  pure def recordIdentity(state: Identified[r], instance: int, key: int): Identified[r] = {
    callerInstances: state.callerInstances.append(instance),
    callerKeys: state.callerKeys.append(key),
    ...state
  }
}

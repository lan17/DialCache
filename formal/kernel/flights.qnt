module flights {
  // Source executions, their registries and the callers they own. A source is
  // registered under its instance and key while it is shared; a caller's owner
  // is the source that will complete it (NO_OWNER for a caller served from a
  // layer). Settling a source clears every registry slot that named it, so a
  // finished flight never coalesces a later caller.
  import conformance_observations.* from "../conformance-observations"

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
  type Registry[r] = {
    sources: List[Source],
    owners: List[int],
    memoSlots: List[int],
    callerContexts: List[int],
    callerKeys: List[int],
    processFlights: List[int],
    requestFlights: List[int] | r
  }

  pure def processOwner(state: Registry[r], instance: int, key: int, keysPerInstance: int): int =
    state.processFlights.nth(instance * keysPerInstance + key)
  // Every caller is recorded with its owner and memo slot at admission.
  pure def admitCaller(state: Registry[r], owner: int, slot: int, context: int, key: int): Registry[r] = {
    owners: state.owners.append(owner),
    memoSlots: state.memoSlots.append(slot),
    callerContexts: state.callerContexts.append(context),
    callerKeys: state.callerKeys.append(key),
    ...state
  }
  pure def lastCaller(state: Registry[r]): int = state.owners.length() - 1
  // Starting a source makes it the last caller's owner and registers it with
  // the request scope (when the call memoizes) and the process (when shared).
  pure def registerSource(state: Registry[r], source: Source, slot: int, keysPerInstance: int): Registry[r] = {
    val index = state.sources.length()
    {
      sources: state.sources.append(source),
      owners: state.owners.replaceAt(lastCaller(state), index),
      requestFlights: if (slot >= 0) state.requestFlights.replaceAt(slot, index) else state.requestFlights,
      processFlights: if (source.shared) state.processFlights.replaceAt(source.instance * keysPerInstance + source.key, index)
        else state.processFlights,
      ...state
    }
  }
  pure def settleSource(state: Registry[r], index: int, result: int): Registry[r] = {
    sources: state.sources.replaceAt(index, { result: result, ...state.sources.nth(index) }),
    processFlights: state.processFlights.foldl(List(), (out, owner) => out.append(if (owner == index) NO_OWNER else owner)),
    requestFlights: state.requestFlights.foldl(List(), (out, owner) => out.append(if (owner == index) NO_OWNER else owner)),
    ...state
  }
  pure def ownedBy(state: Registry[r], index: int): Set[int] =
    state.owners.indices().filter(call => state.owners.nth(call) == index)
}

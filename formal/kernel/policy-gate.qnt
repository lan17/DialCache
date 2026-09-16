module policy_gate {
  // Callers whose policy reply is held by the environment. A participating
  // caller is held under the index of its policy call at admission and
  // released by that index (the drivers' `release policy <index>`); a released
  // caller is served by the traversal with the state current at release. The
  // gate holds only callers still waiting, so a profile that never holds a
  // reply carries an empty list. `lastReleased` names the caller the latest
  // release served, so a property can be stated about that release step.
  import encodings.* from "./encodings"

  type Held = { policyCall: int, caller: int }
  type Gated[r] = { held: List[Held], lastReleased: int | r }

  pure def hold(state: Gated[r], policyCall: int, caller: int): Gated[r] =
    { held: state.held.append({ policyCall: policyCall, caller: caller }), ...state }
  pure def holding(state: Gated[r]): bool = state.held.length() > 0
  // The policy call of the latest held caller (the drivers' `policyCalls - 1`).
  pure def latest(state: Gated[r]): int =
    if (state.held.length() == 0) NO_OWNER else state.held.nth(state.held.length() - 1).policyCall
  pure def heldCaller(state: Gated[r], policyCall: int): int =
    state.held.foldl(NO_OWNER, (found, entry) => if (entry.policyCall == policyCall) entry.caller else found)
  pure def release(state: Gated[r], policyCall: int): Gated[r] = {
    held: state.held.select(entry => entry.policyCall != policyCall),
    lastReleased: heldCaller(state, policyCall),
    ...state
  }
}

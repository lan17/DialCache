module policy_gate {
  // Callers whose policy reply is held by the environment. A participating
  // caller is held, with the call it asked for, under the index of its policy
  // call at admission and released by that index (the drivers' `release policy
  // <index>`); the traversal then serves it with the state current at release.
  // The gate holds only callers still waiting, so a profile that never holds a
  // reply carries an empty list.
  import encodings.* from "./encodings"
  import calls.* from "./calls"

  type Held = { policyCall: int, caller: int, call: Call }
  type Gated[r] = { held: List[Held] | r }

  pure val NOT_HELD: Held = { policyCall: NO_OWNER, caller: NO_OWNER, call: { instance: NO_OWNER, key: NO_OWNER, context: NO_OWNER, enabled: false } }

  pure def hold(state: Gated[r], policyCall: int, caller: int, call: Call): Gated[r] =
    { held: state.held.append({ policyCall: policyCall, caller: caller, call: call }), ...state }
  pure def holding(state: Gated[r]): bool = state.held.length() > 0
  // The policy call of the latest held caller (the drivers' `policyCalls - 1`).
  pure def latest(state: Gated[r]): int =
    if (state.held.length() == 0) NO_OWNER else state.held.nth(state.held.length() - 1).policyCall
  // The entry held under a policy call; NOT_HELD (caller -1) when none is.
  pure def entry(state: Gated[r], policyCall: int): Held =
    state.held.foldl(NOT_HELD, (found, held) => if (held.policyCall == policyCall) held else found)
  pure def release(state: Gated[r], policyCall: int): Gated[r] =
    { held: state.held.select(held => held.policyCall != policyCall), ...state }
}

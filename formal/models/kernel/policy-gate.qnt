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

  // The key is the policy-call count at admission (`serving::entered`), which
  // advances only where the layout has a policy provider: a composition that
  // holds replies across steps needs `serving::Layout.policyProvider`, since
  // without one every held caller would share key 0, `entry` would return the
  // first and `release` drop them all. A layout without a provider composes
  // immediate replies only, which hold and release within one step.
  pure def hold(state: Gated[r], policyCall: int, caller: int, call: Call): Gated[r] =
    { held: state.held.append({ policyCall: policyCall, caller: caller, call: call }), ...state }
  pure def holding(state: Gated[r]): bool = state.held.length() > 0
  // The policy call of the latest held caller (the drivers' `policyCalls - 1`).
  pure def latest(state: Gated[r]): int =
    if (state.held.length() == 0) NO_OWNER else state.held.nth(state.held.length() - 1).policyCall
  pure def holds(state: Gated[r], policyCall: int): bool =
    state.held.select(held => held.policyCall == policyCall).length() > 0
  // The entry held under a policy call. Releasing a policy call the gate does
  // not hold is a modeling error: the lookup fails here, out of bounds.
  pure def entry(state: Gated[r], policyCall: int): Held =
    state.held.select(held => held.policyCall == policyCall).nth(0)
  pure def release(state: Gated[r], policyCall: int): Gated[r] =
    { held: state.held.select(held => held.policyCall != policyCall), ...state }
}

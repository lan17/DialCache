module callers {
  // Per-caller identity a profile records for its own independent properties:
  // which context and key each admitted caller asked for, parallel to the
  // callers' outcomes. No library rule reads it; a profile composes it after
  // admission when an invariant needs it.
  type Callers[r] = { callerContexts: List[int], callerKeys: List[int] | r }

  pure def record(state: Callers[r], context: int, key: int): Callers[r] = {
    callerContexts: state.callerContexts.append(context),
    callerKeys: state.callerKeys.append(key),
    ...state
  }
}

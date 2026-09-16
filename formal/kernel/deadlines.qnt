module deadlines {
  // Source budgets (C23 to C27): a source starts with the budget its call
  // resolved (none for a caller outside every request, the configured budget
  // otherwise, a key that failed to construct included), the deadline is
  // measured from the source's own start (`cache_rules.sourceAcceptsAt`,
  // equality belongs to the timeout), an expired source completes every
  // caller it owns with DEADLINE_ERROR when its timer is delivered on an
  // advance or when its result arrives late, and the abandoned work still
  // drains once. The records are parallel to the source list; a profile whose
  // drivers bound sources composes the budgeted variants of the local
  // lifecycle below.
  import cache_rules.* from "../cache-rules"
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import policy_gate as Gate from "./policy-gate"
  import clock as Clock from "./clock"

  pure val UNBOUNDED = -1

  // Per source: when it started, its budget, when it settled (-1 while
  // pending) and whether its external work has been delivered.
  type Budgeted[r] = { now: int, sourceBudget: int, started: List[int], budgets: List[int], settledAt: List[int], drained: List[bool] | r }
  type BudgetedLocal[r] = {
    now: int,
    sourceBudget: int,
    started: List[int],
    budgets: List[int],
    settledAt: List[int],
    drained: List[bool],
    o: Observation,
    capacity: int,
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    localValues: List[int],
    localExpires: List[int],
    lru: List[List[int]],
    sources: List[Serving::LocalSource],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held] | r
  }

  // The budget a call's source gets: none outside every request (C01).
  pure def budgetFor(state: Budgeted[r], call: Call): int = if (call.outside) UNBOUNDED else state.sourceBudget
  pure def stamp(state: Budgeted[r], budget: int): Budgeted[r] = {
    started: state.started.append(state.now),
    budgets: state.budgets.append(budget),
    settledAt: state.settledAt.append(-1),
    drained: state.drained.append(false),
    ...state
  }
  // The deadline is measured from the source's start; equality belongs to the timeout.
  pure def reached(state: Budgeted[r], index: int): bool =
    not(sourceAcceptsAt(state.started.nth(index), state.now, state.budgets.nth(index)))
  pure def pending(state: Budgeted[r], index: int): bool = not(state.drained.nth(index))
  pure def drain(state: Budgeted[r], index: int): Budgeted[r] = { drained: state.drained.replaceAt(index, true), ...state }
  pure def markSettled(state: Budgeted[r], index: int): Budgeted[r] = { settledAt: state.settledAt.replaceAt(index, state.now), ...state }

  // -- Budgeted variants of the local lifecycle ------------------------------------

  pure def admitLocal(state: BudgetedLocal[r], layout: Serving::Layout, call: Call): BudgetedLocal[r] = {
    val admitted = Serving::admitLocal(state, layout, call)
    if (admitted.sources.length() > state.sources.length()) stamp(admitted, budgetFor(state, call)) else admitted
  }
  pure def releaseLocal(state: BudgetedLocal[r], layout: Serving::Layout, policyCall: int, resolved: Resolution): BudgetedLocal[r] = {
    val call = Gate::entry(state, policyCall).call
    val released = Serving::releaseLocal(state, layout, policyCall, resolved)
    if (released.sources.length() > state.sources.length()) stamp(released, budgetFor(state, call)) else released
  }
  // A source's outcome arriving after its deadline is a deadline error; work
  // whose deadline already completed its callers drains without effect.
  pure def settleLocal(state: BudgetedLocal[r], layout: Serving::Layout, index: int, value: int): BudgetedLocal[r] = {
    val drained = drain(state, index)
    if (state.sources.nth(index).result != CALL_PENDING) drained
    else markSettled(Serving::settleLocal(drained, layout, index, if (reached(state, index)) DEADLINE_ERROR else value), index)
  }
  // Time passes and every pending source whose deadline is reached completes
  // its callers with a deadline error; its external work is not drained.
  pure def advanceLocal(state: BudgetedLocal[r], layout: Serving::Layout, ms: int): BudgetedLocal[r] = {
    val advanced = Clock::advance(state, ms)
    advanced.sources.indices().fold(advanced, (current, index) =>
      if (current.sources.nth(index).result == CALL_PENDING and reached(current, index))
        markSettled(Serving::settleLocal(current, layout, index, DEADLINE_ERROR), index)
      else current)
  }
}

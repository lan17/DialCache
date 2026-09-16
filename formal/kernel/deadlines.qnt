module deadlines {
  // Source budgets (C23 to C27): a source starts with the budget its start
  // resolved. A source started at admission belongs to a caller that made no
  // policy call: it is bounded only when its key failed to construct (C27); a
  // disabled context and a call outside every request run theirs unbounded
  // (C01). A source started at release belongs to a caller that was enabled
  // when admitted, whether or not its scope has closed since, and is always
  // bounded. The deadline is measured from the source's own start
  // (`cache_rules.sourceAcceptsAt`, equality belongs to the timeout), an
  // expired source completes every caller it owns with DEADLINE_ERROR when its
  // timer is delivered on an advance or when its result arrives late, and the
  // abandoned work still drains once. The records are parallel to the source
  // list; a profile whose drivers bound sources composes the budgeted variants
  // of the local lifecycle below.
  import cache_rules.* from "../cache-rules"
  import conformance_observations.* from "../conformance-observations"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import clock as Clock from "./clock"

  pure val UNBOUNDED = -1

  // Per source: when it started, its budget, when it settled (-1 while
  // pending) and whether its external work has been delivered.
  type Budgeted[r] = { now: int, sourceBudget: int, started: List[int], budgets: List[int], settledAt: List[int], drained: List[bool] | r }
  // The budgeted local lifecycle: the local projection of the traversal with
  // the source records beside its source list.
  type BudgetedLocal[r] = Serving::LocalServed[{ sourceBudget: int, started: List[int], budgets: List[int], settledAt: List[int], drained: List[bool] | r }]

  // The budget of a source started at admission: the configured budget when
  // the key failed to construct (C27), none for any other bypass (C01).
  pure def admissionBudget(state: Budgeted[r], call: Call): int = if (call.keyFailed) state.sourceBudget else UNBOUNDED
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
    if (admitted.sources.length() > state.sources.length()) stamp(admitted, admissionBudget(state, call)) else admitted
  }
  // A source started at release is bounded: its caller was enabled when
  // admitted, whether or not its scope has closed since.
  pure def releaseLocal(state: BudgetedLocal[r], layout: Serving::Layout, policyCall: int, resolved: Resolution, ttls: Ttls): BudgetedLocal[r] = {
    val released = Serving::releaseLocal(state, layout, policyCall, resolved, ttls)
    if (released.sources.length() > state.sources.length()) stamp(released, state.sourceBudget) else released
  }
  // A source's outcome arriving after its deadline is a deadline error; work
  // whose deadline already completed its callers drains without effect.
  pure def settleLocal(state: BudgetedLocal[r], layout: Serving::Layout, index: int, value: int, ttls: Ttls): BudgetedLocal[r] = {
    val drained = drain(state, index)
    if (state.sources.nth(index).result != CALL_PENDING) drained
    else markSettled(Serving::settleLocal(drained, layout, index, if (reached(state, index)) DEADLINE_ERROR else value, ttls), index)
  }
  // Time passes and every pending source whose deadline is reached completes
  // its callers with a deadline error, which publishes to no layer; its
  // external work is not drained.
  pure def advanceLocal(state: BudgetedLocal[r], layout: Serving::Layout, ms: int): BudgetedLocal[r] = {
    val advanced = Clock::advance(state, ms)
    advanced.sources.indices().fold(advanced, (current, index) =>
      if (current.sources.nth(index).result == CALL_PENDING and reached(current, index))
        markSettled(Serving::finish(current, layout, index, DEADLINE_ERROR), index)
      else current)
  }
}

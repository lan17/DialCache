// A kernel library module whose folds declare their operator parameter
// through a type alias rather than inline: Quint records such a position as
// the alias name, and the lint resolves the alias (and a chain of aliases) to
// the operator type before judging whether the definition takes an operator.
module library_alias {
  type Counter[r] = { count: int | r }
  type Step[r] = (Counter[r], int) => Counter[r]
  type Chained[r] = Step[r]

  pure def bump(state: Counter[r], delta: int): Counter[r] = { count: state.count + delta, ...state }
  pure def repeatVia(state: Counter[r], times: int, each: Step[r]): Counter[r] =
    1.to(times).fold(state, (current, step) => each(current, step))
  pure def repeatChained(state: Counter[r], times: int, each: Chained[r]): Counter[r] =
    1.to(times).fold(state, (current, step) => each(current, step))
}

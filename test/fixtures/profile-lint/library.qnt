// A kernel library module for the composition fixtures: transitions over a
// row-polymorphic record, so a profile composes them over its own flat state.
module library {
  type Counter[r] = { count: int | r }

  pure def bump(state: Counter[r], delta: int): Counter[r] = { count: state.count + delta, ...state }
  pure def reset(state: Counter[r]): Counter[r] = { count: 0, ...state }
}

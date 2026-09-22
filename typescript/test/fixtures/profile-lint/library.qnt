// A kernel library module for the composition fixtures: transitions over a
// row-polymorphic record, so a profile composes them over its own flat state.
module library {
  type Counter[r] = { count: int | r }

  pure def bump(state: Counter[r], delta: int): Counter[r] = { count: state.count + delta, ...state }
  pure def reset(state: Counter[r]): Counter[r] = { count: 0, ...state }
  // A fold whose step is an operator argument: only the library's own variants
  // may instantiate it; a profile that does is reported whatever it passes
  // (composition-lambda-argument, composition-named-operator-argument).
  pure def repeat(state: Counter[r], times: int, each: (Counter[r], int) => Counter[r]): Counter[r] =
    1.to(times).fold(state, (current, step) => each(current, step))
}

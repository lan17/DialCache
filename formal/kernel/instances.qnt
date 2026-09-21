module instances {
  // Which instances the environment has constructed. The local-clock drivers
  // construct default instances at fractional process times; the model records
  // only that an instance exists, since the layers judge time on the shared
  // whole-millisecond grid whatever the construction phase (C09). Read by
  // guards and input domains alone, never by a rule; kept as a transition
  // because the composition lint has no environment allowance yet, as
  // `request_memo::openScope` is.
  type Constructed[r] = { constructed: List[bool] | r }

  pure def construct(state: Constructed[r], instance: int): Constructed[r] =
    { constructed: state.constructed.replaceAt(instance, true), ...state }
}

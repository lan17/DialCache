module instances {
  // Which instances the environment has constructed.
  //
  // Rules
  // - The local-clock drivers construct default instances at fractional process times; the model
  //   records only that an instance exists (C09).
  // - The layers judge time on the shared whole-millisecond grid whatever the construction phase
  //   (C09); construction is read by guards and input domains alone, never by a rule.
  // - `construct` stays a transition because the composition lint has no environment allowance
  //   yet, as `request_memo::openScope` is.
  // Shapes
  // - Constructed[r]: whether each instance exists; the local-clock profile composes it.
  // Consumers: local-clock.
  type Constructed[r] = { constructed: List[bool] | r }

  pure def construct(state: Constructed[r], instance: int): Constructed[r] =
    { constructed: state.constructed.replaceAt(instance, true), ...state }
}

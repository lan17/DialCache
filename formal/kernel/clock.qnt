module clock {
  // Elapsed time. Profiles advance it by whole milliseconds; frames, watermarks
  // and deadlines read it. Wall-clock divergence is a separate concern that
  // profiles with rollback add alongside this monotonic clock.
  type Timed[r] = { now: int | r }

  pure def advance(state: Timed[r], ms: int): Timed[r] = { now: state.now + ms, ...state }
}

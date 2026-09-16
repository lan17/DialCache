module clock {
  // Elapsed time. Profiles advance it by whole milliseconds; local entries,
  // retention and deadlines read it. The wall clock is the monotonic clock
  // plus a skew, so one transition moves both and only the skew can be
  // shifted (a rollback, C22): a profile without wall-clock divergence holds
  // the skew at 0.
  type Timed[r] = { now: int | r }
  type Skewed[r] = { now: int, skew: int | r }

  pure def advance(state: Timed[r], ms: int): Timed[r] = { now: state.now + ms, ...state }
  pure def wallOf(state: Skewed[r]): int = state.now + state.skew
  pure def shiftWall(state: Skewed[r], ms: int): Skewed[r] = { skew: state.skew + ms, ...state }
}

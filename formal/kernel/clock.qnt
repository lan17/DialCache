module clock {
  import cache_rules.* from "../cache-rules"
  // Elapsed time. Profiles advance it by whole milliseconds; local entries,
  // retention and deadlines read it. The wall clock is the monotonic clock
  // plus a skew, so one transition moves both and only the skew can be
  // shifted (a rollback, C22): a profile without wall-clock divergence holds
  // the skew at 0.
  type Timed[r] = { now: int | r }
  type Skewed[r] = { now: int, skew: int | r }
  // The environment's fractional time beside the clock the layers read: the
  // drivers advance it in ticks (the local-clock drivers' microseconds), and
  // the monotonic clock is that time on the whole-millisecond grid
  // (`cache_rules.wholeMs`, the projection `localEntryLiveOnGrid` judges
  // with, C09), so a fractional advance moves `now` only across a millisecond
  // boundary and local insertion and expiry fall on the grid whatever the
  // instance's construction phase. Combining advanceTicks with delivered
  // deadlines requires a kernel transition not yet defined here.
  type Ticked[r] = { now: int, ticks: int | r }

  pure def advance(state: Timed[r], ms: int): Timed[r] = { now: state.now + ms, ...state }
  pure def advanceTicks(state: Ticked[r], ticks: int, ticksPerMs: int): Ticked[r] =
    { ticks: state.ticks + ticks, now: wholeMs(state.ticks + ticks, ticksPerMs), ...state }
  pure def wallOf(state: Skewed[r]): int = state.now + state.skew
  pure def shiftWall(state: Skewed[r], ms: int): Skewed[r] = { skew: state.skew + ms, ...state }
}

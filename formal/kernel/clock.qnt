module clock {
  // Elapsed time. Profiles advance it by whole milliseconds; local entries,
  // retention and deadlines read it. A profile whose remote frames carry
  // wall-clock stamps also keeps a wall clock: both move together on
  // `elapse`, and only the wall clock may be shifted (a rollback, C22).
  type Timed[r] = { now: int | r }
  type Walled[r] = { now: int, wall: int | r }

  pure def advance(state: Timed[r], ms: int): Timed[r] = { now: state.now + ms, ...state }
  pure def elapse(state: Walled[r], ms: int): Walled[r] = { now: state.now + ms, wall: state.wall + ms, ...state }
  pure def shiftWall(state: Walled[r], ms: int): Walled[r] = { wall: state.wall + ms, ...state }
}

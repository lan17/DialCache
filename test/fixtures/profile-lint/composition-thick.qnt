// A composed profile that still computes over cache state in three places: a
// branch on state in a wrapper, a helper that derives a transition argument
// from a state parameter, and an inline clock rule. The input assignment may
// branch on state (it is the driver contract, not cache state).
module composition_thick {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  pure def room(state: { count: int | r }): int = 10 - state.count

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = all {
    s' = if (s.count < 5) L::bump(s, 1) else s,
    input' = { name: "bump", choice: -1 }
  }

  action fill = all {
    s' = L::bump(s, room(s)),
    input' = { name: if (s.count > 3) "fill-late" else "fill", choice: -1 }
  }

  action tick = all {
    s' = { count: s.count + 1, ...s },
    input' = { name: "tick", choice: -1 }
  }

  action step = any { bumpWrapper, fill, tick }

  val countWithinBound = s.count <= 12
}

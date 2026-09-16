// A composed profile whose wrappers hand parametrized actions arguments drawn
// from cache state. A computation in the argument is the wrapper's rule logic
// and is reported where it is written; a plain state read passed through
// taints the callee's parameter, so the callee's computation over it is
// reported in the callee.
module composition_action_argument {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpBy(delta: int): bool = all {
    s' = L::bump(s, delta),
    input' = { name: "bump", choice: delta }
  }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    bumpBy(if (s.count > 5) 0 else choice)
  }

  action scaleBy(delta: int): bool = all {
    s' = L::bump(s, delta * 2),
    input' = { name: "scale", choice: delta }
  }

  action scaleWrapper = scaleBy(s.count)

  action step = any { bumpWrapper, scaleWrapper }

  val countWithinBound = s.count <= 30
}

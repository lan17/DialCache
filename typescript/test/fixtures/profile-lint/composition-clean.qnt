// A composed profile: it owns its state, its input choices and its guards, and
// every value it assigns to `s` is a library transition, record wiring or input
// decoding. The lint reports no composition violation.
module composition_clean {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  // Input decoding reads no state; branching on the choice is wiring.
  pure def delta(choice: int): int = if (choice == 1) 1 else 2

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      // A guard restricts the environment; it is not an assigned value.
      s.count < 10,
      s' = L::bump(s, delta(choice)),
      input' = { name: "bump", choice: choice }
    }
  }

  action resetWrapper = all { s' = L::reset(s), input' = { name: "reset", choice: -1 } }

  // Profile-owned bookkeeping: a record update with a literal is wiring.
  action relabel = all { s' = { label: "later", ...s }, input' = { name: "relabel", choice: -1 } }

  action step = any { bumpWrapper, resetWrapper, relabel }

  val countWithinBound = s.count <= 11
}

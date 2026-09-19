// A composed profile that hands a kernel definition a profile operator through
// an alias: `alias` is a parameterless definition whose body is the name of the
// parametrized one, so neither the argument nor what it resolves to is a
// lambda. The argument sits in a position the library declares with an
// operator type and does not name a kernel definition, so it is reported at
// the call like the operator itself would be.
module composition_aliased_operator_argument {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  pure def hook(current, step) = L::bump(current, if (current.count % 2 == 0) step * 2 else step)
  pure def alias = hook

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = L::repeat(s, choice, alias),
      input' = { name: "bump", choice: choice }
    }
  }

  action step = bumpWrapper

  val countWithinBound = s.count <= 30
}

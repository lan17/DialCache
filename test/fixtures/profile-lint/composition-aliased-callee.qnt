// A composed profile that applies a kernel definition through an alias of its
// own (`repeatAlias` is a parameterless definition whose body is the kernel
// name) and hands the fold rule logic in the operator position. The callee is
// resolved through the alias like an argument is, so the application is judged
// as the kernel's: the transition is recorded under the kernel's name and the
// lambda is reported at the call.
module composition_aliased_callee {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  pure def repeatAlias = L::repeat

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = repeatAlias(s, choice, (current, step) => L::bump(current, if (current.count % 2 == 0) step * 2 else step)),
      input' = { name: "bump", choice: choice }
    }
  }

  action step = bumpWrapper

  val countWithinBound = s.count <= 30
}

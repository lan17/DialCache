// A composed profile whose helper rebinds its operator parameter under a
// let-bound name before forwarding it to the kernel definition: at the kernel
// call the argument is the let-bound name, which resolves to a definition
// whose body is the parameter's name, not a lambda. The position is declared
// with an operator type and the chain ends at a lambda parameter, not a kernel
// definition, so the call is reported in the helper with the chain from the
// wrapper.
module composition_let_bound_operator_argument {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  pure def repeatWith(state, times, each) = {
    val f = each
    L::repeat(state, times, f)
  }

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = repeatWith(s, choice, (current, step) => L::bump(current, step)),
      input' = { name: "bump", choice: choice }
    }
  }

  action step = bumpWrapper

  val countWithinBound = s.count <= 30
}

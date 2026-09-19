// A composed profile that applies kernel transitions through aliases of its
// own, with nothing but wiring in the arguments: `bumpAlias` is a parameterless
// definition whose body is the kernel name, and `repeatAlias` is applied with
// the kernel's own step. The lint follows both aliases to the kernel, records
// the transitions under the kernel's names and reports nothing.
module composition_aliased_transition {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  pure def bumpAlias = L::bump
  pure def repeatAlias = L::repeat

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = bumpAlias(s, choice),
      input' = { name: "bump", choice: choice }
    }
  }
  action repeatWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = repeatAlias(s, choice, L::bump),
      input' = { name: "repeat", choice: choice }
    }
  }

  action step = any { bumpWrapper, repeatWrapper }

  val countWithinBound = s.count <= 30
}

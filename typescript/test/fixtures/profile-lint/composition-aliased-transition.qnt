// A composed profile that applies kernel definitions through aliases of its
// own: `bumpAlias` and `repeatAlias` are parameterless definitions whose body
// is the kernel name. The lint follows the callee to the kernel, so each
// application is judged and recorded as the kernel's: `bumpAlias(s, choice)`
// records `library::bump` and reports nothing, and `repeatAlias(...)`
// instantiates the higher-order fold and is reported whatever it passes.
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

// A composed profile that instantiates kernel folds whose operator parameter
// is declared through a type alias (`Step[r]`) and through a chain of aliases
// (`Chained[r] = Step[r]`). The definition takes an operator whatever spelling
// the library chose, so each instantiation is reported, the one passing the
// kernel's own step included.
module composition_alias_typed_operator_position {
  import library_alias as L from "./library-alias"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = L::repeatVia(s, choice, (current, step) => L::bump(current, step * 3)),
      input' = { name: "bump", choice: choice }
    }
  }
  action chainedWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = L::repeatChained(s, choice, (current, step) => L::bump(current, step * 3)),
      input' = { name: "chained", choice: choice }
    }
  }
  action kernelStepWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = L::repeatVia(s, choice, L::bump),
      input' = { name: "kernelStep", choice: choice }
    }
  }

  action step = any { bumpWrapper, chainedWrapper, kernelStepWrapper }

  val countWithinBound = s.count <= 60
}

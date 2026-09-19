// A composed profile that hands a kernel definition an operator written in
// the profile by name rather than as a lambda literal. The library's fold
// would run the profile's step over cache state where the lint cannot follow
// it, so the named operator is reported at the call like a lambda is,
// whatever its body does.
module composition_named_operator_argument {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  // Rule logic over the state the fold hands it: invisible to a walk that
  // follows the name with untainted parameters.
  pure def hook(current, step) = L::bump(current, if (current.count % 2 == 0) step * 2 else step)

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = L::repeat(s, choice, hook),
      input' = { name: "bump", choice: choice }
    }
  }

  action step = bumpWrapper

  val countWithinBound = s.count <= 30
}

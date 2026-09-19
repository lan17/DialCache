// A composed profile that instantiates a kernel fold with an operator written
// in the profile. The library's fold would run the profile's step where the
// lint cannot follow it, so the call to the higher-order definition is
// reported, whatever the lambda's body does.
module composition_lambda_argument {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = L::repeat(s, choice, (current, step) => L::bump(current, step)),
      input' = { name: "bump", choice: choice }
    }
  }

  action step = bumpWrapper

  val countWithinBound = s.count <= 30
}

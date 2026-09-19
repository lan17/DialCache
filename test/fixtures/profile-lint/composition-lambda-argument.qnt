// A composed profile that hands a kernel definition an operator written in
// the profile. The library's fold would run the profile's step where the lint
// cannot follow it, so the lambda argument is reported at the call, whatever
// its body does.
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

// A composed profile whose wrapper keeps its nondet inline and draws the
// domain from state. The chosen input is not cache state, so the lint reports
// no composition violation.
module composition_nondet_inline {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(s.count + 2).oneOf()
    all {
      s.count < 10,
      s' = L::bump(s, choice),
      input' = { name: "bump", choice: choice }
    }
  }

  action step = any { bumpWrapper }

  val countWithinBound = s.count <= 21
}

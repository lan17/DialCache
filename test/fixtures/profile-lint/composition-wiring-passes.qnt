// The wiring the composition rule accepts by design: a record literal that
// sets a field over a library result, a chosen input passed straight to the
// library, and a kernel definition handed to a kernel operator position, by
// name or through an alias (the library's own step, not rule logic written in
// the profile). No comparison, branch or arithmetic touches cache state.
module composition_wiring_passes {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  pure def each = L::bump

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = { label: "bumped", ...L::bump(s, choice) },
      input' = { name: "bump", choice: choice }
    }
  }
  action repeatWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = L::repeat(L::repeat(s, choice, L::bump), choice, each),
      input' = { name: "repeat", choice: choice }
    }
  }

  action step = any { bumpWrapper, repeatWrapper }

  val countWithinBound = s.count <= 30
}

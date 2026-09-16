// The wiring the composition rule accepts by design: a record literal that
// sets a field over a library result, and a chosen input passed straight to
// the library. No comparison, branch or arithmetic touches cache state.
module composition_wiring_passes {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  action init = all { s' = { count: 0, label: "start" }, input' = { name: "init", choice: -1 } }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      s' = { label: "bumped", ...L::bump(s, choice) },
      input' = { name: "bump", choice: choice }
    }
  }

  action step = any { bumpWrapper }

  val countWithinBound = s.count <= 30
}

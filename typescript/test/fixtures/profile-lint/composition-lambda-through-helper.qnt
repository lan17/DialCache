// A composed profile that instantiates a kernel fold inside a helper of its
// own, forwarding the wrapper's lambda as a parameter. The higher-order call
// is the helper's, so it is reported there with the chain from the wrapper.
module composition_lambda_through_helper {
  import library as L from "./library"

  var s: { count: int, label: str }
  var input: { name: str, choice: int }

  pure def repeatWith(state, times, each) = L::repeat(state, times, each)

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

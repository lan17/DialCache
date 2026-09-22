// Private transition logic hidden two calls deep and inside a nested
// definition: the wrapper calls `settle`, which binds a local `commit` action
// that assigns every kernel variable. The lint folds let-bound definitions into
// their owner, so it reports each assignment against `settle` with the chain
// bumpWrapper -> settle.
module profile_nested_let {
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  action init = K::init

  action settle(delta: int): bool = {
    action commit = all {
      K::count' = K::count + delta,
      K::witnessed' = K::witnessed,
      K::input' = { name: "bump", choice: delta },
      K::o' = project(K::count + delta),
    }
    all { K::count + delta <= 3, commit }
  }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    settle(choice)
  }

  action step = any { bumpWrapper }
}

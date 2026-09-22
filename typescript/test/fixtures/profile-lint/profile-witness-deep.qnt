// Witness feedback two pure calls deep and through a higher-order operator: the
// wrapper's guard `screen` calls `apply`, which calls back the `blocked` helper
// passed as an operator argument, and `blocked` reads the witness label set.
// The lint follows the resolved reference at the call site and reports the
// guard with the chain step -> bumpWrapper -> screen -> blocked.
module profile_witness_deep {
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  def apply(f: (int) => bool, delta: int): bool = f(delta)
  def blocked(delta: int): bool = K::witnessed.contains("full")
  def screen(delta: int): bool = not(apply(blocked, delta))

  action init = K::init

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all { screen(choice), K::bump(choice) }
  }

  action step = any { bumpWrapper }
}

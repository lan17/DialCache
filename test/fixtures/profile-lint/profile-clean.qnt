// A clean kernel instance: wrappers own the nondet choice and call one kernel
// action each; the projection is an operator constant. The lint reports no
// thin-profile violation and no witness feedback for this module.
module profile_clean {
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  action init = K::init

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    K::bump(choice)
  }

  action resetWrapper = K::reset

  action step = any { bumpWrapper, resetWrapper }

  // Invariants and runs may read witness state; they are not lint roots.
  val countWithinCapacity = K::count <= 3
  val fullIsRecordedAtCapacity = K::witnessed.contains("full") implies K::count <= 3
}

// Witness feedback through a cache guard: the wrapper enables the kernel step
// only while no label has been recorded, reading the label set through the
// helper `unlabeled`. The lint reports it with root kind "guard" and the chain
// step -> bumpWrapper -> unlabeled.
module profile_witness_guard {
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  val unlabeled = K::witnessed.size() == 0

  action init = K::init

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all {
      unlabeled,
      K::bump(choice),
    }
  }

  action step = any { bumpWrapper }
}

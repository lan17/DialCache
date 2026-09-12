// Witness feedback through the observation projection. The profile itself is
// as thin as profile_clean; the feedback sits in the instantiated kernel
// variant, whose observation field `o` is computed from the witness label set
// (see kernel-leaky.qnt for why a projection constant cannot be the route).
// The lint reports it with root kind "projection" and chains through
// step -> bumpWrapper -> kernel_leaky::bump and step -> resetWrapper ->
// kernel_leaky::reset, while the thin-profile rule stays satisfied.
module profile_witness_projection {
  pure def project(n: int): int = n * 2
  import kernel_leaky(CAPACITY = 3, PROJECT = project) as K from "./kernel-leaky"

  action init = K::init

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    K::bump(choice)
  }

  action resetWrapper = K::reset

  action step = any { bumpWrapper, resetWrapper }
}

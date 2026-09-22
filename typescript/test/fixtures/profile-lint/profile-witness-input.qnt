// Witness feedback into the input handed to a kernel action: the wrapper adds
// the label count to its choice before calling the kernel. No guard, domain,
// assignment or projection is involved, so the finding carries the root kind
// "step" itself, with the chain step -> bumpWrapper.
module profile_witness_input {
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  action init = K::init

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    K::bump(choice + K::witnessed.size())
  }

  action step = any { bumpWrapper }
}

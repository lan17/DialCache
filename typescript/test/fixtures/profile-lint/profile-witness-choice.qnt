// Witness feedback through an input-choice domain: once the kernel records the
// "full" label, the wrapper's choice domain empties. The feedback hides behind
// the helper `allowed` inside a lambda argument, so a textual check on the
// nondet line would not see it. The lint reports it with root kind
// "choice domain" and the chain step -> bumpWrapper -> allowed.
module profile_witness_choice {
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  def allowed(delta: int): bool = not(K::witnessed.contains("full"))

  action init = K::init

  action bumpWrapper = {
    nondet choice = 1.to(2).filter(delta => allowed(delta)).oneOf()
    K::bump(choice)
  }

  action step = any { bumpWrapper }
}

// Witness feedback through a choice domain computed by a helper: `domain` is a
// value that shrinks once the kernel records the "full" label, and the wrapper
// draws its choice from it. The lint reports it with root kind "choice domain"
// and the chain step -> bumpWrapper -> domain.
module profile_witness_domain {
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  val domain = if (K::witnessed.contains("full")) Set(1) else Set(1, 2)

  action init = K::init

  action bumpWrapper = {
    nondet choice = domain.oneOf()
    K::bump(choice)
  }

  action step = any { bumpWrapper }
}

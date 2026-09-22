// Names shared with the kernel: the profile defines its own `room` (a guard
// that reads witness state) and its own `bump` (private transition logic),
// both spelled like the kernel's definitions. `viaKernel` calls the kernel's
// pair through the instance and must stay clean; `viaLocal` calls the local
// pair and must be reported. A lint that matched names rather than resolved
// references would confuse the two.
module profile_shadow {
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  def room(n: int): bool = not(K::witnessed.contains("full"))

  action bump(delta: int): bool = all {
    K::count' = K::count + delta,
    K::witnessed' = K::witnessed,
    K::input' = { name: "bump", choice: delta },
    K::o' = project(K::count + delta),
  }

  action init = K::init

  action viaKernel = {
    nondet choice = 1.to(2).oneOf()
    all { K::room(K::count + choice), K::bump(choice) }
  }

  action viaLocal = {
    nondet choice = 1.to(2).oneOf()
    all { room(choice), bump(choice) }
  }

  action step = any { viaKernel, viaLocal }
}

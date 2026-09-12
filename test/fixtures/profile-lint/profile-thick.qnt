// A profile that carries private transition logic: the wrapper calls a local
// helper `decide` that restates the kernel's room rule and assigns state, both
// kernel-visible (`K::count`) and profile-local (`decided`). The lint reports
// the chain bumpWrapper -> decide -> assignment for each assigned variable.
module profile_thick {
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  var decided: int

  action decide(delta: int): bool = all {
    K::count + delta <= 3,
    K::count' = K::count + delta,
    K::witnessed' = K::witnessed,
    K::input' = { name: "bump", choice: delta },
    K::o' = project(K::count + delta),
    decided' = delta,
  }

  action init = all { K::init, decided' = 0 }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    decide(choice)
  }

  action step = any { bumpWrapper }
}

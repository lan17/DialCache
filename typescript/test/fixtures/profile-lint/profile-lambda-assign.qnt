// Private transition logic inside a lambda passed as an operator argument: the
// wrapper hands `runWith` an anonymous action that assigns every kernel
// variable. The assignments belong to the wrapper's own body, so the lint
// reports them against bumpWrapper with the one-element chain [bumpWrapper].
module profile_lambda_assign {
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  action init = K::init

  action runWith(delta: int, f: (int) => bool): bool = f(delta)

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    runWith(choice, d => all {
      K::count + d <= 3,
      K::count' = K::count + d,
      K::witnessed' = K::witnessed,
      K::input' = { name: "bump", choice: d },
      K::o' = project(K::count + d),
    })
  }

  action step = any { bumpWrapper }
}

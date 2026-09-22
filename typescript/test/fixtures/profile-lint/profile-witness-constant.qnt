// Witness feedback through an operator constant: the projection bound at
// instantiation calls `label`, which reads the profile's own witness variable.
module profile_witness_constant {
  var seen: Set[str]
  def label(n: int): int = if (seen.contains("full")) 1 else 0
  def project(n: int): int = n * 2 + label(n)
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  action init = all { K::init, seen' = Set() }

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    all { K::bump(choice), seen' = if (K::count + choice == 3) seen.union(Set("full")) else seen }
  }

  action step = any { bumpWrapper }
}

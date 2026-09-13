// Witness feedback through a sum-typed guard: the wrapper matches on `mode`,
// which reads the witness label set, to choose between two kernel actions. The
// scrutinee of a match whose arms are actions is a guard, so the lint reports
// it with root kind "guard" and the chain step -> bumpWrapper -> mode.
module profile_witness_match {
  type Mode = Open | Closed
  pure def project(n: int): int = n * 2
  import kernel(CAPACITY = 3, PROJECT = project) as K from "./kernel"

  def mode = if (K::witnessed.contains("full")) Closed else Open

  action init = K::init

  action bumpWrapper = {
    nondet choice = 1.to(2).oneOf()
    match mode {
      | Open => K::bump(choice)
      | Closed => K::reset
    }
  }

  action step = any { bumpWrapper }
}

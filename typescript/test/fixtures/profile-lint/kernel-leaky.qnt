// A kernel variant with witness feedback into the observation. Quint 0.32
// rejects an operator constant that reads any variable (QNT201: instance
// overrides must be pure), so feedback into the projection can only enter
// through the definition that assigns the observation field. This kernel keeps
// the observation as field `o` of the state record `s` and lets the witness
// label set leak into it, once through a record literal (`init`, `bump`) and
// once through a record update (`reset`), which are the two shapes today's
// profiles use for `o`.
module kernel_leaky {
  const CAPACITY: int
  const PROJECT: (int) => int

  var s: { count: int, o: int }
  var witnessed: Set[str]
  var input: { name: str, choice: int }

  pure def room(n: int): bool = n <= CAPACITY

  action init = all {
    s' = { count: 0, o: PROJECT(0) },
    witnessed' = Set(),
    input' = { name: "init", choice: 0 },
  }

  action bump(delta: int): bool = all {
    room(s.count + delta),
    s' = { count: s.count + delta, o: PROJECT(s.count + delta) + witnessed.size() },
    witnessed' = if (s.count + delta == CAPACITY) witnessed.union(Set("full")) else witnessed,
    input' = { name: "bump", choice: delta },
  }

  action reset = all {
    s' = { ...s, count: 0, o: if (witnessed.contains("full")) PROJECT(1) else PROJECT(0) },
    witnessed' = witnessed.union(Set("reset")),
    input' = { name: "reset", choice: 0 },
  }
}

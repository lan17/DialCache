// Synthetic kernel for the profile lint fixtures (test/formal-profile-lint.test.ts).
// It is not a DialCache model: it has just enough structure to exercise the
// thin-profile rule and witness isolation from issue #165. The kernel owns all
// state, takes every choice as an action parameter, contains no nondet, and
// records the witness label set `witnessed` in its own transitions.
module kernel {
  const CAPACITY: int
  const PROJECT: (int) => int

  var count: int
  var witnessed: Set[str]
  var input: { name: str, choice: int }
  var o: int

  pure def room(n: int): bool = n <= CAPACITY

  action init = all {
    count' = 0,
    witnessed' = Set(),
    input' = { name: "init", choice: 0 },
    o' = PROJECT(0),
  }

  action bump(delta: int): bool = all {
    room(count + delta),
    count' = count + delta,
    // The witness monitor may read its own prior state to accumulate.
    witnessed' = if (count + delta == CAPACITY) witnessed.union(Set("full")) else witnessed,
    input' = { name: "bump", choice: delta },
    o' = PROJECT(count + delta),
  }

  action reset = all {
    count' = 0,
    witnessed' = witnessed.union(Set("reset")),
    input' = { name: "reset", choice: 0 },
    o' = PROJECT(0),
  }
}

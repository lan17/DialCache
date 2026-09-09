module conformance_observations {
  // Public outcomes/effects shared by the feature profiles. Cache contents,
  // phases, policy snapshots and fences stay in each model's private state.
  // Calls: 0 pending, 1/2 fixture value, 3 source error, 4 deadline error.
  type Observation = {
    calls: List[int], loaders: int, reads: int, writes: int, invalidations: int,
    maintenance: List[str], loads: int, dumps: int, policyCalls: int,
    classifications: int, comparisons: int, sourceScopes: List[bool],
    writeTtls: List[int], shadow: List[str], recovery: List[str]
  }
  pure val empty: Observation = {
    calls: List(), loaders: 0, reads: 0, writes: 0, invalidations: 0,
    maintenance: List(), loads: 0, dumps: 0, policyCalls: 0,
    classifications: 0, comparisons: 0, sourceScopes: List(),
    writeTtls: List(), shadow: List(), recovery: List()
  }
  pure def finish(o: Observation, result: int): Observation = {
    calls: o.calls.foldl(List(), (out, c) => out.append(if (c == 0) result else c)), ...o
  }
}

module dialcache_scope_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Request-only caching: one key and two independent request lifetimes.
  // Handles 2/3 nest enabled/disabled under 0; 4 reenables inside 3.
  // Completed handles remain usable for detached work. Only an outer close
  // ends its memo lifetime. No language-specific executor ordering is modeled.
  type Source = { slot: int, shared: bool, result: int }
  type State = {
    o: Observation, opened: List[bool], completed: List[bool],
    memo: List[int], registered: List[int], sources: List[Source], owners: List[int],
    policyCall: int, scope: int, overlay: int
  }
  var s: State
  action init = s' = {
    o: empty, opened: List(true, false, false, false, false),
    completed: List(false, false, false, false, false), memo: List(0, 0),
    registered: List(-1, -1), sources: List(), owners: List(),
    policyCall: -1, scope: 0, overlay: 0
  }
  pure def holder(scope: int): int = if (scope == 1) 1 else 0
  pure def activeScope(state: State, scope: int): bool =
    scope < 5 and scope != 3 and not(state.completed.nth(holder(scope)))
  pure def source(state: State, call: int, slot: int, shared: bool, active: bool): State = {
    owners: state.owners.replaceAt(call, state.sources.length()),
    sources: state.sources.append({ slot: slot, shared: shared, result: 0 }),
    registered: if (shared) state.registered.replaceAt(slot, state.sources.length()) else state.registered,
    o: { loaders: state.o.loaders + 1, sourceScopes: state.o.sourceScopes.append(active), ...state.o }, ...state
  }
  pure def begin(state: State, scope: int): State = {
    val active = activeScope(state, scope)
    val updated = { scope: scope, owners: state.owners.append(-1),
      policyCall: if (active) state.o.calls.length() else -1,
      o: { calls: state.o.calls.append(0), policyCalls: state.o.policyCalls + (if (active) 1 else 0), ...state.o }, ...state }
    if (active) updated else source(updated, state.o.calls.length(), -1, false, false)
  }
  action beginCall = {
    // Context 5 is outside every request.
    nondet choice = 0.to(5).filter(id => id == 5 or s.opened.nth(id)).oneOf()
    all { s.policyCall == -1, s.o.calls.length() < 16, s' = begin(s, choice) }
  }
  action releasePolicy = all {
    s.policyCall >= 0,
    val active = activeScope(s, s.scope)
    val slot = if (active and s.overlay != 1) holder(s.scope) else -1
    val shared = slot >= 0 and s.overlay != 2
    val owner = if (shared) s.registered.nth(slot) else -1
    val value = if (slot >= 0) s.memo.nth(slot) else 0
    val updated = { policyCall: -1, ...s }
    // Admission precedes the memo read, including when an independent call
    // has populated the memo while the registered source is still pending.
    s' = if (owner >= 0) { owners: s.owners.replaceAt(s.policyCall, owner), ...updated }
      else if (value > 0) { o: { calls: s.o.calls.replaceAt(s.policyCall, value), ...s.o }, ...updated }
      else source(updated, s.policyCall, slot, shared, active)
  }
  pure def settle(state: State, loader: int, result: int): State = {
    val entry = state.sources.nth(loader)
    val live = entry.slot >= 0 and not(state.completed.nth(entry.slot))
    {
      sources: state.sources.replaceAt(loader, { result: result, ...entry }),
      memo: if (live and result != 3) state.memo.replaceAt(entry.slot, result) else state.memo,
      registered: if (live and state.registered.nth(entry.slot) == loader) state.registered.replaceAt(entry.slot, -1) else state.registered,
      o: { calls: state.o.calls.foldl(List(), (out, value) =>
        out.append(if (state.owners.nth(out.length()) == loader) result else value)), ...state.o }, ...state
    }
  }
  val pending = s.sources.indices().filter(i => s.sources.nth(i).result == 0)
  action resolveLoader = {
    nondet choice = 1.to(32).filter(code => pending.contains((code - 1) / 2)).oneOf()
    s' = settle(s, (choice - 1) / 2, (choice - 1) % 2 + 1)
  }
  action rejectLoader = { nondet choice = pending.oneOf()
    s' = settle(s, choice, 3) }
  pure def open(state: State, scope: int): State = { opened: state.opened.replaceAt(scope, true), ...state }
  action openScope = {
    nondet choice = 1.to(4).filter(id => not(s.opened.nth(id)) and
      (id == 1 or (not(s.completed.nth(0)) and (id != 4 or s.opened.nth(3))))).oneOf()
    s' = open(s, choice)
  }
  pure def close(state: State, scope: int): State = {
    completed: state.completed.replaceAt(scope, true),
    memo: state.memo.indices().fold(state.memo, (out, slot) =>
      if (scope < 2 and slot == scope) out.replaceAt(slot, 0) else out),
    registered: state.registered.indices().fold(state.registered, (out, slot) =>
      if (scope < 2 and slot == scope) out.replaceAt(slot, -1) else out), ...state
  }
  action closeScope = {
    nondet choice = 0.to(4).filter(id => s.opened.nth(id) and not(s.completed.nth(id))).oneOf()
    all { s.o.calls.length() > 0, s' = close(s, choice) }
  }
  // 0 inherits request caching/sharing; 1 bypasses request caching;
  // 2 retains memoization while disabling flight sharing.
  action policy = { nondet choice = Set(0, 1, 2).oneOf()
    s' = { overlay: choice, ...s } }
  action step = any {
    beginCall, releasePolicy, any { resolveLoader, rejectLoader },
    // Keep closure reachable without letting early closure consume most runs.
    any { openScope, policy, any { openScope, policy, closeScope } }
  }
  val closedScopesHaveNoMemo = s.memo.indices().forall(slot =>
    not(s.completed.nth(slot)) or (s.memo.nth(slot) == 0 and s.registered.nth(slot) == -1))
  val registeredSourcesArePending = s.registered.indices().forall(slot => {
    val loader = s.registered.nth(slot)
    loader < 0 or (s.sources.nth(loader).slot == slot and s.sources.nth(loader).shared and s.sources.nth(loader).result == 0)
  })
  val callsKeepSourceOutcome = s.o.calls.indices().forall(i =>
    if (s.owners.nth(i) >= 0) s.o.calls.nth(i) == s.sources.nth(s.owners.nth(i)).result
    else (s.o.calls.nth(i) == 0) == (i == s.policyCall))
  val sourceCountsMatchEffects = s.sources.length() == s.o.loaders and
    s.o.sourceScopes.length() == s.o.loaders and s.owners.length() == s.o.calls.length()

  run lateSourceCannotPopulateReplacementTest = init
    .then(s' = begin(s, 0)).then(releasePolicy).then(s' = close(s, 0))
    .then(s' = open(s, 1)).then(s' = settle(s, 0, 1))
    .then(s' = begin(s, 1)).then(releasePolicy)
    .expect(s.o.calls == List(1, 0) and s.o.loaders == 2 and s.memo == List(0, 0))

  run policyReplyAfterCloseBypassesRequestTest = init
    .then(s' = begin(s, 0)).then(s' = close(s, 0)).then(releasePolicy)
    .then(s' = settle(s, 0, 1))
    .expect(s.o.sourceScopes == List(false) and s.memo == List(0, 0))

  run nestedCloseAndDisabledBypassKeepOuterMemoTest = init
    .then(s' = open(s, 2)).then(s' = begin(s, 2)).then(releasePolicy)
    .then(s' = settle(s, 0, 1)).then(s' = close(s, 2))
    .then(s' = open(s, 3)).then(s' = begin(s, 3)).then(s' = settle(s, 1, 2))
    .then(s' = open(s, 4)).then(s' = begin(s, 4)).then(releasePolicy)
    .expect(s.o.calls == List(1, 2, 1) and s.o.loaders == 2 and s.o.sourceScopes == List(true, false))

  run rejectedFlightAllowsRetryTest = init
    .then(s' = begin(s, 0)).then(releasePolicy)
    .then(s' = begin(s, 0)).then(releasePolicy).then(s' = settle(s, 0, 3))
    .then(s' = begin(s, 0)).then(releasePolicy)
    .expect(s.o.calls == List(3, 3, 0) and s.o.loaders == 2)
}

module dialcache_scope_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Request-only caching: one key and two independent request lifetimes.
  // Handles 2/3 nest enabled/disabled under 0; 4 reenables inside 3.
  // Completed handles remain usable for detached work. Only an outer close
  // ends its memo lifetime. No language-specific executor ordering is modeled.
  // State: o/d are replay observations; memo, registration, ownership, and
  // source records predict future effects and are never implementation inputs.
  // Environment: one request-only key, two outer lifetimes, one held policy
  // reply, independently settled sources; no source deadline or TTL expiry.
  // Bounds: sixteen callers, five saved contexts plus an outside context.

  // -- Stable context, policy, and sentinel encodings -------------------------

  pure val ROOT_REQUEST = 0
  pure val REPLACEMENT_REQUEST = 1
  pure val NESTED_ENABLED = 2
  pure val NESTED_DISABLED = 3
  pure val REENABLED_REQUEST = 4
  pure val OUTSIDE_REQUEST = 5
  pure val POLICY_INHERIT = 0
  pure val POLICY_NO_REQUEST = 1
  pure val POLICY_NO_COALESCING = 2
  pure val NO_OWNER = -1
  pure val NO_MEMO = 0
  pure val MAX_CALLERS = 16
  pure val SOURCE_VALUE_COUNT = 7
  pure val MAX_RESOLVE_CHOICE = 112

  // -- State and initial environment -----------------------------------------

  type Source = {
    slot: int,
    shared: bool,
    result: int,
    metricLayer: str
  }
  type State = {
    o: Observation,
    d: Diagnostics,
    opened: List[bool],
    completed: List[bool],
    memo: List[int],
    registered: List[int],
    sources: List[Source],
    owners: List[int],
    policyCall: int,
    scope: int,
    overlay: int
  }
  var s: State
  action init = s' = {
    o: empty,
    d: noDiagnostics,
    opened: List(true, false, false, false, false),
    completed: List(false, false, false, false, false),
    memo: List(NO_MEMO, NO_MEMO),
    registered: List(NO_OWNER, NO_OWNER),
    sources: List(),
    owners: List(),
    policyCall: NO_OWNER,
    scope: ROOT_REQUEST,
    overlay: POLICY_INHERIT
  }

  // -- Scope ownership and caller admission ----------------------------------

  pure def holder(scope: int): int = if (scope == REPLACEMENT_REQUEST) REPLACEMENT_REQUEST else ROOT_REQUEST
  pure def activeScope(state: State, scope: int): bool =
    scope < OUTSIDE_REQUEST and scope != NESTED_DISABLED and not(state.completed.nth(holder(scope)))
  pure def source(state: State, call: int, slot: int, shared: bool, active: bool, metricLayer: str): State = {
    owners: state.owners.replaceAt(call, state.sources.length()),
    sources: state.sources.append({
      slot: slot,
      shared: shared,
      result: CALL_PENDING,
      metricLayer: metricLayer
    }),
    registered: if (shared) state.registered.replaceAt(slot, state.sources.length()) else state.registered,
    o: {
      loaders: state.o.loaders + 1,
      sourceScopes: state.o.sourceScopes.append(active),
      ...state.o
    },
    ...state
  }
  pure def begin(state: State, scope: int): State = {
    val active = activeScope(state, scope)
    val withCaller = {
      scope: scope,
      owners: state.owners.append(NO_OWNER),
      policyCall: if (active) state.o.calls.length() else NO_OWNER,
      o: {
        calls: state.o.calls.append(CALL_PENDING),
        policyCalls: state.o.policyCalls + (if (active) 1 else 0),
        ...state.o
      },
      ...state
    }
    if (active) withCaller else source(withCaller, state.o.calls.length(), NO_OWNER, false, false, "")
  }
  action beginCall = {
    // Context 5 is outside every request.
    nondet choice = ROOT_REQUEST.to(OUTSIDE_REQUEST).filter(id => id == OUTSIDE_REQUEST or s.opened.nth(id)).oneOf()
    all {
      s.policyCall == NO_OWNER,
      s.o.calls.length() < MAX_CALLERS,
      s' = begin(s, choice)
    }
  }
  action releasePolicy = all {
    s.policyCall >= 0,
    val scopeStillOpen = activeScope(s, s.scope)
    val memoSlot = if (scopeStillOpen and s.overlay != POLICY_NO_REQUEST) holder(s.scope) else NO_OWNER
    val canShare = memoSlot >= 0 and s.overlay != POLICY_NO_COALESCING
    val registeredOwner = if (canShare) s.registered.nth(memoSlot) else NO_OWNER
    val memoValue = if (memoSlot >= 0) s.memo.nth(memoSlot) else NO_MEMO
    val afterPolicyReply = { policyCall: NO_OWNER, ...s }
    // Admission precedes the memo read, including when an independent call
    // has populated the memo while the registered source is still pending.
    s' = if (registeredOwner >= 0) {
      d: { coalesced: s.d.coalesced.append("request_local"), ...s.d },
      owners: s.owners.replaceAt(s.policyCall, registeredOwner),
      ...afterPolicyReply
    }
    else if (memoValue > 0) {
      o: {
        calls: s.o.calls.replaceAt(s.policyCall, memoValue),
        ...s.o
      },
      ...afterPolicyReply
    }
    else source(afterPolicyReply, s.policyCall, memoSlot, canShare, scopeStillOpen,
      if (not(scopeStillOpen)) "noop" else if (memoSlot >= 0) "request_local" else "local")
  }

  // -- Source settlement and request publication -----------------------------

  pure def settle(state: State, loader: int, result: int): State = {
    val sourceRecord = state.sources.nth(loader)
    val memoScopeStillOpen = sourceRecord.slot >= 0 and not(state.completed.nth(sourceRecord.slot))
    {
      d: {
        fallbackErrors: if (result == SOURCE_ERROR
          and sourceRecord.metricLayer != "") state.d.fallbackErrors.append(sourceRecord.metricLayer)
          else state.d.fallbackErrors,
        ...state.d
      },
      sources: state.sources.replaceAt(loader, { result: result, ...sourceRecord }),
      memo: if (memoScopeStillOpen and result != SOURCE_ERROR) state.memo.replaceAt(sourceRecord.slot, result)
        else state.memo,
      registered: if (memoScopeStillOpen
        and state.registered.nth(sourceRecord.slot) == loader) state.registered.replaceAt(sourceRecord.slot,
        NO_OWNER) else state.registered,
      o: {
        calls: finishOwnedCalls(state.o.calls, state.owners, loader, result),
        ...state.o
      },
      ...state
    }
  }
  val pending = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING)
  action resolveLoader = {
    nondet choice = 1.to(MAX_RESOLVE_CHOICE).filter(code => pending.contains((code - 1) / SOURCE_VALUE_COUNT)).oneOf()
    s' = settle(s, (choice - 1) / SOURCE_VALUE_COUNT, values.nth((choice - 1) % SOURCE_VALUE_COUNT))
  }
  action rejectLoader = {
    nondet choice = pending.oneOf()
    s' = settle(s, choice, SOURCE_ERROR)
  }

  // -- Environment scope and policy changes ----------------------------------

  pure def open(state: State, scope: int): State = {
    opened: state.opened.replaceAt(scope, true),
    ...state
  }
  action openScope = {
    nondet choice = REPLACEMENT_REQUEST.to(REENABLED_REQUEST).filter(id => not(s.opened.nth(id)) and
      (id == REPLACEMENT_REQUEST or (not(s.completed.nth(ROOT_REQUEST)) and (id != REENABLED_REQUEST
        or s.opened.nth(NESTED_DISABLED))))).oneOf()
    s' = open(s, choice)
  }
  pure def close(state: State, scope: int): State = {
    completed: state.completed.replaceAt(scope, true),
    memo: state.memo.indices().fold(state.memo, (out, slot) =>
      if (scope < NESTED_ENABLED and slot == scope) out.replaceAt(slot, NO_MEMO) else out),
    registered: state.registered.indices().fold(state.registered, (out, slot) =>
      if (scope < NESTED_ENABLED and slot == scope) out.replaceAt(slot, NO_OWNER) else out),
    ...state
  }
  action closeScope = {
    nondet choice = ROOT_REQUEST.to(REENABLED_REQUEST).filter(id => s.opened.nth(id)
      and not(s.completed.nth(id))).oneOf()
    all {
      s.o.calls.length() > 0,
      s' = close(s, choice)
    }
  }
  // 0 inherits request caching/sharing; 1 bypasses request caching;
  // 2 retains memoization while disabling flight sharing.
  action policy = {
    nondet choice = Set(POLICY_INHERIT, POLICY_NO_REQUEST, POLICY_NO_COALESCING).oneOf()
    s' = { overlay: choice, ...s }
  }

  // -- Exploration schedule (nesting/order preserve sampling weights) ---------

  action step = any {
    beginCall,
    releasePolicy,
    any {
      resolveLoader,
      rejectLoader
    },
    // Keep closure reachable without letting early closure consume most runs.
    any {
      openScope,
      policy,
      any {
        openScope,
        policy,
        closeScope
      }
    }
  }

  // -- Independently stated safety properties --------------------------------

  val closedScopesHaveNoMemo = s.memo.indices().forall(slot =>
    not(s.completed.nth(slot)) or (s.memo.nth(slot) == NO_MEMO and s.registered.nth(slot) == NO_OWNER))
  val registeredSourcesArePending = s.registered.indices().forall(slot => {
    val loader = s.registered.nth(slot)
    loader < 0 or (s.sources.nth(loader).slot == slot and s.sources.nth(loader).shared
      and s.sources.nth(loader).result == CALL_PENDING)
  })
  val callsKeepSourceOutcome = s.o.calls.indices().forall(i =>
    if (s.owners.nth(i) >= 0) s.o.calls.nth(i) == s.sources.nth(s.owners.nth(i)).result
  else (s.o.calls.nth(i) == CALL_PENDING) == (i == s.policyCall))
  val sourceCountsMatchEffects = s.sources.length() == s.o.loaders and
    s.o.sourceScopes.length() == s.o.loaders and s.owners.length() == s.o.calls.length()

  // -- Deterministic regression schedules ------------------------------------

  run lateSourceCannotPopulateReplacementTest = init
    .then(s' = begin(s, ROOT_REQUEST))
    .then(releasePolicy)
    .then(s' = close(s, ROOT_REQUEST))
    .then(s' = open(s, REPLACEMENT_REQUEST))
    .then(s' = settle(s, 0, VALUE_ONE))
    .then(s' = begin(s, REPLACEMENT_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2 and s.memo == List(NO_MEMO, NO_MEMO))

  run policyReplyAfterCloseBypassesRequestTest = init
    .then(s' = begin(s, ROOT_REQUEST))
    .then(s' = close(s, ROOT_REQUEST))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ONE))
    .expect(s.o.sourceScopes == List(false) and s.memo == List(NO_MEMO, NO_MEMO))

  run nestedCloseAndDisabledBypassKeepOuterMemoTest = init
    .then(s' = open(s, NESTED_ENABLED))
    .then(s' = begin(s, NESTED_ENABLED))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ONE))
    .then(s' = close(s, NESTED_ENABLED))
    .then(s' = open(s, NESTED_DISABLED))
    .then(s' = begin(s, NESTED_DISABLED))
    .then(s' = settle(s, 1, VALUE_TWO))
    .then(s' = open(s, REENABLED_REQUEST))
    .then(s' = begin(s, REENABLED_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.sourceScopes == List(true, false))

  run rejectedFlightAllowsRetryTest = init
    .then(s' = begin(s, ROOT_REQUEST))
    .then(releasePolicy)
    .then(s' = begin(s, ROOT_REQUEST))
    .then(releasePolicy)
    .then(s' = settle(s, 0, SOURCE_ERROR))
    .then(s' = begin(s, ROOT_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(SOURCE_ERROR, SOURCE_ERROR, CALL_PENDING) and s.o.loaders == 2)
  run sharedFailureHasOneAttributedErrorTest = init.then(s' = begin(s, ROOT_REQUEST))
    .then(releasePolicy)
    .then(s' = begin(s, ROOT_REQUEST))
    .then(releasePolicy)
    .then(s' = settle(s, 0, SOURCE_ERROR))
    .expect(s.d.coalesced == List("request_local") and s.d.fallbackErrors == List("request_local"))
  run disabledSourceFailureHasNoCacheTrailTest = init.then(s' = begin(s, OUTSIDE_REQUEST))
    .then(s' = settle(s, 0, SOURCE_ERROR))
    .expect(s.d.fallbackErrors == List() and s.o.calls == List(SOURCE_ERROR))
  run policyClosureFailureIsAttributedWithoutCachingTest = init.then(s' = begin(s, ROOT_REQUEST))
    .then(s' = close(s, ROOT_REQUEST))
    .then(releasePolicy)
    .then(s' = settle(s, 0, SOURCE_ERROR))
    .expect(s.d.fallbackErrors == List("noop"))
  run absentValueIsMemoizedTest = init.then(s' = begin(s, ROOT_REQUEST))
    .then(releasePolicy)
    .then(s' = settle(s, 0, VALUE_ABSENT))
    .then(s' = begin(s, ROOT_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT) and s.o.loaders == 1)
}

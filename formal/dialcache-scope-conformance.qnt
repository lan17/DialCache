module dialcache_scope_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import diagnostics as Diag from "./kernel/diagnostics"
  import request_memo as Memo from "./kernel/request-memo"
  import flights as Flights from "./kernel/flights"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Request-only caching: one key and two independent request lifetimes.
  // Handles 2/3 nest enabled/disabled under 0; 4 reenables inside 3.
  // Completed handles remain usable for detached work. Only an outer close
  // ends its memo lifetime. No language-specific executor ordering is modeled.
  // Every rule is a kernel transition (formal/kernel): the request-only
  // projection of the traversal with its diagnosed variants, since the drivers
  // compare the diagnostics channel. This module owns the bounded state, the
  // context decoding (which outer lifetime a nested handle memoizes into and
  // whether a handle is enabled), the policy decoding, the input choices and
  // the guards. State: o/d are replay observations; memo, registries,
  // ownership and source records predict future effects and are never
  // implementation inputs.
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
  pure val MAX_CALLERS = 16
  pure val SOURCE_VALUE_COUNT = 7
  pure val MAX_RESOLVE_CHOICE = 112
  // One key, memo rows for the two outer lifetimes, five contexts of which the
  // two outer ones are persistent scopes; no remote layer writes a TTL; the
  // drivers probe each source for the scope it started under.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, servingTtlMs: 0, probeSourceScope: true
  }

  // -- State and initial environment -----------------------------------------

  type State = {
    o: Observation,
    d: Diagnostics,
    opened: List[bool],
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    sources: List[Serving::RequestSource],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held],
    sourceLayers: List[str],
    resolved: Resolution
  }
  var s: State
  // Explicit environment inputs also make deterministic Quint runs replayable.
  var input: { name: str, choice: int }

  // Input decoding: a nested handle memoizes into its outer lifetime (the
  // replacement request or the root); a disabled handle and a call outside
  // every request are not enabled. Policy overlay 0 inherits request caching
  // and sharing, 1 bypasses request caching, 2 retains memoization while
  // disabling flight sharing.
  pure def holder(scope: int): int = if (scope == REPLACEMENT_REQUEST) REPLACEMENT_REQUEST else ROOT_REQUEST
  pure def call(scope: int): Call =
    { instance: 0, key: 0, context: holder(scope), enabled: scope != NESTED_DISABLED and scope != OUTSIDE_REQUEST }
  pure def resolutionOf(overlay: int): Resolution = {
    layers: { request: overlay != POLICY_NO_REQUEST, local: false, remote: false },
    coalesce: overlay != POLICY_NO_COALESCING
  }

  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty,
      d: noDiagnostics,
      opened: List(true, false, false, false, false),
      closed: List(false, false, false, false, false),
      memo: List(NO_VALUE, NO_VALUE),
      requestFlights: List(NO_OWNER, NO_OWNER),
      processFlights: List(NO_OWNER),
      sources: List(),
      owners: List(),
      memoSlots: List(),
      held: List(),
      sourceLayers: List(),
      resolved: resolutionOf(POLICY_INHERIT)
    }
  }

  // -- Caller admission and policy release -----------------------------------

  action startCall(scope: int): bool = all {
    s' = Diag::admitRequest(s, LAYOUT, call(scope)),
    input' = { name: "beginCall", choice: scope }
  }
  action beginCall = {
    // Context 5 is outside every request.
    nondet choice = ROOT_REQUEST.to(OUTSIDE_REQUEST).filter(id => id == OUTSIDE_REQUEST or s.opened.nth(id)).oneOf()
    all {
      not(Gate::holding(s)),
      s.o.calls.length() < MAX_CALLERS,
      startCall(choice)
    }
  }
  action releasePolicy = all {
    Gate::holding(s),
    s' = Diag::releaseRequest(s, LAYOUT, Gate::latest(s), s.resolved),
    input' = { name: "releasePolicy", choice: -1 }
  }

  // -- Source settlement and request publication -----------------------------

  action finishSource(loader: int, result: int): bool = all {
    s' = Diag::settleRequest(s, LAYOUT, loader, result),
    input' = if (result == SOURCE_ERROR) { name: "rejectLoader", choice: loader }
      else { name: "resolveLoader", choice: loader * SOURCE_VALUE_COUNT
        + (if (result <= VALUE_TWO) result else result - 2) }
  }
  val pending = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING)
  action resolveLoader = {
    nondet choice = 1.to(MAX_RESOLVE_CHOICE).filter(code => pending.contains((code - 1) / SOURCE_VALUE_COUNT)).oneOf()
    finishSource((choice - 1) / SOURCE_VALUE_COUNT, values.nth((choice - 1) % SOURCE_VALUE_COUNT))
  }
  action rejectLoader = {
    nondet choice = pending.oneOf()
    finishSource(choice, SOURCE_ERROR)
  }

  // -- Environment scope and policy changes ----------------------------------

  action openContext(scope: int): bool = all {
    s' = Memo::openScope(s, scope),
    input' = { name: "openScope", choice: scope }
  }
  action openScope = {
    nondet choice = REPLACEMENT_REQUEST.to(REENABLED_REQUEST).filter(id => not(s.opened.nth(id)) and
      (id == REPLACEMENT_REQUEST or (not(s.closed.nth(ROOT_REQUEST)) and (id != REENABLED_REQUEST
        or s.opened.nth(NESTED_DISABLED))))).oneOf()
    openContext(choice)
  }
  action closeContext(scope: int): bool = all {
    s' = Serving::closeScope(s, LAYOUT, scope),
    input' = { name: "closeScope", choice: scope }
  }
  action closeScope = {
    nondet choice = ROOT_REQUEST.to(REENABLED_REQUEST).filter(id => s.opened.nth(id)
      and not(s.closed.nth(id))).oneOf()
    all {
      s.o.calls.length() > 0,
      closeContext(choice)
    }
  }
  action changePolicy(overlay: int): bool = all {
    s' = { resolved: resolutionOf(overlay), ...s },
    input' = { name: "policy", choice: overlay }
  }
  action policy = {
    nondet choice = Set(POLICY_INHERIT, POLICY_NO_REQUEST, POLICY_NO_COALESCING).oneOf()
    changePolicy(choice)
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
  // The memo row a source fills is the memo slot of its owners: a caller joins
  // only the flight registered under its own row, so every owner of a source
  // memoizes into the same row or into none.

  pure def fillsRow(x: State, loader: int, slot: int): bool =
    Flights::ownedBy(x, loader).forall(caller => x.memoSlots.nth(caller) == slot)
  val closedScopesHaveNoMemo = s.memo.indices().forall(slot =>
    not(s.closed.nth(slot)) or (s.memo.nth(slot) == NO_VALUE and s.requestFlights.nth(slot) == NO_OWNER))
  val registeredSourcesArePending = s.requestFlights.indices().forall(slot => {
    val loader = s.requestFlights.nth(slot)
    loader < 0 or (fillsRow(s, loader, slot) and s.sources.nth(loader).result == CALL_PENDING)
  })
  val callsKeepSourceOutcome = s.o.calls.indices().forall(i =>
    if (s.owners.nth(i) >= 0) s.o.calls.nth(i) == s.sources.nth(s.owners.nth(i)).result
    else (s.o.calls.nth(i) == CALL_PENDING) == (s.held.select(held => held.caller == i).length() > 0))
  val sourceCountsMatchEffects = s.sources.length() == s.o.loaders and
    s.o.sourceScopes.length() == s.o.loaders and s.owners.length() == s.o.calls.length()
    and s.sourceLayers.length() == s.o.loaders and s.held.length() <= 1

  // A memo row holds nothing or a value a source memoizing into it settled
  // with, and the settlement that just happened left its successful value in
  // the row of every owner memoizing into an open scope: source admission
  // order and coalescing do not determine the final value.
  pure def publishable(value: int): bool = values.indices().exists(index => values.nth(index) == value)
  val justSettled = input.name == "resolveLoader" or input.name == "rejectLoader"
  val settledSource = if (input.name == "resolveLoader") (input.choice - 1) / SOURCE_VALUE_COUNT else input.choice
  val memoFollowsLatestSuccessfulSettlement = s.memo.indices().forall(slot =>
      s.memo.nth(slot) == NO_VALUE or s.sources.indices().exists(loader =>
        s.sources.nth(loader).result == s.memo.nth(slot) and publishable(s.memo.nth(slot))
          and Flights::ownedBy(s, loader).exists(caller => s.memoSlots.nth(caller) == slot)))
    and (not(justSettled) or {
      val result = s.sources.nth(settledSource).result
      not(publishable(result)) or Flights::ownedBy(s, settledSource).forall(caller => {
        val row = s.memoSlots.nth(caller)
        row < 0 or s.closed.nth(row) or s.memo.nth(row) == result
      })
    })

  // -- Deterministic regression schedules ------------------------------------

  run lateSourceCannotPopulateReplacementTest = init
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(closeContext(ROOT_REQUEST))
    .then(openContext(REPLACEMENT_REQUEST))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(REPLACEMENT_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2 and s.memo == List(NO_VALUE, NO_VALUE))

  run policyReplyAfterCloseBypassesRequestTest = init
    .then(startCall(ROOT_REQUEST))
    .then(closeContext(ROOT_REQUEST))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .expect(s.o.sourceScopes == List(false) and s.memo == List(NO_VALUE, NO_VALUE))

  run nestedCloseAndDisabledBypassKeepOuterMemoTest = init
    .then(openContext(NESTED_ENABLED))
    .then(startCall(NESTED_ENABLED))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(closeContext(NESTED_ENABLED))
    .then(openContext(NESTED_DISABLED))
    .then(startCall(NESTED_DISABLED))
    .then(finishSource(1, VALUE_TWO))
    .then(openContext(REENABLED_REQUEST))
    .then(startCall(REENABLED_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.sourceScopes == List(true, false))

  run rejectedFlightAllowsRetryTest = init
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(finishSource(0, SOURCE_ERROR))
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(SOURCE_ERROR, SOURCE_ERROR, CALL_PENDING) and s.o.loaders == 2)
  run sharedFailureHasOneAttributedErrorTest = init.then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(finishSource(0, SOURCE_ERROR))
    .expect(s.d.coalesced == List("request_local") and s.d.fallbackErrors == List("request_local"))
  run disabledSourceFailureHasNoCacheTrailTest = init.then(startCall(OUTSIDE_REQUEST))
    .then(finishSource(0, SOURCE_ERROR))
    .expect(s.d.fallbackErrors == List() and s.o.calls == List(SOURCE_ERROR))
  run policyClosureFailureIsAttributedWithoutCachingTest = init.then(startCall(ROOT_REQUEST))
    .then(closeContext(ROOT_REQUEST))
    .then(releasePolicy)
    .then(finishSource(0, SOURCE_ERROR))
    .expect(s.d.fallbackErrors == List("noop"))
  run absentValueIsMemoizedTest = init.then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ABSENT))
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT) and s.o.loaders == 1)

  run independentRequestMemoUsesLastCompletionTest = init
    .then(changePolicy(POLICY_NO_COALESCING))
    .then(startCall(ROOT_REQUEST)).then(releasePolicy)
    .then(startCall(ROOT_REQUEST)).then(releasePolicy)
    .then(finishSource(1, VALUE_TWO))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(ROOT_REQUEST)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE)
      and s.o.loaders == 2 and s.d.coalesced == List())

  run pendingSourceKeepsRequestPolicyAcrossBypassAndClosureTest = init
    .then(changePolicy(POLICY_NO_COALESCING))
    .then(startCall(ROOT_REQUEST)).then(releasePolicy)
    .then(changePolicy(POLICY_NO_REQUEST))
    .then(startCall(ROOT_REQUEST)).then(releasePolicy)
    .then(closeContext(ROOT_REQUEST))
    .then(openContext(REPLACEMENT_REQUEST))
    .then(changePolicy(POLICY_INHERIT))
    .then(finishSource(1, VALUE_TWO)).then(finishSource(0, VALUE_ONE))
    .then(startCall(REPLACEMENT_REQUEST)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, CALL_PENDING)
      and s.o.loaders == 3 and s.memo == List(NO_VALUE, NO_VALUE))
}

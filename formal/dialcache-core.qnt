module dialcache_core {
  // One-key behavioral model for caller-visible traversal and publication.
  // A single record state keeps every nondeterministic transition on the same
  // Quint update effect, while preserving the protocol-level distinctions.

  type ScopeState = OutsideScope | OpenScope | ClosedScope
  type CallPhase = CallIdle | RequestLookup | LocalLookup | RemoteLookup | LoaderRunning | RemotePublishing | CallDone
  type ResultOrigin = NoResult | RequestValue | LocalValue | RemoteValue | SourceValue

  type State = {
    scope: ScopeState,
    scopeId: int, callScopeId: int, requestValueScope: int, scopeDepth: int, scopeDisabled: bool,
    policyRequestLocal: bool,
    policyLocal: bool,
    policyRemote: bool,
    policyTracked: bool,
    callRequestLocal: bool,
    callLocal: bool,
    callRemote: bool,
    callTracked: bool,
    callStartedEnabled: bool,
    requestHasValue: bool,
    localHasValue: bool,
    remoteHasValue: bool,
    remoteReadHealthy: bool,
    localReadHealthy: bool, localWriteHealthy: bool,
    localWriteFailures: int,
    phase: CallPhase,
    origin: ResultOrigin,
    requestReads: int,
    localReads: int,
    remoteReads: int,
    sourceCalls: int,
    requestWrites: int,
    localWrites: int,
    remoteWrites: int,
    configSnapshots: int,
    keyConstructions: int,
    remoteSemanticMiss: bool,
    remoteReadFailed: bool
  }

  var s: State

  val callScopeLive = s.scope == OpenScope and s.callScopeId == s.scopeId

  action init = s' = {
    scope: OutsideScope,
    scopeId: 0, callScopeId: 0, requestValueScope: 0, scopeDepth: 0, scopeDisabled: false,
    policyRequestLocal: false,
    policyLocal: false,
    policyRemote: false,
    policyTracked: false,
    callRequestLocal: false,
    callLocal: false,
    callRemote: false,
    callTracked: false,
    callStartedEnabled: false,
    requestHasValue: false,
    localHasValue: false,
    remoteHasValue: false,
    remoteReadHealthy: true,
    localReadHealthy: true, localWriteHealthy: true, localWriteFailures: 0,
    phase: CallIdle,
    origin: NoResult,
    requestReads: 0,
    localReads: 0,
    remoteReads: 0,
    sourceCalls: 0,
    requestWrites: 0,
    localWrites: 0,
    remoteWrites: 0,
    configSnapshots: 0,
    keyConstructions: 0,
    remoteSemanticMiss: false,
    remoteReadFailed: false
  }

  action toggleRequestPolicy = all {
    s.phase == CallIdle,
    s' = { policyRequestLocal: not(s.policyRequestLocal), ...s },
  }

  action toggleLocalPolicy = all {
    s.phase == CallIdle,
    s' = { policyLocal: not(s.policyLocal), ...s },
  }

  action toggleRemotePolicy = all {
    s.phase == CallIdle,
    s' = { policyRemote: not(s.policyRemote), ...s },
  }

  action toggleTrackedPolicy = all {
    s.phase == CallIdle,
    s' = { policyTracked: not(s.policyTracked), ...s },
  }

  action toggleRedisHealth = all {
    s.phase == CallIdle,
    s' = { remoteReadHealthy: not(s.remoteReadHealthy), ...s },
  }

  // Local storage failures are environment outcomes of DialCache-owned
  // operations, not failures of the source. No LRU internals are modeled.
  action toggleLocalReadHealth = all {
    s.phase == CallIdle,
    s' = { localReadHealthy: not(s.localReadHealthy), ...s },
  }
  action toggleLocalWriteHealth = all {
    s.phase == CallIdle,
    s' = { localWriteHealthy: not(s.localWriteHealthy), ...s },
  }

  action openScope = all {
    s.scope != OpenScope,
    s' = { scope: OpenScope, scopeId: s.scopeId + 1, scopeDepth: 1, scopeDisabled: false, requestHasValue: false, ...s },
  }

  action closeScope = all {
    s.scope == OpenScope,
    s' = { scope: ClosedScope, scopeDepth: 0, scopeDisabled: false, requestHasValue: false, ...s },
  }

  action nestedEnable = all {
    s.phase == CallIdle, s.scope == OpenScope, not(s.scopeDisabled),
    s' = { scopeDepth: s.scopeDepth + 1, ...s },
  }
  action exitNestedEnable = all {
    s.phase == CallIdle, s.scopeDepth > 1,
    s' = { scopeDepth: s.scopeDepth - 1, ...s },
  }
  action disableScope = all {
    s.phase == CallIdle, s.scope == OpenScope, not(s.scopeDisabled),
    s' = { scopeDisabled: true, ...s },
  }
  action restoreScope = all {
    s.phase == CallIdle, s.scopeDisabled,
    s' = { scopeDisabled: false, ...s },
  }

  // Outside enable(), DialCache is true pass-through: no key/config/cache work.
  action startPassThrough = all {
    s.phase == CallIdle,
    s.scope != OpenScope or s.scopeDisabled,
    s' = {
      callStartedEnabled: false,
      callRequestLocal: false,
      callLocal: false,
      callRemote: false,
      callTracked: false,
      phase: LoaderRunning,
      origin: NoResult,
      requestReads: 0,
      localReads: 0,
      remoteReads: 0,
      sourceCalls: 1,
      requestWrites: 0,
      localWrites: 0,
      localWriteFailures: 0,
      remoteWrites: 0,
      configSnapshots: 0,
      keyConstructions: 0,
      remoteSemanticMiss: false,
      remoteReadFailed: false,
      ...s
    },
  }

  // Runtime/default policy is snapshotted once at invocation start.
  action startEnabledCall = all {
    s.phase == CallIdle,
    s.scope == OpenScope, not(s.scopeDisabled),
    s' = {
      callScopeId: s.scopeId,
      callStartedEnabled: true,
      callRequestLocal: s.policyRequestLocal,
      callLocal: s.policyLocal,
      callRemote: s.policyRemote,
      callTracked: s.policyTracked,
      phase: RequestLookup,
      origin: NoResult,
      requestReads: 0,
      localReads: 0,
      remoteReads: 0,
      sourceCalls: 0,
      requestWrites: 0,
      localWrites: 0,
      localWriteFailures: 0,
      remoteWrites: 0,
      configSnapshots: 1,
      keyConstructions: 1,
      remoteSemanticMiss: false,
      remoteReadFailed: false,
      ...s
    },
  }

  action requestLookup = all {
    s.phase == RequestLookup,
    s' = {
      requestReads: if (s.callRequestLocal and callScopeLive) s.requestReads + 1 else s.requestReads,
      origin: if (s.callRequestLocal and callScopeLive and s.requestHasValue) RequestValue else s.origin,
      phase: if (s.callRequestLocal and callScopeLive and s.requestHasValue) CallDone else LocalLookup,
      ...s
    },
  }

  action localLookup = all {
    s.phase == LocalLookup,
    s' = {
      localReads: if (s.callLocal) s.localReads + 1 else s.localReads,
      origin: if (s.callLocal and s.localReadHealthy and s.localHasValue) LocalValue else s.origin,
      requestHasValue: if (s.callLocal and s.localReadHealthy and s.localHasValue and s.callRequestLocal and callScopeLive) true else s.requestHasValue,
      requestWrites: if (s.callLocal and s.localReadHealthy and s.localHasValue and s.callRequestLocal and callScopeLive) s.requestWrites + 1 else s.requestWrites,
      requestValueScope: if (s.callLocal and s.localReadHealthy and s.localHasValue and s.callRequestLocal and callScopeLive) s.callScopeId else s.requestValueScope,
      phase: if (s.callLocal and s.localReadHealthy and s.localHasValue) CallDone else RemoteLookup,
      ...s
    },
  }

  action remoteLookupHealthy = all {
    s.phase == RemoteLookup,
    s.callRemote,
    s.remoteReadHealthy,
    s' = {
      remoteReads: s.remoteReads + 1,
      origin: if (s.remoteHasValue) RemoteValue else s.origin,
      localWriteFailures: if (s.remoteHasValue and s.callLocal and s.localReadHealthy and not(s.localWriteHealthy)) s.localWriteFailures + 1 else s.localWriteFailures,
      localHasValue: if (s.remoteHasValue and s.callLocal and s.localReadHealthy and s.localWriteHealthy) true else s.localHasValue,
      localWrites: if (s.remoteHasValue and s.callLocal and s.localReadHealthy and s.localWriteHealthy) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (s.remoteHasValue and s.callRequestLocal and callScopeLive) true else s.requestHasValue,
      requestWrites: if (s.remoteHasValue and s.callRequestLocal and callScopeLive) s.requestWrites + 1 else s.requestWrites,
      requestValueScope: if (s.remoteHasValue and s.callRequestLocal and callScopeLive) s.callScopeId else s.requestValueScope,
      remoteSemanticMiss: not(s.remoteHasValue),
      sourceCalls: if (s.remoteHasValue) s.sourceCalls else s.sourceCalls + 1,
      phase: if (s.remoteHasValue) CallDone else LoaderRunning,
      ...s
    },
  }

  action remoteLookupFailure = all {
    s.phase == RemoteLookup,
    s.callRemote,
    not(s.remoteReadHealthy),
    s' = {
      remoteReads: s.remoteReads + 1,
      remoteReadFailed: true,
      sourceCalls: s.sourceCalls + 1,
      phase: LoaderRunning,
      ...s
    },
  }

  action skipRemote = all {
    s.phase == RemoteLookup,
    not(s.callRemote),
    s' = { sourceCalls: s.sourceCalls + 1, phase: LoaderRunning, ...s },
  }

  action loaderSuccessPassThrough = all {
    s.phase == LoaderRunning,
    not(s.callStartedEnabled),
    s' = { origin: SourceValue, phase: CallDone, ...s },
  }

  action loaderSuccessAfterSemanticMiss = all {
    s.phase == LoaderRunning,
    s.callStartedEnabled,
    s.remoteSemanticMiss,
    s' = { origin: SourceValue, phase: RemotePublishing, ...s },
  }

  // Redis read failure is fail-open but is not a semantic miss, so no refill.
  action loaderSuccessAfterRemoteFailure = all {
    s.phase == LoaderRunning,
    s.callStartedEnabled,
    s.remoteReadFailed,
    s' = {
      origin: SourceValue,
      localWriteFailures: if (s.callLocal and s.localReadHealthy and not(s.callTracked) and not(s.localWriteHealthy)) s.localWriteFailures + 1 else s.localWriteFailures,
      localHasValue: if (s.callLocal and s.localReadHealthy and not(s.callTracked) and s.localWriteHealthy) true else s.localHasValue,
      localWrites: if (s.callLocal and s.localReadHealthy and not(s.callTracked) and s.localWriteHealthy) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (s.callRequestLocal and callScopeLive) true else s.requestHasValue,
      requestWrites: if (s.callRequestLocal and callScopeLive) s.requestWrites + 1 else s.requestWrites,
      requestValueScope: if (s.callRequestLocal and callScopeLive) s.callScopeId else s.requestValueScope,
      phase: CallDone,
      ...s
    },
  }

  action loaderSuccessWithoutRemote = all {
    s.phase == LoaderRunning,
    s.callStartedEnabled,
    not(s.callRemote),
    s' = {
      origin: SourceValue,
      localWriteFailures: if (s.callLocal and s.localReadHealthy and not(s.localWriteHealthy)) s.localWriteFailures + 1 else s.localWriteFailures,
      localHasValue: if (s.callLocal and s.localReadHealthy and s.localWriteHealthy) true else s.localHasValue,
      localWrites: if (s.callLocal and s.localReadHealthy and s.localWriteHealthy) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (s.callRequestLocal and callScopeLive) true else s.requestHasValue,
      requestWrites: if (s.callRequestLocal and callScopeLive) s.requestWrites + 1 else s.requestWrites,
      requestValueScope: if (s.callRequestLocal and callScopeLive) s.callScopeId else s.requestValueScope,
      phase: CallDone,
      ...s
    },
  }

  action loaderFailure = all {
    s.phase == LoaderRunning,
    s' = {
      requestHasValue: if (s.scope == OpenScope) s.requestHasValue else false,
      phase: CallDone,
      origin: NoResult,
      ...s
    },
  }

  action finishRemotePublication = all {
    s.phase == RemotePublishing,
    s' = {
      remoteWrites: s.remoteWrites + 1,
      remoteHasValue: true,
      localWriteFailures: if (s.callLocal and s.localReadHealthy and not(s.callTracked) and not(s.localWriteHealthy)) s.localWriteFailures + 1 else s.localWriteFailures,
      localHasValue: if (s.callLocal and s.localReadHealthy and not(s.callTracked) and s.localWriteHealthy) true else s.localHasValue,
      localWrites: if (s.callLocal and s.localReadHealthy and not(s.callTracked) and s.localWriteHealthy) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (s.callRequestLocal and callScopeLive) true else s.requestHasValue,
      requestWrites: if (s.callRequestLocal and callScopeLive) s.requestWrites + 1 else s.requestWrites,
      requestValueScope: if (s.callRequestLocal and callScopeLive) s.callScopeId else s.requestValueScope,
      phase: CallDone,
      ...s
    },
  }

  action resetCall = all {
    s.phase == CallDone,
    s' = { phase: CallIdle, origin: NoResult, ...s },
  }

  action step = any {
    toggleRequestPolicy,
    toggleLocalPolicy,
    toggleRemotePolicy,
    toggleTrackedPolicy,
    toggleRedisHealth, toggleLocalReadHealth, toggleLocalWriteHealth,
    openScope,
    closeScope, nestedEnable, exitNestedEnable, disableScope, restoreScope,
    startPassThrough,
    startEnabledCall,
    requestLookup,
    localLookup,
    remoteLookupHealthy,
    remoteLookupFailure,
    skipRemote,
    loaderSuccessPassThrough,
    loaderSuccessAfterSemanticMiss,
    loaderSuccessAfterRemoteFailure,
    loaderSuccessWithoutRemote,
    loaderFailure,
    finishRemotePublication,
    resetCall,
  }

  val closedScopeHasNoRequestValue =
    s.scope != ClosedScope or not(s.requestHasValue)

  val passThroughSkipsCacheMachinery =
    s.callStartedEnabled or
      (s.requestReads == 0 and s.localReads == 0 and s.remoteReads == 0 and
       s.configSnapshots == 0 and s.keyConstructions == 0 and
       s.requestWrites == 0 and s.localWrites == 0 and s.remoteWrites == 0)

  val firstHitStopsLowerTraversal = and {
    s.origin != RequestValue or (s.localReads == 0 and s.remoteReads == 0 and s.sourceCalls == 0),
    s.origin != LocalValue or (s.remoteReads == 0 and s.sourceCalls == 0),
    s.origin != RemoteValue or s.sourceCalls == 0,
  }

  val failedLocalReadSkipsReuseAndPublication =
    s.phase == CallIdle or s.localReadHealthy or
      (s.origin != LocalValue and s.localWrites == 0 and s.localWriteFailures == 0)

  val failedLocalWritePreservesAcceptedResult =
    s.phase != CallDone or s.localWriteFailures == 0 or
      (s.origin == RemoteValue or s.origin == SourceValue)

  val remoteFailureNeverRefills =
    not(s.remoteReadFailed) or s.remoteWrites == 0

  val trackedRemoteFallbackSuppressesLocalPublication =
    not(s.callTracked and s.remoteSemanticMiss and s.origin == SourceValue) or s.localWrites == 0

  val onePolicySnapshotPerEnabledInvocation =
    if (s.callStartedEnabled)
      (s.configSnapshots == 1 and s.keyConstructions == 1)
    else
      (s.configSnapshots == 0 and s.keyConstructions == 0)
  val requestValueBelongsToCurrentScope =
    not(s.requestHasValue) or (s.scope == OpenScope and s.requestValueScope == s.scopeId)

  run lateResultCannotEnterReplacementScopeTest = init.then(toggleRequestPolicy).then(openScope)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(skipRemote)
    .then(closeScope).then(openScope).then(loaderSuccessWithoutRemote)
    .expect(not(s.requestHasValue) and s.requestWrites == 0)

  run nestedDisablePreservesMemoTest = init.then(toggleRequestPolicy).then(openScope)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(skipRemote)
    .then(loaderSuccessWithoutRemote).then(resetCall).then(nestedEnable).then(exitNestedEnable)
    .then(disableScope).then(startPassThrough).then(loaderSuccessPassThrough).then(resetCall)
    .then(restoreScope).then(startEnabledCall).then(requestLookup)
    .expect(s.origin == RequestValue and s.sourceCalls == 0)

  run localReadFailureContinuesToRemoteTest = init.then(toggleLocalPolicy).then(toggleRemotePolicy).then(openScope)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(remoteLookupHealthy)
    .then(loaderSuccessAfterSemanticMiss).then(finishRemotePublication).then(resetCall)
    .then(toggleLocalReadHealth).then(startEnabledCall).then(requestLookup).then(localLookup).then(remoteLookupHealthy)
    .expect(s.origin == RemoteValue and s.localReads == 1 and s.remoteReads == 1 and s.sourceCalls == 0 and s.localWrites == 0)

  run localWriteFailurePreservesSourceAndMemoTest = init.then(toggleLocalPolicy).then(toggleRequestPolicy)
    .then(toggleLocalWriteHealth).then(openScope).then(startEnabledCall).then(requestLookup).then(localLookup)
    .then(skipRemote).then(loaderSuccessWithoutRemote)
    .expect(s.origin == SourceValue and not(s.localHasValue) and s.localWriteFailures == 1 and s.requestHasValue)

  run localWriteFailurePreservesRemoteHitTest = init.then(toggleRemotePolicy).then(openScope)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(remoteLookupHealthy)
    .then(loaderSuccessAfterSemanticMiss).then(finishRemotePublication).then(resetCall)
    .then(toggleLocalPolicy).then(toggleRequestPolicy).then(toggleLocalWriteHealth)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(remoteLookupHealthy)
    .expect(s.origin == RemoteValue and s.sourceCalls == 0 and s.localWriteFailures == 1 and s.requestHasValue)

  run localReadFailureSuppressesSourcePublicationTest = init.then(toggleLocalPolicy).then(toggleLocalReadHealth)
    .then(openScope).then(startEnabledCall).then(requestLookup).then(localLookup).then(skipRemote)
    .then(loaderSuccessWithoutRemote)
    .expect(s.origin == SourceValue and not(s.localHasValue) and s.localWrites == 0 and s.localWriteFailures == 0)
}

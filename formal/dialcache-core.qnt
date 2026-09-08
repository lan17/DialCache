module dialcache_core {
  // One-key behavioral model for caller-visible traversal and publication.
  // A single record state keeps every nondeterministic transition on the same
  // Quint update effect, while preserving the protocol-level distinctions.

  type ScopeState = OutsideScope | OpenScope | ClosedScope
  type CallPhase = CallIdle | RequestLookup | LocalLookup | RemoteLookup | LoaderRunning | RemotePublishing | CallDone
  type ResultOrigin = NoResult | RequestValue | LocalValue | RemoteValue | SourceValue

  type State = {
    scope: ScopeState,
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

  action init = s' = {
    scope: OutsideScope,
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

  action openScope = all {
    s.scope != OpenScope,
    s' = { scope: OpenScope, requestHasValue: false, ...s },
  }

  action closeScope = all {
    s.scope == OpenScope,
    s' = { scope: ClosedScope, requestHasValue: false, ...s },
  }

  // Outside enable(), DialCache is true pass-through: no key/config/cache work.
  action startPassThrough = all {
    s.phase == CallIdle,
    s.scope != OpenScope,
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
    s.scope == OpenScope,
    s' = {
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
      requestReads: if (s.callRequestLocal and s.scope == OpenScope) s.requestReads + 1 else s.requestReads,
      origin: if (s.callRequestLocal and s.scope == OpenScope and s.requestHasValue) RequestValue else s.origin,
      phase: if (s.callRequestLocal and s.scope == OpenScope and s.requestHasValue) CallDone else LocalLookup,
      ...s
    },
  }

  action localLookup = all {
    s.phase == LocalLookup,
    s' = {
      localReads: if (s.callLocal) s.localReads + 1 else s.localReads,
      origin: if (s.callLocal and s.localHasValue) LocalValue else s.origin,
      requestHasValue: if (s.callLocal and s.localHasValue and s.callRequestLocal and s.scope == OpenScope) true else s.requestHasValue,
      requestWrites: if (s.callLocal and s.localHasValue and s.callRequestLocal and s.scope == OpenScope) s.requestWrites + 1 else s.requestWrites,
      phase: if (s.callLocal and s.localHasValue) CallDone else RemoteLookup,
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
      localHasValue: if (s.remoteHasValue and s.callLocal) true else s.localHasValue,
      localWrites: if (s.remoteHasValue and s.callLocal) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (s.remoteHasValue and s.callRequestLocal and s.scope == OpenScope) true else s.requestHasValue,
      requestWrites: if (s.remoteHasValue and s.callRequestLocal and s.scope == OpenScope) s.requestWrites + 1 else s.requestWrites,
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
      localHasValue: if (s.callLocal and not(s.callTracked)) true else s.localHasValue,
      localWrites: if (s.callLocal and not(s.callTracked)) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (s.callRequestLocal and s.scope == OpenScope) true else s.requestHasValue,
      requestWrites: if (s.callRequestLocal and s.scope == OpenScope) s.requestWrites + 1 else s.requestWrites,
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
      localHasValue: if (s.callLocal) true else s.localHasValue,
      localWrites: if (s.callLocal) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (s.callRequestLocal and s.scope == OpenScope) true else s.requestHasValue,
      requestWrites: if (s.callRequestLocal and s.scope == OpenScope) s.requestWrites + 1 else s.requestWrites,
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
      localHasValue: if (s.callLocal and not(s.callTracked)) true else s.localHasValue,
      localWrites: if (s.callLocal and not(s.callTracked)) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (s.callRequestLocal and s.scope == OpenScope) true else s.requestHasValue,
      requestWrites: if (s.callRequestLocal and s.scope == OpenScope) s.requestWrites + 1 else s.requestWrites,
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
    toggleRedisHealth,
    openScope,
    closeScope,
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

  val remoteFailureNeverRefills =
    not(s.remoteReadFailed) or s.remoteWrites == 0

  val trackedRemoteFallbackSuppressesLocalPublication =
    not(s.callTracked and s.remoteSemanticMiss and s.origin == SourceValue) or s.localWrites == 0

  val onePolicySnapshotPerEnabledInvocation =
    if (s.callStartedEnabled)
      (s.configSnapshots == 1 and s.keyConstructions == 1)
    else
      (s.configSnapshots == 0 and s.keyConstructions == 0)
}

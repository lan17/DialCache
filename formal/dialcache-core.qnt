module dialcache_core {
  // Behavioral model for one cache key and one DialCache instance.
  //
  // This models the caller-visible read-through chain and the publication
  // boundaries that differ for tracked/untracked remote reads. It deliberately
  // treats key construction, serialization, Redis framing, and metrics as
  // separate contracts.

  type ScopeState = OutsideScope | OpenScope | ClosedScope
  type CallPhase = CallIdle | RequestLookup | LocalLookup | RemoteLookup | LoaderRunning | RemotePublishing | CallDone
  type ResultOrigin = NoResult | RequestValue | LocalValue | RemoteValue | SourceValue

  var scope: ScopeState

  // Effective policy snapshot for the next invocation. Policy can change only
  // between calls; startEnabledCall snapshots the booleans into call* fields.
  var policyRequestLocal: bool
  var policyLocal: bool
  var policyRemote: bool
  var policyTracked: bool

  var callRequestLocal: bool
  var callLocal: bool
  var callRemote: bool
  var callTracked: bool
  var callStartedEnabled: bool

  // Settled storage state for this one abstract key.
  var requestHasValue: bool
  var localHasValue: bool
  var remoteHasValue: bool

  // Environment condition for the semantic Redis read.
  var remoteReadHealthy: bool

  var phase: CallPhase
  var origin: ResultOrigin

  // Per-call evidence used by invariants and later conformance traces.
  var requestReads: int
  var localReads: int
  var remoteReads: int
  var sourceCalls: int
  var requestWrites: int
  var localWrites: int
  var remoteWrites: int
  var configSnapshots: int
  var keyConstructions: int
  var remoteSemanticMiss: bool
  var remoteReadFailed: bool

  action init = all {
    scope' = OutsideScope,

    policyRequestLocal' = false,
    policyLocal' = false,
    policyRemote' = false,
    policyTracked' = false,

    callRequestLocal' = false,
    callLocal' = false,
    callRemote' = false,
    callTracked' = false,
    callStartedEnabled' = false,

    requestHasValue' = false,
    localHasValue' = false,
    remoteHasValue' = false,
    remoteReadHealthy' = true,

    phase' = CallIdle,
    origin' = NoResult,

    requestReads' = 0,
    localReads' = 0,
    remoteReads' = 0,
    sourceCalls' = 0,
    requestWrites' = 0,
    localWrites' = 0,
    remoteWrites' = 0,
    configSnapshots' = 0,
    keyConstructions' = 0,
    remoteSemanticMiss' = false,
    remoteReadFailed' = false,
  }

  // Runtime/default policy changes affect only future invocations.
  action toggleRequestPolicy = all {
    phase == CallIdle,
    policyRequestLocal' = not(policyRequestLocal),
  }

  action toggleLocalPolicy = all {
    phase == CallIdle,
    policyLocal' = not(policyLocal),
  }

  action toggleRemotePolicy = all {
    phase == CallIdle,
    policyRemote' = not(policyRemote),
  }

  action toggleTrackedPolicy = all {
    phase == CallIdle,
    policyTracked' = not(policyTracked),
  }

  action toggleRedisHealth = all {
    phase == CallIdle,
    remoteReadHealthy' = not(remoteReadHealthy),
  }

  action openScope = all {
    scope != OpenScope,
    scope' = OpenScope,
    // Every outer enable scope owns a new request-local table.
    requestHasValue' = false,
  }

  action closeScope = all {
    scope == OpenScope,
    scope' = ClosedScope,
    // A closed request-local table cannot be read or repopulated.
    requestHasValue' = false,
  }

  // Calls that begin outside an enabled scope are true pass-through: no key,
  // config, cache lookup, coalescing, or DialCache fallback deadline exists.
  action startPassThrough = all {
    phase == CallIdle,
    scope != OpenScope,

    callStartedEnabled' = false,
    callRequestLocal' = false,
    callLocal' = false,
    callRemote' = false,
    callTracked' = false,

    phase' = LoaderRunning,
    origin' = NoResult,

    requestReads' = 0,
    localReads' = 0,
    remoteReads' = 0,
    sourceCalls' = 1,
    requestWrites' = 0,
    localWrites' = 0,
    remoteWrites' = 0,
    configSnapshots' = 0,
    keyConstructions' = 0,
    remoteSemanticMiss' = false,
    remoteReadFailed' = false,
  }

  // One effective policy snapshot is resolved before traversal.
  action startEnabledCall = all {
    phase == CallIdle,
    scope == OpenScope,

    callStartedEnabled' = true,
    callRequestLocal' = policyRequestLocal,
    callLocal' = policyLocal,
    callRemote' = policyRemote,
    callTracked' = policyTracked,

    phase' = RequestLookup,
    origin' = NoResult,

    requestReads' = 0,
    localReads' = 0,
    remoteReads' = 0,
    sourceCalls' = 0,
    requestWrites' = 0,
    localWrites' = 0,
    remoteWrites' = 0,
    configSnapshots' = 1,
    keyConstructions' = 1,
    remoteSemanticMiss' = false,
    remoteReadFailed' = false,
  }

  action requestLookup = all {
    phase == RequestLookup,
    if (callRequestLocal and scope == OpenScope)
      all {
        requestReads' = requestReads + 1,
        if (requestHasValue)
          all {
            origin' = RequestValue,
            phase' = CallDone,
          }
        else
          phase' = LocalLookup,
      }
    else
      phase' = LocalLookup,
  }

  action localLookup = all {
    phase == LocalLookup,
    if (callLocal)
      all {
        localReads' = localReads + 1,
        if (localHasValue)
          all {
            origin' = LocalValue,
            if (callRequestLocal and scope == OpenScope)
              all {
                requestHasValue' = true,
                requestWrites' = requestWrites + 1,
              }
            else true,
            phase' = CallDone,
          }
        else
          phase' = RemoteLookup,
      }
    else
      phase' = RemoteLookup,
  }

  // A healthy semantic Redis read is either a hit or miss. A hit can warm the
  // process-local layer only if that layer participated in this invocation.
  action remoteLookupHealthy = all {
    phase == RemoteLookup,
    callRemote,
    remoteReadHealthy,
    remoteReads' = remoteReads + 1,
    if (remoteHasValue)
      all {
        origin' = RemoteValue,
        if (callLocal)
          all {
            localHasValue' = true,
            localWrites' = localWrites + 1,
          }
        else true,
        if (callRequestLocal and scope == OpenScope)
          all {
            requestHasValue' = true,
            requestWrites' = requestWrites + 1,
          }
        else true,
        phase' = CallDone,
      }
    else
      all {
        remoteSemanticMiss' = true,
        sourceCalls' = sourceCalls + 1,
        phase' = LoaderRunning,
      },
  }

  // Redis I/O is fail-open for a cached invocation. It authorizes no Redis
  // refill because DialCache did not observe a semantic miss.
  action remoteLookupFailure = all {
    phase == RemoteLookup,
    callRemote,
    not(remoteReadHealthy),
    remoteReads' = remoteReads + 1,
    remoteReadFailed' = true,
    sourceCalls' = sourceCalls + 1,
    phase' = LoaderRunning,
  }

  action skipRemote = all {
    phase == RemoteLookup,
    not(callRemote),
    sourceCalls' = sourceCalls + 1,
    phase' = LoaderRunning,
  }

  // Successful pass-through loaders are returned directly and publish nowhere.
  action loaderSuccessPassThrough = all {
    phase == LoaderRunning,
    not(callStartedEnabled),
    origin' = SourceValue,
    phase' = CallDone,
  }

  // A source result after a semantic Redis miss takes the Redis publication
  // path. Tracked misses suppress direct process-local publication; untracked
  // misses may publish locally after the remote write path settles.
  action loaderSuccessAfterSemanticMiss = all {
    phase == LoaderRunning,
    callStartedEnabled,
    remoteSemanticMiss,
    origin' = SourceValue,
    phase' = RemotePublishing,
  }

  // A Redis read failure is not a semantic miss: no refill. Only an untracked
  // path may directly publish the fallback to process-local memory.
  action loaderSuccessAfterRemoteFailure = all {
    phase == LoaderRunning,
    callStartedEnabled,
    remoteReadFailed,
    origin' = SourceValue,
    if (callLocal and not(callTracked))
      all {
        localHasValue' = true,
        localWrites' = localWrites + 1,
      }
    else true,
    if (callRequestLocal and scope == OpenScope)
      all {
        requestHasValue' = true,
        requestWrites' = requestWrites + 1,
      }
    else true,
    phase' = CallDone,
  }

  // Local-only / remote-policy-disabled fallback publication.
  action loaderSuccessWithoutRemote = all {
    phase == LoaderRunning,
    callStartedEnabled,
    not(callRemote),
    origin' = SourceValue,
    if (callLocal)
      all {
        localHasValue' = true,
        localWrites' = localWrites + 1,
      }
    else true,
    if (callRequestLocal and scope == OpenScope)
      all {
        requestHasValue' = true,
        requestWrites' = requestWrites + 1,
      }
    else true,
    phase' = CallDone,
  }

  // Rejected source calls publish nothing and leave no settled request-local
  // value. A later invocation can therefore retry.
  action loaderFailure = all {
    phase == LoaderRunning,
    requestHasValue' = if (scope == OpenScope) requestHasValue else false,
    phase' = CallDone,
    origin' = NoResult,
  }

  // Redis writes are fail-open. The model does not distinguish write success
  // from failure because either way the caller returns the accepted source
  // value. remoteWrites counts dispatch attempts.
  action finishRemotePublication = all {
    phase == RemotePublishing,
    remoteWrites' = remoteWrites + 1,
    remoteHasValue' = true,
    if (callLocal and not(callTracked))
      all {
        localHasValue' = true,
        localWrites' = localWrites + 1,
      }
    else true,
    if (callRequestLocal and scope == OpenScope)
      all {
        requestHasValue' = true,
        requestWrites' = requestWrites + 1,
      }
    else true,
    phase' = CallDone,
  }

  action resetCall = all {
    phase == CallDone,
    phase' = CallIdle,
    origin' = NoResult,
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

  // Closed request-local state is terminal for that outer scope: later
  // completions can publish shared layers but cannot repopulate it.
  val closedScopeHasNoRequestValue =
    scope != ClosedScope or not(requestHasValue)

  // Calls that started outside enable() never consulted key/config/cache state.
  val passThroughSkipsCacheMachinery =
    callStartedEnabled or
      (requestReads == 0 and localReads == 0 and remoteReads == 0 and
       configSnapshots == 0 and keyConstructions == 0 and
       requestWrites == 0 and localWrites == 0 and remoteWrites == 0)

  // Layer traversal is ordered and short-circuits on the first hit.
  val firstHitStopsLowerTraversal = and {
    origin != RequestValue or (localReads == 0 and remoteReads == 0 and sourceCalls == 0),
    origin != LocalValue or (remoteReads == 0 and sourceCalls == 0),
    origin != RemoteValue or sourceCalls == 0,
  }

  // A failed semantic Redis read cannot authorize a refill.
  val remoteFailureNeverRefills =
    not(remoteReadFailed) or remoteWrites == 0

  // Tracked remote fallback results do not publish directly to process-local.
  val trackedRemoteFallbackSuppressesLocalPublication =
    not(callTracked and remoteSemanticMiss and origin == SourceValue) or localWrites == 0

  // Every enabled cached invocation resolves exactly one effective config and
  // constructs exactly one key; true pass-through resolves neither.
  val onePolicySnapshotPerEnabledInvocation =
    if (callStartedEnabled)
      (configSnapshots == 1 and keyConstructions == 1)
    else
      (configSnapshots == 0 and keyConstructions == 0)
}
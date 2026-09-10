module dialcache_coalescing_liveness {
  // Selected rules from C11, C14 and C23-C26. One request/process flight, with followers
  // and older abandoned sources. Policy flags are environment inputs; phase and
  // flightScope are DialCache ownership. fallbackStartedAt records invocation
  // time so deadline properties can be checked independently of the transition.
  // Time ranges from 0 through MAX_TIME. This model checks deadline safety and
  // cleanup; it does not assume scheduler fairness or prove eventual progress.

  // Types, bounds and state
  type FlightScope = NoFlight | RequestFlight | ProcessFlight
  type FlightPhase = FlightIdle | CacheLookup | FallbackRunning | Publication | FlightDone
  type Outcome = NoOutcome | CacheHit | SourceSuccess | SourceFailure | SourceTimeout

  pure val MAX_TIME = 8
  pure val FALLBACK_TIMEOUT = 3

  type State = {
    now: int,
    scopeEnabled: bool,
    requestLayerActive: bool,
    sharedLayerActive: bool,
    coalesce: bool,
    phase: FlightPhase,
    flightScope: FlightScope,
    outcome: Outcome,
    followers: int,
    sourceExecutions: int,
    independentExecutions: int,
    fallbackDeadline: int,
    fallbackStartedAt: int,
    fallbackDeadlineStarted: bool,
    activeSourceRunning: bool,
    abandonedSources: int,
    acceptedSourceResult: bool,
    publicationDispatched: bool
  }

  var s: State

  // Initial state
  action init = s' = {
    now: 0,
    scopeEnabled: false,
    requestLayerActive: false,
    sharedLayerActive: false,
    coalesce: true,
    phase: FlightIdle,
    flightScope: NoFlight,
    outcome: NoOutcome,
    followers: 0,
    sourceExecutions: 0,
    independentExecutions: 0,
    fallbackDeadline: 0,
    fallbackStartedAt: 0,
    fallbackDeadlineStarted: false,
    activeSourceRunning: false,
    abandonedSources: 0,
    acceptedSourceResult: false,
    publicationDispatched: false
  }

  // Environment transitions
  action advanceTime = all {
    s.now < MAX_TIME,
    s' = { now: s.now + 1, ...s },
  }

  action toggleEnabled = all {
    s.phase == FlightIdle,
    s' = { scopeEnabled: not(s.scopeEnabled), ...s },
  }

  action toggleRequestLayer = all {
    s.phase == FlightIdle,
    s' = { requestLayerActive: not(s.requestLayerActive), ...s },
  }

  action toggleSharedLayer = all {
    s.phase == FlightIdle,
    s' = { sharedLayerActive: not(s.sharedLayerActive), ...s },
  }

  action toggleCoalesce = all {
    s.phase == FlightIdle,
    s' = { coalesce: not(s.coalesce), ...s },
  }

  // Flight admission and cache lookup
  // Request-local coalescing wraps process coalescing and therefore wins when
  // both scopes are eligible for the same key.
  action startLeader = all {
    s.phase == FlightIdle,
    s.scopeEnabled,
    s.coalesce,
    s.requestLayerActive or s.sharedLayerActive,
    s' = {
      phase: CacheLookup,
      flightScope: if (s.requestLayerActive) RequestFlight else ProcessFlight,
      outcome: NoOutcome,
      followers: 0,
      sourceExecutions: 0,
      fallbackDeadlineStarted: false,
      activeSourceRunning: false,
      acceptedSourceResult: false,
      publicationDispatched: false,
      ...s
    },
  }

  action joinFollower = all {
    s.phase != FlightIdle,
    s.phase != FlightDone,
    s.flightScope != NoFlight,
    s' = { followers: s.followers + 1, ...s },
  }

  action startIndependentCaller = all {
    s.phase == FlightIdle,
    not(s.scopeEnabled and s.coalesce and (s.requestLayerActive or s.sharedLayerActive)),
    s' = { independentExecutions: s.independentExecutions + 1, ...s },
  }

  action finishCacheHit = all {
    s.phase == CacheLookup,
    s' = { outcome: CacheHit, phase: FlightDone, ...s },
  }

  // Source acceptance, abandonment and publication
  // Cache-read time is outside the fallback budget. The source deadline begins
  // exactly when the leader invokes the fallback.
  action cacheMissStartsFallback = all {
    s.phase == CacheLookup,
    s' = {
      sourceExecutions: s.sourceExecutions + 1,
      activeSourceRunning: true,
      fallbackDeadlineStarted: true,
      fallbackStartedAt: s.now,
      fallbackDeadline: s.now + FALLBACK_TIMEOUT,
      phase: FallbackRunning,
      ...s
    },
  }

  action sourceSucceedsBeforeDeadline = all {
    s.phase == FallbackRunning,
    s.now < s.fallbackDeadline,
    s.activeSourceRunning,
    s' = {
      activeSourceRunning: false,
      acceptedSourceResult: true,
      outcome: SourceSuccess,
      phase: Publication,
      ...s
    },
  }

  action sourceRejects = all {
    s.phase == FallbackRunning,
    s.activeSourceRunning,
    s.now < s.fallbackDeadline,
    s' = {
      activeSourceRunning: false,
      acceptedSourceResult: false,
      outcome: SourceFailure,
      phase: FlightDone,
      ...s
    },
  }

  // A late success or rejection can reach DialCache before the timer callback.
  // Settlement still checks the monotonic deadline and returns a timeout.
  action sourceSettlesAfterDeadline = all {
    s.phase == FallbackRunning,
    s.activeSourceRunning,
    s.now >= s.fallbackDeadline,
    s' = {
      activeSourceRunning: false,
      acceptedSourceResult: false,
      outcome: SourceTimeout,
      phase: FlightDone,
      flightScope: NoFlight,
      ...s
    },
  }

  // Timeout removes DialCache ownership immediately. The underlying operation is
  // not cancelled; it becomes abandoned external work that may settle later.
  action fallbackTimesOut = all {
    s.phase == FallbackRunning,
    s.fallbackDeadlineStarted,
    s.now >= s.fallbackDeadline,
    s.activeSourceRunning,
    s' = {
      activeSourceRunning: false,
      abandonedSources: s.abandonedSources + 1,
      acceptedSourceResult: false,
      outcome: SourceTimeout,
      phase: FlightDone,
      flightScope: NoFlight,
      ...s
    },
  }

  // This can happen while another flight is already active. It cannot affect the
  // current flight's accepted result or publication state.
  action abandonedSourceSettles = all {
    s.abandonedSources > 0,
    s' = { abandonedSources: s.abandonedSources - 1, ...s },
  }

  // Serialization/write work begins only after a result was accepted before the
  // fallback deadline, and is intentionally outside that deadline.
  action dispatchPublication = all {
    s.phase == Publication,
    s.acceptedSourceResult,
    s' = { publicationDispatched: true, phase: FlightDone, ...s },
  }

  action resetFlight = all {
    s.phase == FlightDone,
    s' = {
      phase: FlightIdle,
      flightScope: NoFlight,
      outcome: NoOutcome,
      followers: 0,
      sourceExecutions: 0,
      fallbackDeadlineStarted: false,
      activeSourceRunning: false,
      acceptedSourceResult: false,
      publicationDispatched: false,
      ...s
    },
  }

  // Exploration order
  action step = any {
    advanceTime,
    toggleEnabled,
    toggleRequestLayer,
    toggleSharedLayer,
    toggleCoalesce,
    startLeader,
    joinFollower,
    startIndependentCaller,
    finishCacheHit,
    cacheMissStartsFallback,
    sourceSucceedsBeforeDeadline,
    sourceRejects,
    sourceSettlesAfterDeadline,
    fallbackTimesOut,
    abandonedSourceSettles,
    dispatchPublication,
    resetFlight,
  }

  // Invariants
  val flightsRequireEligibleCaching =
    s.flightScope == NoFlight or
      (s.scopeEnabled and s.coalesce and (s.requestLayerActive or s.sharedLayerActive))

  val oneSourcePerRegisteredFlight =
    s.sourceExecutions <= 1

  val fallbackDeadlineStartsWithFallback =
    not(s.fallbackDeadlineStarted) or
      ((s.phase == FallbackRunning or s.phase == Publication or s.phase == FlightDone) and
       s.fallbackStartedAt <= s.now and
       s.fallbackDeadline == s.fallbackStartedAt + FALLBACK_TIMEOUT)

  val timedOutSourceCannotPublish =
    s.outcome != SourceTimeout or
      (not(s.acceptedSourceResult) and not(s.publicationDispatched))

  val publicationRequiresAcceptedSource =
    not(s.publicationDispatched) or s.acceptedSourceResult

  val noFlightWhenCoalescingIneligible =
    (s.scopeEnabled and s.coalesce and (s.requestLayerActive or s.sharedLayerActive)) or
      s.flightScope == NoFlight

  // Abandoned work is explicitly not represented as an active registered source.
  val abandonedSourceIsNotAFlight =
    s.abandonedSources == 0 or not(s.activeSourceRunning) or s.phase == FallbackRunning

  // Deterministic regressions
  run lateSettlementBeforeTimerTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(cacheMissStartsFallback)
    .then(advanceTime).then(advanceTime).then(advanceTime)
    .then(sourceSettlesAfterDeadline)
    .expect(s.outcome == SourceTimeout and s.flightScope == NoFlight)
    .expect(timedOutSourceCannotPublish)

  run abandonedSourceMayOverlapNewFlightTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(cacheMissStartsFallback)
    .then(advanceTime).then(advanceTime).then(advanceTime)
    .then(fallbackTimesOut).then(resetFlight).then(startLeader)
    .then(cacheMissStartsFallback)
    .expect(s.abandonedSources == 1 and s.activeSourceRunning)
    .then(abandonedSourceSettles)
    .expect(s.activeSourceRunning and s.sourceExecutions == 1)

  run acceptedPublicationOutlivesDeadlineTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(cacheMissStartsFallback).then(sourceSucceedsBeforeDeadline)
    .then(advanceTime).then(advanceTime).then(advanceTime)
    .then(dispatchPublication)
    .expect(s.publicationDispatched and s.outcome == SourceSuccess)

  // C23: time spent reading the cache must not consume the source budget.
  run delayedLookupKeepsFullSourceBudgetTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(advanceTime).then(advanceTime)
    .then(cacheMissStartsFallback)
    .expect(s.fallbackStartedAt == 2 and s.fallbackDeadline == 5)
    .expect(fallbackDeadlineStartsWithFallback)
    .then(advanceTime).then(sourceSucceedsBeforeDeadline)
    .expect(s.outcome == SourceSuccess)

  run deadlineEpochMutationIsDetectedTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(advanceTime).then(advanceTime).then(cacheMissStartsFallback)
    .then(all { s' = { fallbackDeadline: FALLBACK_TIMEOUT, ...s } })
    .expect(not(fallbackDeadlineStartsWithFallback))
}

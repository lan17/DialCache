module dialcache_coalescing_liveness {
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
    fallbackDeadlineStarted: bool,
    activeSourceRunning: bool,
    abandonedSources: int,
    acceptedSourceResult: bool,
    publicationDispatched: bool
  }

  var s: State

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
    fallbackDeadlineStarted: false,
    activeSourceRunning: false,
    abandonedSources: 0,
    acceptedSourceResult: false,
    publicationDispatched: false
  }

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

  // Cache-read time is outside the fallback budget. The source deadline begins
  // exactly when the leader invokes the fallback.
  action cacheMissStartsFallback = all {
    s.phase == CacheLookup,
    s' = {
      sourceExecutions: s.sourceExecutions + 1,
      activeSourceRunning: true,
      fallbackDeadlineStarted: true,
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
    s' = {
      activeSourceRunning: false,
      acceptedSourceResult: false,
      outcome: SourceFailure,
      phase: FlightDone,
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
    fallbackTimesOut,
    abandonedSourceSettles,
    dispatchPublication,
    resetFlight,
  }

  val flightsRequireEligibleCaching =
    s.flightScope == NoFlight or
      (s.scopeEnabled and s.coalesce and (s.requestLayerActive or s.sharedLayerActive))

  val oneSourcePerRegisteredFlight =
    s.sourceExecutions <= 1

  val fallbackDeadlineStartsWithFallback =
    not(s.fallbackDeadlineStarted) or
      s.phase == FallbackRunning or s.phase == Publication or s.phase == FlightDone

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
}

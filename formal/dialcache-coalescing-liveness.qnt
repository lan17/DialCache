module dialcache_coalescing_liveness {
  // Model one cache identity and one DialCache instance. Request-local and
  // process coalescing are represented as distinct flight scopes.

  type FlightScope = NoFlight | RequestFlight | ProcessFlight
  type FlightPhase = FlightIdle | CacheLookup | FallbackRunning | Publication | FlightDone
  type Outcome = NoOutcome | CacheHit | SourceSuccess | SourceFailure | SourceTimeout

  pure val MAX_TIME = 8
  pure val FALLBACK_TIMEOUT = 3

  var now: int
  var enabled: bool
  var requestLayerActive: bool
  var sharedLayerActive: bool
  var coalesce: bool

  var phase: FlightPhase
  var flightScope: FlightScope
  var outcome: Outcome
  var followers: int
  var sourceExecutions: int
  var independentExecutions: int

  var fallbackDeadline: int
  var fallbackDeadlineStarted: bool
  var activeSourceRunning: bool
  // Timed-out source work is no longer part of a registered flight. It may
  // settle later while a new flight is already running.
  var abandonedSources: int
  var acceptedSourceResult: bool
  var publicationDispatched: bool

  action init = all {
    now' = 0,
    enabled' = false,
    requestLayerActive' = false,
    sharedLayerActive' = false,
    coalesce' = true,

    phase' = FlightIdle,
    flightScope' = NoFlight,
    outcome' = NoOutcome,
    followers' = 0,
    sourceExecutions' = 0,
    independentExecutions' = 0,

    fallbackDeadline' = 0,
    fallbackDeadlineStarted' = false,
    activeSourceRunning' = false,
    abandonedSources' = 0,
    acceptedSourceResult' = false,
    publicationDispatched' = false,
  }

  action advanceTime = all {
    now < MAX_TIME,
    now' = now + 1,
  }

  action toggleEnabled = all {
    phase == FlightIdle,
    enabled' = not(enabled),
  }

  action toggleRequestLayer = all {
    phase == FlightIdle,
    requestLayerActive' = not(requestLayerActive),
  }

  action toggleSharedLayer = all {
    phase == FlightIdle,
    sharedLayerActive' = not(sharedLayerActive),
  }

  action toggleCoalesce = all {
    phase == FlightIdle,
    coalesce' = not(coalesce),
  }

  // The first eligible caller creates a flight. Request-local coalescing wins
  // before process coalescing because it wraps the request-local lookup.
  action startLeader = all {
    phase == FlightIdle,
    enabled,
    coalesce,
    requestLayerActive or sharedLayerActive,
    phase' = CacheLookup,
    flightScope' = if (requestLayerActive) RequestFlight else ProcessFlight,
    outcome' = NoOutcome,
    followers' = 0,
    sourceExecutions' = 0,
    fallbackDeadlineStarted' = false,
    acceptedSourceResult' = false,
    publicationDispatched' = false,
  }

  // A later caller with the same identity joins only an existing registered
  // flight. It inherits the leader's lookup, fallback, deadline, and outcome.
  action joinFollower = all {
    phase != FlightIdle,
    phase != FlightDone,
    flightScope != NoFlight,
    followers' = followers + 1,
  }

  // Outside enable(), with all serving layers inactive, or with coalescing
  // disabled, callers execute independently and create no registered flight.
  action startIndependentCaller = all {
    phase == FlightIdle,
    not(enabled and coalesce and (requestLayerActive or sharedLayerActive)),
    independentExecutions' = independentExecutions + 1,
  }

  action finishCacheHit = all {
    phase == CacheLookup,
    outcome' = CacheHit,
    phase' = FlightDone,
  }

  // The fallback deadline starts only when the source starts, after cache read
  // work has completed or failed open.
  action cacheMissStartsFallback = all {
    phase == CacheLookup,
    sourceExecutions' = sourceExecutions + 1,
    activeSourceRunning' = true,
    fallbackDeadlineStarted' = true,
    fallbackDeadline' = now + FALLBACK_TIMEOUT,
    phase' = FallbackRunning,
  }

  action sourceSucceedsBeforeDeadline = all {
    phase == FallbackRunning,
    now < fallbackDeadline,
    activeSourceRunning' = false,
    acceptedSourceResult' = true,
    outcome' = SourceSuccess,
    phase' = Publication,
  }

  action sourceRejects = all {
    phase == FallbackRunning,
    activeSourceRunning' = false,
    acceptedSourceResult' = false,
    outcome' = SourceFailure,
    phase' = FlightDone,
  }

  // Timeout clears the registered flight and abandons ownership of the source;
  // it does not cancel the underlying operation.
  action fallbackTimesOut = all {
    phase == FallbackRunning,
    fallbackDeadlineStarted,
    now >= fallbackDeadline,
    activeSourceRunning,
    activeSourceRunning' = false,
    abandonedSources' = abandonedSources + 1,
    acceptedSourceResult' = false,
    outcome' = SourceTimeout,
    phase' = FlightDone,
    flightScope' = NoFlight,
  }

  // An abandoned source may settle during any later flight. Its value is
  // ignored and has no path to acceptedSourceResult/publicationDispatched.
  action abandonedSourceSettles = all {
    abandonedSources > 0,
    abandonedSources' = abandonedSources - 1,
  }

  // Serializer/write work begins only after the source result has been accepted.
  // Its settlement is application-owned and is not constrained by the source
  // fallback deadline.
  action dispatchPublication = all {
    phase == Publication,
    acceptedSourceResult,
    publicationDispatched' = true,
    phase' = FlightDone,
  }

  action resetFlight = all {
    phase == FlightDone,
    phase' = FlightIdle,
    flightScope' = NoFlight,
    outcome' = NoOutcome,
    followers' = 0,
    sourceExecutions' = 0,
    fallbackDeadlineStarted' = false,
    acceptedSourceResult' = false,
    publicationDispatched' = false,
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
    flightScope == NoFlight or (enabled and coalesce and (requestLayerActive or sharedLayerActive))

  val oneSourcePerRegisteredFlight =
    sourceExecutions <= 1

  val fallbackDeadlineStartsWithFallback =
    not(fallbackDeadlineStarted) or
      phase == FallbackRunning or phase == Publication or phase == FlightDone

  val timedOutSourceCannotPublish =
    outcome != SourceTimeout or (not(acceptedSourceResult) and not(publicationDispatched))

  val publicationRequiresAcceptedSource =
    not(publicationDispatched) or acceptedSourceResult

  val noFlightWhenCoalescingIneligible =
    (enabled and coalesce and (requestLayerActive or sharedLayerActive)) or flightScope == NoFlight

  // A timeout can leave external work behind even though DialCache has no
  // registered leader. This encodes the non-cancellation contract directly.
  val abandonedSourceIsNotAFlight =
    abandonedSources == 0 or not(activeSourceRunning) or phase == FallbackRunning
}
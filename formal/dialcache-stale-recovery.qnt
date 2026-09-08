module dialcache_stale_recovery {
  // Model stale-on-error for one Redis frame and one caller/coalesced flight.
  // F and M are exclusive age ceilings. The retained candidate comes only from
  // the initial Redis read; there is deliberately no second-read transition.

  type InitialRead = ReadPending | FreshHit | RetainedCandidate | PlainMiss | ReadFailed
  type SourceState = SourceIdle | SourceRunning | SourceSucceeded | SourceRejected
  type RecoveryState = RecoveryIdle | ClassifierDenied | CandidateChecking | CandidateLoading | RecoveryServed | RecoveryMissed
  type FinalOutcome = PendingOutcome | ServedFresh | ServedSource | ServedStale | RejectedSource

  pure val FRESH_AGE = 2
  pure val MAX_RECOVERY_AGE = 5
  pure val MAX_TIME = 8

  var now: int
  var framePresent: bool
  var frameCreatedAt: int
  var frameValid: bool
  var frameFenced: bool
  var readHealthy: bool

  var initialRead: InitialRead
  var candidateRetained: bool
  var candidateCreatedAt: int
  var redisReads: int

  var sourceState: SourceState
  var classifierAllows: bool
  var recoveryState: RecoveryState
  var candidateDecoded: bool

  var redisWrites: int
  var processLocalWrites: int
  var requestLocalWrites: int
  var shadowJobs: int
  var finalOutcome: FinalOutcome

  action init = all {
    now' = 0,
    framePresent' = false,
    frameCreatedAt' = 0,
    frameValid' = true,
    frameFenced' = false,
    readHealthy' = true,

    initialRead' = ReadPending,
    candidateRetained' = false,
    candidateCreatedAt' = 0,
    redisReads' = 0,

    sourceState' = SourceIdle,
    classifierAllows' = false,
    recoveryState' = RecoveryIdle,
    candidateDecoded' = false,

    redisWrites' = 0,
    processLocalWrites' = 0,
    requestLocalWrites' = 0,
    shadowJobs' = 0,
    finalOutcome' = PendingOutcome,
  }

  action advanceTime = all {
    now < MAX_TIME,
    now' = now + 1,
  }

  action seedFrameNow = all {
    initialRead == ReadPending,
    redisReads == 0,
    framePresent' = true,
    frameCreatedAt' = now,
  }

  action makeFrameOlder = all {
    initialRead == ReadPending,
    redisReads == 0,
    framePresent,
    frameCreatedAt > 0,
    frameCreatedAt' = frameCreatedAt - 1,
  }

  action toggleFrameValidity = all {
    initialRead == ReadPending,
    redisReads == 0,
    frameValid' = not(frameValid),
  }

  action toggleFence = all {
    initialRead == ReadPending,
    redisReads == 0,
    frameFenced' = not(frameFenced),
  }

  action toggleReadHealth = all {
    initialRead == ReadPending,
    redisReads == 0,
    readHealthy' = not(readHealthy),
  }

  action toggleClassifier = all {
    sourceState != SourceSucceeded,
    recoveryState == RecoveryIdle,
    classifierAllows' = not(classifierAllows),
  }

  // One caller-serving Redis read classifies freshness before ordinary
  // deserialization. Invalid/future/fenced/absent frames cannot be candidates.
  action performInitialRead = all {
    initialRead == ReadPending,
    redisReads == 0,
    redisReads' = 1,
    initialRead' = if (not(readHealthy))
      ReadFailed
    else if (not(framePresent) or not(frameValid) or frameFenced or frameCreatedAt > now)
      PlainMiss
    else if (now - frameCreatedAt < FRESH_AGE)
      FreshHit
    else if (now - frameCreatedAt < MAX_RECOVERY_AGE)
      RetainedCandidate
    else
      PlainMiss,
    candidateRetained' = readHealthy and framePresent and frameValid and not(frameFenced) and
      frameCreatedAt <= now and now - frameCreatedAt >= FRESH_AGE and
      now - frameCreatedAt < MAX_RECOVERY_AGE,
    candidateCreatedAt' = if (readHealthy and framePresent and frameValid and not(frameFenced) and
      frameCreatedAt <= now and now - frameCreatedAt >= FRESH_AGE and
      now - frameCreatedAt < MAX_RECOVERY_AGE)
      frameCreatedAt
    else
      candidateCreatedAt,
    finalOutcome' = if (readHealthy and framePresent and frameValid and not(frameFenced) and
      frameCreatedAt <= now and now - frameCreatedAt < FRESH_AGE)
      ServedFresh
    else
      finalOutcome,
  }

  action startSource = all {
    initialRead != ReadPending,
    initialRead != FreshHit,
    sourceState == SourceIdle,
    sourceState' = SourceRunning,
  }

  // Source success follows ordinary refill/publication rules. The retained raw
  // candidate is intentionally not decoded on this path.
  action sourceSucceeds = all {
    sourceState == SourceRunning,
    sourceState' = SourceSucceeded,
    finalOutcome' = ServedSource,
    redisWrites' = if (initialRead == ReadFailed) 0 else 1,
  }

  action sourceRejects = all {
    sourceState == SourceRunning,
    sourceState' = SourceRejected,
    recoveryState' = if (classifierAllows) CandidateChecking else ClassifierDenied,
    finalOutcome' = if (classifierAllows) finalOutcome else RejectedSource,
  }

  // Authorization does not imply a candidate exists. Recovery preserves the
  // original source rejection whenever the candidate is missing or too old.
  action checkCandidate = all {
    recoveryState == CandidateChecking,
    recoveryState' = if (candidateRetained and candidateCreatedAt <= now and
      now - candidateCreatedAt < MAX_RECOVERY_AGE)
      CandidateLoading
    else
      RecoveryMissed,
    finalOutcome' = if (candidateRetained and candidateCreatedAt <= now and
      now - candidateCreatedAt < MAX_RECOVERY_AGE)
      finalOutcome
    else
      RejectedSource,
  }

  // Lazy deserialization/decompression can take arbitrary application-owned
  // time. DialCache rechecks age after asynchronous load before returning.
  action candidateLoadSucceeds = all {
    recoveryState == CandidateLoading,
    candidateDecoded' = true,
    recoveryState' = if (candidateCreatedAt <= now and now - candidateCreatedAt < MAX_RECOVERY_AGE)
      RecoveryServed
    else
      RecoveryMissed,
    finalOutcome' = if (candidateCreatedAt <= now and now - candidateCreatedAt < MAX_RECOVERY_AGE)
      ServedStale
    else
      RejectedSource,
    // Request-local memoization is the only permitted publication.
    requestLocalWrites' = if (candidateCreatedAt <= now and now - candidateCreatedAt < MAX_RECOVERY_AGE)
      requestLocalWrites + 1
    else
      requestLocalWrites,
  }

  action candidateLoadFails = all {
    recoveryState == CandidateLoading,
    recoveryState' = RecoveryMissed,
    finalOutcome' = RejectedSource,
  }

  // Later Redis invalidation/deletion/refresh cannot revoke retained bytes.
  action mutateRedisAfterRetention = all {
    candidateRetained,
    framePresent' = not(framePresent),
    frameFenced' = true,
  }

  action step = any {
    advanceTime,
    seedFrameNow,
    makeFrameOlder,
    toggleFrameValidity,
    toggleFence,
    toggleReadHealth,
    toggleClassifier,
    performInitialRead,
    startSource,
    sourceSucceeds,
    sourceRejects,
    checkCandidate,
    candidateLoadSucceeds,
    candidateLoadFails,
    mutateRedisAfterRetention,
  }

  val recoveryUsesSingleRedisRead =
    redisReads <= 1

  val retainedCandidateWasEligible =
    not(candidateRetained) or
      (frameValid and candidateCreatedAt <= now and initialRead == RetainedCandidate)

  val servedStaleIsStrictlyWithinMaxAge =
    finalOutcome != ServedStale or
      (candidateCreatedAt <= now and now - candidateCreatedAt < MAX_RECOVERY_AGE)

  val staleRequiresAuthorizedSourceFailure =
    finalOutcome != ServedStale or
      (sourceState == SourceRejected and classifierAllows)

  val sourceSuccessDoesNotDecodeCandidate =
    sourceState != SourceSucceeded or not(candidateDecoded)

  val recoveredStaleHasNoSharedPublication =
    finalOutcome != ServedStale or
      (redisWrites == 0 and processLocalWrites == 0 and shadowJobs == 0)

  val readFailureNeverRetains =
    initialRead != ReadFailed or not(candidateRetained)
}
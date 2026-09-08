module dialcache_stale_recovery {
  // Stale-on-error for one Redis frame and one caller/coalesced flight.
  // F is the fresh ceiling; M is the exclusive recovery ceiling. Recovery uses
  // retained bytes from the initial read and deliberately has no second read.

  type InitialRead = ReadPending | FreshHit | RetainedCandidate | PlainMiss | ReadFailed
  type SourceState = SourceIdle | SourceRunning | SourceSucceeded | SourceRejected
  type RecoveryState = RecoveryIdle | ClassifierDenied | CandidateChecking | CandidateLoading | RecoveryServed | RecoveryMissed
  type FinalOutcome = PendingOutcome | ServedFresh | ServedSource | ServedStale | RejectedSource

  pure val FRESH_AGE = 2
  pure val MAX_RECOVERY_AGE = 5
  pure val MAX_TIME = 8

  type State = {
    now: int,
    framePresent: bool,
    frameCreatedAt: int,
    frameValid: bool,
    frameFenced: bool,
    readHealthy: bool,
    initialRead: InitialRead,
    candidateRetained: bool,
    candidateCreatedAt: int,
    redisReads: int,
    sourceState: SourceState,
    classifierAllows: bool,
    recoveryState: RecoveryState,
    candidateDecoded: bool,
    redisWrites: int,
    processLocalWrites: int,
    requestLocalWrites: int,
    shadowJobs: int,
    finalOutcome: FinalOutcome
  }

  var s: State

  action init = s' = {
    now: 0,
    framePresent: false,
    frameCreatedAt: 0,
    frameValid: true,
    frameFenced: false,
    readHealthy: true,
    initialRead: ReadPending,
    candidateRetained: false,
    candidateCreatedAt: 0,
    redisReads: 0,
    sourceState: SourceIdle,
    classifierAllows: false,
    recoveryState: RecoveryIdle,
    candidateDecoded: false,
    redisWrites: 0,
    processLocalWrites: 0,
    requestLocalWrites: 0,
    shadowJobs: 0,
    finalOutcome: PendingOutcome
  }

  action advanceTime = all {
    s.now < MAX_TIME,
    s' = { now: s.now + 1, ...s },
  }

  action seedFrameNow = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = { framePresent: true, frameCreatedAt: s.now, ...s },
  }

  action makeFrameOlder = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s.framePresent,
    s.frameCreatedAt > 0,
    s' = { frameCreatedAt: s.frameCreatedAt - 1, ...s },
  }

  action toggleFrameValidity = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = { frameValid: not(s.frameValid), ...s },
  }

  action toggleFence = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = { frameFenced: not(s.frameFenced), ...s },
  }

  action toggleReadHealth = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = { readHealthy: not(s.readHealthy), ...s },
  }

  action toggleClassifier = all {
    s.sourceState != SourceSucceeded,
    s.recoveryState == RecoveryIdle,
    s' = { classifierAllows: not(s.classifierAllows), ...s },
  }

  // Freshness is classified before ordinary deserialization. Only a valid,
  // unfenced, non-future frame with F <= age < M is retained as a candidate.
  action performInitialRead = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = {
      redisReads: 1,
      initialRead: if (not(s.readHealthy))
        ReadFailed
      else if (not(s.framePresent) or not(s.frameValid) or s.frameFenced or s.frameCreatedAt > s.now)
        PlainMiss
      else if (s.now - s.frameCreatedAt < FRESH_AGE)
        FreshHit
      else if (s.now - s.frameCreatedAt < MAX_RECOVERY_AGE)
        RetainedCandidate
      else
        PlainMiss,
      candidateRetained: s.readHealthy and s.framePresent and s.frameValid and not(s.frameFenced) and
        s.frameCreatedAt <= s.now and s.now - s.frameCreatedAt >= FRESH_AGE and
        s.now - s.frameCreatedAt < MAX_RECOVERY_AGE,
      candidateCreatedAt: if (s.readHealthy and s.framePresent and s.frameValid and not(s.frameFenced) and
        s.frameCreatedAt <= s.now and s.now - s.frameCreatedAt >= FRESH_AGE and
        s.now - s.frameCreatedAt < MAX_RECOVERY_AGE)
        s.frameCreatedAt
      else
        s.candidateCreatedAt,
      finalOutcome: if (s.readHealthy and s.framePresent and s.frameValid and not(s.frameFenced) and
        s.frameCreatedAt <= s.now and s.now - s.frameCreatedAt < FRESH_AGE)
        ServedFresh
      else
        s.finalOutcome,
      ...s
    },
  }

  action startSource = all {
    s.initialRead != ReadPending,
    s.initialRead != FreshHit,
    s.sourceState == SourceIdle,
    s' = { sourceState: SourceRunning, ...s },
  }

  // A successful source path never needs to deserialize retained stale bytes.
  action sourceSucceeds = all {
    s.sourceState == SourceRunning,
    s' = {
      sourceState: SourceSucceeded,
      finalOutcome: ServedSource,
      redisWrites: if (s.initialRead == ReadFailed) 0 else 1,
      ...s
    },
  }

  action sourceRejects = all {
    s.sourceState == SourceRunning,
    s' = {
      sourceState: SourceRejected,
      recoveryState: if (s.classifierAllows) CandidateChecking else ClassifierDenied,
      finalOutcome: if (s.classifierAllows) s.finalOutcome else RejectedSource,
      ...s
    },
  }

  action checkCandidate = all {
    s.recoveryState == CandidateChecking,
    s' = {
      recoveryState: if (s.candidateRetained and s.candidateCreatedAt <= s.now and
        s.now - s.candidateCreatedAt < MAX_RECOVERY_AGE)
        CandidateLoading
      else
        RecoveryMissed,
      finalOutcome: if (s.candidateRetained and s.candidateCreatedAt <= s.now and
        s.now - s.candidateCreatedAt < MAX_RECOVERY_AGE)
        s.finalOutcome
      else
        RejectedSource,
      ...s
    },
  }

  // Loading/decompression may take application-owned time, so age is checked
  // again after it settles. Exact M is already too old.
  action candidateLoadSucceeds = all {
    s.recoveryState == CandidateLoading,
    s' = {
      candidateDecoded: true,
      recoveryState: if (s.candidateCreatedAt <= s.now and s.now - s.candidateCreatedAt < MAX_RECOVERY_AGE)
        RecoveryServed
      else
        RecoveryMissed,
      finalOutcome: if (s.candidateCreatedAt <= s.now and s.now - s.candidateCreatedAt < MAX_RECOVERY_AGE)
        ServedStale
      else
        RejectedSource,
      requestLocalWrites: if (s.candidateCreatedAt <= s.now and s.now - s.candidateCreatedAt < MAX_RECOVERY_AGE)
        s.requestLocalWrites + 1
      else
        s.requestLocalWrites,
      ...s
    },
  }

  action candidateLoadFails = all {
    s.recoveryState == CandidateLoading,
    s' = { recoveryState: RecoveryMissed, finalOutcome: RejectedSource, ...s },
  }

  // Retained bytes live in process memory. Later Redis deletion/invalidation
  // cannot revoke that original candidate and recovery still performs no re-read.
  action mutateRedisAfterRetention = all {
    s.candidateRetained,
    s' = { framePresent: not(s.framePresent), frameFenced: true, ...s },
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
    s.redisReads <= 1

  val retainedCandidateWasEligible =
    not(s.candidateRetained) or
      (s.frameValid and s.candidateCreatedAt <= s.now and s.initialRead == RetainedCandidate)

  val servedStaleIsStrictlyWithinMaxAge =
    s.finalOutcome != ServedStale or
      (s.candidateCreatedAt <= s.now and s.now - s.candidateCreatedAt < MAX_RECOVERY_AGE)

  val staleRequiresAuthorizedSourceFailure =
    s.finalOutcome != ServedStale or
      (s.sourceState == SourceRejected and s.classifierAllows)

  val sourceSuccessDoesNotDecodeCandidate =
    s.sourceState != SourceSucceeded or not(s.candidateDecoded)

  val recoveredStaleHasNoSharedPublication =
    s.finalOutcome != ServedStale or
      (s.redisWrites == 0 and s.processLocalWrites == 0 and s.shadowJobs == 0)

  val readFailureNeverRetains =
    s.initialRead != ReadFailed or not(s.candidateRetained)
}

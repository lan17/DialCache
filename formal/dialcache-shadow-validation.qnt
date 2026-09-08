module dialcache_shadow_validation {
  // Model one detached shadow job. C0 is the initial Redis observation, S is
  // the accepted source result, and C1 is the single confirmation read after a
  // disagreement. The caller result is fixed before shadow work can affect it.

  type CallerPath = NoCallerPath | ServedRemoteHit | RemoteRampedDown | OrdinaryRemoteMiss | EarlierLayerHit
  type C0State = C0Unknown | C0Miss | C0Present | C0Undecodable
  type JobPhase = JobIdle | JobAdmitted | WaitingForSource | Comparing | Confirming | Filling | JobDone
  type ShadowOutcome = NoShadowOutcome | Match | Mismatch | Superseded | Filled | FillFenced | DeserializationError | ComparisonError | ConfirmationError | Dropped

  var enabledScope: bool
  var remotePolicyValid: bool
  var shadowSelected: bool
  var metricsHookPresent: bool
  var capacityAvailable: bool
  var duplicateKeyActive: bool

  var callerPath: CallerPath
  var callerResultCommitted: bool
  var callerSourceAccepted: bool
  var detachedSourceExecutions: int

  var c0: C0State
  var c0EqualsSource: bool
  var c1Present: bool
  var c1SameBytesAsC0: bool
  var observedFencePresent: bool
  var fillTimestampClearsFence: bool

  var phase: JobPhase
  var outcome: ShadowOutcome
  var confirmationReads: int
  var fillWrites: int
  var repairWritesForPresentC0: int

  action init = all {
    enabledScope' = true,
    remotePolicyValid' = true,
    shadowSelected' = true,
    metricsHookPresent' = true,
    capacityAvailable' = true,
    duplicateKeyActive' = false,

    callerPath' = NoCallerPath,
    callerResultCommitted' = false,
    callerSourceAccepted' = false,
    detachedSourceExecutions' = 0,

    c0' = C0Unknown,
    c0EqualsSource' = false,
    c1Present' = false,
    c1SameBytesAsC0' = false,
    observedFencePresent' = false,
    fillTimestampClearsFence' = true,

    phase' = JobIdle,
    outcome' = NoShadowOutcome,
    confirmationReads' = 0,
    fillWrites' = 0,
    repairWritesForPresentC0' = 0,
  }

  // Eligibility gates can vary before a caller path is selected.
  action toggleEnabled = all {
    callerPath == NoCallerPath,
    enabledScope' = not(enabledScope),
  }

  action togglePolicy = all {
    callerPath == NoCallerPath,
    remotePolicyValid' = not(remotePolicyValid),
  }

  action toggleSelection = all {
    callerPath == NoCallerPath,
    shadowSelected' = not(shadowSelected),
  }

  action toggleMetricsHook = all {
    callerPath == NoCallerPath,
    metricsHookPresent' = not(metricsHookPresent),
  }

  action toggleCapacity = all {
    callerPath == NoCallerPath,
    capacityAvailable' = not(capacityAvailable),
  }

  action toggleDuplicate = all {
    callerPath == NoCallerPath,
    duplicateKeyActive' = not(duplicateKeyActive),
  }

  // A served Redis hit commits the caller-visible C0 result before detached
  // validation begins. Shadow cannot delay or replace it.
  action callerServedRemoteHit = all {
    callerPath == NoCallerPath,
    callerPath' = ServedRemoteHit,
    callerResultCommitted' = true,
    c0' = C0Present,
  }

  // With serving ramped down, the caller runs the source exactly once. Shadow
  // may reuse that accepted S; it must not start another source call.
  action callerRemoteRampedDown = all {
    callerPath == NoCallerPath,
    callerPath' = RemoteRampedDown,
    callerSourceAccepted' = true,
    callerResultCommitted' = true,
  }

  action callerOrdinaryRemoteMiss = all {
    callerPath == NoCallerPath,
    callerPath' = OrdinaryRemoteMiss,
    callerSourceAccepted' = true,
    callerResultCommitted' = true,
  }

  action callerEarlierLayerHit = all {
    callerPath == NoCallerPath,
    callerPath' = EarlierLayerHit,
    callerResultCommitted' = true,
  }

  // Eligibility is evaluated only after the ordinary caller path has reached
  // the remote boundary. Ordinary enabled remote misses deliberately do not
  // schedule a duplicate shadow fill.
  action admitJob = all {
    phase == JobIdle,
    callerPath == ServedRemoteHit or callerPath == RemoteRampedDown,
    enabledScope,
    remotePolicyValid,
    shadowSelected,
    metricsHookPresent,
    capacityAvailable,
    not(duplicateKeyActive),
    phase' = JobAdmitted,
  }

  action dropJob = all {
    phase == JobIdle,
    callerPath == ServedRemoteHit or callerPath == RemoteRampedDown,
    enabledScope,
    remotePolicyValid,
    shadowSelected,
    metricsHookPresent,
    not(capacityAvailable and not(duplicateKeyActive)),
    outcome' = Dropped,
    phase' = JobDone,
  }

  // Served-hit jobs launch one detached source read after caller completion.
  action servedHitStartsDetachedSource = all {
    phase == JobAdmitted,
    callerPath == ServedRemoteHit,
    callerResultCommitted,
    detachedSourceExecutions' = detachedSourceExecutions + 1,
    phase' = WaitingForSource,
  }

  // Ramped-down jobs use the caller's already-accepted source result and only
  // perform the independent C0 Redis observation.
  action rampedDownObserveMiss = all {
    phase == JobAdmitted,
    callerPath == RemoteRampedDown,
    callerSourceAccepted,
    c0' = C0Miss,
    phase' = Filling,
  }

  action rampedDownObservePresent = all {
    phase == JobAdmitted,
    callerPath == RemoteRampedDown,
    callerSourceAccepted,
    c0' = C0Present,
    phase' = Comparing,
  }

  action rampedDownObserveUndecodable = all {
    phase == JobAdmitted,
    callerPath == RemoteRampedDown,
    callerSourceAccepted,
    c0' = C0Undecodable,
    outcome' = DeserializationError,
    phase' = JobDone,
  }

  // Once the served-hit detached source settles, compare against an
  // independently deserialized copy of C0, never the caller's mutable object.
  action detachedSourceReady = all {
    phase == WaitingForSource,
    callerPath == ServedRemoteHit,
    c0 == C0Present,
    phase' = Comparing,
  }

  action compareEqual = all {
    phase == Comparing,
    c0 == C0Present,
    c0EqualsSource' = true,
    outcome' = Match,
    phase' = JobDone,
  }

  action compareDifferent = all {
    phase == Comparing,
    c0 == C0Present,
    c0EqualsSource' = false,
    phase' = Confirming,
    confirmationReads' = confirmationReads + 1,
  }

  action comparisonFails = all {
    phase == Comparing,
    outcome' = ComparisonError,
    phase' = JobDone,
  }

  // There is exactly one C1 confirmation after disagreement. C1 is compared by
  // serialized bytes and is never deserialized or chased to another version.
  action confirmationSeesChanged = all {
    phase == Confirming,
    c1Present' = true,
    c1SameBytesAsC0' = false,
    outcome' = Superseded,
    phase' = JobDone,
  }

  action confirmationSeesAbsent = all {
    phase == Confirming,
    c1Present' = false,
    outcome' = Superseded,
    phase' = JobDone,
  }

  action confirmationSeesSame = all {
    phase == Confirming,
    c1Present' = true,
    c1SameBytesAsC0' = true,
    outcome' = Mismatch,
    phase' = JobDone,
  }

  action confirmationFails = all {
    phase == Confirming,
    outcome' = ConfirmationError,
    phase' = JobDone,
  }

  action toggleObservedFence = all {
    phase == Filling,
    observedFencePresent' = not(observedFencePresent),
  }

  action toggleFillTimestamp = all {
    phase == Filling,
    fillTimestampClearsFence' = not(fillTimestampClearsFence),
  }

  // Only a semantic C0 miss can fill. A tracked observed fence may suppress the
  // dispatch before serialization or immediately before SET; both collapse to
  // FillFenced here because the observable protocol result is the same.
  action finishFill = all {
    phase == Filling,
    c0 == C0Miss,
    if (observedFencePresent and not(fillTimestampClearsFence))
      all {
        outcome' = FillFenced,
        phase' = JobDone,
      }
    else
      all {
        fillWrites' = fillWrites + 1,
        outcome' = Filled,
        phase' = JobDone,
      },
  }

  action step = any {
    toggleEnabled,
    togglePolicy,
    toggleSelection,
    toggleMetricsHook,
    toggleCapacity,
    toggleDuplicate,
    callerServedRemoteHit,
    callerRemoteRampedDown,
    callerOrdinaryRemoteMiss,
    callerEarlierLayerHit,
    admitJob,
    dropJob,
    servedHitStartsDetachedSource,
    rampedDownObserveMiss,
    rampedDownObservePresent,
    rampedDownObserveUndecodable,
    detachedSourceReady,
    compareEqual,
    compareDifferent,
    comparisonFails,
    confirmationSeesChanged,
    confirmationSeesAbsent,
    confirmationSeesSame,
    confirmationFails,
    toggleObservedFence,
    toggleFillTimestamp,
    finishFill,
  }

  // Shadow processing is detached: the ordinary caller result is already
  // committed before any admitted job performs source/compare/fill work.
  val shadowNeverPrecedesCallerResult =
    phase == JobIdle or callerResultCommitted

  // The ordinary enabled remote-miss path owns its own refill and never admits
  // a second shadow job for the same invocation.
  val ordinaryRemoteMissHasNoShadowJob =
    callerPath != OrdinaryRemoteMiss or phase == JobIdle

  // Ramped-down validation reuses the caller source; only served hits execute a
  // detached shadow-owned source call.
  val rampedDownDoesNotDuplicateSource =
    callerPath != RemoteRampedDown or detachedSourceExecutions == 0

  // A disagreement requires exactly one confirmation before mismatch or
  // superseded can be reported.
  val verdictsRequireSingleConfirmation =
    (outcome != Mismatch and outcome != Superseded) or confirmationReads == 1

  // A confirmed mismatch means the original C0 payload survived C1 unchanged.
  val mismatchMeansSameC1Bytes =
    outcome != Mismatch or (c1Present and c1SameBytesAsC0)

  // A present C0 is observation-only. Shadow never repairs a mismatch or an
  // undecodable present value.
  val presentC0IsNeverRepaired =
    repairWritesForPresentC0 == 0 and
      (c0 != C0Present and c0 != C0Undecodable or fillWrites == 0)

  // Fills are authorized only by a semantic C0 miss.
  val fillsRequireMiss =
    fillWrites == 0 or c0 == C0Miss

  // A fence rejection is a skipped write, not a failed/ambiguous dispatch.
  val fencedFillDoesNotWrite =
    outcome != FillFenced or fillWrites == 0
}
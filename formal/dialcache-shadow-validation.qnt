module dialcache_shadow_validation {
  // One detached C0/S/C1 shadow job. Caller-visible work is committed before
  // this state machine can compare, confirm, or fill.

  type CallerPath = NoCallerPath | ServedRemoteHit | RemoteRampedDown | OrdinaryRemoteMiss | EarlierLayerHit
  type C0State = C0Unknown | C0Miss | C0Present | C0Undecodable
  type JobPhase = JobIdle | JobAdmitted | WaitingForSource | Comparing | Confirming | Filling | JobDone
  type ShadowOutcome = NoShadowOutcome | Match | Mismatch | Superseded | Filled | FillFenced | DeserializationError | ComparisonError | ConfirmationError | Dropped

  type State = {
    enabledScope: bool,
    remotePolicyValid: bool,
    shadowSelected: bool,
    metricsHookPresent: bool,
    capacityAvailable: bool,
    duplicateKeyActive: bool,
    callerPath: CallerPath,
    callerResultCommitted: bool,
    callerSourceAccepted: bool,
    detachedSourceExecutions: int,
    c0: C0State,
    c0EqualsSource: bool,
    c1Present: bool,
    c1SameBytesAsC0: bool,
    observedFencePresent: bool,
    fillTimestampClearsFence: bool,
    phase: JobPhase,
    outcome: ShadowOutcome,
    confirmationReads: int,
    fillWrites: int,
    repairWritesForPresentC0: int
  }

  var s: State

  action init = s' = {
    enabledScope: true,
    remotePolicyValid: true,
    shadowSelected: true,
    metricsHookPresent: true,
    capacityAvailable: true,
    duplicateKeyActive: false,
    callerPath: NoCallerPath,
    callerResultCommitted: false,
    callerSourceAccepted: false,
    detachedSourceExecutions: 0,
    c0: C0Unknown,
    c0EqualsSource: false,
    c1Present: false,
    c1SameBytesAsC0: false,
    observedFencePresent: false,
    fillTimestampClearsFence: true,
    phase: JobIdle,
    outcome: NoShadowOutcome,
    confirmationReads: 0,
    fillWrites: 0,
    repairWritesForPresentC0: 0
  }

  action toggleEnabled = all {
    s.callerPath == NoCallerPath,
    s' = { enabledScope: not(s.enabledScope), ...s },
  }
  action togglePolicy = all {
    s.callerPath == NoCallerPath,
    s' = { remotePolicyValid: not(s.remotePolicyValid), ...s },
  }
  action toggleSelection = all {
    s.callerPath == NoCallerPath,
    s' = { shadowSelected: not(s.shadowSelected), ...s },
  }
  action toggleMetricsHook = all {
    s.callerPath == NoCallerPath,
    s' = { metricsHookPresent: not(s.metricsHookPresent), ...s },
  }
  action toggleCapacity = all {
    s.callerPath == NoCallerPath,
    s' = { capacityAvailable: not(s.capacityAvailable), ...s },
  }
  action toggleDuplicate = all {
    s.callerPath == NoCallerPath,
    s' = { duplicateKeyActive: not(s.duplicateKeyActive), ...s },
  }

  action callerServedRemoteHit = all {
    s.callerPath == NoCallerPath,
    s' = { callerPath: ServedRemoteHit, callerResultCommitted: true, c0: C0Present, ...s },
  }
  action callerRemoteRampedDown = all {
    s.callerPath == NoCallerPath,
    s' = { callerPath: RemoteRampedDown, callerSourceAccepted: true, callerResultCommitted: true, ...s },
  }
  action callerOrdinaryRemoteMiss = all {
    s.callerPath == NoCallerPath,
    s' = { callerPath: OrdinaryRemoteMiss, callerSourceAccepted: true, callerResultCommitted: true, ...s },
  }
  action callerEarlierLayerHit = all {
    s.callerPath == NoCallerPath,
    s' = { callerPath: EarlierLayerHit, callerResultCommitted: true, ...s },
  }

  action admitJob = all {
    s.phase == JobIdle,
    s.callerPath == ServedRemoteHit or s.callerPath == RemoteRampedDown,
    s.enabledScope,
    s.remotePolicyValid,
    s.shadowSelected,
    s.metricsHookPresent,
    s.capacityAvailable,
    not(s.duplicateKeyActive),
    s' = { phase: JobAdmitted, ...s },
  }

  action dropJob = all {
    s.phase == JobIdle,
    s.callerPath == ServedRemoteHit or s.callerPath == RemoteRampedDown,
    s.enabledScope,
    s.remotePolicyValid,
    s.shadowSelected,
    s.metricsHookPresent,
    not(s.capacityAvailable and not(s.duplicateKeyActive)),
    s' = { outcome: Dropped, phase: JobDone, ...s },
  }

  action servedHitStartsDetachedSource = all {
    s.phase == JobAdmitted,
    s.callerPath == ServedRemoteHit,
    s.callerResultCommitted,
    s' = { detachedSourceExecutions: s.detachedSourceExecutions + 1, phase: WaitingForSource, ...s },
  }

  // Ramped-down validation reuses the caller's accepted source result.
  action rampedDownObserveMiss = all {
    s.phase == JobAdmitted,
    s.callerPath == RemoteRampedDown,
    s.callerSourceAccepted,
    s' = { c0: C0Miss, phase: Filling, ...s },
  }
  action rampedDownObservePresent = all {
    s.phase == JobAdmitted,
    s.callerPath == RemoteRampedDown,
    s.callerSourceAccepted,
    s' = { c0: C0Present, phase: Comparing, ...s },
  }
  action rampedDownObserveUndecodable = all {
    s.phase == JobAdmitted,
    s.callerPath == RemoteRampedDown,
    s.callerSourceAccepted,
    s' = { c0: C0Undecodable, outcome: DeserializationError, phase: JobDone, ...s },
  }

  action detachedSourceReady = all {
    s.phase == WaitingForSource,
    s.callerPath == ServedRemoteHit,
    s.c0 == C0Present,
    s' = { phase: Comparing, ...s },
  }

  action compareEqual = all {
    s.phase == Comparing,
    s.c0 == C0Present,
    s' = { c0EqualsSource: true, outcome: Match, phase: JobDone, ...s },
  }
  action compareDifferent = all {
    s.phase == Comparing,
    s.c0 == C0Present,
    s' = { c0EqualsSource: false, phase: Confirming, confirmationReads: s.confirmationReads + 1, ...s },
  }
  action comparisonFails = all {
    s.phase == Comparing,
    s' = { outcome: ComparisonError, phase: JobDone, ...s },
  }

  // One C1 byte comparison distinguishes mismatch from a superseded C0.
  action confirmationSeesChanged = all {
    s.phase == Confirming,
    s' = { c1Present: true, c1SameBytesAsC0: false, outcome: Superseded, phase: JobDone, ...s },
  }
  action confirmationSeesAbsent = all {
    s.phase == Confirming,
    s' = { c1Present: false, outcome: Superseded, phase: JobDone, ...s },
  }
  action confirmationSeesSame = all {
    s.phase == Confirming,
    s' = { c1Present: true, c1SameBytesAsC0: true, outcome: Mismatch, phase: JobDone, ...s },
  }
  action confirmationFails = all {
    s.phase == Confirming,
    s' = { outcome: ConfirmationError, phase: JobDone, ...s },
  }

  action toggleObservedFence = all {
    s.phase == Filling,
    s' = { observedFencePresent: not(s.observedFencePresent), ...s },
  }
  action toggleFillTimestamp = all {
    s.phase == Filling,
    s' = { fillTimestampClearsFence: not(s.fillTimestampClearsFence), ...s },
  }

  // Present/undecodable C0 is diagnostic only; only a semantic miss may fill.
  action finishFill = all {
    s.phase == Filling,
    s.c0 == C0Miss,
    s' = {
      fillWrites: if (s.observedFencePresent and not(s.fillTimestampClearsFence))
        s.fillWrites else s.fillWrites + 1,
      outcome: if (s.observedFencePresent and not(s.fillTimestampClearsFence))
        FillFenced else Filled,
      phase: JobDone,
      ...s
    },
  }

  action step = any {
    toggleEnabled, togglePolicy, toggleSelection, toggleMetricsHook, toggleCapacity, toggleDuplicate,
    callerServedRemoteHit, callerRemoteRampedDown, callerOrdinaryRemoteMiss, callerEarlierLayerHit,
    admitJob, dropJob, servedHitStartsDetachedSource, rampedDownObserveMiss, rampedDownObservePresent,
    rampedDownObserveUndecodable, detachedSourceReady, compareEqual, compareDifferent, comparisonFails,
    confirmationSeesChanged, confirmationSeesAbsent, confirmationSeesSame, confirmationFails,
    toggleObservedFence, toggleFillTimestamp, finishFill,
  }

  val shadowNeverPrecedesCallerResult =
    s.phase == JobIdle or s.callerResultCommitted

  val ordinaryRemoteMissHasNoShadowJob =
    s.callerPath != OrdinaryRemoteMiss or s.phase == JobIdle

  val rampedDownDoesNotDuplicateSource =
    s.callerPath != RemoteRampedDown or s.detachedSourceExecutions == 0

  val verdictsRequireSingleConfirmation =
    (s.outcome != Mismatch and s.outcome != Superseded) or s.confirmationReads == 1

  val mismatchMeansSameC1Bytes =
    s.outcome != Mismatch or (s.c1Present and s.c1SameBytesAsC0)

  val presentC0IsNeverRepaired =
    s.repairWritesForPresentC0 == 0 and
      (s.c0 != C0Present and s.c0 != C0Undecodable or s.fillWrites == 0)

  val fillsRequireMiss =
    s.fillWrites == 0 or s.c0 == C0Miss

  val fencedFillDoesNotWrite =
    s.outcome != FillFenced or s.fillWrites == 0
}

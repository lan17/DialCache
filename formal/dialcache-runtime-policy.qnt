module dialcache_runtime_policy {
  // Policy merge/snapshot behavior independently from cache traversal.
  // -1 means omitted/inherit; 0 means explicit off; positive values are policy.

  pure val OMITTED = -1

  type State = {
    baselineLocalTtl: int,
    baselineLocalRamp: int,
    baselineRemoteTtl: int,
    baselineRemoteRamp: int,
    baselineRequestLocal: int,
    baselineCoalesce: int,
    baselineRecoveryAge: int,
    baselineShadowRamp: int,
    runtimeLocalTtl: int,
    runtimeLocalRamp: int,
    runtimeRemoteTtl: int,
    runtimeRemoteRamp: int,
    runtimeRequestLocal: int,
    runtimeCoalesce: int,
    runtimeRecoveryAge: int,
    runtimeShadowRamp: int,
    snapshotTaken: bool,
    snapLocalTtl: int,
    snapLocalRamp: int,
    snapRemoteTtl: int,
    snapRemoteRamp: int,
    snapRequestLocal: int,
    snapCoalesce: int,
    snapRecoveryAge: int,
    snapShadowRamp: int,
    localEntryPresent: bool,
    localEntryTtlAtInsert: int,
    remoteEntryPresent: bool,
    remotePhysicalTtlAtInsert: int
  }

  var s: State

  pure def inherit(runtimeValue: int, baselineValue: int, libraryDefault: int): int =
    if (runtimeValue != OMITTED) runtimeValue
    else if (baselineValue != OMITTED) baselineValue
    else libraryDefault

  pure def effectiveRamp(runtimeRamp: int, baselineRamp: int, effectiveTtl: int): int =
    if (runtimeRamp != OMITTED) runtimeRamp
    else if (baselineRamp != OMITTED) baselineRamp
    else if (effectiveTtl > 0) 100
    else 0

  action init = s' = {
    baselineLocalTtl: OMITTED,
    baselineLocalRamp: OMITTED,
    baselineRemoteTtl: OMITTED,
    baselineRemoteRamp: OMITTED,
    baselineRequestLocal: OMITTED,
    baselineCoalesce: OMITTED,
    baselineRecoveryAge: OMITTED,
    baselineShadowRamp: OMITTED,
    runtimeLocalTtl: OMITTED,
    runtimeLocalRamp: OMITTED,
    runtimeRemoteTtl: OMITTED,
    runtimeRemoteRamp: OMITTED,
    runtimeRequestLocal: OMITTED,
    runtimeCoalesce: OMITTED,
    runtimeRecoveryAge: OMITTED,
    runtimeShadowRamp: OMITTED,
    snapshotTaken: false,
    snapLocalTtl: 0,
    snapLocalRamp: 0,
    snapRemoteTtl: 0,
    snapRemoteRamp: 0,
    snapRequestLocal: 0,
    snapCoalesce: 1,
    snapRecoveryAge: 0,
    snapShadowRamp: 0,
    localEntryPresent: false,
    localEntryTtlAtInsert: 0,
    remoteEntryPresent: false,
    remotePhysicalTtlAtInsert: 0
  }

  action setBaselineLocal = all {
    not(s.snapshotTaken),
    s' = {
      baselineLocalTtl: if (s.baselineLocalTtl == OMITTED) 6 else OMITTED,
      baselineLocalRamp: if (s.baselineLocalRamp == OMITTED) 100 else OMITTED,
      ...s
    },
  }

  action setBaselineRemote = all {
    not(s.snapshotTaken),
    s' = {
      baselineRemoteTtl: if (s.baselineRemoteTtl == OMITTED) 8 else OMITTED,
      baselineRemoteRamp: if (s.baselineRemoteRamp == OMITTED) 100 else OMITTED,
      ...s
    },
  }

  action setBaselineFeatures = all {
    not(s.snapshotTaken),
    s' = {
      baselineRequestLocal: if (s.baselineRequestLocal == OMITTED) 1 else OMITTED,
      baselineCoalesce: if (s.baselineCoalesce == OMITTED) 0 else OMITTED,
      baselineRecoveryAge: if (s.baselineRecoveryAge == OMITTED) 12 else OMITTED,
      baselineShadowRamp: if (s.baselineShadowRamp == OMITTED) 25 else OMITTED,
      ...s
    },
  }

  action setRuntimeSparseLocalRamp = all {
    not(s.snapshotTaken),
    s' = { runtimeLocalRamp: if (s.runtimeLocalRamp == OMITTED) 0 else OMITTED, ...s },
  }

  action setRuntimeSparseRemoteTtl = all {
    not(s.snapshotTaken),
    s' = { runtimeRemoteTtl: if (s.runtimeRemoteTtl == OMITTED) 4 else OMITTED, ...s },
  }

  action setRuntimeFeatureOverrides = all {
    not(s.snapshotTaken),
    s' = {
      runtimeRequestLocal: if (s.runtimeRequestLocal == OMITTED) 0 else OMITTED,
      runtimeCoalesce: if (s.runtimeCoalesce == OMITTED) 1 else OMITTED,
      runtimeRecoveryAge: if (s.runtimeRecoveryAge == OMITTED) 0 else OMITTED,
      runtimeShadowRamp: if (s.runtimeShadowRamp == OMITTED) 0 else OMITTED,
      ...s
    },
  }

  action takeSnapshot = all {
    not(s.snapshotTaken),
    s' = {
      snapshotTaken: true,
      snapLocalTtl: inherit(s.runtimeLocalTtl, s.baselineLocalTtl, 0),
      snapLocalRamp: effectiveRamp(s.runtimeLocalRamp, s.baselineLocalRamp, inherit(s.runtimeLocalTtl, s.baselineLocalTtl, 0)),
      snapRemoteTtl: inherit(s.runtimeRemoteTtl, s.baselineRemoteTtl, 0),
      snapRemoteRamp: effectiveRamp(s.runtimeRemoteRamp, s.baselineRemoteRamp, inherit(s.runtimeRemoteTtl, s.baselineRemoteTtl, 0)),
      snapRequestLocal: inherit(s.runtimeRequestLocal, s.baselineRequestLocal, 0),
      snapCoalesce: inherit(s.runtimeCoalesce, s.baselineCoalesce, 1),
      snapRecoveryAge: inherit(s.runtimeRecoveryAge, s.baselineRecoveryAge, 0),
      snapShadowRamp: inherit(s.runtimeShadowRamp, s.baselineShadowRamp, 0),
      ...s
    },
  }

  action endInvocation = all {
    s.snapshotTaken,
    s' = { snapshotTaken: false, ...s },
  }

  action insertLocalEntry = all {
    s.snapshotTaken,
    s.snapLocalTtl > 0,
    s.snapLocalRamp > 0,
    s' = { localEntryPresent: true, localEntryTtlAtInsert: s.snapLocalTtl, ...s },
  }

  action insertRemoteEntry = all {
    s.snapshotTaken,
    s.snapRemoteTtl > 0,
    s.snapRemoteRamp > 0,
    s' = {
      remoteEntryPresent: true,
      remotePhysicalTtlAtInsert: if (s.snapRecoveryAge > s.snapRemoteTtl) s.snapRecoveryAge else s.snapRemoteTtl,
      ...s
    },
  }

  action step = any {
    setBaselineLocal,
    setBaselineRemote,
    setBaselineFeatures,
    setRuntimeSparseLocalRamp,
    setRuntimeSparseRemoteTtl,
    setRuntimeFeatureOverrides,
    takeSnapshot,
    endInvocation,
    insertLocalEntry,
    insertRemoteEntry,
  }

  val runtimeOverlayIsLeafWise = and {
    not(s.snapshotTaken) or s.runtimeLocalRamp == OMITTED or s.snapLocalRamp == s.runtimeLocalRamp,
    not(s.snapshotTaken) or s.runtimeRemoteTtl == OMITTED or s.snapRemoteTtl == s.runtimeRemoteTtl,
    not(s.snapshotTaken) or s.runtimeRequestLocal == OMITTED or s.snapRequestLocal == s.runtimeRequestLocal,
    not(s.snapshotTaken) or s.runtimeCoalesce == OMITTED or s.snapCoalesce == s.runtimeCoalesce,
  }

  val configuredTtlImpliesDefaultFullRamp = and {
    not(s.snapshotTaken) or s.snapLocalTtl <= 0 or s.runtimeLocalRamp != OMITTED or s.baselineLocalRamp != OMITTED or s.snapLocalRamp == 100,
    not(s.snapshotTaken) or s.snapRemoteTtl <= 0 or s.runtimeRemoteRamp != OMITTED or s.baselineRemoteRamp != OMITTED or s.snapRemoteRamp == 100,
  }

  val featureLibraryDefaults =
    not(s.snapshotTaken) or
    ((s.runtimeRequestLocal != OMITTED or s.baselineRequestLocal != OMITTED or s.snapRequestLocal == 0) and
     (s.runtimeRecoveryAge != OMITTED or s.baselineRecoveryAge != OMITTED or s.snapRecoveryAge == 0) and
     (s.runtimeShadowRamp != OMITTED or s.baselineShadowRamp != OMITTED or s.snapShadowRamp == 0) and
     (s.runtimeCoalesce != OMITTED or s.baselineCoalesce != OMITTED or s.snapCoalesce == 1))

  val existingLocalEntryKeepsInsertionTtl =
    not(s.localEntryPresent) or s.localEntryTtlAtInsert > 0

  val existingRemoteEntryKeepsPhysicalTtl =
    not(s.remoteEntryPresent) or s.remotePhysicalTtlAtInsert > 0
}

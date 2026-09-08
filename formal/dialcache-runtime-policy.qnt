module dialcache_runtime_policy {
  // Model policy merge/snapshot behavior independently from cache traversal.
  // Values use small integers: -1 means omitted/inherit; 0 means explicit off;
  // positive values are configured policy values.

  pure val OMITTED = -1

  var baselineLocalTtl: int
  var baselineLocalRamp: int
  var baselineRemoteTtl: int
  var baselineRemoteRamp: int
  var baselineRequestLocal: int
  var baselineCoalesce: int
  var baselineRecoveryAge: int
  var baselineShadowRamp: int

  var runtimeLocalTtl: int
  var runtimeLocalRamp: int
  var runtimeRemoteTtl: int
  var runtimeRemoteRamp: int
  var runtimeRequestLocal: int
  var runtimeCoalesce: int
  var runtimeRecoveryAge: int
  var runtimeShadowRamp: int

  var snapshotTaken: bool
  var snapLocalTtl: int
  var snapLocalRamp: int
  var snapRemoteTtl: int
  var snapRemoteRamp: int
  var snapRequestLocal: int
  var snapCoalesce: int
  var snapRecoveryAge: int
  var snapShadowRamp: int

  // Existing-entry metadata proves later policy changes do not rewrite state.
  var localEntryPresent: bool
  var localEntryTtlAtInsert: int
  var remoteEntryPresent: bool
  var remotePhysicalTtlAtInsert: int

  pure def inherit(runtimeValue: int, baselineValue: int, libraryDefault: int): int =
    if (runtimeValue != OMITTED) runtimeValue
    else if (baselineValue != OMITTED) baselineValue
    else libraryDefault

  pure def effectiveRamp(runtimeRamp: int, baselineRamp: int, effectiveTtl: int): int =
    if (runtimeRamp != OMITTED) runtimeRamp
    else if (baselineRamp != OMITTED) baselineRamp
    else if (effectiveTtl > 0) 100
    else 0

  action init = all {
    baselineLocalTtl' = OMITTED,
    baselineLocalRamp' = OMITTED,
    baselineRemoteTtl' = OMITTED,
    baselineRemoteRamp' = OMITTED,
    baselineRequestLocal' = OMITTED,
    baselineCoalesce' = OMITTED,
    baselineRecoveryAge' = OMITTED,
    baselineShadowRamp' = OMITTED,

    runtimeLocalTtl' = OMITTED,
    runtimeLocalRamp' = OMITTED,
    runtimeRemoteTtl' = OMITTED,
    runtimeRemoteRamp' = OMITTED,
    runtimeRequestLocal' = OMITTED,
    runtimeCoalesce' = OMITTED,
    runtimeRecoveryAge' = OMITTED,
    runtimeShadowRamp' = OMITTED,

    snapshotTaken' = false,
    snapLocalTtl' = 0,
    snapLocalRamp' = 0,
    snapRemoteTtl' = 0,
    snapRemoteRamp' = 0,
    snapRequestLocal' = 0,
    snapCoalesce' = 1,
    snapRecoveryAge' = 0,
    snapShadowRamp' = 0,

    localEntryPresent' = false,
    localEntryTtlAtInsert' = 0,
    remoteEntryPresent' = false,
    remotePhysicalTtlAtInsert' = 0,
  }

  // Provider/default inputs vary between invocations. Once takeSnapshot runs,
  // that invocation uses only snap* fields until endInvocation.
  action setBaselineLocal = all {
    not(snapshotTaken),
    baselineLocalTtl' = if (baselineLocalTtl == OMITTED) 6 else OMITTED,
    baselineLocalRamp' = if (baselineLocalRamp == OMITTED) 100 else OMITTED,
  }

  action setBaselineRemote = all {
    not(snapshotTaken),
    baselineRemoteTtl' = if (baselineRemoteTtl == OMITTED) 8 else OMITTED,
    baselineRemoteRamp' = if (baselineRemoteRamp == OMITTED) 100 else OMITTED,
  }

  action setBaselineFeatures = all {
    not(snapshotTaken),
    baselineRequestLocal' = if (baselineRequestLocal == OMITTED) 1 else OMITTED,
    baselineCoalesce' = if (baselineCoalesce == OMITTED) 0 else OMITTED,
    baselineRecoveryAge' = if (baselineRecoveryAge == OMITTED) 12 else OMITTED,
    baselineShadowRamp' = if (baselineShadowRamp == OMITTED) 25 else OMITTED,
  }

  action setRuntimeSparseLocalRamp = all {
    not(snapshotTaken),
    runtimeLocalRamp' = if (runtimeLocalRamp == OMITTED) 0 else OMITTED,
  }

  action setRuntimeSparseRemoteTtl = all {
    not(snapshotTaken),
    runtimeRemoteTtl' = if (runtimeRemoteTtl == OMITTED) 4 else OMITTED,
  }

  action setRuntimeFeatureOverrides = all {
    not(snapshotTaken),
    runtimeRequestLocal' = if (runtimeRequestLocal == OMITTED) 0 else OMITTED,
    runtimeCoalesce' = if (runtimeCoalesce == OMITTED) 1 else OMITTED,
    runtimeRecoveryAge' = if (runtimeRecoveryAge == OMITTED) 0 else OMITTED,
    runtimeShadowRamp' = if (runtimeShadowRamp == OMITTED) 0 else OMITTED,
  }

  // One invocation resolves and freezes one effective policy snapshot.
  action takeSnapshot = all {
    not(snapshotTaken),
    snapshotTaken' = true,

    snapLocalTtl' = inherit(runtimeLocalTtl, baselineLocalTtl, 0),
    snapLocalRamp' = effectiveRamp(
      runtimeLocalRamp,
      baselineLocalRamp,
      inherit(runtimeLocalTtl, baselineLocalTtl, 0)
    ),
    snapRemoteTtl' = inherit(runtimeRemoteTtl, baselineRemoteTtl, 0),
    snapRemoteRamp' = effectiveRamp(
      runtimeRemoteRamp,
      baselineRemoteRamp,
      inherit(runtimeRemoteTtl, baselineRemoteTtl, 0)
    ),
    snapRequestLocal' = inherit(runtimeRequestLocal, baselineRequestLocal, 0),
    // Coalescing is the notable true-by-default feature.
    snapCoalesce' = inherit(runtimeCoalesce, baselineCoalesce, 1),
    snapRecoveryAge' = inherit(runtimeRecoveryAge, baselineRecoveryAge, 0),
    snapShadowRamp' = inherit(runtimeShadowRamp, baselineShadowRamp, 0),
  }

  action endInvocation = all {
    snapshotTaken,
    snapshotTaken' = false,
  }

  action insertLocalEntry = all {
    snapshotTaken,
    snapLocalTtl > 0,
    snapLocalRamp > 0,
    localEntryPresent' = true,
    localEntryTtlAtInsert' = snapLocalTtl,
  }

  action insertRemoteEntry = all {
    snapshotTaken,
    snapRemoteTtl > 0,
    snapRemoteRamp > 0,
    remoteEntryPresent' = true,
    remotePhysicalTtlAtInsert' = if (snapRecoveryAge > snapRemoteTtl)
      snapRecoveryAge
    else
      snapRemoteTtl,
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

  // Explicit runtime leaves override, while omitted leaves inherit baseline.
  val runtimeOverlayIsLeafWise = and {
    not(snapshotTaken) or runtimeLocalRamp == OMITTED or snapLocalRamp == runtimeLocalRamp,
    not(snapshotTaken) or runtimeRemoteTtl == OMITTED or snapRemoteTtl == runtimeRemoteTtl,
    not(snapshotTaken) or runtimeRequestLocal == OMITTED or snapRequestLocal == runtimeRequestLocal,
    not(snapshotTaken) or runtimeCoalesce == OMITTED or snapCoalesce == runtimeCoalesce,
  }

  // If a shared-layer TTL exists and no ramp leaf is supplied anywhere, the
  // effective ramp defaults to 100 rather than disabling the layer.
  val configuredTtlImpliesDefaultFullRamp = and {
    not(snapshotTaken) or snapLocalTtl <= 0 or runtimeLocalRamp != OMITTED or baselineLocalRamp != OMITTED or snapLocalRamp == 100,
    not(snapshotTaken) or snapRemoteTtl <= 0 or runtimeRemoteRamp != OMITTED or baselineRemoteRamp != OMITTED or snapRemoteRamp == 100,
  }

  // Library defaults: request-local/recovery/shadow off, coalescing on.
  val featureLibraryDefaults =
    not(snapshotTaken) or
    ((runtimeRequestLocal != OMITTED or baselineRequestLocal != OMITTED or snapRequestLocal == 0) and
     (runtimeRecoveryAge != OMITTED or baselineRecoveryAge != OMITTED or snapRecoveryAge == 0) and
     (runtimeShadowRamp != OMITTED or baselineShadowRamp != OMITTED or snapShadowRamp == 0) and
     (runtimeCoalesce != OMITTED or baselineCoalesce != OMITTED or snapCoalesce == 1))

  // Existing entry retention is insertion policy, not current provider state.
  val existingLocalEntryKeepsInsertionTtl =
    not(localEntryPresent) or localEntryTtlAtInsert > 0

  val existingRemoteEntryKeepsPhysicalTtl =
    not(remoteEntryPresent) or remotePhysicalTtlAtInsert > 0
}
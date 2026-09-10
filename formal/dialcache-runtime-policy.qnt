module dialcache_runtime_policy {
  // Selected rules from C09, C16-C18 and C22: valid overlays and insertion policy.
  // Runtime/baseline records are environment inputs; captured* and snapshot
  // belong to an invocation. Entry timestamps are abstracted to insertion TTLs.
  // Malformed policy values and asynchronous provider failures are covered by
  // portable scenarios and other profiles, not by this valid-policy model.

  // Types and sampled policy values
  // -1 is omitted/inherit, 0 is explicit off. Captured input records are
  // history variables: policy changes may race with an active invocation,
  // but its resolved snapshot and already inserted entries must stay stable.
  // requestLocal/coalesce use 1 for on; ramps are percentages, and TTL/age
  // examples are abstract positive durations.
  pure val OMITTED = -1
  type Policy = {
    localTtl: int,
    localRamp: int,
    remoteTtl: int,
    remoteRamp: int,
    requestLocal: int,
    coalesce: int,
    recoveryAge: int,
    shadowRamp: int
  }
  pure val omitted: Policy = {
    localTtl: OMITTED,
    localRamp: OMITTED,
    remoteTtl: OMITTED,
    remoteRamp: OMITTED,
    requestLocal: OMITTED,
    coalesce: OMITTED,
    recoveryAge: OMITTED,
    shadowRamp: OMITTED
  }

  // State
  type State = {
    baseline: Policy,
    runtime: Policy,
    capturedBaseline: Policy,
    capturedRuntime: Policy,
    snapshot: Policy,
    snapshotTaken: bool,
    localEntryPresent: bool,
    localEntryTtlAtInsert: int,
    localInsertionTtl: int,
    remoteEntryPresent: bool,
    remotePhysicalTtlAtInsert: int,
    remoteInsertionTtl: int,
    remoteInsertionRecoveryAge: int
  }
  var s: State

  // Resolution: inherit each leaf independently, then derive omitted ramps.
  pure def inherit(runtimeValue: int, baselineValue: int, libraryDefault: int): int =
    if (runtimeValue != OMITTED) runtimeValue
    else if (baselineValue != OMITTED) baselineValue
    else libraryDefault

  pure def effectiveRamp(runtimeRamp: int, baselineRamp: int, effectiveTtl: int): int =
    inherit(runtimeRamp, baselineRamp, if (effectiveTtl > 0) 100 else 0)

  pure def resolve(runtime: Policy, baseline: Policy): Policy = {
    val localTtl = inherit(runtime.localTtl, baseline.localTtl, 0)
    val remoteTtl = inherit(runtime.remoteTtl, baseline.remoteTtl, 0)
    {
      localTtl: localTtl,
      localRamp: effectiveRamp(runtime.localRamp, baseline.localRamp, localTtl),
      remoteTtl: remoteTtl,
      remoteRamp: effectiveRamp(runtime.remoteRamp, baseline.remoteRamp, remoteTtl),
      requestLocal: inherit(runtime.requestLocal, baseline.requestLocal, 0),
      coalesce: inherit(runtime.coalesce, baseline.coalesce, 1),
      recoveryAge: inherit(runtime.recoveryAge, baseline.recoveryAge, 0),
      shadowRamp: inherit(runtime.shadowRamp, baseline.shadowRamp, 0)
    }
  }

  // Initial state
  action init = s' = {
    baseline: omitted,
    runtime: omitted,
    capturedBaseline: omitted,
    capturedRuntime: omitted,
    snapshot: resolve(omitted, omitted),
    snapshotTaken: false,
    localEntryPresent: false,
    localEntryTtlAtInsert: 0,
    localInsertionTtl: 0,
    remoteEntryPresent: false,
    remotePhysicalTtlAtInsert: 0,
    remoteInsertionTtl: 0,
    remoteInsertionRecoveryAge: 0
  }

  // Environment transitions
  action setBaselineLocal = all {
    not(s.snapshotTaken),
    s' = { baseline: { localTtl: 6, ...s.baseline }, ...s },
  }

  action setBaselineRemote = all {
    not(s.snapshotTaken),
    s' = { baseline: { remoteTtl: 8, ...s.baseline }, ...s },
  }

  action setBaselineFeatures = all {
    not(s.snapshotTaken),
    s' = { baseline: { requestLocal: 1, coalesce: 0, recoveryAge: 12, shadowRamp: 25, ...s.baseline }, ...s },
  }

  // Every runtime leaf can change while an invocation is pending.
  action setRuntimeLocalTtl = {
    nondet ttl = Set(OMITTED, 0, 4).oneOf()
    s' = { runtime: { localTtl: ttl, ...s.runtime }, ...s }
  }

  action setRuntimeSparseLocalRamp = {
    nondet ramp = Set(OMITTED, 0, 50, 100).oneOf()
    s' = { runtime: { localRamp: ramp, ...s.runtime }, ...s }
  }

  action setRuntimeSparseRemoteTtl = {
    nondet ttl = Set(OMITTED, 0, 4).oneOf()
    s' = { runtime: { remoteTtl: ttl, ...s.runtime }, ...s }
  }

  action setRuntimeRemoteRamp = {
    nondet ramp = Set(OMITTED, 0, 50, 100).oneOf()
    s' = { runtime: { remoteRamp: ramp, ...s.runtime }, ...s }
  }

  action setRuntimeRequestLocal = {
    nondet flag = Set(OMITTED, 0, 1).oneOf()
    s' = { runtime: { requestLocal: flag, ...s.runtime }, ...s }
  }

  action setRuntimeCoalesce = {
    nondet flag = Set(OMITTED, 0, 1).oneOf()
    s' = { runtime: { coalesce: flag, ...s.runtime }, ...s }
  }

  action setRuntimeRecoveryAge = {
    nondet age = Set(OMITTED, 0, 12).oneOf()
    s' = { runtime: { recoveryAge: age, ...s.runtime }, ...s }
  }

  action setRuntimeShadowRamp = {
    nondet ramp = Set(OMITTED, 0, 25, 100).oneOf()
    s' = { runtime: { shadowRamp: ramp, ...s.runtime }, ...s }
  }

  // Invocation capture and insertion
  action takeSnapshot = all {
    not(s.snapshotTaken),
    s' = {
      snapshotTaken: true,
      capturedBaseline: s.baseline,
      capturedRuntime: s.runtime,
      snapshot: resolve(s.runtime, s.baseline),
      ...s
    },
  }

  action endInvocation = all {
    s.snapshotTaken,
    s' = { snapshotTaken: false, ...s },
  }

  action insertLocalEntry = all {
    s.snapshotTaken,
    s.snapshot.localTtl > 0,
    s.snapshot.localRamp > 0,
    s' = {
      localEntryPresent: true,
      localEntryTtlAtInsert: s.snapshot.localTtl,
      localInsertionTtl: s.snapshot.localTtl,
      ...s
    },
  }

  action insertRemoteEntry = all {
    s.snapshotTaken,
    s.snapshot.remoteTtl > 0,
    s.snapshot.remoteRamp > 0,
    s' = {
      remoteEntryPresent: true,
      remotePhysicalTtlAtInsert:
        if (s.snapshot.recoveryAge > s.snapshot.remoteTtl) s.snapshot.recoveryAge
        else s.snapshot.remoteTtl,
      remoteInsertionTtl: s.snapshot.remoteTtl,
      remoteInsertionRecoveryAge: s.snapshot.recoveryAge,
      ...s
    },
  }

  // Exploration order
  action step = any {
    setBaselineLocal,
    setBaselineRemote,
    setBaselineFeatures,
    setRuntimeLocalTtl,
    setRuntimeSparseLocalRamp,
    setRuntimeSparseRemoteTtl,
    setRuntimeRemoteRamp,
    setRuntimeRequestLocal,
    setRuntimeCoalesce,
    setRuntimeRecoveryAge,
    setRuntimeShadowRamp,
    takeSnapshot,
    endInvocation,
    insertLocalEntry,
    insertRemoteEntry,
  }

  // Invariants
  val runtimeOverlayIsLeafWise =
    not(s.snapshotTaken) or s.snapshot == resolve(s.capturedRuntime, s.capturedBaseline)
  val configuredTtlImpliesDefaultFullRamp = and {
    not(s.snapshotTaken) or s.snapshot.localTtl <= 0 or
      s.capturedRuntime.localRamp != OMITTED or s.capturedBaseline.localRamp != OMITTED or
      s.snapshot.localRamp == 100,
    not(s.snapshotTaken) or s.snapshot.remoteTtl <= 0 or
      s.capturedRuntime.remoteRamp != OMITTED or s.capturedBaseline.remoteRamp != OMITTED or
      s.snapshot.remoteRamp == 100,
  }

  val featureLibraryDefaults =
    not(s.snapshotTaken) or
    ((s.capturedRuntime.requestLocal != OMITTED or s.capturedBaseline.requestLocal != OMITTED or s.snapshot.requestLocal == 0) and
     (s.capturedRuntime.recoveryAge != OMITTED or s.capturedBaseline.recoveryAge != OMITTED or s.snapshot.recoveryAge == 0) and
     (s.capturedRuntime.shadowRamp != OMITTED or s.capturedBaseline.shadowRamp != OMITTED or s.snapshot.shadowRamp == 0) and
     (s.capturedRuntime.coalesce != OMITTED or s.capturedBaseline.coalesce != OMITTED or s.snapshot.coalesce == 1))
  val existingLocalEntryKeepsInsertionTtl =
    not(s.localEntryPresent) or (s.localEntryTtlAtInsert == s.localInsertionTtl and s.localInsertionTtl > 0)
  val existingRemoteEntryKeepsPhysicalTtl =
    not(s.remoteEntryPresent) or s.remotePhysicalTtlAtInsert ==
      (if (s.remoteInsertionRecoveryAge > s.remoteInsertionTtl) s.remoteInsertionRecoveryAge else s.remoteInsertionTtl)

  // Deterministic regressions
  run policyChangeDuringInvocationTest = init.then(setBaselineLocal).then(takeSnapshot)
    .then(all { s' = { runtime: { localTtl: 4, ...s.runtime }, ...s } })
    .then(insertLocalEntry)
    .expect(s.snapshot.localTtl == 6 and s.localEntryTtlAtInsert == 6 and runtimeOverlayIsLeafWise)
    .then(endInvocation).then(takeSnapshot)
    .expect(s.snapshot.localTtl == 4 and s.localEntryTtlAtInsert == 6 and existingLocalEntryKeepsInsertionTtl)

  run localTtlMutationIsDetectedTest = init.then(setBaselineLocal).then(takeSnapshot).then(insertLocalEntry)
    .then(all { s' = { localEntryTtlAtInsert: 1, ...s } })
    .expect(not(existingLocalEntryKeepsInsertionTtl))

  run physicalTtlMutationIsDetectedTest = init.then(setBaselineRemote).then(setBaselineFeatures)
    .then(takeSnapshot).then(insertRemoteEntry)
    .expect(s.remotePhysicalTtlAtInsert == 12)
    .then(all { s' = { remotePhysicalTtlAtInsert: 8, ...s } })
    .expect(not(existingRemoteEntryKeepsPhysicalTtl))
}

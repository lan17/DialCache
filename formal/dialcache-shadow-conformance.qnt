module dialcache_shadow_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Ramped-down remote serving with a selected dark C0/S/C1 job. Caller and
  // C0 are independent; every external read/load/dump/write can be held.
  // Phase: 0 idle, 1 C0, 2 source, 3 decode, 4 C1, 5 dump, 6 write, 7 done.
  type State = {
    o: Observation, d: Diagnostics, now: int, wall: int, comparator: int, comparisonMs: int, hook: bool, shadowActive: bool, defaultLog: bool, log: bool, acceptedLog: bool, c0Created: int, deadline: int, phase: int, source: int,
    sourcePending: bool, sourceValue: int, abandoned: bool,
    frame: int, created: int, watermark: int, c0: int, fence: int, writeStamp: int,
    readFailed: bool, loadFailed: bool, dumpFailed: bool, writeFailed: bool
  }
  var s: State
  // Text and binary representations can share bytes; different JSON bytes
  // can still decode to the same value. C1 uses bytes, C0/S uses decoded values.
  pure def payloadBytes(payload: int): int = if (payload == 3) 1 else if (payload == 4) 2 else if (payload == 6) 5 else if (payload == 8) 7 else payload
  pure def payloadValue(payload: int): int = if (payload >= 7) 3 else if (payload == 3 or payload == 5 or payload == 6) 1 else if (payload == 4) 2 else payload
  pure def done(st: State, outcome: str): State = {
    val validated = outcome == "match" or outcome == "mismatch"
    val age = if (st.wall < st.c0Created) 0 else st.wall - st.c0Created
    { phase: 7, o: { shadow: st.o.shadow.append(outcome), ...st.o },
      d: { warnings: st.d.warnings + (if (outcome == "mismatch" and st.acceptedLog) 1 else 0),
        ages: if (validated) st.d.ages.append(age) else st.d.ages, ...st.d }, ...st }
  }
  pure def continueJob(st: State): State =
    if (st.phase != 2 or st.source == 1) st
    else if (st.source == 3) done(st, "source_error")
    else if (st.source == 4) done(st, "timeout")
    else if (st.c0 > 0) { phase: 3, o: { loads: st.o.loads + 1, ...st.o }, ...st }
    else if (st.wall <= st.fence) done(st, "fill_fenced")
    else { phase: 5, o: { dumps: st.o.dumps + 1, ...st.o }, ...st }

  // Input fixtures: default/equal/unequal/error comparator, then the same four
  // with mismatch logging enabled; fixture 8 omits the outcome hook.
  // Fixtures 9/10 let successful/failing comparison consume the job budget.
  // Policy changes are captured at admission.
  action init = {
    nondet choice = 0.to(10).oneOf()
    s' = {
    o: empty, d: noDiagnostics, now: 10000, wall: 100000,
    comparator: if (choice == 10) 3 else choice % 4, comparisonMs: if (choice >= 9) 10 else 0, hook: choice != 8, shadowActive: choice != 8,
    defaultLog: choice >= 4 and choice < 8, log: choice >= 4 and choice < 8, acceptedLog: false, c0Created: 0, deadline: 0, phase: 0, source: 0,
    sourcePending: false, sourceValue: 0, abandoned: false,
    frame: 0, created: 0, watermark: 0, c0: 0, fence: 0, writeStamp: 0,
    readFailed: false, loadFailed: false, dumpFailed: false, writeFailed: false
    }
  }
  action beginCall = all {
    (s.phase == 0 or s.phase == 7), not(s.sourcePending), s.o.calls.length() < 8,
    s' = { phase: if (s.shadowActive) 1 else 7, source: 1, sourcePending: true, sourceValue: 0,
      abandoned: false, deadline: s.now + 10, c0: 0, c0Created: 0, fence: 0, acceptedLog: s.log,
      o: { calls: s.o.calls.append(0), loaders: s.o.loaders + 1,
        reads: s.o.reads + (if (s.shadowActive) 1 else 0), policyCalls: s.o.policyCalls + 1, ...s.o }, ...s }
  }
  action resolveLoader = { nondet choice = Set(1, 2).oneOf()
    all { s.sourcePending,
      s' = continueJob({ sourcePending: false,
        source: if (s.source == 4) 4 else 2, sourceValue: choice,
        o: if (s.source == 4) s.o else finish(s.o, choice), ...s }) }
  }
  action rejectLoader = all { s.sourcePending,
    s' = continueJob({ sourcePending: false, source: if (s.source == 4) 4 else 3,
      o: if (s.source == 4) s.o else finish(s.o, 3),
      d: { fallbackErrors: if (s.source == 4) s.d.fallbackErrors else s.d.fallbackErrors.append("local"), ...s.d }, ...s })
  }
  action releaseRead = all {
    s.phase == 1 or s.phase == 4,
    val readable = s.frame > 0 and s.created > s.watermark
    val snapshot = if (readable) s.frame else 0
    s' = if (s.abandoned) { phase: 7, ...s }
      else if (s.phase == 4) done(s, if (s.readFailed) "confirmation_error"
        else if (payloadBytes(snapshot) == payloadBytes(s.c0)) "mismatch" else "superseded")
      else if (s.readFailed) done(s, "redis_error")
      else continueJob({ phase: 2, c0: if (s.created > s.wall) 0 else snapshot, c0Created: s.created, fence: if (readable) 0 else s.watermark, ...s })
  }
  action releaseLoad = all { s.phase == 3,
    val compared = { now: s.now + s.comparisonMs, wall: s.wall + s.comparisonMs, o: { comparisons: s.o.comparisons + (if (s.comparator == 0) 0 else 1), ...s.o }, ...s }
    s' = if (s.abandoned) { phase: 7, ...s }
      else if (s.loadFailed) done(s, "deserialization_error")
      else if (compared.now >= s.deadline) done({ abandoned: true, ...compared }, "timeout")
      else if (s.comparator == 3) done(compared, "comparison_error")
      else if (s.comparator == 1 or (s.comparator == 0 and payloadValue(s.c0) == s.sourceValue)) done(compared, "match")
      else { phase: 4, o: { reads: s.o.reads + 1, ...compared.o }, ...compared }
  }
  action releaseDump = all { s.phase == 5,
    s' = if (s.abandoned) { phase: 7, ...s }
      else if (s.dumpFailed) done(s, "fill_error")
      else if (s.wall <= s.fence) done(s, "fill_fenced")
      else { phase: 6, writeStamp: s.wall,
        o: { writes: s.o.writes + 1, writeTtls: s.o.writeTtls.append(60000), ...s.o }, ...s }
  }
  action releaseWrite = all { s.phase == 6,
    val stored = { frame: if (s.writeFailed) s.frame else s.sourceValue,
      created: if (s.writeFailed) s.created else s.writeStamp, ...s }
    s' = if (s.abandoned) { phase: 7, ...stored }
      else done(stored, if (s.writeFailed) "fill_error" else "filled")
  }
  action advance = { nondet choice = Set(1, 10).oneOf()
    val expired = s.now + choice >= s.deadline
    val callerTimeout = s.source == 1 and expired
    val jobTimeout = s.phase > 0 and s.phase < 7 and not(s.abandoned) and expired
    s' = { d: { fallbackErrors: if (callerTimeout) s.d.fallbackErrors.append("local") else s.d.fallbackErrors, ...s.d },
      now: s.now + choice, wall: s.wall + choice, source: if (callerTimeout) 4 else s.source,
      abandoned: s.abandoned or jobTimeout,
      phase: if (jobTimeout and s.phase == 2) 7 else s.phase,
      o: { shadow: if (jobTimeout) s.o.shadow.append("timeout") else s.o.shadow,
        ...finish(s.o, if (callerTimeout) 4 else 0) }, ...s }
  }
  action seed = { nondet choice = 1.to(8).oneOf()
    s' = { frame: choice, created: s.wall, ...s } }
  // External replacement with identical bytes in the other supported form.
  // This targets confirmation's representation boundary, without fixing its outcome.
  action reencode = {
    nondet choice = Set(List(0, 3, 4, 1, 2, 6, 5, 8, 7).nth(s.frame)).oneOf()
    all { s.phase == 4, s.frame > 0, s' = { frame: choice, created: s.wall, ...s } }
  }
  action invalidate = { nondet choice = Set(0, 20).oneOf()
    s' = if (s.writeFailed) { o: { invalidations: s.o.invalidations + 1,
      maintenance: s.o.maintenance.append("mutation_error"), ...s.o }, ...s }
    else { watermark: if (s.wall + choice > s.watermark) s.wall + choice else s.watermark,
      o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("ok"), ...s.o }, ...s }
  }
  action rollbackWall = s' = { wall: s.wall - 1000, ...s }
  action logPolicy = { nondet choice = Set(0, 1).oneOf()
    s' = { log: choice == 1, shadowActive: s.hook, ...s } }
  def shadowPolicyFor(choice: int): State = { shadowActive: s.hook and choice == 0, log: s.defaultLog, ...s }
  action shadowPolicy = { nondet choice = Set(0, 1, 2).oneOf()
    s' = shadowPolicyFor(choice) }
  action readFault = { nondet choice = Set(0, 1).oneOf()
    s' = { readFailed: choice == 1, ...s } }
  action loadFault = { nondet choice = Set(0, 1).oneOf()
    s' = { loadFailed: choice == 1, ...s } }
  action dumpFault = { nondet choice = Set(0, 1).oneOf()
    s' = { dumpFailed: choice == 1, ...s } }
  action writeFault = { nondet choice = Set(0, 1).oneOf()
    s' = { writeFailed: choice == 1, ...s } }
  // At C1, favor completion and logging changes while retaining every
  // replacement, failure, clock, and admission-policy transition.
  action step = if (s.phase == 4) any { releaseRead, logPolicy, reencode, any { seed, invalidate, readFault, advance, rollbackWall, shadowPolicy } } else any {
    any { beginCall, resolveLoader, rejectLoader, releaseRead, releaseLoad, releaseDump, releaseWrite },
    any { advance, seed, invalidate, readFault, loadFault, dumpFault, writeFault, rollbackWall, logPolicy, shadowPolicy }
  }
  val oneSourcePerCaller = s.o.loaders == s.o.calls.length()
  val writesRequireMiss = s.phase != 6 or (s.c0 == 0 and s.source == 2)
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()
  val missingHookHasNoShadowEffects = s.hook or (s.o.reads == 0 and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
  val agesRequireVerdicts = s.d.ages.length() == s.o.shadow.select(x => x == "match" or x == "mismatch").length()
  val warningsRequireMismatch = s.d.warnings <= s.o.shadow.select(x => x == "mismatch").length()

  // Fixed model regressions anchor the callback and captured-policy contract.
  action compareFixture = init.then(s' = { phase: 3, deadline: s.now + 10, comparisonMs: 0, hook: true, shadowActive: true, c0: 1, c0Created: s.wall - 1, sourceValue: 2,
    o: { calls: List(2), loaders: 1, reads: 1, loads: 1, ...empty }, ...s })
  run identicalTextAndBinaryBytesConfirmMismatchTest = compareFixture
    .then(s' = { comparator: 2, frame: 3, created: s.wall, ...s }).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch"))
  run sameDecodedValueWithDifferentBytesIsSupersededTest = compareFixture
    .then(s' = { comparator: 2, frame: 5, created: s.wall, ...s }).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("superseded"))
  run binarySnapshotComparesDecodedValueTest = compareFixture
    .then(s' = { comparator: 0, c0: 3, sourceValue: 1, ...s }).then(releaseLoad)
    .expect(s.o.shadow == List("match") and s.o.reads == 1)
  run slowComparisonTimesOutBeforeConfirmationTest = compareFixture
    .then(s' = { comparator: 2, comparisonMs: 10, ...s }).then(releaseLoad)
    .expect(s.o.shadow == List("timeout") and s.o.reads == 1 and s.o.comparisons == 1 and s.o.calls == List(2))
  run slowComparisonFailureStillTimesOutTest = compareFixture
    .then(s' = { comparator: 3, comparisonMs: 10, ...s }).then(releaseLoad)
    .expect(s.o.shadow == List("timeout") and s.o.comparisons == 1 and s.o.calls == List(2))
  run missingHookSkipsDarkJobTest = init.then(s' = { hook: false, shadowActive: false, ...s })
    .then(beginCall).then(resolveLoader).expect(s.o.calls.nth(0) > 0 and s.o.reads == 0 and s.o.shadow == List())
  run invalidShadowPolicySkipsDarkJobTest = init.then(s' = shadowPolicyFor(2)).then(beginCall).then(resolveLoader)
    .expect(s.o.calls.nth(0) > 0 and s.o.reads == 0 and s.o.shadow == List())
  run admittedComparisonSurvivesPolicyDisableTest = compareFixture.then(s' = { comparator: 1, ...s })
    .then(s' = shadowPolicyFor(1)).then(releaseLoad).expect(s.o.shadow == List("match"))
  run explicitEqualityOverridesValuesTest = compareFixture.then(s' = { comparator: 1, ...s }).then(releaseLoad)
    .expect(s.o.shadow == List("match") and s.o.comparisons == 1 and s.d.ages == List(1))
  run explicitInequalityRequiresConfirmationTest = compareFixture
    .then(s' = { comparator: 2, sourceValue: 1, frame: 1, created: s.wall, acceptedLog: true, ...s })
    .then(releaseLoad).expect(s.phase == 4 and s.d.warnings == 0).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.o.comparisons == 1 and s.d.warnings == 1)
  run comparisonFailureKeepsCallerTest = compareFixture.then(s' = { comparator: 3, ...s }).then(releaseLoad)
    .expect(s.o.calls == List(2) and s.o.shadow == List("comparison_error") and s.d.ages == List())
  run acceptedLoggingSurvivesPolicyChangeTest = compareFixture
    .then(s' = { comparator: 2, frame: 1, created: s.wall, acceptedLog: true, log: false, ...s })
    .then(releaseLoad).then(releaseRead).expect(s.d.warnings == 1)
  run ageClampsAfterWallRollbackTest = compareFixture.then(s' = { comparator: 1, ...s })
    .then(rollbackWall).then(releaseLoad).expect(s.d.ages == List(0))
  run confirmationKeepsOriginalAgeTest = compareFixture
    .then(s' = { comparator: 2, frame: 1, created: s.wall, ...s }).then(releaseLoad)
    .then(s' = { wall: s.wall + 1, created: s.wall + 1000, ...s }).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.d.ages == List(2))
}

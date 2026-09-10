module dialcache_shadow_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Model boundary -----------------------------------------------------------
  // One ramped-down caller source and its selected dark C0/source/C1 job.
  // Selected rules from C47/C49-C54 govern admission, comparison, fill authority,
  // and timeout ownership; C57/C60 cover snapshot age and captured logging.
  // See BEHAVIOR.md: "Generated feature profiles" for fixtures and payloads.
  // Each source/read/decode/serialize/write can remain externally pending. This
  // profile excludes serving hits, request/local storage, and overlapping jobs.
  // `now` is elapsed milliseconds; `wall` is independent application time.
  // C0, fence, accepted logging, and dispatched write stamp are retained history.

  // Trace encodings and fixture bounds ---------------------------------------
  pure val IDLE = 0
  pure val C0_READ = 1
  pure val SOURCE_WAIT = 2
  pure val SNAPSHOT_DECODE = 3
  pure val CONFIRMATION_READ = 4
  pure val FILL_SERIALIZE = 5
  pure val FILL_WRITE = 6
  pure val JOB_DONE = 7
  pure val SOURCE_NOT_STARTED = 0
  pure val SOURCE_PENDING = 1
  pure val SOURCE_ACCEPTED = 2
  pure val SOURCE_FAILED = 3
  pure val SOURCE_TIMED_OUT = 4
  pure val COMPARE_DEFAULT = 0
  pure val COMPARE_EQUAL = 1
  pure val COMPARE_UNEQUAL = 2
  pure val COMPARE_ERROR = 3
  pure val COMPARATOR_COUNT = 4
  pure val FIRST_LOGGING_FIXTURE = 4
  pure val FIXTURE_NO_HOOK = 8
  pure val FIXTURE_SLOW_EQUAL = 9
  pure val FIXTURE_SLOW_ERROR = 10
  pure val SHADOW_ENABLED = 0
  pure val SHADOW_DISABLED = 1
  pure val SHADOW_INVALID = 2
  pure val JOB_BUDGET_MS = 10
  pure val WALL_ROLLBACK_MS = 1000
  pure val MAX_CALLS = 8

  // Payload identity is not decoded value identity. The Unicode fixture's
  // decoded symbol is 3; it never becomes a caller result in this profile.
  pure val NO_PAYLOAD = 0
  pure val TEXT_ONE = 1
  pure val TEXT_TWO = 2
  pure val BINARY_ONE = 3
  pure val BINARY_TWO = 4
  pure val BINARY_PADDED_ONE = 5
  pure val TEXT_PADDED_ONE = 6
  pure val TEXT_UNICODE = 7
  pure val BINARY_UNICODE = 8
  pure val DECODED_UNICODE = 3

  // State: diagnostics, independent source/job lifecycles, and remote bytes.
  type State = {
    o: Observation, d: Diagnostics,
    now: int, wall: int, comparator: int, comparisonMs: int,
    hook: bool, shadowActive: bool, defaultLog: bool, log: bool, acceptedLog: bool,
    c0Created: int, deadline: int, phase: int, source: int,
    sourcePending: bool, sourceValue: int, abandoned: bool,
    frame: int, created: int, watermark: int, c0: int, fence: int, writeStamp: int,
    readFailed: bool, loadFailed: bool, dumpFailed: bool, writeFailed: bool
  }
  var s: State

  // Snapshot identity and job completion -------------------------------------
  // Text and binary representations can share bytes; different JSON bytes
  // can still decode to the same value. C1 uses bytes, C0/S uses decoded values.
  pure def payloadBytes(payload: int): int =
    if (payload == BINARY_ONE) TEXT_ONE
    else if (payload == BINARY_TWO) TEXT_TWO
    else if (payload == TEXT_PADDED_ONE) BINARY_PADDED_ONE
    else if (payload == BINARY_UNICODE) TEXT_UNICODE
    else payload
  pure def payloadValue(payload: int): int =
    if (payload >= TEXT_UNICODE) DECODED_UNICODE
    else if (payload == BINARY_ONE or payload == BINARY_PADDED_ONE or payload == TEXT_PADDED_ONE) VALUE_ONE
    else if (payload == BINARY_TWO) VALUE_TWO
    else payload
  pure def done(st: State, outcome: str): State = {
    val validated = outcome == "match" or outcome == "mismatch"
    val age = if (st.wall < st.c0Created) 0 else st.wall - st.c0Created
    {
      phase: JOB_DONE,
      o: { shadow: st.o.shadow.append(outcome), ...st.o },
      d: {
        warnings: st.d.warnings + (if (outcome == "mismatch" and st.acceptedLog) 1 else 0),
        ages: if (validated) st.d.ages.append(age) else st.d.ages,
        ...st.d
      },
      ...st
    }
  }
  pure def continueJob(st: State): State =
    if (st.phase != SOURCE_WAIT or st.source == SOURCE_PENDING) st
    else if (st.source == SOURCE_FAILED) done(st, "source_error")
    else if (st.source == SOURCE_TIMED_OUT) done(st, "timeout")
    else if (st.c0 > NO_PAYLOAD) { phase: SNAPSHOT_DECODE, o: { loads: st.o.loads + 1, ...st.o }, ...st }
    else if (st.wall <= st.fence) done(st, "fill_fenced")
    else { phase: FILL_SERIALIZE, o: { dumps: st.o.dumps + 1, ...st.o }, ...st }

  // Initial fixture ----------------------------------------------------------
  // Input fixtures: default/equal/unequal/error comparator, then the same four
  // with mismatch logging enabled; fixture 8 omits the outcome hook.
  // Fixtures 9/10 let successful/failing comparison consume the job budget.
  // Policy changes are captured at admission.
  action init = {
    nondet choice = 0.to(FIXTURE_SLOW_ERROR).oneOf()
    s' = {
      o: empty, d: noDiagnostics, now: 10000, wall: 100000,
      comparator: if (choice == FIXTURE_SLOW_ERROR) COMPARE_ERROR else choice % COMPARATOR_COUNT,
      comparisonMs: if (choice >= FIXTURE_SLOW_EQUAL) JOB_BUDGET_MS else 0,
      hook: choice != FIXTURE_NO_HOOK, shadowActive: choice != FIXTURE_NO_HOOK,
      defaultLog: choice >= FIRST_LOGGING_FIXTURE and choice < FIXTURE_NO_HOOK,
      log: choice >= FIRST_LOGGING_FIXTURE and choice < FIXTURE_NO_HOOK,
      acceptedLog: false, c0Created: 0, deadline: 0,
      phase: IDLE, source: SOURCE_NOT_STARTED,
      sourcePending: false, sourceValue: 0, abandoned: false,
      frame: NO_PAYLOAD, created: 0, watermark: 0, c0: NO_PAYLOAD, fence: 0, writeStamp: 0,
      readFailed: false, loadFailed: false, dumpFailed: false, writeFailed: false
    }
  }

  // Caller source and job admission ------------------------------------------
  action beginCall = all {
    (s.phase == IDLE or s.phase == JOB_DONE), not(s.sourcePending), s.o.calls.length() < MAX_CALLS,
    s' = {
      phase: if (s.shadowActive) C0_READ else JOB_DONE,
      source: SOURCE_PENDING, sourcePending: true, sourceValue: 0,
      abandoned: false, deadline: s.now + JOB_BUDGET_MS,
      c0: NO_PAYLOAD, c0Created: 0, fence: 0, acceptedLog: s.log,
      o: {
        calls: s.o.calls.append(CALL_PENDING), loaders: s.o.loaders + 1,
        reads: s.o.reads + (if (s.shadowActive) 1 else 0), policyCalls: s.o.policyCalls + 1,
        ...s.o
      },
      ...s
    }
  }
  action resolveLoader = {
    nondet choice = Set(VALUE_ONE, VALUE_TWO).oneOf()
    all {
      s.sourcePending,
      s' = continueJob({
        sourcePending: false,
        source: if (s.source == SOURCE_TIMED_OUT) SOURCE_TIMED_OUT else SOURCE_ACCEPTED, sourceValue: choice,
        o: if (s.source == SOURCE_TIMED_OUT) s.o else finishPendingCalls(s.o, choice),
        ...s
      })
    }
  }
  action rejectLoader = all {
    s.sourcePending,
    s' = continueJob({
      sourcePending: false, source: if (s.source == SOURCE_TIMED_OUT) SOURCE_TIMED_OUT else SOURCE_FAILED,
      o: if (s.source == SOURCE_TIMED_OUT) s.o else finishPendingCalls(s.o, SOURCE_ERROR),
      d: {
        fallbackErrors: if (s.source == SOURCE_TIMED_OUT) s.d.fallbackErrors
          else s.d.fallbackErrors.append("local"),
        ...s.d
      },
      ...s
    })
  }

  // C0 acquisition, retained comparison, and C1 confirmation ------------------
  action releaseRead = all {
    s.phase == C0_READ or s.phase == CONFIRMATION_READ,
    val readable = s.frame > NO_PAYLOAD and s.created > s.watermark
    val snapshot = if (readable) s.frame else NO_PAYLOAD
    s' = if (s.abandoned) { phase: JOB_DONE, ...s }
      else if (s.phase == CONFIRMATION_READ) done(s, if (s.readFailed) "confirmation_error"
        else if (payloadBytes(snapshot) == payloadBytes(s.c0)) "mismatch" else "superseded")
      else if (s.readFailed) done(s, "redis_error")
      else continueJob({
        phase: SOURCE_WAIT,
        c0: if (s.created > s.wall) NO_PAYLOAD else snapshot, c0Created: s.created,
        fence: if (readable) 0 else s.watermark,
        ...s
      })
  }
  action releaseLoad = all {
    s.phase == SNAPSHOT_DECODE,
    val compared = {
      now: s.now + s.comparisonMs, wall: s.wall + s.comparisonMs,
      o: { comparisons: s.o.comparisons + (if (s.comparator == COMPARE_DEFAULT) 0 else 1), ...s.o },
      ...s
    }
    val valuesMatch = s.comparator == COMPARE_EQUAL or
      (s.comparator == COMPARE_DEFAULT and payloadValue(s.c0) == s.sourceValue)
    s' = if (s.abandoned) { phase: JOB_DONE, ...s }
      else if (s.loadFailed) done(s, "deserialization_error")
      else if (compared.now >= s.deadline) done({ abandoned: true, ...compared }, "timeout")
      else if (s.comparator == COMPARE_ERROR) done(compared, "comparison_error")
      else if (valuesMatch) done(compared, "match")
      else { phase: CONFIRMATION_READ, o: { reads: s.o.reads + 1, ...compared.o }, ...compared }
  }

  // Conditional fill preparation and native write completion ------------------
  action releaseDump = all {
    s.phase == FILL_SERIALIZE,
    s' = if (s.abandoned) { phase: JOB_DONE, ...s }
      else if (s.dumpFailed) done(s, "fill_error")
      else if (s.wall <= s.fence) done(s, "fill_fenced")
      else {
        phase: FILL_WRITE, writeStamp: s.wall,
        o: { writes: s.o.writes + 1, writeTtls: s.o.writeTtls.append(60000), ...s.o },
        ...s
      }
  }
  action releaseWrite = all {
    s.phase == FILL_WRITE,
    val stored = {
      frame: if (s.writeFailed) s.frame else s.sourceValue,
      created: if (s.writeFailed) s.created else s.writeStamp,
      ...s
    }
    s' = if (s.abandoned) { phase: JOB_DONE, ...stored }
      else done(stored, if (s.writeFailed) "fill_error" else "filled")
  }

  // Environmental clocks, storage, policy, and failures -----------------------
  action advance = {
    nondet choice = Set(1, 10).oneOf()
    val expired = s.now + choice >= s.deadline
    val callerTimeout = s.source == SOURCE_PENDING and expired
    val jobTimeout = s.phase > IDLE and s.phase < JOB_DONE and not(s.abandoned) and expired
    s' = {
      d: {
        fallbackErrors: if (callerTimeout) s.d.fallbackErrors.append("local") else s.d.fallbackErrors,
        ...s.d
      },
      now: s.now + choice, wall: s.wall + choice, source: if (callerTimeout) SOURCE_TIMED_OUT else s.source,
      abandoned: s.abandoned or jobTimeout,
      phase: if (jobTimeout and s.phase == SOURCE_WAIT) JOB_DONE else s.phase,
      o: {
        shadow: if (jobTimeout) s.o.shadow.append("timeout") else s.o.shadow,
        ...finishPendingCalls(s.o, if (callerTimeout) DEADLINE_ERROR else CALL_PENDING)
      },
      ...s
    }
  }
  action seed = {
    nondet choice = TEXT_ONE.to(BINARY_UNICODE).oneOf()
    s' = { frame: choice, created: s.wall, ...s }
  }
  // External replacement with identical bytes in the other supported form.
  // This targets confirmation's representation boundary, without fixing its outcome.
  action reencode = {
    nondet choice = Set(List(
      NO_PAYLOAD, BINARY_ONE, BINARY_TWO, TEXT_ONE, TEXT_TWO,
      TEXT_PADDED_ONE, BINARY_PADDED_ONE, BINARY_UNICODE, TEXT_UNICODE
    ).nth(s.frame)).oneOf()
    all { s.phase == CONFIRMATION_READ, s.frame > NO_PAYLOAD, s' = { frame: choice, created: s.wall, ...s } }
  }
  action invalidate = {
    nondet choice = Set(0, 20).oneOf()
    s' = if (s.writeFailed) {
      o: {
        invalidations: s.o.invalidations + 1,
        maintenance: s.o.maintenance.append("mutation_error"),
        ...s.o
      },
      ...s
    } else {
      watermark: if (s.wall + choice > s.watermark) s.wall + choice else s.watermark,
      o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("ok"), ...s.o },
      ...s
    }
  }
  action rollbackWall = s' = { wall: s.wall - WALL_ROLLBACK_MS, ...s }
  action logPolicy = {
    nondet choice = Set(0, 1).oneOf()
    s' = { log: choice == 1, shadowActive: s.hook, ...s }
  }
  def shadowPolicyFor(choice: int): State = {
    shadowActive: s.hook and choice == SHADOW_ENABLED, log: s.defaultLog,
    ...s
  }
  action shadowPolicy = {
    nondet choice = Set(SHADOW_ENABLED, SHADOW_DISABLED, SHADOW_INVALID).oneOf()
    s' = shadowPolicyFor(choice)
  }
  action readFault = {
    nondet choice = Set(0, 1).oneOf()
    s' = { readFailed: choice == 1, ...s }
  }
  action loadFault = {
    nondet choice = Set(0, 1).oneOf()
    s' = { loadFailed: choice == 1, ...s }
  }
  action dumpFault = {
    nondet choice = Set(0, 1).oneOf()
    s' = { dumpFailed: choice == 1, ...s }
  }
  action writeFault = {
    nondet choice = Set(0, 1).oneOf()
    s' = { writeFailed: choice == 1, ...s }
  }

  // Exploration schedule: preserve grouping and order for seeded sampling.
  // At C1, favor completion and logging changes while retaining every
  // replacement, failure, clock, and admission-policy transition.
  action step = if (s.phase == CONFIRMATION_READ) any {
    releaseRead, logPolicy, reencode,
    any { seed, invalidate, readFault, advance, rollbackWall, shadowPolicy }
  } else any {
    any { beginCall, resolveLoader, rejectLoader, releaseRead, releaseLoad, releaseDump, releaseWrite },
    any { advance, seed, invalidate, readFault, loadFault, dumpFault, writeFault, rollbackWall, logPolicy, shadowPolicy }
  }

  // Invariants: independent checks over state and observed history.
  val oneSourcePerCaller = s.o.loaders == s.o.calls.length()
  val writesRequireMiss = s.phase != FILL_WRITE or (s.c0 == NO_PAYLOAD and s.source == SOURCE_ACCEPTED)
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()
  val missingHookHasNoShadowEffects = s.hook or (s.o.reads == 0 and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
  val agesRequireVerdicts = s.d.ages.length() == s.o.shadow.select(x => x == "match" or x == "mismatch").length()
  val warningsRequireMismatch = s.d.warnings <= s.o.shadow.select(x => x == "mismatch").length()

  // Deterministic model regressions ------------------------------------------
  // Fixed model regressions anchor the callback and captured-policy contract.
  action compareFixture = init.then(s' = {
    phase: SNAPSHOT_DECODE, deadline: s.now + JOB_BUDGET_MS, comparisonMs: 0,
    hook: true, shadowActive: true,
    c0: TEXT_ONE, c0Created: s.wall - 1, sourceValue: VALUE_TWO,
    o: { calls: List(VALUE_TWO), loaders: 1, reads: 1, loads: 1, ...empty },
    ...s
  })
  run identicalTextAndBinaryBytesConfirmMismatchTest = compareFixture
    .then(s' = { comparator: COMPARE_UNEQUAL, frame: BINARY_ONE, created: s.wall, ...s }).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch"))
  run sameDecodedValueWithDifferentBytesIsSupersededTest = compareFixture
    .then(s' = { comparator: COMPARE_UNEQUAL, frame: BINARY_PADDED_ONE, created: s.wall, ...s }).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("superseded"))
  run binarySnapshotComparesDecodedValueTest = compareFixture
    .then(s' = { comparator: COMPARE_DEFAULT, c0: BINARY_ONE, sourceValue: VALUE_ONE, ...s }).then(releaseLoad)
    .expect(s.o.shadow == List("match") and s.o.reads == 1)
  run slowComparisonTimesOutBeforeConfirmationTest = compareFixture
    .then(s' = { comparator: COMPARE_UNEQUAL, comparisonMs: 10, ...s }).then(releaseLoad)
    .expect(s.o.shadow == List("timeout") and s.o.reads == 1 and s.o.comparisons == 1 and s.o.calls == List(VALUE_TWO))
  run slowComparisonFailureStillTimesOutTest = compareFixture
    .then(s' = { comparator: COMPARE_ERROR, comparisonMs: 10, ...s }).then(releaseLoad)
    .expect(s.o.shadow == List("timeout") and s.o.comparisons == 1 and s.o.calls == List(VALUE_TWO))
  run missingHookSkipsDarkJobTest = init.then(s' = { hook: false, shadowActive: false, ...s })
    .then(beginCall).then(resolveLoader).expect(s.o.calls.nth(0) > 0 and s.o.reads == 0 and s.o.shadow == List())
  run invalidShadowPolicySkipsDarkJobTest = init.then(s' = shadowPolicyFor(SHADOW_INVALID)).then(beginCall).then(resolveLoader)
    .expect(s.o.calls.nth(0) > 0 and s.o.reads == 0 and s.o.shadow == List())
  run admittedComparisonSurvivesPolicyDisableTest = compareFixture.then(s' = { comparator: COMPARE_EQUAL, ...s })
    .then(s' = shadowPolicyFor(SHADOW_DISABLED)).then(releaseLoad).expect(s.o.shadow == List("match"))
  run explicitEqualityOverridesValuesTest = compareFixture.then(s' = { comparator: COMPARE_EQUAL, ...s }).then(releaseLoad)
    .expect(s.o.shadow == List("match") and s.o.comparisons == 1 and s.d.ages == List(1))
  run explicitInequalityRequiresConfirmationTest = compareFixture
    .then(s' = { comparator: COMPARE_UNEQUAL, sourceValue: VALUE_ONE, frame: TEXT_ONE, created: s.wall, acceptedLog: true, ...s })
    .then(releaseLoad).expect(s.phase == CONFIRMATION_READ and s.d.warnings == 0).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.o.comparisons == 1 and s.d.warnings == 1)
  run comparisonFailureKeepsCallerTest = compareFixture.then(s' = { comparator: COMPARE_ERROR, ...s }).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List("comparison_error") and s.d.ages == List())
  run acceptedLoggingSurvivesPolicyChangeTest = compareFixture
    .then(s' = { comparator: COMPARE_UNEQUAL, frame: TEXT_ONE, created: s.wall, acceptedLog: true, log: false, ...s })
    .then(releaseLoad).then(releaseRead).expect(s.d.warnings == 1)
  run ageClampsAfterWallRollbackTest = compareFixture.then(s' = { comparator: COMPARE_EQUAL, ...s })
    .then(rollbackWall).then(releaseLoad).expect(s.d.ages == List(0))
  run confirmationKeepsOriginalAgeTest = compareFixture
    .then(s' = { comparator: COMPARE_UNEQUAL, frame: TEXT_ONE, created: s.wall, ...s }).then(releaseLoad)
    .then(s' = { wall: s.wall + 1, created: s.wall + 1000, ...s }).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.d.ages == List(2))
}

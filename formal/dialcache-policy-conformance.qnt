module dialcache_policy_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import policy_overlay.* from "./kernel/policy-overlay"
  import config_errors as ConfigErrors from "./kernel/config-errors"
  import receipts as Receipts from "./kernel/receipts"
  import serving as Serving from "./kernel/serving"
  import remote_frames as Remote from "./kernel/remote-frames"
  import clock as Clock from "./kernel/clock"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Two logical keys, one process-local slot, untracked Redis. At most one
  // provider reply is held at a time, but accepted sources can overlap and
  // settle in either order. Every source owns its accepted publication policy.
  // State: o is the replay projection and policyErrors the drivers' policy
  // diagnostics channel. Cache entries, source ownership and captured
  // publication policies are predictions checked by later calls.
  // Environment: untracked Redis, separate wall/elapsed clocks, held policy
  // replies and sources, injectable provider/read/dump/write failures.
  // Bounds: two keys, one local slot, twelve callers; no source deadline.
  // Every rule is a kernel transition (formal/kernel): the receipted layered
  // release (sources carry the TTLs of the reply that started them; the
  // receipt of the latest release is read by the one-step properties), the
  // overlay decoder (policy_overlay) and the config error record. This module
  // owns the bounded state, the input choices, the guards, the properties and
  // the regressions.

  // -- Stable outcome and duration encodings (the overlay codes are
  // policy_overlay's) ---------------------------------------------------------

  pure val HALF_SECOND_MS = 500
  pure val ONE_SECOND_MS = 1000
  pure val DEFAULT_RETENTION_MS = 5000
  pure val INITIAL_WALL_MS = 100000
  pure val MAX_CALLERS = 12
  pure val SOURCE_VALUE_COUNT = 7
  pure val MAX_RESOLVE_CHOICE = 84
  pure val FAULT_HEALTHY = 0
  pure val FAULT_FAILED = 1

  // -- Bounded state and layout ----------------------------------------------

  type State = {
    o: Observation,
    policyErrors: List[ConfigErrors::PolicyError],
    now: int,
    skew: int,
    policy: int,
    providerFailed: bool,
    readFailed: bool,
    dumpFailed: bool,
    writeFailed: bool,
    remoteAvailable: bool,
    tracked: bool,
    capacity: int,
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    localValues: List[int],
    localExpires: List[int],
    lru: List[List[int]],
    remoteValues: List[int],
    created: List[int],
    expires: List[int],
    watermark: List[int],
    sources: List[Serving::LayeredSource],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held],
    receipt: Receipts::Receipt
  }
  var s: State
  // Recorded environment commands are replayable in sampled and fixed runs.
  var input: { name: str, choice: int }
  // Two keys of one entity on one instance, no request scope (context 0 is a
  // fresh scope without a memo row), one local slot (capacity 1), untracked
  // remote frames; the drivers' fixture configures 1 s local and remote TTLs
  // and a 5 s stale-on-error maximum, the baseline every overlay resolves
  // against (formal/replay/features.mjs policy).
  pure val LAYOUT: Serving::Layout =
    { keysPerInstance: 2, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 2, probeSourceScope: false }
  pure val BASELINE: Ttls = { localMs: ONE_SECOND_MS, freshMs: ONE_SECOND_MS, retentionMs: DEFAULT_RETENTION_MS }
  // Input decoding: every caller is enabled and asks for one key.
  pure def call(key: int): Call = { instance: 0, key: key, context: 0, enabled: true, keyFailed: false }

  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty,
      policyErrors: List(),
      now: 0,
      skew: INITIAL_WALL_MS,
      policy: INHERIT,
      providerFailed: false,
      readFailed: false,
      dumpFailed: false,
      writeFailed: false,
      remoteAvailable: true,
      tracked: false,
      capacity: 1,
      closed: List(),
      memo: List(),
      requestFlights: List(),
      processFlights: List(NO_OWNER, NO_OWNER),
      localValues: List(NO_VALUE, NO_VALUE),
      localExpires: List(0, 0),
      lru: List(List()),
      remoteValues: List(NO_VALUE, NO_VALUE),
      created: List(0, 0),
      expires: List(0, 0),
      watermark: List(0),
      sources: List(),
      owners: List(),
      memoSlots: List(),
      held: List(),
      receipt: Receipts::NO_RECEIPT
    }
  }

  // -- Caller admission and layer traversal ----------------------------------

  action startCall(key: int): bool = all {
    s' = Serving::admit(s, LAYOUT, call(key)),
    input' = { name: "beginCall", choice: key }
  }
  action beginCall = {
    nondet choice = Set(0, 1).oneOf()
    all {
      not(Gate::holding(s)),
      s.o.calls.length() < MAX_CALLERS,
      startCall(choice)
    }
  }
  // The held reply resolves against the overlay in force: the traversal runs
  // with the fixture's layers gated by the decoded TTLs and leaves its
  // receipt, and a failed reply is reported once on the policy-error channel.
  action releasePolicy = all {
    Gate::holding(s),
    s' = ConfigErrors::recordConfigError(
      Receipts::release(s, LAYOUT, Gate::latest(s), resolve(s, BASELINE), ttls(s, BASELINE)),
      failed(s)),
    input' = { name: "releasePolicy", choice: -1 }
  }

  // -- Source settlement and accepted publication policy ---------------------

  val pendingSources = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING)
  action finishSource(loader: int, value: int): bool = all {
    s' = Serving::settle(s, LAYOUT, loader, value),
    input' = if (value == SOURCE_ERROR) { name: "rejectLoader", choice: loader }
      else { name: "resolveLoader", choice: loader * SOURCE_VALUE_COUNT
        + (if (value <= VALUE_TWO) value else value - 2) }
  }
  action resolveLoader = {
    // One portable choice records both the actual source index and its value.
    nondet choice = 1.to(MAX_RESOLVE_CHOICE)
      .filter(code => pendingSources.contains((code - 1) / SOURCE_VALUE_COUNT)).oneOf()
    finishSource((choice - 1) / SOURCE_VALUE_COUNT, values.nth((choice - 1) % SOURCE_VALUE_COUNT))
  }
  action rejectLoader = {
    nondet choice = pendingSources.oneOf()
    finishSource(choice, SOURCE_ERROR)
  }

  // -- External policy, clocks, storage, and failures -------------------------

  action changePolicy(overlay: int): bool = all {
    s' = { policy: overlay, ...s },
    input' = { name: "policy", choice: overlay }
  }
  action policy = {
    nondet choice = INHERIT.to(INVALID_SHADOW_RAMP).oneOf()
    changePolicy(choice)
  }
  action elapse(ms: int): bool = all {
    s' = Clock::advance(s, ms),
    input' = { name: "advance", choice: ms }
  }
  action advance = {
    nondet choice = Set(1, HALF_SECOND_MS, ONE_SECOND_MS, TWO_SECONDS_MS, DEFAULT_RETENTION_MS).oneOf()
    elapse(choice)
  }
  action seedRemote(key: int, value: int): bool = all {
    s' = Remote::seedFrame(s, key, value, DEFAULT_RETENTION_MS),
    input' = { name: "seed", choice: key * 2 + value - 1 }
  }
  action seed = {
    nondet choice = 0.to(3).oneOf()
    seedRemote(choice / 2, choice % 2 + 1)
  }
  action rollbackWall = all {
    s' = Clock::shiftWall(s, -ONE_SECOND_MS),
    input' = { name: "rollbackWall", choice: -1 }
  }
  // The fault switches are environment inputs the traversal and the overlay
  // decoder read, set by record update.
  pure def faultChoice(failing: bool): int = if (failing) FAULT_FAILED else FAULT_HEALTHY
  action setProviderFault(failing: bool): bool = all {
    s' = { providerFailed: failing, ...s },
    input' = { name: "providerFault", choice: faultChoice(failing) }
  }
  action setReadFault(failing: bool): bool = all {
    s' = { readFailed: failing, ...s },
    input' = { name: "readFault", choice: faultChoice(failing) }
  }
  action setDumpFault(failing: bool): bool = all {
    s' = { dumpFailed: failing, ...s },
    input' = { name: "dumpFault", choice: faultChoice(failing) }
  }
  action setWriteFault(failing: bool): bool = all {
    s' = { writeFailed: failing, ...s },
    input' = { name: "writeFault", choice: faultChoice(failing) }
  }
  action providerFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    setProviderFault(choice == FAULT_FAILED)
  }
  action readFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    setReadFault(choice == FAULT_FAILED)
  }
  action dumpFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    setDumpFault(choice == FAULT_FAILED)
  }
  action writeFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    setWriteFault(choice == FAULT_FAILED)
  }

  // -- Exploration schedule (nesting/order preserve sampling weights) ---------

  action step = any {
    any {
      beginCall,
      releasePolicy,
      resolveLoader,
      rejectLoader
    },
    any {
      policy,
      seed,
      advance,
      rollbackWall,
      providerFault,
      readFault,
      dumpFault,
      writeFault
    }
  }

  // -- Independently stated safety properties --------------------------------
  // The read properties are stated about the release that just happened, from
  // its receipt: the caller, its key, the layer that served it (or that it
  // started a source or joined a flight) and the local slot of its key as the
  // release found it. The frames and the clocks do not move during a release,
  // so the frame the caller read is the post-state's, and the reply's TTLs
  // decode from the unchanged overlay. The boundaries are restated here, not
  // read from the rules.

  val justReleased = input.name == "releasePolicy"
  val releasedCaller = s.receipt.caller
  val releasedValue = s.o.calls.nth(releasedCaller)
  val startedSource = s.receipt.layer == Receipts::STARTED
  val joinedFlight = s.receipt.layer == Receipts::NOT_SERVED
  // The flight registry is consulted before any layer: a coalescing reply
  // with a shared layer on joins the pending flight registered for its key
  // rather than hitting a layer (a hit registers nothing, so the registry the
  // release saw is the post-state's).
  val joinable = resolve(s, BASELINE).coalesce and (localTtl(s, BASELINE) > 0 or remoteTtl(s, BASELINE) > 0)
    and s.processFlights.nth(s.receipt.key) >= 0

  // A local hit is served only with the local layer on and no flight to join,
  // from the entry that was live at the read, holding the caller's value, and
  // leaves its insertion expiry alone; every other release that reached the
  // layers while the local layer was on (a remote hit, a started source)
  // found no live entry.
  val localHitsRespectInsertionExpiry = not(justReleased) or joinedFlight or {
    val key = s.receipt.key
    val live = s.receipt.localValue > NO_VALUE and s.now < s.receipt.localExpires
    if (s.receipt.layer == Receipts::FROM_LOCAL)
      localTtl(s, BASELINE) > 0 and not(joinable)
        and live and s.receipt.localValue == releasedValue and s.localExpires.nth(key) == s.receipt.localExpires
    else not(localTtl(s, BASELINE) > 0 and live)
  }
  // A remote hit serves a retained frame holding the caller's value, stamped
  // at or before the acquired wall time and younger than the reply's fresh
  // TTL (physical retention and logical age are distinct); a miss that started
  // a source with the remote layer on and the read healthy found no such frame.
  val remoteHitsRespectAcquiredFreshness = not(justReleased) or {
    val key = s.receipt.key
    val fresh = remoteTtl(s, BASELINE)
    val wall = s.now + s.skew
    val readable = s.remoteValues.nth(key) > NO_VALUE and s.now < s.expires.nth(key)
      and s.created.nth(key) <= wall and wall - s.created.nth(key) < fresh
    if (s.receipt.layer == Receipts::FROM_REMOTE)
      not(joinable) and readable and s.remoteValues.nth(key) == releasedValue and not(s.readFailed)
    else not(startedSource and fresh > 0 and not(s.readFailed) and readable)
  }
  // A remote hit with the local layer on warms the entry of its key with the
  // served value for the reply's local TTL, whatever the frame's remaining
  // freshness.
  val remoteHitsWarmLocalForTheReplysLocalTtl = not(justReleased) or s.receipt.layer != Receipts::FROM_REMOTE
    or localTtl(s, BASELINE) == 0 or {
      val key = s.receipt.key
      s.localValues.nth(key) == releasedValue and s.localExpires.nth(key) == s.now + localTtl(s, BASELINE)
    }

  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()
  val hitsSkipSource = s.o.loaders <= s.o.calls.length()
  val callsKeepSourceOutcome = s.o.calls.indices().forall(i =>
    if (s.owners.nth(i) >= 0) s.o.calls.nth(i) == s.sources.nth(s.owners.nth(i)).result
    else (s.o.calls.nth(i) == CALL_PENDING) == (s.held.select(h => h.caller == i).length() > 0))
  val sourceCountsMatchEffects = s.sources.length() == s.o.loaders and s.owners.length() == s.o.calls.length()
    and s.held.length() <= 1
  val registeredSourcesArePending = s.processFlights.indices().forall(key => {
    val loader = s.processFlights.nth(key)
    loader < 0 or (s.sources.nth(loader).key == key and s.sources.nth(loader).result == CALL_PENDING
      and s.sources.nth(loader).shared)
  })
  val sharedSourcesKeepRegistration = pendingSources.forall(i =>
    not(s.sources.nth(i).shared) or s.processFlights.nth(s.sources.nth(i).key) == i)
  // This projection owns invocation-level configuration failure only. Optional
  // layer errors retain their independent layer-policy cases. The replay maps
  // the public error label (not the source error object) into errorType. That
  // each failed reply reports exactly one error is pinned by
  // providerFailureReportsStablePolicyCategoryTest (the provider fault),
  // invalidReadBudgetBypassesAllCachingTest (the invalid read budget) and by
  // the drivers, which compare the policyErrors channel on every history.
  val policyResolutionErrorsHaveStableClassification = s.policyErrors.indices().forall(index => {
    val error = s.policyErrors.nth(index)
    error.layer == "noop" and error.errorType == "config_resolution"
  })

  // -- Deterministic regression schedules ------------------------------------

  run invalidReadBudgetBypassesAllCachingTest = init.then(changePolicy(INVALID_READ_BUDGET))
    .then(startCall(0))
    .then(releasePolicy)
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.loaders == 2 and s.o.reads == 0)
    .expect(s.policyErrors == List(ConfigErrors::CONFIG_RESOLUTION, ConfigErrors::CONFIG_RESOLUTION))
    .then(finishSource(0, VALUE_ONE))
    .expect(s.localValues == List(NO_VALUE, NO_VALUE) and s.o.writes == 0)
  run invalidLocalRampPreservesRemoteTest = init.then(changePolicy(INVALID_LOCAL_RAMP))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.reads == 2 and s.o.loads == 1 and s.localValues == List(NO_VALUE, NO_VALUE))
  run invalidRemoteRampPreservesLocalTest = init.then(changePolicy(INVALID_REMOTE_RAMP))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 0)
  run invalidRecoveryUsesOrdinaryRetentionTest = init.then(changePolicy(INVALID_RECOVERY_AGE))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .expect(s.o.writeTtls == List(ONE_SECOND_MS) and s.expires == List(ONE_SECOND_MS, 0))
  run invalidShadowPreservesNormalServingTest = init.then(changePolicy(INVALID_SHADOW_RAMP))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(1))
    .then(releasePolicy)
    .then(finishSource(1, VALUE_TWO))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loads == 1 and s.o.shadow == List())

  // A hit changes recency, but the insertion deadline stays at 1,000 ms.
  // The final probe distinguishes fixed TTL from renewing it on the middle hit.
  run localHitDoesNotRenewInsertionTtlTest = init
    .then(changePolicy(NO_REMOTE))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(elapse(HALF_SECOND_MS))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.localExpires.nth(0) == ONE_SECOND_MS)
    .then(elapse(HALF_SECOND_MS))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)

  run wallRollbackDoesNotExtendLocalTtlTest = init.then(changePolicy(NO_REMOTE))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(rollbackWall)
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE))
    .then(elapse(ONE_SECOND_MS))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)
  run wallRollbackRejectsFutureRemoteFrameTest = init.then(changePolicy(NO_LOCAL))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(rollbackWall)
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)

  run independentCompletionKeepsRegisteredLeaderTest = init
    .then(startCall(0))
    .then(releasePolicy)
    .then(changePolicy(INDEPENDENT_OFFSET))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(1, VALUE_TWO))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO) and s.processFlights == List(0, -1))
    .then(changePolicy(INHERIT))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 2)
    .then(finishSource(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE))

  run independentFailureKeepsRegisteredLeaderTest = init
    .then(startCall(0))
    .then(releasePolicy)
    .then(changePolicy(INDEPENDENT_OFFSET))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(1, SOURCE_ERROR))
    .expect(s.o.calls == List(CALL_PENDING, SOURCE_ERROR) and s.processFlights == List(0, -1))
    .then(changePolicy(INHERIT))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR, VALUE_ONE))

  run eachSourceKeepsPublicationPolicyTest = init
    .then(startCall(0))
    .then(releasePolicy)
    .then(changePolicy(INDEPENDENT_OFFSET + REMOTE_FOUR_SECONDS_NO_RECOVERY))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(1, VALUE_TWO))
    .then(finishSource(0, VALUE_ONE))
    .expect(s.o.writeTtls == List(FOUR_SECONDS_MS, DEFAULT_RETENTION_MS) and s.remoteValues == List(1, 0))
  run absentValueIsStoredAndReusedTest = init.then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ABSENT))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT) and s.o.loaders == 1 and s.o.writes == 1)

  // Coalescing controls pending work. It does not turn off settled caching.
  run independentLocalCallsStillReuseSettledValueTest = init
    .then(changePolicy(INDEPENDENT_OFFSET + NO_REMOTE))
    .then(startCall(0)).then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.reads == 0)

  run independentLocalPublicationUsesLastCompletionTest = init
    .then(changePolicy(INDEPENDENT_OFFSET + NO_REMOTE))
    .then(startCall(0)).then(releasePolicy)
    .then(startCall(0)).then(releasePolicy)
    .then(finishSource(1, VALUE_TWO)).then(finishSource(0, VALUE_ONE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  run independentRemotePublicationUsesLastCompletionTest = init
    .then(changePolicy(INDEPENDENT_OFFSET + NO_LOCAL))
    .then(startCall(0)).then(releasePolicy)
    .then(startCall(0)).then(releasePolicy)
    .then(finishSource(1, VALUE_TWO)).then(finishSource(0, VALUE_ONE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE)
      and s.o.loaders == 2 and s.o.reads == 3 and s.o.writes == 2 and s.o.loads == 1)

  run providerFailureBypassesAndPreservesExistingLocalTest = init
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(setProviderFault(true))
    .then(startCall(0)).then(releasePolicy).then(finishSource(1, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.reads == 1 and s.o.writes == 1)
    .then(setProviderFault(false))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  run disablingServingKeepsExistingLocalForReenablementTest = init
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(changePolicy(NO_SERVING))
    .then(startCall(0)).then(releasePolicy).then(finishSource(1, VALUE_TWO))
    .then(changePolicy(INHERIT))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE)
      and s.o.loaders == 2 and s.o.reads == 1 and s.o.writes == 1)

  // Redis physical retention may outlast logical freshness. Increasing the
  // fresh TTL can reuse retained bytes, but cannot recreate expired storage.
  run increasedFreshTtlCanReusePhysicallyRetainedValueTest = init
    .then(changePolicy(NO_LOCAL))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(elapse(ONE_SECOND_MS))
    .then(changePolicy(REMOTE_TTL_TWO_SECONDS))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE)
      and s.o.loaders == 1 and s.o.loads == 1 and s.o.writes == 1)

  run exactRemoteFreshBoundaryStartsSourceTest = init
    .then(changePolicy(NO_LOCAL))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(elapse(ONE_SECOND_MS))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING)
      and s.o.loaders == 2 and s.o.loads == 0 and s.expires.nth(0) == DEFAULT_RETENTION_MS)

  // The first read proves the retained frame is usable; its hit cannot renew
  // logical freshness. Equality then refills and a later read reuses that fill.
  run remoteHitBeforeBoundaryDoesNotRenewFreshnessTest = init
    .then(changePolicy(NO_LOCAL)).then(seedRemote(0, VALUE_ONE))
    .then(elapse(HALF_SECOND_MS)).then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0 and s.o.loads == 1)
    .then(elapse(HALF_SECOND_MS)).then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 1 and s.o.loads == 1)
    .then(finishSource(0, VALUE_TWO)).then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO)
      and s.o.loaders == 1 and s.o.loads == 2 and s.o.writes == 1)

  run increasedFreshTtlCannotResurrectExpiredStorageTest = init
    .then(changePolicy(RECOVERY_TWO_SECONDS))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(elapse(TWO_SECONDS_MS))
    .then(changePolicy(REMOTE_FOUR_SECONDS_NO_RECOVERY))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING)
      and s.o.loaders == 2 and s.o.loads == 0 and s.o.writes == 1)

  run remoteHitStartsFullLocalInsertionTtlTest = init
    .then(changePolicy(NO_LOCAL))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(elapse(HALF_SECOND_MS))
    .then(changePolicy(INHERIT))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.localExpires.nth(0) == HALF_SECOND_MS + ONE_SECOND_MS)
    .then(elapse(HALF_SECOND_MS))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.loaders == 1 and s.o.reads == 2 and s.o.loads == 1)

  // A remote hit warms local storage for the reply's local TTL, not for the
  // frame's remaining freshness: a 2 s local TTL keeps serving locally after
  // the 1 s remote freshness has passed.
  run remoteHitWarmsLocalForTheReplysLocalTtlTest = init.then(seedRemote(0, VALUE_ONE))
    .then(changePolicy(LOCAL_TTL_TWO_SECONDS))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loads == 1 and s.localExpires.nth(0) == TWO_SECONDS_MS)
    .then(elapse(ONE_SECOND_MS)).then(elapse(HALF_SECOND_MS))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 0 and s.o.reads == 1)

  run untrackedReadFailureStillWarmsActiveLocalTest = init
    .then(setReadFault(true))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE)
      and s.o.loaders == 1 and s.o.reads == 1 and s.o.dumps == 0 and s.o.writes == 0)

  run invalidRemoteTtlPreservesLocalServingTest = init
    .then(changePolicy(INVALID_REMOTE_TTL))
    .then(startCall(0)).then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 0 and s.o.writes == 0 and s.o.loads == 0)

  run invalidLocalTtlStillServesFreshRemoteTest = init
    .then(seedRemote(0, VALUE_ONE)).then(changePolicy(INVALID_LOCAL_TTL))
    .then(startCall(0)).then(releasePolicy)
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 0
      and s.o.reads == 2 and s.o.loads == 2 and s.o.writes == 0)

  run recoveryAgeEqualToFreshTtlStillServesFreshRemoteTest = init
    .then(seedRemote(0, VALUE_ONE)).then(changePolicy(INVALID_RECOVERY_AGE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0
      and s.o.reads == 1 and s.o.loads == 1 and s.o.recovery == List())

  run negativeRecoveryAgeStillServesFreshRemoteTest = init
    .then(seedRemote(0, VALUE_ONE)).then(changePolicy(NEGATIVE_RECOVERY_AGE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0
      and s.o.reads == 1 and s.o.loads == 1 and s.o.recovery == List())

  run providerFailureReportsStablePolicyCategoryTest = init
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(setProviderFault(true))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.policyErrors == List({ layer: "noop", errorType: "config_resolution" })
      and s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2
      and s.o.reads == 1 and s.o.writes == 1)
    .then(finishSource(1, VALUE_TWO)).then(setProviderFault(false))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.policyErrors == List({ layer: "noop", errorType: "config_resolution" })
      and s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  // Falsy source results are values in Redis. With the local layer disabled,
  // each later same-key call within freshness is a remote hit returning the
  // stored falsy value; reaching the fresh boundary starts a source instead.
  run falsyRemoteValuesAreServedFromRemoteTest = init.then(changePolicy(NO_LOCAL))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_FALSE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_FALSE, VALUE_FALSE) and s.o.loaders == 1 and s.o.loads == 1)
    .then(startCall(1)).then(releasePolicy).then(finishSource(1, VALUE_ZERO))
    .then(startCall(1)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_FALSE, VALUE_FALSE, VALUE_ZERO, VALUE_ZERO)
      and s.o.loaders == 2 and s.o.loads == 2)
    .then(elapse(ONE_SECOND_MS))
    .then(startCall(0)).then(releasePolicy).then(finishSource(2, VALUE_EMPTY_STRING))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_FALSE, VALUE_FALSE, VALUE_ZERO, VALUE_ZERO, VALUE_EMPTY_STRING, VALUE_EMPTY_STRING)
      and s.o.loaders == 3 and s.o.reads == 6 and s.o.loads == 3 and s.o.writes == 3
      and s.localValues == List(NO_VALUE, NO_VALUE))
}

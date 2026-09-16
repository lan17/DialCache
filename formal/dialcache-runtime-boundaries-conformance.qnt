module dialcache_runtime_boundaries_conformance {
  import conformance_observations.* from "./conformance-observations"
  import cohort_boundaries.* from "./cohort-boundaries"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import runtime_policy.* from "./kernel/runtime-policy"
  import serving as Serving from "./kernel/serving"
  import flights as Flights from "./kernel/flights"
  import policy_gate as Gate from "./kernel/policy-gate"

  // C06/C13/C16/C19: one key, one request lifetime and one initially selected layer.
  // Operation defaults either omit or disable coalescing; runtime policy can
  // inherit, disable or enable it independently of the serving cohort. Sources
  // may overlap and settle in either order; later public calls observe the
  // retained values. The all-features fixture permits only the full kill
  // switch and restoration, retaining its request memo, so its initial remote
  // miss and later first-layer hits never admit shadow or recovery work. Other
  // fixtures start with one layer; a local-TTL overlay can add an earlier local
  // layer to a remote fixture, whose retained value survives later remote-only
  // overwrites. Redis/codec work is healthy and immediate; no time advances
  // (the clock profile owns expiry).
  // Every rule is a kernel transition (formal/kernel); this module owns the
  // bounded state, the fixture decoding, the input choices and the guards.
  // The drivers hold every policy reply, so admission and traversal are two
  // steps here (Serving::admit, then Serving::release with the reply resolved
  // by runtime_policy against the fixture's baseline).

  pure val REQUEST_LAYER = 0
  pure val LOCAL_LAYER = 1
  pure val REMOTE_LAYER = 2
  pure val DEFAULT_POLICY = 9
  pure val DEFAULT_SHARING_FIXTURE_OFFSET = 3
  pure val NO_LOCAL_TTL_FIXTURE = 6
  pure val NO_REMOTE_TTL_FIXTURE = 7
  pure val DISABLED_BASELINE_FIXTURE = 8
  pure val ALL_FEATURES_FIXTURE = 9
  pure val EXTENDED_RETENTION_MS = 120000
  pure val VALUE_UNDEFINED_STRING = 11
  pure val SOURCE_VALUES = List(VALUE_ONE, VALUE_TWO, VALUE_ABSENT, VALUE_UNDEFINED_STRING, VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING)
  pure val MAX_CALLERS = 8
  pure val TTL_MS = 60000
  pure val INITIAL_TIME_MS = 10000
  pure val SAMPLES: Samples = { local: 4292886220, remote: 1018911151 }
  pure val CALL: Call = { instance: 0, key: 0, context: 0 }
  pure def layoutFor(ttlMs: int): Serving::Layout =
    { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 1, operationsPerEntity: 1, servingTtlMs: ttlMs }

  type State = {
    o: Observation,
    now: int,
    tracked: bool,
    remoteAvailable: bool,
    capacity: int,
    policy: int,
    baseline: Baseline,
    layout: Serving::Layout,
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    localValues: List[int],
    lru: List[List[int]],
    remoteValues: List[int],
    created: List[int],
    watermark: List[int],
    sources: List[Flights::Source],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }

  // Fixture decoding (input only): the initially configured layer, the
  // operation default for coalescing, whether the layer has a TTL, a disabled
  // baseline, the all-features fixture and whether a Redis client exists.
  pure def layerOf(fixture: int): int = if (fixture == ALL_FEATURES_FIXTURE) REQUEST_LAYER
    else if (fixture < NO_LOCAL_TTL_FIXTURE) fixture % DEFAULT_SHARING_FIXTURE_OFFSET
    else if (fixture == NO_REMOTE_TTL_FIXTURE) REMOTE_LAYER else LOCAL_LAYER
  pure def configured(fixture: int): bool = fixture < NO_LOCAL_TTL_FIXTURE or fixture == ALL_FEATURES_FIXTURE
  pure def baselineOf(fixture: int): Baseline = {
    request: layerOf(fixture) == REQUEST_LAYER,
    local: (layerOf(fixture) == LOCAL_LAYER and configured(fixture)) or fixture == ALL_FEATURES_FIXTURE,
    remote: (layerOf(fixture) == REMOTE_LAYER and configured(fixture)) or fixture == ALL_FEATURES_FIXTURE,
    coalesce: fixture >= DEFAULT_SHARING_FIXTURE_OFFSET,
    disabled: fixture == DISABLED_BASELINE_FIXTURE
  }
  val allFeatures = s.baseline.request and s.baseline.local

  action initialize(fixture: int): bool = all {
    s' = {
      o: empty,
      now: INITIAL_TIME_MS,
      tracked: false,
      remoteAvailable: (fixture < NO_LOCAL_TTL_FIXTURE and fixture % DEFAULT_SHARING_FIXTURE_OFFSET == REMOTE_LAYER)
        or fixture == NO_REMOTE_TTL_FIXTURE or fixture == ALL_FEATURES_FIXTURE,
      capacity: 1,
      policy: DEFAULT_POLICY,
      baseline: baselineOf(fixture),
      layout: layoutFor(if (fixture == ALL_FEATURES_FIXTURE) EXTENDED_RETENTION_MS else TTL_MS),
      closed: List(false),
      memo: List(NO_VALUE),
      requestFlights: List(NO_OWNER),
      processFlights: List(NO_OWNER),
      localValues: List(NO_VALUE),
      lru: List(List()),
      remoteValues: List(NO_VALUE),
      created: List(0),
      watermark: List(0),
      sources: List(),
      owners: List(),
      memoSlots: List(),
      held: List()
    },
    input' = { name: "init", choice: fixture }
  }
  action init = {
    nondet choice = REQUEST_LAYER.to(ALL_FEATURES_FIXTURE).oneOf()
    initialize(choice)
  }

  action beginCall = all {
    not(Gate::holding(s)),
    s.o.calls.length() < MAX_CALLERS,
    s' = Serving::admit(s, s.layout, CALL),
    input' = { name: "beginCall", choice: -1 }
  }
  action releasePolicy = all {
    Gate::holding(s),
    s' = Serving::release(s, s.layout, Gate::latest(s), resolve(s, SAMPLES)),
    input' = { name: "releasePolicy", choice: -1 }
  }
  action changePolicy(policy: int): bool = all {
    s' = { policy: policy, ...s },
    input' = { name: "policy", choice: policy }
  }
  action policy = {
    nondet choice = 0.to(KILL_ALL_FEATURES)
      .filter(code => not(allFeatures) or Set(DEFAULT_POLICY, KILL_ALL_FEATURES).contains(code)).oneOf()
    changePolicy(choice)
  }
  action closeScope = all {
    s.baseline.request,
    not(allFeatures),
    not(s.closed.nth(0)),
    s' = Serving::closeScope(s, s.layout, 0),
    input' = { name: "closeScope", choice: -1 }
  }
  action finishSource(loader: int, valueIndex: int): bool = all {
    s' = Serving::settle(s, s.layout, loader, SOURCE_VALUES.nth(valueIndex)),
    input' = { name: "resolveLoader", choice: loader * SOURCE_VALUES.length() + valueIndex }
  }
  action resolveLoader = {
    nondet choice = 0.to(MAX_CALLERS * SOURCE_VALUES.length() - 1)
      .filter(code => code / SOURCE_VALUES.length() < s.sources.length()
        and s.sources.nth(code / SOURCE_VALUES.length()).result == CALL_PENDING).oneOf()
    finishSource(choice / SOURCE_VALUES.length(), choice % SOURCE_VALUES.length())
  }
  action step = any { beginCall, releasePolicy, resolveLoader, policy, closeScope }

  // -- Independently stated safety properties --------------------------------
  // The boundary properties are stated about the step that just happened: the
  // released caller, the policy in force and the registry, or the source that
  // just settled. One reply is held at a time (beginCall waits for the
  // release), so the caller a release served is the last admitted one; a
  // source it started has that caller as its only owner, a source it joined
  // has at least one more.

  val justReleased = input.name == "releasePolicy"
  val releasedCaller = s.o.calls.length() - 1
  pure def joinedCaller(x: State, caller: int): bool =
    x.owners.nth(caller) >= 0 and Flights::ownedBy(x, x.owners.nth(caller)) != Set(caller)
  pure def bypassed(x: State, caller: int): bool = x.owners.nth(caller) >= 0
    and Flights::ownedBy(x, x.owners.nth(caller)) == Set(caller) and {
      val source = x.sources.nth(x.owners.nth(caller))
      not(source.local) and not(source.remote) and not(source.shared)
    }
  val equalAndLowerCohortsNeverTraverse = not(justReleased) or s.baseline.request
    or s.policy >= NULL_PROVIDER or s.policy / 3 > AT_SAMPLE or bypassed(s, releasedCaller)
  val inheritedDisabledSharingNeverJoins = not(justReleased)
    or (s.policy < NULL_PROVIDER and s.policy % 3 == ENABLE_SHARING)
    or (s.baseline.coalesce and (s.policy >= NULL_PROVIDER or s.policy % 3 == INHERIT_SHARING))
    or not(joinedCaller(s, releasedCaller))
  val invalidBooleanLeavesBypassAllCaching = not(justReleased)
    or s.policy < INVALID_COALESCE or s.policy > NULL_REQUEST_LOCAL or bypassed(s, releasedCaller)
  val callersKeepTheirSourceValue = s.owners.indices().forall(caller =>
    s.owners.nth(caller) < 0 or s.o.calls.nth(caller) == s.sources.nth(s.owners.nth(caller)).result)
  // Every layer holds nothing or a value a settled source put there (remote
  // only from a source that read it; local also from a remote hit warming it;
  // the memo also from a local or remote hit), and the settlement that just
  // happened left its value in every layer its source publishes to (remote
  // when the flight read it, local when it may warm it, the request memo of
  // each owner memoizing into the open scope), whatever the admission order of
  // the sources; no source errors here.
  pure def memoizes(x: State, loader: int): bool =
    Flights::ownedBy(x, loader).exists(caller => x.memoSlots.nth(caller) >= 0)
  pure def publishedBy(x: State, value: int, publishes: (int) => bool): bool =
    value == NO_VALUE or x.sources.indices().exists(loader => publishes(loader) and x.sources.nth(loader).result == value)
  val justSettled = input.name == "resolveLoader"
  val settledSource = input.choice / SOURCE_VALUES.length()
  val retainedValueFollowsSettlementOrder = publishedBy(s, s.remoteValues.nth(0), loader => s.sources.nth(loader).remote)
    and publishedBy(s, s.localValues.nth(0), loader => s.sources.nth(loader).local or s.sources.nth(loader).remote)
    and publishedBy(s, s.memo.nth(0), loader =>
      s.sources.nth(loader).local or s.sources.nth(loader).remote or memoizes(s, loader))
    and (not(justSettled) or {
      val source = s.sources.nth(settledSource)
      (not(source.remote) or s.remoteValues.nth(0) == source.result)
        and (not(source.local) or s.localValues.nth(0) == source.result)
        and (s.closed.nth(0) or Flights::ownedBy(s, settledSource).forall(caller =>
          s.memoSlots.nth(caller) < 0 or s.memo.nth(0) == source.result))
    })
  val sourceEffectsMatch = s.sources.length() == s.o.loaders and s.owners.length() == s.o.calls.length()
    and s.held.length() <= 1

  // -- Deterministic regression schedules (verbatim) --------------------------

  run runtimeLocalTtlAddsEarlierLayerToRemoteFixtureTest = initialize(REMOTE_LAYER)
    .then(changePolicy(RUNTIME_LOCAL_TTL))
    .then(beginCall).then(releasePolicy).then(beginCall)
    .then(finishSource(0, 7)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_EMPTY_STRING, VALUE_EMPTY_STRING)
      and s.o.loaders == 1 and s.o.reads == 1 and s.o.loads == 0 and s.o.writes == 1)

  run runtimeLocalTtlEnablesSharingWithoutRemoteTtlTest = initialize(NO_REMOTE_TTL_FIXTURE)
    .then(changePolicy(RAMP_UP_DISABLED_BASELINE))
    .then(beginCall).then(releasePolicy)
    .then(changePolicy(RUNTIME_LOCAL_TTL))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 1 and s.o.calls == List(CALL_PENDING, CALL_PENDING))
    .then(finishSource(0, 2)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT, VALUE_ABSENT)
      and s.o.reads == 0 and s.o.writes == 0 and s.o.loaders == 1)

  run remoteHitPromotesIntoNewlyEnabledLocalLayerTest = initialize(REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 0)).then(changePolicy(RUNTIME_LOCAL_TTL))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING, VALUE_ONE) and s.o.loads == 1)
    .then(finishSource(1, 1)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_ONE) and s.o.reads == 3)
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_ONE, VALUE_TWO)
      and s.o.reads == 4 and s.o.loads == 2 and s.o.writes == 2)

  run runtimeTrueEnablesSharingOverFalseDefaultTest = initialize(REQUEST_LAYER)
    .then(changePolicy(FULL_COHORT * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy)
    .then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 1 and s.o.calls == List(CALL_PENDING, CALL_PENDING))
    .then(finishSource(0, 0))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)

  run inheritedFalseKeepsIndependentMemoizingSourcesTest = initialize(REQUEST_LAYER)
    .then(beginCall).then(releasePolicy)
    .then(beginCall).then(releasePolicy)
    .then(finishSource(1, 1)).then(finishSource(0, 0))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  run localCohortEqualityBypassesBeforeAboveSampleCachesTest = initialize(LOCAL_LAYER)
    .then(changePolicy(AT_SAMPLE * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(ABOVE_SAMPLE * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2)

  run remoteCohortEqualityBypassesBeforeAboveSampleCachesTest = initialize(REMOTE_LAYER)
    .then(changePolicy(AT_SAMPLE * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(ABOVE_SAMPLE * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.writes == 1 and s.o.loads == 1)

  run requestAbsenceAndLiteralTextStayDistinctTest = initialize(REQUEST_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 2)).then(finishSource(1, 3))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_UNDEFINED_STRING, VALUE_UNDEFINED_STRING)
      and s.o.loaders == 2)

  run localAbsenceAndLiteralTextStayDistinctTest = initialize(LOCAL_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 3)).then(finishSource(1, 2))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_UNDEFINED_STRING, VALUE_ABSENT, VALUE_ABSENT)
      and s.o.loaders == 2)

  run remoteAbsenceAndLiteralTextStayDistinctTest = initialize(REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 2)).then(finishSource(1, 3))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_UNDEFINED_STRING, VALUE_UNDEFINED_STRING)
      and s.o.loaders == 2 and s.o.loads == 1 and s.o.writes == 2)

  run requestFalsyValuesRemainDistinctAndReusableTest = initialize(REQUEST_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 4)).then(beginCall).then(releasePolicy)
    .then(finishSource(1, 5)).then(beginCall).then(releasePolicy)
    .then(finishSource(2, 6)).then(beginCall).then(releasePolicy)
    .then(finishSource(3, 7)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING,
      VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING) and s.o.loaders == 4)

  run localFalsyValuesRemainDistinctAndReusableTest = initialize(LOCAL_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 4)).then(beginCall).then(releasePolicy)
    .then(finishSource(1, 5)).then(beginCall).then(releasePolicy)
    .then(finishSource(2, 6)).then(beginCall).then(releasePolicy)
    .then(finishSource(3, 7)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING,
      VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING) and s.o.loaders == 4)

  run remoteFalsyValuesRemainDistinctAndReusableTest = initialize(REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 4)).then(beginCall).then(releasePolicy)
    .then(finishSource(1, 5)).then(beginCall).then(releasePolicy)
    .then(finishSource(2, 6)).then(beginCall).then(releasePolicy)
    .then(finishSource(3, 7)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING,
      VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING) and s.o.loaders == 4)

  run nullProviderInheritsConfiguredServingAndDefaultSharingTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(changePolicy(NULL_PROVIDER))
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 0)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 2 and s.o.loads == 1 and s.o.writeTtls == List(TTL_MS))

  run omittedRampAndSharingUseLibraryDefaultsTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 0)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 2 and s.o.loads == 1 and s.o.writeTtls == List(TTL_MS)
      and s.o.shadow == List() and s.o.recovery == List())

  run reenablingSharingUsesTheOmittedTrueDefaultTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REQUEST_LAYER)
    .then(changePolicy(FULL_COHORT * 3 + DISABLE_SHARING))
    .then(beginCall).then(releasePolicy)
    .then(changePolicy(DEFAULT_POLICY))
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 2)
    .then(finishSource(1, 1)).then(finishSource(0, 0))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  run falseRequestLeafPreservesMemoForReenablementTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REQUEST_LAYER)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(DISABLE_REQUEST))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  run invalidCoalesceBypassesWithoutReplacingRemoteTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(INVALID_COALESCE))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.writes == 1 and s.o.loads == 1)

  run invalidRequestLocalBypassesWithoutReplacingRemoteTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(INVALID_REQUEST_LOCAL))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.writes == 1 and s.o.loads == 1)

  run explicitNullCoalesceBypassesWithoutReplacingRemoteTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(NULL_COALESCE))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.writes == 1 and s.o.loads == 1)

  run explicitNullRequestLocalBypassesWithoutReplacingRemoteTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(NULL_REQUEST_LOCAL))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.writes == 1 and s.o.loads == 1)

  run runtimeLocalTtlWithoutRampActivatesLayerTest = initialize(NO_LOCAL_TTL_FIXTURE)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(RUNTIME_LOCAL_TTL))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2
      and s.o.reads == 0 and s.o.writes == 0)

  run runtimeRemoteTtlWithoutRampActivatesLayerTest = initialize(NO_REMOTE_TTL_FIXTURE)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(RUNTIME_REMOTE_TTL))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.loads == 1 and s.o.writeTtls == List(TTL_MS))

  run disabledBaselineRampedUpKeepsDefaultSharingTest = initialize(DISABLED_BASELINE_FIXTURE)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(RAMP_UP_DISABLED_BASELINE))
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 2)
    .then(finishSource(1, 1)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2)

  run fullFeatureKillSwitchKeepsOmittedSharingAndRetainedMemoTest = initialize(ALL_FEATURES_FIXTURE)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 1 and s.o.reads == 1)
    .then(finishSource(0, 0))
    .then(changePolicy(KILL_ALL_FEATURES))
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 3 and s.o.reads == 1)
    .then(finishSource(1, 1)).then(finishSource(2, 3))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_UNDEFINED_STRING, VALUE_ONE)
      and s.o.loaders == 3 and s.o.reads == 1 and s.o.writes == 1
      and s.o.writeTtls == List(EXTENDED_RETENTION_MS)
      and s.o.shadow == List() and s.o.recovery == List())

  // The coalesce gate covers the request registry's lookup as well as its
  // registration: once sharing is disabled, a caller does not join the flight
  // an earlier shared caller registered under the same memo slot, and the
  // independent sources memoize in settlement order.
  run disabledSharingDoesNotJoinRegisteredFlightTest = initialize(REQUEST_LAYER)
    .then(changePolicy(FULL_COHORT * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 1)
    .then(changePolicy(FULL_COHORT * 3 + DISABLE_SHARING))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 2 and s.o.calls == List(CALL_PENDING, CALL_PENDING, CALL_PENDING))
    .then(finishSource(1, 1)).then(finishSource(0, 0))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)
}

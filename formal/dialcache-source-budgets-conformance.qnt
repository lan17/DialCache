module dialcache_source_budgets_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import deadlines as Deadlines from "./kernel/deadlines"
  import policy_gate as Gate from "./kernel/policy-gate"

  // C01/C23-C27: source deadlines belong to source execution, not policy work
  // or the waiting caller. One local key and eight calls permit delayed policy,
  // shared followers, independent bypasses, and abandoned work beside a retry.
  // Sources and policy replies are external gates. Timers are delivered on an
  // advance; late settlement before timer delivery is covered by effects.
  // Remote I/O, request memo and shadow work are outside this focused profile.
  // Every rule is a kernel transition (formal/kernel): the local projection of
  // the traversal with its budgeted variants. This module owns the bounded
  // state, the fixture decoding (the configured source budget and the identity
  // a call is admitted with), the input choices and the guards.

  // Initialization choices are part of the replay input: keep these codes stable.
  pure val DEFAULT_BUDGET_MODE = 0
  pure val UNBOUNDED_BUDGET_MODE = 1
  pure val FINITE_BUDGET_MODE = 2
  pure val ENABLED = 0
  pure val OUTSIDE = 1
  pure val INVALID_KEY = 2
  pure val OUTSIDE_INVALID_KEY = 3
  pure val MAX_CALLS = 8
  pure val LOCAL_TTL_MS = 1000
  pure val MAX_TIME_MS = 180000
  // One key on one instance, no persistent request scope, a 1 s local TTL and
  // no remote layer; every reply enables the local layer with sharing.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true
  }
  pure val LOCAL: Resolution = { layers: { request: false, local: true, remote: false }, coalesce: true }
  pure val TTLS: Ttls = { localMs: LOCAL_TTL_MS, freshMs: 0, retentionMs: 0 }

  // All times are monotonic milliseconds. A budget of -1 is unbounded. A
  // source's external work can remain undelivered after its deadline completed
  // its callers: the abandoned source can still finish externally.
  type State = {
    o: Observation,
    now: int,
    sourceBudget: int,
    capacity: int,
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    localValues: List[int],
    localExpires: List[int],
    lru: List[List[int]],
    sources: List[Serving::LocalSource],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held],
    deadlines: List[Deadlines::Due],
    started: List[int],
    budgets: List[int],
    settledAt: List[int],
    drained: List[bool]
  }
  var s: State
  // input records the external command. s.o predicts public observations;
  // owners, registries and local storage describe model-owned state, not inputs
  // a native replay driver may read to decide what the implementation should do.
  var input: { name: str, choice: int }

  // Input decoding: the fixture's configured source budget, the identity a
  // call is admitted with, and the source and value a resolve choice names
  // (`resolved` records them as id * 2 + value). A key that failed to
  // construct is the one bypass whose source keeps the configured budget
  // (C27); an outside call returns before its key is constructed, so both
  // outside kinds run unbounded (C01).
  pure def configuredBudget(mode: int): int =
    if (mode == DEFAULT_BUDGET_MODE) 60000
    else if (mode == UNBOUNDED_BUDGET_MODE) Deadlines::UNBOUNDED
    else 10
  pure def call(kind: int): Call =
    { instance: 0, key: 0, context: 0, enabled: kind == ENABLED, keyFailed: kind == INVALID_KEY }
  pure def resolvedSource(choice: int): int = (choice - 1) / 2
  pure def resolvedValue(choice: int): int = (choice - 1) % 2 + 1

  action initialize(mode: int): bool = all {
    input' = { name: "init", choice: mode },
    s' = {
      o: empty,
      now: 0,
      sourceBudget: configuredBudget(mode),
      capacity: 1,
      closed: List(),
      memo: List(),
      requestFlights: List(),
      processFlights: List(NO_OWNER),
      localValues: List(NO_VALUE),
      localExpires: List(0),
      lru: List(List()),
      sources: List(),
      owners: List(),
      memoSlots: List(),
      held: List(),
      deadlines: List(),
      started: List(),
      budgets: List(),
      settledAt: List(),
      drained: List()
    }
  }
  action init = {
    nondet choice = Set(DEFAULT_BUDGET_MODE, UNBOUNDED_BUDGET_MODE, FINITE_BUDGET_MODE).oneOf()
    initialize(choice)
  }

  action begin(kind: int): bool = all {
    s.o.calls.length() < MAX_CALLS,
    input' = { name: "beginCall", choice: kind },
    s' = Deadlines::admitLocal(s, LAYOUT, call(kind))
  }
  action beginCall = {
    nondet choice = Set(ENABLED, OUTSIDE, INVALID_KEY, OUTSIDE_INVALID_KEY).oneOf()
    begin(choice)
  }

  // The drivers release a held policy reply by its policy call index.
  action release(id: int): bool = all {
    Gate::holds(s, id),
    input' = { name: "releasePolicy", choice: id },
    s' = Deadlines::releaseLocal(s, LAYOUT, id, LOCAL, TTLS)
  }
  action releasePolicy = { nondet choice = 0.to(MAX_CALLS - 1).oneOf(); release(choice) }

  action resolved(id: int, value: int): bool = all {
    id < s.sources.length(),
    Deadlines::pending(s, id),
    input' = { name: "resolveLoader", choice: id * 2 + value },
    s' = Deadlines::settleLocal(s, LAYOUT, id, value)
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_CALLS * 2).oneOf()
    resolved(resolvedSource(choice), resolvedValue(choice))
  }
  action rejected(id: int): bool = all {
    id < s.sources.length(),
    Deadlines::pending(s, id),
    input' = { name: "rejectLoader", choice: id },
    s' = Deadlines::settleLocal(s, LAYOUT, id, SOURCE_ERROR)
  }
  action rejectLoader = { nondet choice = 0.to(MAX_CALLS - 1).oneOf(); rejected(choice) }

  action advanced(delta: int): bool = all {
    s.now + delta <= MAX_TIME_MS,
    input' = { name: "advance", choice: delta },
    s' = Deadlines::advanceLocal(s, LAYOUT, delta)
  }
  action advance = { nondet choice = Set(1, 3, 6, 9, 10, 100, 59999, 60001).oneOf(); advanced(choice) }
  action step = any { beginCall, releasePolicy, resolveLoader, rejectLoader, advance }

  // -- Independently stated safety properties --------------------------------
  // A property about an admission is stated about the step that just admitted:
  // the newest caller and, when it started one, the newest source. A property
  // about a publication is stated about the step that just settled: the source
  // and value the resolve input names.

  val newestSource = s.sources.length() - 1
  val justAdmitted = input.name == "beginCall"
  val outsideAdmission = justAdmitted and (input.choice == OUTSIDE or input.choice == OUTSIDE_INVALID_KEY)
  // A source started outside every request has no deadline, warms nothing and
  // shares nothing; a source without a deadline never expires.
  val outsideSourcesHaveNoDeadline = s.budgets.indices().forall(i =>
      s.budgets.nth(i) >= 0 or s.sources.nth(i).result != DEADLINE_ERROR)
    and (not(outsideAdmission) or (s.budgets.nth(newestSource) == Deadlines::UNBOUNDED
      and s.sources.nth(newestSource).localMs == 0 and not(s.sources.nth(newestSource).shared)))
  val acceptedSourceRespectsItsOwnStart = s.sources.indices().forall(i =>
    not(accepted(s.sources.nth(i).result))
      or (s.settledAt.nth(i) >= s.started.nth(i) and
        (s.budgets.nth(i) < 0 or s.settledAt.nth(i) < s.started.nth(i) + s.budgets.nth(i))))
  val registeredWorkIsNotAbandoned = s.processFlights.nth(0) < 0
    or s.sources.nth(s.processFlights.nth(0)).result == CALL_PENDING
  // The local slot is empty exactly when no source that captured a local TTL
  // has settled accepted, and otherwise holds a value one of them published
  // (never an error code, never a bypass source's value; a failed settlement
  // leaves the slot as it was); and the settlement that just happened owns the
  // slot: when the source the resolve input names captured a local TTL and its
  // outcome is accepted (the kernel settles a late result as a deadline error
  // and drains an already-settled source without effect), the slot holds the
  // value the input delivered, stamped with that TTL from now, whatever it held
  // before. A rejection settles SOURCE_ERROR and publishes nothing.
  val justSettled = input.name == "resolveLoader"
  val localPublicationRequiresAcceptedSource = {
    val publishers = s.sources.indices().filter(i => s.sources.nth(i).localMs > 0 and accepted(s.sources.nth(i).result))
    val value = s.localValues.nth(0)
    (value != NO_VALUE) == (publishers.size() > 0)
      and (value == NO_VALUE or publishers.exists(i => s.sources.nth(i).result == value))
      and (not(justSettled) or {
        val source = s.sources.nth(resolvedSource(input.choice))
        not(source.localMs > 0 and accepted(source.result))
          or (value == resolvedValue(input.choice) and s.localExpires.nth(0) == s.now + source.localMs)
      })
  }
  val followersKeepTheirOwnersOutcome = s.owners.indices().forall(call => {
    val owner = s.owners.nth(call)
    owner < 0 or s.o.calls.nth(call) == s.sources.nth(owner).result
  })
  // Only an enabled call makes a policy call: the newest caller waits for a
  // reply exactly when it was admitted enabled, and over the whole history the
  // policy calls are the callers admitted enabled: each is held, served from
  // local or owns a shared source (every reply here enables the shared local
  // layer), while a bypass caller owns an unshared one.
  val onlyEnabledValidCallsResolvePolicy = (not(justAdmitted)
      or ((input.choice == ENABLED) == (s.held.select(held => held.caller == s.o.calls.length() - 1).length() > 0)))
    and s.o.policyCalls == s.owners.indices().filter(c => s.owners.nth(c) == NO_OWNER or s.sources.nth(s.owners.nth(c)).shared).size()

  run outsideAndInvalidOutsideCallsIgnoreDeadlineAndSharingTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(OUTSIDE)).then(begin(OUTSIDE_INVALID_KEY)).then(advanced(100))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.policyCalls == 0 and s.o.loaders == 2)
    .then(resolved(0, VALUE_ONE)).then(resolved(1, VALUE_TWO))
    .then(begin(ENABLED)).then(release(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, CALL_PENDING) and s.o.loaders == 3)

  run defaultSourceBudgetExpiresAtSixtySecondsTest = initialize(DEFAULT_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(advanced(59999))
    .expect(s.o.calls == List(CALL_PENDING))
    .then(advanced(1)).then(resolved(0, VALUE_ONE))
    .then(begin(ENABLED)).then(release(1))
    .expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING) and s.o.loaders == 2)

  run unboundedEnabledSourcePublishesAfterSixtySecondsTest = initialize(UNBOUNDED_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(advanced(60001))
    .expect(s.o.calls == List(CALL_PENDING))
    .then(resolved(0, VALUE_ONE)).then(begin(ENABLED)).then(release(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)

  run lateFollowerUsesLeadersRemainingBudgetTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(advanced(6))
    .then(begin(ENABLED)).then(release(1)).then(advanced(3))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 1)
    .then(advanced(1))
    .expect(s.o.calls == List(DEADLINE_ERROR, DEADLINE_ERROR))

  run heldPolicyDoesNotSpendSourceBudgetTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(ENABLED)).then(advanced(100))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.loaders == 0)
    .then(release(0)).then(advanced(9)).then(resolved(0, VALUE_ONE))
    .then(begin(ENABLED)).then(release(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)

  run invalidKeyStillKeepsEnabledSourceDeadlineTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(INVALID_KEY)).then(advanced(9))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.policyCalls == 0)
    .then(advanced(1)).then(resolved(0, VALUE_ONE))
    .then(begin(ENABLED)).then(release(0))
    .expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING) and s.o.loaders == 2)

  run abandonedSourceCannotReplaceSuccessfulRetryTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(advanced(10))
    .then(begin(ENABLED)).then(release(1)).then(resolved(1, VALUE_TWO))
    .then(resolved(0, VALUE_ONE)).then(begin(ENABLED)).then(release(2))
    .expect(s.o.calls == List(DEADLINE_ERROR, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2)

  // A published local entry serves until its insertion TTL and not at it: a
  // same-key call one millisecond before expiry is served locally, the next
  // call at the exact boundary starts a source (C09). The clock reaches
  // LOCAL_TTL_MS - 1 through the drivers' advance choices (nine hundreds,
  // nine tens, one nine).
  run localEntryExpiresAfterItsTtlTest = initialize(DEFAULT_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(resolved(0, VALUE_ONE))
    .then(9.reps(_ => advanced(100))).then(9.reps(_ => advanced(10))).then(advanced(9))
    .expect(s.now == LOCAL_TTL_MS - 1)
    .then(begin(ENABLED)).then(release(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
    .then(advanced(1)).then(begin(ENABLED)).then(release(2))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)
    .then(resolved(1, VALUE_TWO)).then(begin(ENABLED)).then(release(3))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2)

  // A failed settlement is not a writer (C13): a rejected source completes its
  // caller with the source error and leaves the published local entry, which
  // still serves the next enabled call.
  run rejectedSourceLeavesPublishedLocalEntryTest = initialize(DEFAULT_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(resolved(0, VALUE_ONE))
    .then(begin(OUTSIDE)).then(rejected(1))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR) and s.o.loaders == 2)
    .then(begin(ENABLED)).then(release(1))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR, VALUE_ONE) and s.o.loaders == 2)

  // The latest accepted source owns the entry even when its value equals the
  // one it replaces (C13): the entry published at 0 expires at LOCAL_TTL_MS,
  // the enabled call at that instant starts a source, and the equal value it
  // republishes serves one millisecond before 2 * LOCAL_TTL_MS because the
  // insertion expiry was stamped again. The clock reaches each instant
  // through the drivers' advance choices (ten hundreds; nine hundreds, nine
  // tens, one nine).
  run republishedEqualValueRestampsLocalExpiryTest = initialize(DEFAULT_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(resolved(0, VALUE_ONE))
    .then(10.reps(_ => advanced(100)))
    .expect(s.now == LOCAL_TTL_MS)
    .then(begin(ENABLED)).then(release(1))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)
    .then(resolved(1, VALUE_ONE))
    .then(9.reps(_ => advanced(100))).then(9.reps(_ => advanced(10))).then(advanced(9))
    .expect(s.now == 2 * LOCAL_TTL_MS - 1)
    .then(begin(ENABLED)).then(release(2))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 2)
}

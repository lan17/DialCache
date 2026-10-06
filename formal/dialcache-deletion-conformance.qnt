module dialcache_deletion_conformance {
  import conformance_observations.* from "./conformance-observations"
  import payloads as Payloads from "./kernel/payloads"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import recovery as Recovery from "./kernel/recovery"
  import serving as Serving from "./kernel/serving"
  import remote_frames as Remote from "./kernel/remote-frames"
  import flights as Flights from "./kernel/flights"
  import clock as Clock from "./kernel/clock"
  import policy_gate as Gate from "./kernel/policy-gate"
  // C61-C63: exact maintenance over request, local and remote storage. Two
  // entities x two operations, two instances, three persistent request roots,
  // fresh contexts, a disabled child and an outside context distinguish owners.
  // The four abstract identities stand for reader key bytes; native key/wire
  // tests distinguish argument, namespace and tracking-mode encodings.
  // All TTLs are 60 seconds; 1 ms ticks keep entries fresh at these bounds.
  // Receipts snapshot each store, watermark and flight registry before delete;
  // only public inputs and observations enter implementation replay.
  // The environment controls source settlement, seeding, invalidation, scope
  // closure, policy, mutation failure and optional held snapshot decoding.
  // No delete cancels admitted work or promises a publication barrier.
  // Every cache transition belongs to the kernel; this module supplies bounded
  // state, external choices, independent properties and twenty caller slots.

  // -- Fixture, context and identity encodings (policy codes and sentinels are
  // the library's: layer_policy and encodings) --------------------------------

  pure val FIXTURE_UNTRACKED = 0
  pure val FIXTURE_TRACKED = 1
  pure val FIXTURE_ZERO_CAPACITY_UNTRACKED = 2
  pure val FIXTURE_ZERO_CAPACITY_TRACKED = 3
  pure val FIXTURE_WITHOUT_REMOTE = 4
  pure val FIXTURE_TRACKED_WITHOUT_REMOTE = 5
  pure val FIRST_REQUEST_CONTEXT = 0
  pure val SECOND_REQUEST_CONTEXT = 1
  pure val OTHER_INSTANCE_REQUEST_CONTEXT = 2
  pure val FRESH_FIRST_INSTANCE_CONTEXT = 3
  pure val FRESH_OTHER_INSTANCE_CONTEXT = 4
  pure val FIRST_INSTANCE = 0
  pure val OTHER_INSTANCE = 1
  pure val KEY_A = 0
  pure val KEY_A_OTHER_OPERATION = 1
  pure val KEY_B = 2
  pure val KEY_B_OTHER_OPERATION = 3
  pure val KEYS_PER_INSTANCE = 4
  pure val OPERATIONS_PER_ENTITY = 2
  pure val PERSISTENT_CONTEXTS = 3
  pure val DEFAULT_LOCAL_CAPACITY = 2
  pure val NO_LOCAL_CAPACITY = 0
  pure val MAX_CALLERS = 20
  pure val MAX_CONTEXT_KEY_CHOICE = 27
  pure val MAX_RESOLVE_CHOICE = 40
  pure val MAX_SEED_CHOICE = 7
  pure val SOURCE_VALUE_COUNT = 2
  pure val INITIAL_TIME_MS = 10000
  pure val SERVING_TTL_MS = 60000

  // -- Bounded state and layout ----------------------------------------------

  type DeleteReceipt = {
    instance: int, context: int, key: int, outcome: str,
    localValues: List[int], localExpires: List[int], lru: List[List[int]], memo: List[int],
    remoteValues: List[int], expires: List[int], created: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], requestFlights: List[int], processFlights: List[int],
    calls: List[int], policyCalls: int
  }
  pure val NO_DELETE: DeleteReceipt = {
    instance: 0, context: 0, key: 0, outcome: "none",
    localValues: List(), localExpires: List(), lru: List(), memo: List(),
    remoteValues: List(), expires: List(), created: List(), watermark: List(),
    sources: List(), requestFlights: List(), processFlights: List(), calls: List(), policyCalls: 0
  }
  type State = {
    o: Observation,
    io: RemoteIO::IO, reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad],
    loaders: List[int], retained: List[Recovery::Snapshot], holdLoads: bool,
    receipt: DeleteReceipt,
    remoteDeletes: bool,
    now: int,
    skew: int,
    tracked: bool,
    remoteAvailable: bool,
    capacity: int,
    readFailed: bool,
    dumpFailed: bool,
    writeFailed: bool,
    policy: int,
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
    callerInstances: List[int],
    callerKeys: List[int],
    held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }
  pure def zeros(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(0))
  pure def slots(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(NO_OWNER))
  // Input decoding: which instance each context lives on, and the call a
  // context-and-key choice asks for, including disabled and outside calls.
  pure def instance(context: int): int = if (context == OTHER_INSTANCE_REQUEST_CONTEXT
    or context == FRESH_OTHER_INSTANCE_CONTEXT) OTHER_INSTANCE else FIRST_INSTANCE
  pure def call(choice: int): Call = {
    instance: instance(choice / KEYS_PER_INSTANCE), key: choice % KEYS_PER_INSTANCE, context: if (choice / KEYS_PER_INSTANCE == 5) 0 else choice / KEYS_PER_INSTANCE,
    enabled: choice / KEYS_PER_INSTANCE < 5, keyFailed: false
  }
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: KEYS_PER_INSTANCE,
    keysPerScope: KEYS_PER_INSTANCE,
    persistentContexts: PERSISTENT_CONTEXTS,
    operationsPerEntity: OPERATIONS_PER_ENTITY,
    probeSourceScope: false, policyProvider: true
  }
  // Every reply here carries the fixture's TTLs: 60 s local, fresh and retained.
  pure val TTLS: Ttls = { localMs: SERVING_TTL_MS, freshMs: SERVING_TTL_MS, retentionMs: SERVING_TTL_MS }

  // -- Public fixture inputs and external effects ----------------------------

  action initialize(fixture: int): bool = all {
    s' = {
      o: empty,
      io: RemoteIO::NO_IO, reads: List(), loads: List(), loaders: List(), retained: List(), holdLoads: false,
      receipt: NO_DELETE,
      remoteDeletes: fixture != 6,
      now: INITIAL_TIME_MS,
      skew: 0,
      tracked: fixture % 2 == FIXTURE_TRACKED,
      remoteAvailable: fixture < FIXTURE_WITHOUT_REMOTE or fixture == 6,
      capacity: if (Set(FIXTURE_ZERO_CAPACITY_UNTRACKED, FIXTURE_ZERO_CAPACITY_TRACKED).contains(fixture))
        NO_LOCAL_CAPACITY else DEFAULT_LOCAL_CAPACITY,
      readFailed: false,
      dumpFailed: false,
      writeFailed: false,
      policy: ALL_LAYERS,
      closed: List(false, false, false),
      memo: zeros(12),
      requestFlights: slots(12),
      processFlights: slots(8),
      localValues: zeros(8),
      localExpires: zeros(8),
      lru: List(List(), List()),
      remoteValues: zeros(4),
      created: zeros(4),
      expires: zeros(4),
      watermark: zeros(2),
      sources: List(),
      owners: List(),
      memoSlots: List(),
      callerInstances: List(),
      callerKeys: List(),
      held: List()
    },
    input' = { name: "init", choice: fixture }
  }
  action init = {
    nondet choice = FIXTURE_UNTRACKED.to(6).oneOf()
    initialize(choice)
  }
  // The environment can hold decode completion after the remote bytes have
  // been acquired. It changes scheduling only; both paths reuse the kernel.
  pure def sourceIndex(state: State, loader: int): int = if (state.holdLoads) state.loaders.nth(loader) else loader
  pure def sourceCount(state: State): int = if (state.holdLoads) state.loaders.length() else state.sources.length()
  action startCall(choice: int): bool = all {
    s.o.calls.length() < MAX_CALLERS,
    input' = { name: "beginCall", choice: choice },
    if (not(s.holdLoads)) {
      s' = Flights::recordIdentity(Serving::begin(s, LAYOUT, call(choice), resolution(s.policy, s.remoteAvailable), TTLS), call(choice))
    } else {
      val entered = RemoteIO::begin(s, LAYOUT, call(choice), resolution(s.policy, s.remoteAvailable), TTLS, 30000000)
      if (entered.o.reads == s.o.reads) s' = Flights::recordIdentity(entered, call(choice))
      else s' = Flights::recordIdentity(RemoteIO::settleRead(entered, LAYOUT, RemoteIO::latestRead(entered).read, false, Recovery::NONE), call(choice))
    }
  }
  action beginCall = {
    nondet choice = 0.to(MAX_CONTEXT_KEY_CHOICE).oneOf()
    startCall(choice)
  }
  action finishSource(loader: int, value: int): bool = all {
    if (s.holdLoads) s' = RemoteIO::settleLoader(s, LAYOUT, loader, value, false)
    else s' = Serving::settle(s, LAYOUT, loader, value),
    input' = if (value == SOURCE_ERROR) { name: "rejectLoader", choice: loader }
      else { name: "resolveLoader", choice: loader * SOURCE_VALUE_COUNT + value }
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_RESOLVE_CHOICE).filter(code =>
      (code - 1) / SOURCE_VALUE_COUNT < sourceCount(s)
      and s.sources.nth(sourceIndex(s, (code - 1) / SOURCE_VALUE_COUNT)).result == CALL_PENDING
    ).oneOf()
    finishSource((choice - 1) / SOURCE_VALUE_COUNT, (choice - 1) % SOURCE_VALUE_COUNT + VALUE_ONE)
  }
  action rejectLoader = {
    nondet choice = 0.to(sourceCount(s) - 1).filter(i => s.sources.nth(sourceIndex(s, i)).result == CALL_PENDING).oneOf()
    finishSource(choice, SOURCE_ERROR)
  }
  action closeContext(context: int): bool = all {
    s' = Serving::closeScope(s, LAYOUT, context),
    input' = { name: "closeScope", choice: context }
  }
  action closeScope = {
    nondet choice = FIRST_REQUEST_CONTEXT.to(OTHER_INSTANCE_REQUEST_CONTEXT)
      .filter(scope => not(s.closed.nth(scope))).oneOf()
    closeContext(choice)
  }
  action changePolicy(policy: int): bool = all {
    s' = { policy: policy, ...s },
    input' = { name: "policy", choice: policy }
  }
  action policy = {
    nondet choice = ALL_LAYERS.to(NO_LAYERS).oneOf()
    changePolicy(choice)
  }
  action seedRemote(key: int, value: int): bool = all {
    s' = Remote::seedFrame(s, key, value, SERVING_TTL_MS),
    input' = { name: "seed", choice: key * SOURCE_VALUE_COUNT + value - 1 }
  }
  action seed = {
    nondet choice = 0.to(MAX_SEED_CHOICE).oneOf()
    seedRemote(choice / SOURCE_VALUE_COUNT, choice % SOURCE_VALUE_COUNT + VALUE_ONE)
  }
  action invalidateEntity(entity: int): bool = all {
    s' = Serving::invalidate(s, entity, 0),
    input' = { name: "invalidate", choice: entity }
  }
  action invalidate = {
    nondet choice = Set(0, 1).oneOf()
    invalidateEntity(choice)
  }
  action tick = all {
    s' = Clock::advance(s, 1),
    input' = { name: "tick", choice: -1 }
  }

  // Context 5 is a disabled child of request 0; 6 is outside all scopes.
  // Both remain useful maintenance contexts regardless of reader enablement.
  action remove(choice: int): bool = {
    val selected = call(choice)
    val context = selected.context
    val deleted = Serving::deleteEntry(s, LAYOUT, selected.instance, context, selected.key, context < 3)
    all {
      s' = { receipt: {
        instance: selected.instance, context: choice / KEYS_PER_INSTANCE, key: selected.key,
        outcome: Serving::maintenanceOutcome(deleted),
        localValues: s.localValues, localExpires: s.localExpires, lru: s.lru, memo: s.memo,
        remoteValues: s.remoteValues, expires: s.expires, created: s.created, watermark: s.watermark,
        sources: s.sources, requestFlights: s.requestFlights, processFlights: s.processFlights,
        calls: s.o.calls, policyCalls: s.o.policyCalls
      }, ...deleted },
      input' = { name: "deleteEntry", choice: choice }
    }
  }
  action deleteEntry = { nondet choice = 0.to(27).oneOf(); remove(choice) }
  action setRemoteFault(choice: int): bool = all {
    s' = { writeFailed: choice == 1, ...s },
    input' = { name: "remoteFault", choice: choice }
  }
  action remoteFault = { nondet choice = Set(0, 1).oneOf(); setRemoteFault(choice) }
  action holdDecoding = all {
    s.o.calls.length() == 0,
    s' = { holdLoads: true, ...s },
    input' = { name: "holdDecoding", choice: -1 }
  }
  action releaseDecode(index: int): bool = all {
    RemoteIO::holdsLoad(s, index),
    s' = RemoteIO::settleLoad(s, LAYOUT, index, false),
    input' = { name: "releaseLoad", choice: index }
  }
  action releaseLoad = { nondet choice = s.loads.indices().map(i => s.loads.nth(i).load).oneOf(); releaseDecode(choice) }
  action step = any { beginCall, resolveLoader, deleteEntry, releaseLoad, holdDecoding, any { rejectLoader, policy, seed, invalidate, tick, closeScope, remoteFault } }

  // Receipts are read only here, independently of the transition they guard.
  val atomicPathSeedsDecodableFrames = Payloads::atomicSafe(s)
  val justDeleted = input.name == "deleteEntry"
  val receiptLocalSlot = s.receipt.instance * KEYS_PER_INSTANCE + s.receipt.key
  val receiptContext = if (s.receipt.context == 5) 0 else s.receipt.context
  val receiptMemoSlot = if (receiptContext < 3) receiptContext * KEYS_PER_INSTANCE + s.receipt.key else -1
  val deletionStoresUnchanged = and {
    s.localValues == s.receipt.localValues, s.localExpires == s.receipt.localExpires,
    s.lru == s.receipt.lru, s.memo == s.receipt.memo,
    s.remoteValues == s.receipt.remoteValues, s.expires == s.receipt.expires,
    s.created == s.receipt.created, s.watermark == s.receipt.watermark
  }
  val deletedSlotsAbsent = and {
    s.localValues.nth(receiptLocalSlot) == NO_VALUE,
    s.localExpires.nth(receiptLocalSlot) == 0,
    s.lru.nth(s.receipt.instance).select(k => k == s.receipt.key).length() == 0,
    receiptMemoSlot < 0 or s.memo.nth(receiptMemoSlot) == NO_VALUE,
    not(s.remoteAvailable) or (s.remoteValues.nth(s.receipt.key) == NO_VALUE and s.expires.nth(s.receipt.key) == 0)
  }
  val okDeleteLeavesKeyAbsentEverywhere = not(justDeleted and s.receipt.outcome == "ok") or deletedSlotsAbsent
  val deleteLeavesWatermarks = not(justDeleted) or s.watermark == s.receipt.watermark
  val deleteTouchesOnlyItsKey = not(justDeleted) or and {
    s.localValues.indices().forall(i => i == receiptLocalSlot or (s.localValues.nth(i) == s.receipt.localValues.nth(i)
      and s.localExpires.nth(i) == s.receipt.localExpires.nth(i))),
    s.memo.indices().forall(i => i == receiptMemoSlot or s.memo.nth(i) == s.receipt.memo.nth(i)),
    s.remoteValues.indices().forall(i => i == s.receipt.key or (s.remoteValues.nth(i) == s.receipt.remoteValues.nth(i)
      and s.expires.nth(i) == s.receipt.expires.nth(i))),
    s.created == s.receipt.created,
    s.lru.indices().forall(i => if (i != s.receipt.instance) s.lru.nth(i) == s.receipt.lru.nth(i)
      else s.lru.nth(i).select(k => k != s.receipt.key) == s.receipt.lru.nth(i).select(k => k != s.receipt.key)),
    s.o.calls == s.receipt.calls, s.o.policyCalls == s.receipt.policyCalls
  }
  val failedDeleteChangesNothing = not(justDeleted and s.remoteAvailable and (not(s.remoteDeletes) or s.writeFailed))
    or (deletionStoresUnchanged and s.receipt.outcome == (if (not(s.remoteDeletes)) "unsupported" else "mutation_error"))
  val deleteIgnoresEnablement = not(justDeleted and s.receipt.outcome == "ok" and s.receipt.context >= 5) or deletedSlotsAbsent
  val deleteLeavesFlights = not(justDeleted) or (s.sources == s.receipt.sources
    and s.requestFlights == s.receipt.requestFlights and s.processFlights == s.receipt.processFlights)
  val receiptWasAbsent = s.receipt.localValues.nth(receiptLocalSlot) == NO_VALUE
    and (receiptMemoSlot < 0 or s.receipt.memo.nth(receiptMemoSlot) == NO_VALUE)
    and (not(s.remoteAvailable) or s.receipt.remoteValues.nth(s.receipt.key) == NO_VALUE)
  val absentDeleteReportsOk = not(justDeleted and receiptWasAbsent and (not(s.remoteAvailable) or (s.remoteDeletes and not(s.writeFailed))))
    or (s.receipt.outcome == "ok" and deletionStoresUnchanged)

  action untrackedFixture = initialize(0)
  action trackedFixture = initialize(1)
  run deleteRemovesRequestLocalAndRemoteTest = untrackedFixture
    .then(startCall(0)).then(finishSource(0, VALUE_ONE)).then(remove(0)).then(startCall(0))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 2
      and s.o.deletions == 1 and s.o.maintenance == List("ok"))
  run deleteFromDisabledContextRemovesTest = untrackedFixture
    .then(startCall(0)).then(finishSource(0, VALUE_ONE)).then(remove(20)).then(startCall(0))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 2)
  run deleteOutsideAnyScopeRemovesSharedLayersTest = untrackedFixture
    .then(startCall(0)).then(finishSource(0, VALUE_ONE)).then(remove(24))
    .then(startCall(0)).then(startCall(12))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 2)
  run deleteWithoutRemoteRemovesLocalTest = initialize(4)
    .then(startCall(12)).then(finishSource(0, VALUE_ONE)).then(remove(24)).then(startCall(12))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2 and s.o.deletions == 0
      and s.o.maintenance == List("ok"))
  run deleteUnsupportedRemoteChangesNothingTest = initialize(6)
    .then(startCall(0)).then(finishSource(0, VALUE_ONE)).then(remove(0))
    .expect(s.o.deletions == 0 and s.o.maintenance == List("unsupported"))
    .then(startCall(0)).then(changePolicy(NO_REMOTE_LAYER)).then(startCall(12))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
    .then(changePolicy(NO_LOCAL_LAYER)).then(startCall(12))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
  run remoteDeleteFailureKeepsLocalTest = untrackedFixture
    .then(startCall(0)).then(finishSource(0, VALUE_ONE)).then(setRemoteFault(1)).then(remove(0))
    .expect(s.o.deletions == 1 and s.o.maintenance == List("mutation_error"))
    .then(startCall(0)).then(changePolicy(NO_REMOTE_LAYER)).then(startCall(12))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
    .then(changePolicy(NO_LOCAL_LAYER)).then(startCall(12))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
  run deletePreservesWatermarkAndSiblingVariantsTest = trackedFixture
    .then(seedRemote(0, VALUE_ONE)).then(seedRemote(1, VALUE_TWO)).then(startCall(0)).then(startCall(1))
    .then(invalidateEntity(0)).then(remove(0)).then(startCall(1))
    .then(changePolicy(NO_LOCAL_LAYER)).then(startCall(13))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO, CALL_PENDING)
      and s.o.loaders == 1 and s.o.invalidations == 1 and s.o.deletions == 1)
  run deleteOneInstanceLeavesOtherInstanceTest = untrackedFixture
    .then(seedRemote(0, VALUE_ONE)).then(startCall(12)).then(startCall(16)).then(remove(24)).then(startCall(16))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 0)
    .then(startCall(12)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.loaders == 1)
  run lateFillAfterDeleteRepopulatesTest = untrackedFixture
    .then(startCall(12)).then(remove(24)).then(startCall(12))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 1)
    .then(finishSource(0, VALUE_TWO)).then(startCall(12))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO, VALUE_TWO) and s.o.loaders == 1 and s.o.writes == 1)
  run acquiredReadAfterDeleteStillReturnsTest = untrackedFixture.then(holdDecoding)
    .then(seedRemote(0, VALUE_ONE)).then(startCall(0))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.loads == 1 and s.o.loaders == 0)
    .then(remove(0)).then(releaseDecode(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0 and s.o.deletions == 1)
    .then(startCall(0)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
  run deleteAbsentKeyReportsOkTest = untrackedFixture.then(remove(24))
    .expect(s.o.maintenance == List("ok") and s.o.deletions == 1 and s.o.policyCalls == 0)
    .then(startCall(12)).expect(s.o.calls == List(CALL_PENDING) and s.o.loaders == 1)
  run deleteThenReadMissesAndReloadsTest = untrackedFixture
    .then(startCall(0)).then(finishSource(0, VALUE_ONE)).then(remove(0)).then(startCall(0))
    .then(finishSource(1, VALUE_TWO)).then(startCall(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2 and s.o.writes == 2)
  run deletePreservesSiblingAndOtherRequestTest = untrackedFixture
    .then(seedRemote(0, VALUE_ONE)).then(seedRemote(1, VALUE_TWO))
    .then(startCall(0)).then(startCall(1)).then(startCall(4)).then(remove(0))
    .then(changePolicy(NO_REMOTE_LAYER)).then(startCall(13)).then(startCall(4))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 0)
    .then(changePolicy(NO_LOCAL_LAYER)).then(startCall(13))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO) and s.o.reads == 3)
  run deleteAbsentLocalOnlyReportsOkTest = initialize(4).then(remove(24))
    .expect(s.o.maintenance == List("ok") and s.o.deletions == 0 and s.o.policyCalls == 0)
}

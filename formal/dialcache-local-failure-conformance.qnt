module dialcache_local_failure_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import local_faults as Faults from "./kernel/local-faults"
  import remote_frames as Remote from "./kernel/remote-frames"
  import flights as Flights from "./kernel/flights"
  import policy_gate as Gate from "./kernel/policy-gate"

  // C27: local plumbing can fail without changing an accepted caller result.
  // Two persistent requests and a transient request distinguish memo ownership
  // from process-local publication. The remote layer is untracked. One source
  // is active at a time, with unbounded source time and no elapsed-time steps.
  // Native bindings inject failure at local storage/its integer-clock boundary.
  // A read fault is exercised on a present entry; a write fault is armed while
  // source work is pending. Successful operations use the real native storage.
  // Every rule is a kernel transition (formal/kernel): the layered traversal
  // with the local fault switch read at admission and settlement
  // (`local_faults`). This module owns the bounded state, the scope and policy
  // decoding, the input choices and the guards.

  pure val ROOT_REQUEST = 0
  pure val SECOND_REQUEST = 1
  pure val TRANSIENT_REQUEST = 2
  pure val MAX_CALLS = 10
  pure val SERVING_TTL_MS = 60000
  // One key on one instance, two persistent request scopes and a transient
  // one, one operation per entity; the fixture installs a policy provider.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true
  }
  pure val TTLS: Ttls = { localMs: SERVING_TTL_MS, freshMs: SERVING_TTL_MS, retentionMs: SERVING_TTL_MS }

  type State = {
    o: Observation,
    now: int,
    skew: int,
    remoteAvailable: bool,
    tracked: bool,
    capacity: int,
    readFailed: bool,
    dumpFailed: bool,
    writeFailed: bool,
    localFailed: bool,
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
    held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }

  // Input decoding: every call is enabled on the one key; the two persistent
  // scopes memoize, the transient one does not. The remote ramp reply is the
  // drivers' layer policy code: all layers, or every layer but the remote one.
  pure def call(scope: int): Call = { instance: 0, key: 0, context: scope, enabled: true, keyFailed: false }
  pure def policyOf(selected: int): int = if (selected == 1) ALL_LAYERS else NO_REMOTE_LAYER

  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty,
      now: 0,
      skew: 0,
      remoteAvailable: true,
      tracked: false,
      capacity: 1,
      readFailed: false,
      dumpFailed: false,
      writeFailed: false,
      localFailed: false,
      policy: ALL_LAYERS,
      closed: List(false, false),
      memo: List(NO_VALUE, NO_VALUE),
      requestFlights: List(NO_OWNER, NO_OWNER),
      processFlights: List(NO_OWNER),
      localValues: List(NO_VALUE),
      localExpires: List(0),
      lru: List(List()),
      remoteValues: List(NO_VALUE),
      created: List(0),
      expires: List(0),
      watermark: List(0),
      sources: List(),
      owners: List(),
      memoSlots: List(),
      held: List()
    }
  }

  // One source at a time: the newest source is the pending one, if any.
  val pending = s.sources.length() > 0 and s.sources.nth(Flights::latest(s)).result == CALL_PENDING

  action begin(scope: int): bool = all {
    not(pending), s.o.calls.length() < MAX_CALLS,
    // The two native injection bindings share this fallible-read domain.
    not(s.localFailed) or s.localValues.nth(0) != NO_VALUE,
    input' = { name: "beginCall", choice: scope },
    s' = Faults::begin(s, LAYOUT, call(scope), resolution(s.policy, s.remoteAvailable), TTLS)
  }
  action beginCall = { nondet choice = Set(0, 1, 2).oneOf(); begin(choice) }

  action resolve(value: int): bool = all {
    pending,
    input' = { name: "resolveLoader", choice: value },
    s' = Faults::settle(s, LAYOUT, Flights::latest(s), value)
  }
  action resolveLoader = { nondet choice = Set(VALUE_ONE, VALUE_TWO).oneOf(); resolve(choice) }
  action rejectLoader = all {
    pending, input' = { name: "rejectLoader", choice: -1 },
    s' = Faults::settle(s, LAYOUT, Flights::latest(s), SOURCE_ERROR)
  }
  action fault(selected: int): bool = all {
    input' = { name: "localFault", choice: selected },
    s' = { localFailed: selected == 1, ...s }
  }
  action localFault = { nondet choice = Set(0, 1).oneOf(); fault(choice) }
  action remotePolicy(selected: int): bool = all {
    input' = { name: "policy", choice: selected },
    s' = { policy: policyOf(selected), ...s }
  }
  action policy = { nondet choice = Set(0, 1).oneOf(); remotePolicy(choice) }
  action seeded(value: int): bool = all {
    input' = { name: "seed", choice: value }, s' = Remote::seedFrame(s, 0, value, SERVING_TTL_MS)
  }
  action seed = { nondet choice = Set(VALUE_ONE, VALUE_TWO).oneOf(); seeded(choice) }
  action step = any { beginCall, resolveLoader, rejectLoader, localFault, policy, seed }

  // -- Independently stated safety properties --------------------------------
  // Stated one step over the library records: the step that just admitted
  // (the newest caller and, when it started one, the newest source) and the
  // step that just settled (the newest source, the one settlement names).

  val newest = s.o.calls.length() - 1
  val justAdmitted = input.name == "beginCall"
  val justSettled = input.name == "resolveLoader" or input.name == "rejectLoader"
  // A call admitted under an armed fault reads nothing from local storage: it
  // is served from its scope's memo or from the remote frame, or it starts a
  // source that captured no local TTL, so no later settlement of that source
  // can publish locally, whatever the switch says by then. The no-warm half (a
  // faulted remote hit leaves local storage as it was) is not stated here, as
  // the slot may already hold the served value; the regression
  // localReadFailureFallsThroughAndPreservesOldLocalTest pins it.
  val faultedReadNeverUsesLocal = not(justAdmitted and s.localFailed) or {
    val owner = s.owners.nth(newest)
    val value = s.o.calls.nth(newest)
    if (owner >= 0) s.sources.nth(owner).localMs == 0
    else (input.choice < 2 and s.memo.nth(input.choice) == value) or s.remoteValues.nth(0) == value
  }
  // A settlement under an armed fault carries no local TTL: the write it would
  // have made is the one that failed. Its callers still receive the result.
  val faultedSettlementPublishesNothingLocally = not(justSettled and s.localFailed)
    or s.sources.nth(Flights::latest(s)).localMs == 0
  val callsKeepSourceOutcome = s.owners.indices().forall(caller => {
    val owner = s.owners.nth(caller)
    owner < 0 or s.o.calls.nth(caller) == s.sources.nth(owner).result
  })
  // Storage and memo hold accepted values only: a rejected source publishes
  // and memoizes nothing, and a caller result is never an error code stored.
  val storageHoldsAcceptedValuesOnly = and {
    s.localValues.nth(0) == NO_VALUE or accepted(s.localValues.nth(0)),
    s.remoteValues.nth(0) == NO_VALUE or accepted(s.remoteValues.nth(0)),
    s.memo.indices().forall(slot => s.memo.nth(slot) == NO_VALUE or accepted(s.memo.nth(slot)))
  }

  run localReadFailureFallsThroughAndPreservesOldLocalTest = init
    .then(begin(2)).then(resolve(VALUE_ONE))
    .then(seeded(VALUE_TWO)).then(fault(1)).then(begin(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.reads == 2 and s.o.loaders == 1)
    .then(fault(0)).then(begin(2)).then(begin(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO)
      and s.o.reads == 2 and s.o.loaders == 1)

  run localReadFailureSkipsSourcePublicationButMemoizesTest = init
    .then(begin(2)).then(resolve(VALUE_ONE))
    .then(remotePolicy(0)).then(fault(1)).then(begin(0)).then(fault(0))
    .then(resolve(VALUE_TWO)).then(begin(2)).then(begin(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO)
      and s.o.loaders == 2 and s.o.writes == 1)

  run localWriteFailureKeepsSourceAndRequestMemoTest = init
    .then(begin(0)).then(fault(1)).then(resolve(VALUE_ONE)).then(fault(0))
    .then(remotePolicy(0)).then(begin(0)).then(begin(2))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING)
      and s.o.loaders == 2 and s.o.writes == 1)
    .then(resolve(VALUE_TWO)).then(begin(2))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_TWO)
      and s.o.loaders == 2)

  run sourceFailureKeepsPreviouslyAcceptedStorageTest = init
    .then(begin(2)).then(resolve(VALUE_ONE)).then(remotePolicy(0))
    .then(fault(1)).then(begin(0)).then(rejectLoader).then(fault(0)).then(begin(2))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR, VALUE_ONE)
      and s.o.loaders == 2 and s.o.writes == 1)

  // A rejected source seeds nothing: the next call on an empty store reads
  // remote again and starts its own source.
  run rejectedSourceDoesNotSeedLocalTest = init
    .then(begin(2)).then(rejectLoader).then(begin(2))
    .expect(s.o.calls == List(SOURCE_ERROR, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 2)
}

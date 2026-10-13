// The local storage fault switch over the layered traversal with immediate
// replies: one key on one instance, one persistent scope and a transient
// context, an untracked remote layer. Pins that a call admitted under an
// armed fault reads no local entry and starts a source without a local TTL
// (so a settlement after the fault clears publishes nothing locally while
// memoizing and refilling), that a remote hit under the fault warms nothing,
// that a settlement under the fault stores nothing locally while its callers
// receive the value and the remote refill proceeds, that a healthy call
// after the fault clears publishes again, and that the fault leaves the
// layers and the coalescing as the reply resolved them: two callers under
// the fault share one source exactly as two healthy callers do.
module local_faults_fixture {
  import conformance_observations.* from "../../conformance-observations"
  import encodings.* from "../../kernel/encodings"
  import calls.* from "../../kernel/calls"
  import layer_policy.* from "../../kernel/layer-policy"
  import serving as Serving from "../../kernel/serving"
  import local_faults as Faults from "../../kernel/local-faults"
  import remote_frames as Remote from "../../kernel/remote-frames"
  import flights as Flights from "../../kernel/flights"
  import policy_gate as Gate from "../../kernel/policy-gate"

  pure val TTL_MS = 60000
  pure val LAYOUT: Serving::Layout =
    { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 1, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true }
  pure val TTLS: Ttls = { localMs: TTL_MS, freshMs: TTL_MS, retentionMs: TTL_MS }
  pure val SCOPED: Call = { instance: 0, key: 0, context: 0, enabled: true, keyFailed: false }
  pure val TRANSIENT: Call = { instance: 0, key: 0, context: 1, enabled: true, keyFailed: false }

  type State = {
    o: Observation, now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool, localFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }

  action init = all {
    s' = {
      o: empty, now: 0, skew: 0, remoteAvailable: true, tracked: false, capacity: 1,
      readFailed: false, dumpFailed: false, writeFailed: false, localFailed: false,
      closed: List(false), memo: List(NO_VALUE), requestFlights: List(NO_OWNER), processFlights: List(NO_OWNER),
      localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
      remoteValues: List(NO_VALUE), created: List(0), expires: List(0), watermark: List(0),
      sources: List(), owners: List(), memoSlots: List(), held: List()
    },
    input' = { name: "init", choice: -1 }
  }
  action begin(call: Call, policy: int): bool = all {
    s' = Faults::begin(s, LAYOUT, call, resolution(policy, true), TTLS),
    input' = { name: "beginCall", choice: call.context }
  }
  action settle(value: int): bool = all {
    s' = Faults::settle(s, LAYOUT, Flights::latest(s), value),
    input' = { name: "resolveLoader", choice: value }
  }
  action fault(armed: bool): bool = all {
    s' = { localFailed: armed, ...s },
    input' = { name: "localFault", choice: if (armed) 1 else 0 }
  }
  action seed(value: int): bool = all {
    s' = Remote::seedFrame(s, 0, value, TTL_MS),
    input' = { name: "seed", choice: value }
  }

  // A read under the fault skips a present local entry and reads remote; the
  // source it starts carries no local TTL, and its settlement after the fault
  // clears memoizes and refills but publishes nothing locally.
  run faultedReadStartsASourceWithoutLocalTtlTest = init
    .then(begin(TRANSIENT, ALL_LAYERS)).then(settle(VALUE_ONE))
    .expect(s.localValues == List(VALUE_ONE) and s.o.writes == 1)
    .then(fault(true)).then(begin(SCOPED, NO_REMOTE_LAYER))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.reads == 1 and s.o.loaders == 2
      and s.sources.nth(1).localMs == 0 and s.sources.nth(1).retentionMs == 0)
    .then(fault(false)).then(settle(VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.localValues == List(VALUE_ONE)
      and s.memo == List(VALUE_TWO) and s.o.writes == 1)

  // A remote hit under the fault serves the frame and warms nothing.
  run faultedReadRemoteHitWarmsNothingTest = init
    .then(seed(VALUE_TWO)).then(fault(true))
    .then(begin(TRANSIENT, ALL_LAYERS))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0
      and s.localValues == List(NO_VALUE))
    .then(fault(false)).then(begin(TRANSIENT, ALL_LAYERS))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 2 and s.localValues == List(VALUE_TWO))

  // A settlement under the fault stores nothing locally: the source keeps its
  // callers' result, memoizes it and refills the remote layer.
  run faultedSettlementKeepsResultAndRefillsTest = init
    .then(begin(SCOPED, ALL_LAYERS)).then(fault(true)).then(settle(VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.memo == List(VALUE_ONE) and s.o.writes == 1
      and s.remoteValues == List(VALUE_ONE) and s.localValues == List(NO_VALUE)
      and s.sources.nth(0).localMs == 0)
    .then(fault(false)).then(begin(TRANSIENT, NO_REMOTE_LAYER))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)
    .then(settle(VALUE_TWO))
    .expect(s.localValues == List(VALUE_TWO))

  // The fault hides the local value for the read and withdraws the warm, not
  // the layer or the coalescing: with the remote layer off, two transient
  // callers under the fault join one shared source (owners equal, one
  // loader) exactly as two healthy callers do, over a present local entry
  // neither faulted caller reads; the faulted source captures no local TTL,
  // so its settlement after the fault clears leaves the entry as it was.
  run faultedCallersShareOneSourceTest = init
    .then(begin(TRANSIENT, NO_REMOTE_LAYER)).then(begin(TRANSIENT, NO_REMOTE_LAYER))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 1
      and s.owners == List(0, 0) and s.sources.nth(0).shared and s.sources.nth(0).localMs == TTL_MS)
    .then(settle(VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.localValues == List(VALUE_ONE))
    .then(fault(true)).then(begin(TRANSIENT, NO_REMOTE_LAYER)).then(begin(TRANSIENT, NO_REMOTE_LAYER))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING, CALL_PENDING) and s.o.loaders == 2
      and s.owners == List(0, 0, 1, 1) and s.sources.nth(1).shared and s.sources.nth(1).localMs == 0
      and s.o.reads == 0)
    .then(fault(false)).then(settle(VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.localValues == List(VALUE_ONE)
      and s.o.writes == 0)

  // A rejected source under the fault publishes nothing anywhere and leaves
  // the entry the fault protected.
  run faultedRejectionPublishesNothingTest = init
    .then(begin(TRANSIENT, NO_REMOTE_LAYER)).then(settle(VALUE_ONE))
    .then(fault(true)).then(begin(SCOPED, NO_REMOTE_LAYER)).then(settle(SOURCE_ERROR))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR) and s.localValues == List(VALUE_ONE)
      and s.memo == List(NO_VALUE))
}

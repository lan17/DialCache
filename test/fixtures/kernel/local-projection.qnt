// The local projection of the traversal: one key on one instance, one local
// slot, no persistent scope, replies held and released one at a time with the
// local layer enabled. Pins that a reply's local TTL gates the projection (a
// zero local TTL turns local storage off, so the source it starts shares
// nothing, a second caller starts its own, and settlement warms nothing) and
// that each source warms local storage for the local TTL it captured from the
// reply that started it.
module local_projection {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import clock as Clock from "../../../formal/kernel/clock"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val INITIAL_TIME_MS = 10000
  pure val LOCAL_MS = 1000
  pure val SHORT_LOCAL_MS = 250
  pure val LAYOUT: Serving::Layout =
    { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 1, probeSourceScope: false }
  pure val LOCAL: Resolution = { layers: { request: false, local: true, remote: false }, coalesce: true }
  pure val TTLS: Ttls = { localMs: LOCAL_MS, freshMs: 0, retentionMs: 0 }
  pure val SHORT_TTLS: Ttls = { localMs: SHORT_LOCAL_MS, freshMs: 0, retentionMs: 0 }
  pure val CALL: Call = { instance: 0, key: 0, context: 0, enabled: true, keyFailed: false }

  type State = {
    o: Observation, now: int, capacity: int,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    sources: List[Serving::LocalSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }

  action init = all {
    s' = {
      o: empty, now: INITIAL_TIME_MS, capacity: 1,
      closed: List(), memo: List(), requestFlights: List(), processFlights: List(NO_OWNER),
      localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
      sources: List(), owners: List(), memoSlots: List(), held: List()
    },
    input' = { name: "init", choice: -1 }
  }
  action admit = all {
    s' = Serving::admitLocal(s, LAYOUT, CALL),
    input' = { name: "beginCall", choice: 0 }
  }
  // The drivers release a held reply by its policy call index, with the TTLs
  // the reply resolved to.
  action release(policyCall: int, ttls: Ttls): bool = all {
    s' = Serving::releaseLocal(s, LAYOUT, policyCall, LOCAL, ttls),
    input' = { name: "releasePolicy", choice: policyCall }
  }
  action settle(index: int, value: int): bool = all {
    s' = Serving::settleLocal(s, LAYOUT, index, value),
    input' = { name: "resolveLoader", choice: index }
  }
  action elapse(ms: int): bool = all {
    s' = Clock::advance(s, ms),
    input' = { name: "advance", choice: ms }
  }

  // A zero local TTL turns the projection's only layer off: the source
  // captures no local TTL and shares nothing, the process registry stays
  // empty, a second released caller starts its own source, and settlement
  // leaves local storage and its recency untouched.
  run zeroLocalTtlTurnsTheLocalProjectionOffTest = init
    .then(admit).then(release(0, NO_TTLS))
    .expect(s.o.loaders == 1 and s.sources.nth(0).localMs == 0 and not(s.sources.nth(0).shared)
      and s.processFlights == List(NO_OWNER))
    .then(admit).then(release(1, NO_TTLS))
    .expect(s.o.loaders == 2 and s.owners == List(0, 1) and s.processFlights == List(NO_OWNER))
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.localValues == List(NO_VALUE)
      and s.localExpires == List(0) and s.lru == List(List()))

  // The control: a positive local TTL shares the source, the second caller
  // joins it, and settlement warms local storage for the source's local TTL.
  run positiveLocalTtlSharesAndWarmsTest = init
    .then(admit).then(release(0, TTLS))
    .expect(s.o.loaders == 1 and s.sources.nth(0).localMs == LOCAL_MS and s.sources.nth(0).shared
      and s.processFlights == List(0))
    .then(admit).then(release(1, TTLS))
    .expect(s.o.loaders == 1 and s.owners == List(0, 0))
    .then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.localValues == List(VALUE_ONE)
      and s.localExpires == List(INITIAL_TIME_MS + LOCAL_MS) and s.lru == List(List(0)) and s.processFlights == List(NO_OWNER))

  // Each source warms local storage for the local TTL of the reply that
  // started it: an entry from a short-TTL reply serves one millisecond before
  // that TTL, and the source a later reply starts warms for the later TTL.
  run eachSourceWarmsForItsOwnLocalTtlTest = init
    .then(admit).then(release(0, SHORT_TTLS)).then(settle(0, VALUE_ONE))
    .expect(s.sources.nth(0).localMs == SHORT_LOCAL_MS and s.localExpires == List(INITIAL_TIME_MS + SHORT_LOCAL_MS))
    .then(elapse(SHORT_LOCAL_MS - 1)).then(admit).then(release(1, TTLS))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
    .then(elapse(1)).then(admit).then(release(2, TTLS))
    .expect(s.o.loaders == 2 and s.sources.nth(1).localMs == LOCAL_MS)
    .then(settle(1, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO) and s.localValues == List(VALUE_TWO)
      and s.localExpires == List(INITIAL_TIME_MS + SHORT_LOCAL_MS + LOCAL_MS))
}

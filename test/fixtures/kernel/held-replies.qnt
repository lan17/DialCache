// A profile whose drivers hold policy replies: admission and traversal are
// separate steps, released in any order, over one key, two instances and two
// persistent contexts. Exercises the library seam that immediate profiles
// (layers) reach only through the begin facade: a caller released after a
// later admission and served at its own index, a release that joins a flight
// registered between admission and release, a closed scope released after
// closure, and coalescing off against both registries.
module held_replies {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import flights as Flights from "../../../formal/kernel/flights"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, servingTtlMs: 60000 }
  pure val ALL: Resolution = { layers: { request: true, local: true, remote: true }, coalesce: true }
  pure val UNCOALESCED: Resolution = { layers: { request: true, local: true, remote: true }, coalesce: false }
  pure val REQUEST_ONLY: Resolution = { layers: { request: true, local: false, remote: false }, coalesce: true }

  type State = {
    o: Observation, now: int, policy: int, remoteAvailable: bool, tracked: bool, capacity: int,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], lru: List[List[int]], remoteValues: List[int], created: List[int], watermark: List[int],
    sources: List[Flights::Source], owners: List[int], memoSlots: List[int], held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }

  action init = all {
    s' = { o: empty, now: 10000, policy: ALL_LAYERS, remoteAvailable: true, tracked: false, capacity: 1,
      closed: List(false, false), memo: List(0, 0), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER, NO_OWNER),
      localValues: List(0, 0), lru: List(List(), List()), remoteValues: List(0), created: List(0), watermark: List(0),
      sources: List(), owners: List(), memoSlots: List(), held: List() },
    input' = { name: "init", choice: -1 }
  }
  // Context 0 and 1 are persistent scopes on instance 0; context 2 is a fresh
  // context on instance 1.
  pure def call(context: int): Call = { instance: if (context == 2) 1 else 0, key: 0, context: context }
  action admit(context: int): bool = all {
    s' = Serving::admit(s, LAYOUT, call(context)),
    input' = { name: "beginCall", choice: context }
  }
  // The drivers release a held reply by its policy call index; a profile that
  // holds one reply at a time releases the latest.
  action release(policyCall: int, resolved: Resolution): bool = all {
    s' = Serving::release(s, LAYOUT, policyCall, resolved),
    input' = { name: "releasePolicy", choice: policyCall }
  }
  action releaseLatest(resolved: Resolution): bool = all {
    s' = Serving::release(s, LAYOUT, Gate::latest(s), resolved),
    input' = { name: "releasePolicy", choice: -1 }
  }
  action settle(index: int, value: int): bool = all {
    s' = Serving::settle(s, LAYOUT, index, value),
    input' = { name: "resolveLoader", choice: index }
  }
  action close(context: int): bool = all {
    s' = Serving::closeScope(s, LAYOUT, context),
    input' = { name: "closeScope", choice: context }
  }
  action seed(value: int): bool = all {
    s' = Remote::seedFrame(s, 0, value),
    input' = { name: "seed", choice: value }
  }

  // Two admissions hold two replies with their calls; releasing the later
  // first serves that caller; the earlier, released second, joins the flight
  // the first started.
  run releaseOrderIsTheEnvironmentsTest = init
    .then(admit(0)).then(admit(1))
    .expect(s.o.policyCalls == 2 and Gate::holding(s)
      and s.held == List({ policyCall: 0, caller: 0, call: call(0) }, { policyCall: 1, caller: 1, call: call(1) }))
    .then(release(1, ALL))
    .expect(s.o.loaders == 1 and s.o.reads == 1 and s.owners == List(NO_OWNER, 0)
      and s.held == List({ policyCall: 0, caller: 0, call: call(0) }))
    .then(release(0, ALL))
    .expect(s.o.loaders == 1 and s.o.reads == 1 and s.owners == List(0, 0) and not(Gate::holding(s)))
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.memo == List(VALUE_TWO, VALUE_TWO) and s.o.writes == 1)

  // An earlier held caller served from a layer while a later admission is
  // still held receives the value at its own index, and only its scope memoizes.
  run earlierHeldCallerIsServedAtItsOwnIndexTest = init
    .then(seed(VALUE_TWO)).then(admit(0)).then(admit(1))
    .then(release(0, ALL))
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING) and s.o.reads == 1 and s.o.loads == 1
      and s.held == List({ policyCall: 1, caller: 1, call: call(1) })
      and s.memo == List(VALUE_TWO, 0) and s.localValues == List(VALUE_TWO, 0))

  // A caller released with coalescing off starts its own source although a
  // shared flight for the same instance and key is registered.
  run uncoalescedReleaseIgnoresTheRegistriesTest = init
    .then(admit(0)).then(release(0, ALL))
    .then(admit(1)).then(release(1, UNCOALESCED))
    .expect(s.o.loaders == 2 and s.owners == List(0, 1) and s.sources.nth(1).shared == false)
    .then(settle(1, VALUE_ONE))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_ONE) and s.processFlights == List(0, NO_OWNER))

  // Coalescing off also skips the request registry of the caller's own scope:
  // the flight registered there is neither joined nor replaced.
  run sameScopeUncoalescedReleaseStartsItsOwnSourceTest = init
    .then(admit(0)).then(release(0, ALL))
    .expect(s.requestFlights == List(0, NO_OWNER))
    .then(admit(0)).then(release(1, UNCOALESCED))
    .expect(s.o.loaders == 2 and s.owners == List(0, 1) and s.requestFlights == List(0, NO_OWNER))

  // A scope closed between admission and release: the released caller reads
  // no layer although both are warm, memoizes nothing, shares nothing, and its
  // late settlement publishes nowhere.
  run closedScopeReleasesUnattachedTest = init
    .then(seed(VALUE_TWO)).then(admit(1)).then(release(0, ALL))
    .expect(s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0 and s.localValues == List(VALUE_TWO, 0))
    .then(admit(0)).then(close(0)).then(release(1, ALL))
    .expect(s.o.loaders == 1 and s.o.reads == 1 and s.o.calls == List(VALUE_TWO, CALL_PENDING)
      and s.memoSlots == List(1, NO_OWNER) and s.requestFlights == List(NO_OWNER, NO_OWNER)
      and s.sources.nth(0).shared == false)
    .then(settle(0, VALUE_ONE))
    .expect(s.o.writes == 0 and s.o.calls == List(VALUE_TWO, VALUE_ONE)
      and s.localValues == List(VALUE_TWO, 0) and s.memo == List(0, VALUE_TWO))

  // A fresh context on the other instance is not held: it bypasses the gate
  // only when its scope is closed; a fresh context is open, so it holds like
  // any participating caller and a request-only reply reads no layer. Each
  // release here names the latest held reply.
  run requestOnlyReleaseReadsNoStorageTest = init
    .then(seed(VALUE_TWO)).then(admit(2)).then(releaseLatest(REQUEST_ONLY))
    .expect(s.o.reads == 0 and s.o.loaders == 1 and s.memoSlots == List(NO_OWNER))
    .then(admit(0)).then(releaseLatest(ALL))
    .expect(s.o.reads == 1 and s.o.loads == 1 and s.o.calls == List(CALL_PENDING, VALUE_TWO) and s.localValues == List(VALUE_TWO, 0))

  // The facade equals admission followed by an immediate release.
  run beginIsAdmitThenReleaseTest = init
    .then(all { s' = Serving::begin(s, LAYOUT, 0, 0, 0), input' = { name: "beginCall", choice: 0 } })
    .expect(s.o.policyCalls == 1 and s.o.loaders == 1 and s.o.reads == 1 and s.held == List())
}

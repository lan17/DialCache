// The request-only projection of the traversal with its diagnosed variants:
// one key on one instance, two persistent contexts that share the identity
// and a disabled context, policy replies held and released one at a time.
// Pins that the projection keeps only the request leaf of a layered reply (no
// process sharing, no layer read), that the diagnosed variants change nothing
// the plain transitions do not, and the layer a failed source is attributed to.
module request_only {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import diagnostics as Diag from "../../../formal/kernel/diagnostics"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, probeSourceScope: true }
  pure val ALL: Resolution = { layers: { request: true, local: true, remote: true }, coalesce: true }
  pure val NO_REQUEST: Resolution = { layers: { request: false, local: true, remote: true }, coalesce: true }

  type State = {
    o: Observation, d: Diagnostics, sourceLayers: List[str],
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    sources: List[Serving::RequestSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }

  pure val INITIAL: State = { o: empty, d: noDiagnostics, sourceLayers: List(),
    closed: List(false, false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER),
    sources: List(), owners: List(), memoSlots: List(), held: List() }
  action init = all {
    s' = INITIAL,
    input' = { name: "init", choice: -1 }
  }
  // Contexts 0 and 1 are persistent scopes over the same instance and key;
  // context 2 is a disabled context.
  pure def call(context: int): Call = { instance: 0, key: 0, context: context, enabled: context != 2, keyFailed: false }
  action admit(context: int): bool = all {
    s' = Diag::admitRequest(s, LAYOUT, call(context)),
    input' = { name: "beginCall", choice: context }
  }
  // One reply is held at a time, so each release names the latest.
  action release(resolved: Resolution): bool = all {
    s' = Diag::releaseRequest(s, LAYOUT, Gate::latest(s), resolved),
    input' = { name: "releasePolicy", choice: -1 }
  }
  action settle(index: int, value: int): bool = all {
    s' = Diag::settleRequest(s, LAYOUT, index, value),
    input' = { name: "resolveLoader", choice: index }
  }
  action close(context: int): bool = all {
    s' = Serving::closeScope(s, LAYOUT, context),
    input' = { name: "closeScope", choice: context }
  }

  // A layered coalescing reply is projected to its request leaf: two callers
  // in different scopes with the same identity start their own unshared
  // sources, the process registry is never written and nothing coalesces; a
  // third caller in the first scope joins that scope's registered flight.
  run layeredReplyIsProjectedToTheRequestLeafTest = init
    .then(admit(0)).then(release(ALL))
    .then(admit(1)).then(release(ALL))
    .expect(s.o.loaders == 2 and s.o.reads == 0 and s.owners == List(0, 1) and s.memoSlots == List(0, 1)
      and s.sources == List({ result: CALL_PENDING, shared: false }, { result: CALL_PENDING, shared: false })
      and s.processFlights == List(NO_OWNER) and s.requestFlights == List(0, 1) and s.d.coalesced == List())
    .then(admit(0)).then(release(ALL))
    .expect(s.o.loaders == 2 and s.owners == List(0, 1, 0) and s.d.coalesced == List("request_local"))
    .then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING, VALUE_TWO) and s.memo == List(VALUE_TWO, NO_VALUE)
      and s.requestFlights == List(NO_OWNER, 1) and s.processFlights == List(NO_OWNER))

  // The diagnosed variants are the plain request-only transitions on the
  // observation and the registries; they add only the diagnostics channel and
  // the per-source layer.
  pure def plain(state: State): State =
    Serving::settleRequest(Serving::releaseRequest(Serving::admitRequest(
      Serving::releaseRequest(Serving::admitRequest(state, LAYOUT, call(0)), LAYOUT, 0, ALL),
      LAYOUT, call(1)), LAYOUT, 1, ALL), LAYOUT, 0, SOURCE_ERROR)
  run diagnosedVariantsAreThePlainTransitionsTest = init
    .then(admit(0)).then(release(ALL)).then(admit(1)).then(release(ALL)).then(settle(0, SOURCE_ERROR))
    .expect({ d: noDiagnostics, sourceLayers: List(), ...s } == plain(INITIAL)
      and s.o.calls == List(SOURCE_ERROR, CALL_PENDING) and s.d.fallbackErrors == List("request_local"))

  // A caller whose scope closed between admission and release starts a source
  // outside the cache: it memoizes nothing and its failure is attributed to no
  // layer.
  run closedScopeReleaseIsAttributedToNoopTest = init
    .then(admit(0)).then(close(0)).then(release(ALL))
    .expect(s.o.loaders == 1 and s.o.sourceScopes == List(false) and s.memoSlots == List(NO_OWNER)
      and s.requestFlights == List(NO_OWNER, NO_OWNER))
    .then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.d.fallbackErrors == List("noop"))

  // A rejected source is attributed to the layer its call was serving: the
  // request memo when it memoizes, the shared layers' fallback when the reply
  // disables the request leaf, and no layer for a disabled caller's source.
  run rejectedSourceIsAttributedToItsLayerTest = init
    .then(admit(0)).then(release(ALL)).then(settle(0, SOURCE_ERROR))
    .expect(s.d.fallbackErrors == List("request_local"))
    .then(admit(0)).then(release(NO_REQUEST)).then(settle(1, SOURCE_ERROR))
    .expect(s.o.loaders == 2 and s.memoSlots == List(0, NO_OWNER) and s.d.fallbackErrors == List("request_local", "local"))
    .then(admit(2)).then(settle(2, SOURCE_ERROR))
    .expect(s.o.loaders == 3 and s.o.policyCalls == 2 and s.o.sourceScopes == List(true, true, false)
      and s.o.calls == List(SOURCE_ERROR, SOURCE_ERROR, SOURCE_ERROR) and s.d.fallbackErrors == List("request_local", "local"))
}

module diagnostics {
  // The diagnostics channel (`d`): which singleflight a caller coalesced into
  // and the layer a failed source is attributed to. The labels are the metric
  // labels of the implementations (coalesced scope "request_local" or
  // "process"; fallback errors by the layer the call was serving: the request
  // memo, the shared layers' fallback "local", "noop" once the scope closed).
  // A profile whose drivers compare `d` composes the diagnosed variants of the
  // traversal below; the traversal itself never reads `d`.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import policy_gate as Gate from "./policy-gate"

  pure val REQUEST_LOCAL_LAYER = "request_local"
  pure val LOCAL_LAYER = "local"
  pure val NO_CACHE_LAYER = "noop"
  pure val PROCESS_SCOPE = "process"
  // A source started outside the cache (a disabled or outside caller) has no
  // layer and records no fallback error.
  pure val NO_LAYER = ""

  // Per source, parallel to the source records: the layer it is attributed to.
  type Diagnosed[r] = { d: Diagnostics, sourceLayers: List[str] | r }
  type DiagnosedRequest[r] = {
    d: Diagnostics,
    sourceLayers: List[str],
    o: Observation,
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    sources: List[Serving::RequestSource],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held] | r
  }

  pure def recordCoalesced(state: Diagnosed[r], scope: str): Diagnosed[r] =
    { d: { coalesced: state.d.coalesced.append(scope), ...state.d }, ...state }
  pure def recordSourceLayer(state: Diagnosed[r], layer: str): Diagnosed[r] =
    { sourceLayers: state.sourceLayers.append(layer), ...state }
  pure def recordFallbackError(state: Diagnosed[r], layer: str): Diagnosed[r] =
    if (layer == NO_LAYER) state else { d: { fallbackErrors: state.d.fallbackErrors.append(layer), ...state.d }, ...state }
  // The layer a source started at release is attributed to: none once the
  // scope closed, the request memo when the call memoizes, else the shared
  // layers' fallback.
  pure def sourceLayer(open: bool, slot: int): str =
    if (not(open)) NO_CACHE_LAYER else if (slot >= 0) REQUEST_LOCAL_LAYER else LOCAL_LAYER

  // -- Diagnosed variants of the request-only traversal ------------------------

  pure def admitRequest(state: DiagnosedRequest[r], layout: Serving::Layout, call: Call): DiagnosedRequest[r] = {
    val admitted = Serving::admitRequest(state, layout, call)
    if (admitted.sources.length() > state.sources.length()) recordSourceLayer(admitted, NO_LAYER) else admitted
  }
  pure def releaseRequest(state: DiagnosedRequest[r], layout: Serving::Layout, policyCall: int, resolved: Resolution): DiagnosedRequest[r] = {
    val call = Gate::entry(state, policyCall).call
    val open = Serving::participating(state, layout, call)
    val effective = if (open) Serving::requestOnly(resolved) else BYPASS
    val decision = Serving::decide(state, layout, call, effective, NO_VALUE, NO_VALUE)
    val released = Serving::releaseRequest(state, layout, policyCall, resolved)
    match decision.outcome {
      | JoinsRequest(_) => recordCoalesced(released, REQUEST_LOCAL_LAYER)
      | JoinsProcess(_) => recordCoalesced(released, PROCESS_SCOPE)
      | Starts => recordSourceLayer(released, sourceLayer(open, decision.slot))
      | _ => released
    }
  }
  pure def settleRequest(state: DiagnosedRequest[r], layout: Serving::Layout, index: int, value: int): DiagnosedRequest[r] =
    recordFallbackError(Serving::settleRequest(state, layout, index, value),
      if (value == SOURCE_ERROR) state.sourceLayers.nth(index) else NO_LAYER)
}

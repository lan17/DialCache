module diagnostics {
  // The diagnostics channel (`d`) of the request-only traversal: which
  // singleflight a caller coalesced into and the layer a failed source is
  // attributed to. The labels are the metric labels of the implementations:
  // the coalesced scope is "request_local", the only registry this shape
  // consults; fallback errors name the layer the call was serving (the
  // request memo "request_local" when it memoizes, the shared layers'
  // fallback "local" when it does not, "noop" once the scope closed). A
  // profile whose drivers compare `d` composes the diagnosed variants below;
  // the traversal itself never reads `d`.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import policy_gate as Gate from "./policy-gate"

  pure val REQUEST_LOCAL_LAYER = "request_local"
  pure val LOCAL_LAYER = "local"
  pure val NO_CACHE_LAYER = "noop"
  // A source started outside the cache (a disabled or outside caller) has no
  // layer and records no fallback error.
  pure val NO_LAYER = ""

  // The channel is row-polymorphic: a profile whose drivers compare more
  // fields (shadow's configErrors and futureOffsets) carries them beside
  // these four, which scope's descriptor parses exactly.
  type Channel[q] = { warnings: int, ages: List[int], coalesced: List[str], fallbackErrors: List[str] | q }
  // Per source, parallel to the source records: the layer it is attributed to.
  type Diagnosed[r, q] = { d: Channel[q], sourceLayers: List[str] | r }
  type DiagnosedRequest[r, q] = Serving::RequestServed[Diagnosed[r, q]]

  pure def recordCoalesced(state: Diagnosed[r, q], scope: str): Diagnosed[r, q] =
    { d: { coalesced: state.d.coalesced.append(scope), ...state.d }, ...state }
  pure def recordSourceLayer(state: Diagnosed[r, q], layer: str): Diagnosed[r, q] =
    { sourceLayers: state.sourceLayers.append(layer), ...state }
  pure def recordFallbackError(state: Diagnosed[r, q], layer: str): Diagnosed[r, q] =
    if (layer == NO_LAYER) state else { d: { fallbackErrors: state.d.fallbackErrors.append(layer), ...state.d }, ...state }
  // The layer a source started at release is attributed to: none once the
  // scope closed, the request memo when the call memoizes, else the shared
  // layers' fallback.
  pure def sourceLayer(open: bool, slot: int): str =
    if (not(open)) NO_CACHE_LAYER else if (slot >= 0) REQUEST_LOCAL_LAYER else LOCAL_LAYER

  // -- Diagnosed variants of the request-only traversal ------------------------

  // A caller that does not participate starts a bypass source at admission.
  pure def admitRequest(state: DiagnosedRequest[r, q], layout: Serving::Layout, call: Call): DiagnosedRequest[r, q] = {
    val admitted = Serving::admitRequest(state, layout, call)
    if (Serving::participating(state, layout, call)) admitted else recordSourceLayer(admitted, NO_LAYER)
  }
  // The release judged once (Serving::requestRelease) labels what the same
  // release did to the state.
  pure def releaseRequest(state: DiagnosedRequest[r, q], layout: Serving::Layout, policyCall: int, resolved: Resolution): DiagnosedRequest[r, q] = {
    val judged = Serving::requestRelease(state, layout, policyCall, resolved)
    val released = Serving::releaseRequest(state, layout, policyCall, resolved)
    match judged.decision.outcome {
      | JoinsRequest(_) => recordCoalesced(released, REQUEST_LOCAL_LAYER)
      | Starts => recordSourceLayer(released, sourceLayer(judged.open, judged.decision.slot))
      // A served caller records nothing; the request-only shape reaches
      // neither the process registry nor a layer value.
      | JoinsProcess(_) => released
      | ServesMemo(_) => released
      | ServesLocal(_) => released
      | ServesRemote(_) => released
    }
  }
  pure def settleRequest(state: DiagnosedRequest[r, q], layout: Serving::Layout, index: int, value: int): DiagnosedRequest[r, q] =
    recordFallbackError(Serving::settleRequest(state, layout, index, value),
      if (value == SOURCE_ERROR) state.sourceLayers.nth(index) else NO_LAYER)
}

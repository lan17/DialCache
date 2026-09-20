module diagnostics {
  // The diagnostics channel (`d`) of the request-only traversal: which
  // singleflight a caller coalesced into and the layer a failed source is
  // attributed to; and, over the budgeted held lifecycle, the singleflight a
  // follower coalesced into, the layer a failed remote-reading flight is
  // attributed to and the recovery age. The labels are the metric labels of
  // the implementations:
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
  import remote_io as RemoteIO from "./remote-io"
  import deadlines as Deadlines from "./deadlines"
  import recovery as Recovery from "./recovery"
  import clock as Clock from "./clock"

  pure val REQUEST_LOCAL_LAYER = "request_local"
  pure val LOCAL_LAYER = "local"
  pure val REMOTE_LAYER = "remote"
  pure val NO_CACHE_LAYER = "noop"
  // The singleflight a caller coalesced into: the request registry's, or the
  // process registry's (the layered shapes' second registry).
  pure val PROCESS_SCOPE = "process"
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
  // The budgeted held remote lifecycle with the channel and per-flight layers beside it.
  type DiagnosedHeld[r, q] = Deadlines::BudgetedHeld[Diagnosed[r, q]]

  pure def recordCoalesced(state: Diagnosed[r, q], scope: str): Diagnosed[r, q] =
    { d: { coalesced: state.d.coalesced.append(scope), ...state.d }, ...state }
  pure def recordSourceLayer(state: Diagnosed[r, q], layer: str): Diagnosed[r, q] =
    { sourceLayers: state.sourceLayers.append(layer), ...state }
  pure def recordFallbackError(state: Diagnosed[r, q], layer: str): Diagnosed[r, q] =
    if (layer == NO_LAYER) state else { d: { fallbackErrors: state.d.fallbackErrors.append(layer), ...state.d }, ...state }
  // The age of a recovered value, sampled at its served recovery decode (C57).
  pure def recordAge(state: Diagnosed[r, q], age: int): Diagnosed[r, q] =
    { d: { ages: state.d.ages.append(age), ...state.d }, ...state }
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

  // -- Diagnosed variants of the budgeted held lifecycle -------------------------
  // For a profile whose drivers compare the channel over the held remote path
  // with immediate replies and reads settled at admission (recovery): the
  // singleflight a caller coalesced into, judged once beside the release
  // (`Serving::judgeRelease` applied through `Deadlines::releaseJudged`); the
  // layer a flight is attributed to when it starts (the remote layer for a
  // flight that dispatched a read, whatever the read observed; the request
  // memo or the shared layers' fallback for a source started without the
  // remote layer; none for a bypass source started at admission); the
  // fallback error recorded against that layer when the flight's failure is
  // recorded (a late result that only drains records none); the recovery age
  // sampled when a recovery decode serves.

  pure def beginRead(state: DiagnosedHeld[r, q], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls, budget: int, classifier: int): DiagnosedHeld[r, q] = {
    val admitted = Deadlines::admit(state, layout, call)
    if (not(Serving::participating(state, layout, call))) recordSourceLayer(admitted, NO_LAYER)
    else {
      val judged = Serving::judgeRelease(admitted, layout, state.o.policyCalls, resolved, ttls, false)
      val released = Deadlines::releaseJudged(admitted, layout, judged, state.o.policyCalls, ttls, budget)
      val labeled = match judged.decision.outcome {
        | JoinsRequest(_) => recordCoalesced(released, REQUEST_LOCAL_LAYER)
        | JoinsProcess(_) => recordCoalesced(released, PROCESS_SCOPE)
        | Starts => recordSourceLayer(released,
          if (judged.effective.layers.remote) REMOTE_LAYER else sourceLayer(judged.open, judged.decision.slot))
        | ServesMemo(_) => released
        | ServesLocal(_) => released
        | ServesRemote(_) => released
      }
      Deadlines::settleDispatched(admitted, labeled, layout, classifier)
    }
  }
  // A flight whose failure the step recorded (its source's outcome moved from
  // pending to an error) is attributed to its layer; a result that drains
  // after its deadline completed the flight records nothing.
  pure def failureAttributed(before: DiagnosedHeld[r, q], after: DiagnosedHeld[r, q], flight: int): DiagnosedHeld[r, q] = {
    val outcome = after.sources.nth(flight).result
    if (before.sources.nth(flight).result == CALL_PENDING and outcome != CALL_PENDING and not(accepted(outcome)))
      recordFallbackError(after, after.sourceLayers.nth(flight)) else after
  }
  pure def settleLoader(state: DiagnosedHeld[r, q], layout: Serving::Layout, ordinal: int, value: int, timeout: bool): DiagnosedHeld[r, q] =
    failureAttributed(state, Deadlines::settleLoader(state, layout, ordinal, value, timeout), state.loaders.nth(ordinal))
  pure def expireLoader(state: DiagnosedHeld[r, q], layout: Serving::Layout, ordinal: int): DiagnosedHeld[r, q] =
    failureAttributed(state, Deadlines::expireLoader(state, layout, ordinal), state.loaders.nth(ordinal))
  // Delivery from inside the kernel, as the lint requires: a read expiry is
  // the budgeted one, a loader expiry the attributed one (a held profile
  // registers READ and SOURCE only).
  pure def advance(state: DiagnosedHeld[r, q], layout: Serving::Layout, ms: int): DiagnosedHeld[r, q] =
    Deadlines::deliver(state, ms, (current, d) =>
      if (d.kind == Deadlines::READ) Deadlines::expireRead(current, layout, d.index) else expireLoader(current, layout, d.index))
  // A recovery decode that serves samples the candidate's age at the wall
  // clock of its settlement, beside the label the settlement reports.
  pure def settleLoad(state: DiagnosedHeld[r, q], layout: Serving::Layout, load: int, failed: bool): DiagnosedHeld[r, q] = {
    val snapshot = Recovery::retainedFor(state, RemoteIO::heldLoad(state, load).flight)
    val settled = Deadlines::settleLoad(state, layout, load, failed)
    val served = settled.o.recovery.length() > state.o.recovery.length() and
      settled.o.recovery.nth(settled.o.recovery.length() - 1) == "served"
    if (served) recordAge(settled, Clock::wallOf(state) - snapshot.created) else settled
  }
}

module local_faults {
  // The local storage fault switch (C27). The drivers inject one failure into
  // local storage (its exception or integer-clock seam, the local-failure
  // fixture's `localFaultInjection`), so while it is armed every local read
  // and write throws and the cache fails open. A call whose local read fails
  // keeps the layers its reply resolved to, and with them its coalescing: the
  // implementations pick the process flight from the resolved layer
  // configuration before any read (`src/dialcache.ts` `getThroughSharedLayers`
  // wraps the traversal in the single flight when the local layer is enabled
  // and the key coalesces), and a local read that throws
  // (`getThroughActiveLocal`, `readLocalWithResolvedConfig`) disables only
  // that call's local value and its local write. So under the fault a call
  // reads nothing from local storage, a remote hit does not warm it, and the
  // source it starts captures no local TTL, so its settlement publishes
  // nothing locally even after the fault clears (the failed read is the
  // call's, not the settlement's), while two callers under the fault still
  // share one source. A publication whose local write fails stores nothing and
  // completes its callers with the accepted result, memoized and refilled as
  // usual.
  //
  // Stated with the kernel's fault idiom: the switch is read where the call
  // touches local storage and passed as an argument, never turned into a TTL
  // the layer gating reads. An admission with an immediate reply (`begin`)
  // judges the layered release with the fault as its argument
  // (`serving::judgeReleaseUnder`: the local value hidden, the layers
  // untouched, nothing warmed from the release) and applies that judgment
  // (`serving::releaseJudged`); a settlement (`settle`) withdraws the source's
  // captured local TTL, so `serving::publish` warms nothing. The traversal and
  // the publication keep their one statement in `serving`; the remote fault
  // switches live in `serving::Served` because the traversal reads them mid
  // release, where this one is read at its two entry points.
  import layer_policy.* from "./layer-policy"
  import calls.* from "./calls"
  import flights as Flights from "./flights"
  import serving as Serving from "./serving"

  type Faulted[r] = Serving::Served[{ localFailed: bool | r }]

  // An immediate reply under the switch: admission, then the release judged
  // with the fault as its argument and applied from that judgment.
  pure def begin(state: Faulted[r], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls): Faulted[r] = {
    val admitted = Serving::admit(state, layout, call)
    if (Serving::participating(state, layout, call))
      Serving::releaseJudged(admitted, layout,
        Serving::judgeReleaseUnder(admitted, layout, state.o.policyCalls, resolved, ttls, true, state.localFailed),
        state.o.policyCalls, ttls)
    else admitted
  }
  // A settlement under an armed fault publishes nothing locally: the source
  // settles with its local TTL withdrawn and everything else as captured.
  pure def settle(state: Faulted[r], layout: Serving::Layout, index: int, value: int): Faulted[r] = {
    val source = state.sources.nth(index)
    val publishing = if (state.localFailed) { sources: state.sources.replaceAt(index, { localMs: 0, ...source }), ...state } else state
    Serving::settle(publishing, layout, index, value)
  }
}

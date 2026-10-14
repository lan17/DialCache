module local_faults {
  // The local storage fault switch: while the drivers' injected fault is armed, every local read
  // and write throws and the cache fails open around it.
  //
  // Rules
  // - A call whose local read fails keeps the layers its reply resolved to, and with them its
  //   coalescing; it reads nothing locally, warms nothing and publishes nothing locally (C27).
  // - A publication whose local write fails stores nothing and completes its callers with the
  //   accepted result, memoized and refilled as usual (C27).
  // - The switch is read where the call touches local storage, in `begin` and `settle`, and
  //   passed as an argument; it is never turned into a TTL the layer gating reads.
  // - The traversal and the publication keep their one statement in `serving`; the remote fault
  //   switches stay in `serving::Served` because the traversal reads them mid-release.
  // - The held lifecycle still judges a healthy local read; combining it with this switch needs
  //   fault-aware held transitions and is rejected by shape lint.
  // Shapes
  // - Faulted[r]: `serving::Served` with the `localFailed` switch; local-failure passes it.
  // Consumers: local-failure.
  // Ports: typescript/src/dialcache.ts `getThroughSharedLayers`, `getThroughActiveLocal`,
  //   `readLocalWithResolvedConfig`.
  import layer_policy.* from "./layer-policy"
  import calls.* from "./calls"
  import flights as Flights from "./flights"
  import serving as Serving from "./serving"

  // The switch the drivers arm through the local-failure fixture's
  // `localFaultInjection`: one failure injected into local storage, through
  // its exception or integer-clock seam.
  type Faulted[r] = Serving::Served[{ localFailed: bool | r }]

  // An immediate reply under the switch: admission, then the release judged
  // with the fault as its argument (`serving::judgeReleaseUnder`: the local
  // value hidden, the layers untouched, nothing warmed from the release) and
  // applied from that judgment (`serving::releaseJudged`). The implementations
  // pick the process flight from the resolved layer configuration before any
  // read (`getThroughSharedLayers` wraps the traversal in the single flight
  // when the local layer is enabled and the key coalesces). A local read that
  // throws (`getThroughActiveLocal`, `readLocalWithResolvedConfig`) disables
  // only that call's local value and its local write. So under the fault a
  // call reads nothing from local storage, a remote hit does not warm it, and
  // the source it starts captures no local TTL. Its settlement therefore
  // publishes nothing locally even after the fault clears: the failed read is
  // the call's, not the settlement's. Two callers under the fault still share
  // one source.
  pure def begin(state: Faulted[r], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls): Faulted[r] = {
    val admitted = Serving::admit(state, layout, call)
    if (Serving::participating(state, layout, call))
      Serving::releaseJudged(admitted, layout,
        Serving::judgeReleaseUnder(admitted, layout, state.o.policyCalls, resolved, ttls, true, state.localFailed),
        state.o.policyCalls, ttls)
    else admitted
  }
  // A settlement under an armed fault publishes nothing locally: the source
  // settles with its local TTL withdrawn and everything else as captured, so
  // `serving::publish` warms nothing. A publication whose local write fails
  // stores nothing and completes its callers with the accepted result,
  // memoized and refilled as usual.
  pure def settle(state: Faulted[r], layout: Serving::Layout, index: int, value: int): Faulted[r] = {
    val source = state.sources.nth(index)
    val publishing = if (state.localFailed) { sources: state.sources.replaceAt(index, { localMs: 0, ...source }), ...state } else state
    Serving::settle(publishing, layout, index, value)
  }
}

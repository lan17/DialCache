module local_faults {
  // The local storage fault switch (C27). The drivers inject one failure into
  // local storage (its exception or integer-clock seam, the local-failure
  // fixture's `localFaultInjection`), so while it is armed every local read
  // and write throws and the cache fails open. A call whose local read fails
  // traverses as if the local layer were absent: it reads nothing from it, a
  // remote hit does not warm it, and the source it starts captures no local
  // TTL, so its settlement publishes nothing locally even after the fault
  // clears (the failed read is the call's, not the settlement's). A
  // publication whose local write fails stores nothing and completes its
  // callers with the accepted result, memoized and refilled as usual. Stated
  // as the switch read at the two points a call touches local storage: an
  // admission with an immediate reply (`begin`), where the reply's local TTL
  // is withdrawn so `layer_policy::gated` turns the layer off for that call,
  // and a settlement (`settle`), where the source's captured local TTL is
  // withdrawn so `serving::publish` warms nothing. The traversal and the
  // publication keep their one statement in `serving`; the remote fault
  // switches live in `serving::Served` because the traversal reads them mid
  // release, where this one is read at its two entry points.
  import layer_policy.* from "./layer-policy"
  import calls.* from "./calls"
  import flights as Flights from "./flights"
  import serving as Serving from "./serving"

  type Faulted[r] = Serving::Served[{ localFailed: bool | r }]

  // The TTLs a call meets: the reply's, with the local TTL withdrawn under a fault.
  pure def ttlsUnder(state: Faulted[r], ttls: Ttls): Ttls =
    if (state.localFailed) { localMs: 0, ...ttls } else ttls
  pure def begin(state: Faulted[r], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls): Faulted[r] =
    Serving::begin(state, layout, call, resolved, ttlsUnder(state, ttls))
  // A settlement under an armed fault publishes nothing locally: the source
  // settles with its local TTL withdrawn and everything else as captured.
  pure def settle(state: Faulted[r], layout: Serving::Layout, index: int, value: int): Faulted[r] = {
    val source = state.sources.nth(index)
    val publishing = if (state.localFailed) { sources: state.sources.replaceAt(index, { localMs: 0, ...source }), ...state } else state
    Serving::settle(publishing, layout, index, value)
  }
}

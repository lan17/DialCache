module receipts {
  // The receipt of the latest release: who was served, by which layer, and the local slot of its
  // key as the release found it.
  //
  // Rules
  // - A receipt names the caller, its key, the layer that served it (or that it started a source
  //   or joined a flight) and the local slot of its key as the release found it.
  // - The one-step expiry and freshness properties of a profile with TTLs read it beside the
  //   storage that served the caller.
  // - Frames and clocks do not move during a release, so the frame it read is the post-state's;
  //   the local slot may have been warmed by the release and is kept here as read.
  // - `release` judges the layered release once (`serving::layeredRelease`) on the pre-release
  //   state, reads the slot from that state and applies the judgment (`serving::releaseJudged`).
  // - The traversal never reads the receipt.
  // Shapes
  // - Receipt: caller, key, layer code (`NOT_SERVED` to `STARTED`), local value and expiry as read.
  // - Receipted[r]: the latest receipt beside a profile's state; what `release` writes.
  // - ReceiptedServed[r]: `serving::Served` with the receipt; what `release` takes and returns.
  // Consumers: policy.
  import encodings.* from "./encodings"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"

  pure val NOT_SERVED = 0
  pure val FROM_MEMO = 1
  pure val FROM_LOCAL = 2
  pure val FROM_REMOTE = 3
  pure val STARTED = 4

  type Receipt = { caller: int, key: int, layer: int, localValue: int, localExpires: int }
  type Receipted[r] = { receipt: Receipt | r }
  type ReceiptedServed[r] = Serving::Served[Receipted[r]]
  // No caller has been released yet.
  pure val NO_RECEIPT: Receipt = { caller: NO_OWNER, key: NO_OWNER, layer: NOT_SERVED, localValue: NO_VALUE, localExpires: 0 }

  // A joined caller is completed by a flight and served by no layer.
  pure def servedLayer(outcome: Serving::Outcome): int = match outcome {
    | ServesMemo(_) => FROM_MEMO
    | ServesLocal(_) => FROM_LOCAL
    | ServesRemote(_) => FROM_REMOTE
    | Starts => STARTED
    | JoinsRequest(_) => NOT_SERVED
    | JoinsProcess(_) => NOT_SERVED
  }
  pure def release(state: ReceiptedServed[r], layout: Serving::Layout, policyCall: int, resolved: Resolution, ttls: Ttls): ReceiptedServed[r] = {
    val judged = Serving::layeredRelease(state, layout, policyCall, resolved, ttls)
    {
      receipt: {
        caller: judged.caller,
        key: judged.call.key,
        layer: servedLayer(judged.decision.outcome),
        localValue: state.localValues.nth(Serving::identity(layout, judged.call)),
        localExpires: state.localExpires.nth(Serving::identity(layout, judged.call))
      },
      ...Serving::releaseJudged(state, layout, judged, policyCall, ttls)
    }
  }
}

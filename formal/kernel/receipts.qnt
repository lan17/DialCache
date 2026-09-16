module receipts {
  // The receipt of the latest release: the caller it served, its key, the
  // layer that served it (or that it started a source, or joined a flight),
  // and the local slot of its key as the release found it. The one-step
  // expiry and freshness properties of a profile with TTLs read it beside the
  // storage that served the caller: the frames and clocks do not move during
  // a release, so the frame it read is the post-state's, while the local slot
  // may have been warmed by the release and is kept here as read. A
  // receipted variant of the layered release, judged once
  // (`serving::layeredRelease`) on the pre-release state beside the release
  // itself; the traversal never reads the receipt.
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
        localValue: judged.localValue,
        localExpires: judged.localExpires
      },
      ...Serving::release(state, layout, policyCall, resolved, ttls)
    }
  }
}

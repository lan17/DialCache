module receipts {
  // The receipt of the latest release: the caller it served, its key and the
  // layer that served it (none when a source completes it). The one-step
  // expiry and freshness properties of a profile with TTLs read it beside the
  // storage that served the caller: the frames and clocks do not move during
  // a release, so the entry or frame it read is the post-state's. An opt-in
  // record a wrapper composes after `serving::release` from the release judged
  // once (`serving::layeredRelease`); the traversal never reads it.
  import encodings.* from "./encodings"
  import serving as Serving from "./serving"

  pure val NOT_SERVED = 0
  pure val FROM_MEMO = 1
  pure val FROM_LOCAL = 2
  pure val FROM_REMOTE = 3

  type Receipt = { caller: int, key: int, layer: int }
  type Receipted[r] = { receipt: Receipt | r }
  // No caller has been released yet.
  pure val NO_RECEIPT: Receipt = { caller: NO_OWNER, key: NO_OWNER, layer: NOT_SERVED }

  pure def servedLayer(outcome: Serving::Outcome): int = match outcome {
    | ServesMemo(_) => FROM_MEMO
    | ServesLocal(_) => FROM_LOCAL
    | ServesRemote(_) => FROM_REMOTE
    | JoinsRequest(_) => NOT_SERVED
    | JoinsProcess(_) => NOT_SERVED
    | Starts => NOT_SERVED
  }
  pure def record(state: Receipted[r], judged: Serving::LayeredRelease): Receipted[r] =
    { receipt: { caller: judged.caller, key: judged.call.key, layer: servedLayer(judged.decision.outcome) }, ...state }
}

module local_grid {
  import cache_rules.* from "../cache-rules"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"

  // Raw environment instants are retained beside the ordinary local expiry.
  // Lookup projects both the observed time and the insertion time onto the
  // shared millisecond grid. Keeping both raw instants makes a precise-clock
  // expiry error executable; an already rounded insertion cannot expose it.
  type State[r] = Serving::LocalServed[{ ticks: int, localInsertedTicks: List[int] | r }]

  pure def call(state: State[r], layout: Serving::Layout, who: Call, resolved: Resolution, ttls: Ttls, value: int, ticksPerMs: int): State[r] = {
    val slot = who.instance * layout.keysPerInstance + who.key
    val localEnabled = Serving::participating(state, layout, who) and gated(resolved, ttls).layers.local
    val observed = if (localEnabled) {
      val inserted = state.localInsertedTicks.nth(slot)
      // The retained expiry remains authoritative. Deriving its duration from
      // the insertion grid keeps expiry edits observable instead of silently
      // substituting a second, independently stored TTL.
      val ttlMs = state.localExpires.nth(slot) - wholeMs(inserted, ticksPerMs)
      val live = localEntryLiveOnGrid(state.ticks, inserted, ttlMs, ticksPerMs)
      if (live) state.localValues.nth(slot) else NO_VALUE
    } else NO_VALUE
    val completed = Serving::callLocalObserved(state, layout, who, resolved, ttls, observed, value)
    val started = completed.sources.length() > state.sources.length()
    val publishes = started and accepted(value) and state.capacity > 0
      and completed.sources.nth(completed.sources.length() - 1).localMs > 0
    if (publishes) {
      localInsertedTicks: completed.localInsertedTicks.replaceAt(slot, state.ticks),
      ...completed
    } else completed
  }
}

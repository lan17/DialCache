module metrics {
  // The observer's metric events over the remote layer (C30, C57 to C59):
  // the ordered trail the implementations report to their metrics callback
  // (`src/internal/redis-cache.ts` `getWithResolvedConfig`,
  // `startRawPayloadRead`, `putWithLayer`, `deserializePayload`;
  // `src/dialcache.ts` the `disabled`, `coalesced`, `fallback` and
  // `invalidation` metrics; `go/engine.go` the same) and the effects drivers
  // compare as `events`, one record per event: its name, the layer or scope
  // it names, its detail (a reason, an error category or an operation) and
  // its amount (milliseconds for a duration or an offset, bytes for a size,
  // the dispatch index of a write, 0 otherwise).
  //
  // Stated here once, as metered variants of the held remote lifecycle with
  // held refills (`remote_writes::HeldWriting`) and the diagnosed channel
  // (`diagnostics::DiagnosedHeld`): a participating caller's admission reports
  // each shared layer its reply leaves off as disabled by policy
  // (`policy_disabled`: no effective TTL; local before remote), then the read
  // it dispatched (`request`) or the singleflight it joined (`coalesced`, the
  // scope `diagnostics` recorded); a read reports its deadline error
  // (`cache_read_timeout`, when its deadline is delivered or found reached at
  // its late reply), its fault (`cache_read`) or its miss with the reason
  // (`value_absent` when no frame is present, `watermark_fenced` when the
  // watermark hides one, `unclassified` for a visible frame declined as
  // future-dated, after a `futureOffset` of the stamp's lead over the wall
  // clock, `expired` for one declined as stale, the frame being the stored one
  // or a queued frame reply; a queued miss reply's normalized reason,
  // `adapter_replies`), and its duration (`get`) measured
  // from its dispatch to its settlement, or to the settlement of the fresh
  // decode it held (C59: the decode is inside the read's duration), when the
  // decode reports its own duration (`serialization` `load`) after its fault
  // (`serialization_load`, then an `unclassified` miss); a loader whose
  // flight's outcome the step records reports its failure (`error` against
  // the layer `diagnostics` attributed it to, detail `fallback`) and its
  // duration (`fallback`) from its start to that settlement, whether the
  // result arrived or the deadline was delivered, and a late result that only
  // drains reports nothing (C58: late sources do not repeat failures); a dump
  // released reports its fault (`serialization_dump`) or its duration
  // (`serialization` `dump`) from its hold, then the serialized and stored
  // sizes and, when the second fence check lets the write go, the write's
  // dispatch with its index (`writeDispatch`); a write released reports its
  // fault (`cache_write`); an invalidation that is counted is reported
  // (`invalidation`). The instants the durations are measured from are
  // recorded by the transitions that start each effect: per flight the
  // dispatch of its read, per decode its hold, per loader ordinal its start,
  // per dump its hold.
  //
  // Outside this module's consumers, and not stated: a bypass caller's
  // `context` reason, a payload class that fails the read (the fault reported
  // here is the drivers'), a recovery decode's events, compression events.
  // One consumer today, effects.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import remote_io as RemoteIO from "./remote-io"
  import remote_frames as Remote from "./remote-frames"
  import remote_writes as Writes from "./remote-writes"
  import deadlines as Deadlines from "./deadlines"
  import diagnostics as Diagnostics from "./diagnostics"
  import adapter_replies as Replies from "./adapter-replies"
  import clock as Clock from "./clock"

  type Event = { event: str, location: str, detail: str, amount: int }
  pure val NO_DETAIL = ""
  // A flight that dispatched no read measures no read duration.
  pure val NO_INSTANT = -1
  // The metered shape: the diagnosed held lifecycle with held refills and the
  // queued reply, the events channel and the instants.
  type Metered[r, q] = Diagnostics::DiagnosedHeld[{
    events: List[Event],
    readStarted: List[int], decodeStarted: List[int], sourceStarted: List[int], dumpStarted: List[int],
    reply: int, replyAt: int,
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite] | r
  }, q]

  // A profile's independent diagnostic property reads the raw acquisition
  // facts beside the resulting event stream. This receipt makes no judgment
  // about freshness or the miss category, and no transition consumes it.
  type FrameReadReceipt = { frame: bool, owns: bool, stamp: int, wall: int,
    freshMs: int, elapsed: int, due: int, missesBefore: int }
  pure val NO_FRAME_READ_RECEIPT: FrameReadReceipt = { frame: false, owns: false,
    stamp: 0, wall: 0, freshMs: 0, elapsed: 0, due: 0, missesBefore: 0 }
  pure def frameReadReceipt(state: Metered[r, q], read: int): FrameReadReceipt = {
    val held = RemoteIO::heldRead(state, read)
    {
      frame: state.reply == Replies::FRAME_WITH_MISS_FIELDS,
      owns: held.flight != NO_OWNER,
      stamp: state.replyAt,
      wall: state.now + state.skew,
      freshMs: held.ttls.freshMs,
      elapsed: state.now,
      due: if (held.flight == NO_OWNER) 0 else state.readStarted.nth(held.flight) + state.io.budgets.nth(read),
      missesBefore: state.events.select(e => e.event == "miss").length()
    }
  }

  pure def event(state: Metered[r, q], name: str, location: str, detail: str, amount: int): Metered[r, q] =
    { events: state.events.append({ event: name, location: location, detail: detail, amount: amount }), ...state }
  pure def remote(state: Metered[r, q], name: str, detail: str, amount: int): Metered[r, q] =
    event(state, name, Diagnostics::REMOTE_LAYER, detail, amount)
  pure def error(state: Metered[r, q], category: str): Metered[r, q] = remote(state, "error", category, 0)
  pure def miss(state: Metered[r, q], reason: str): Metered[r, q] = remote(state, "miss", reason, 0)
  pure def last(labels: List[str]): str = labels.nth(labels.length() - 1)

  // The instants a step's new effects started at: a flight the step created
  // (its read's dispatch when the step dispatched one), a decode it held, a
  // loader it started and a dump it held, each at the clock of the step.
  pure def stamped(before: Metered[r, q], after: Metered[r, q]): Metered[r, q] = {
    val flights = if (after.sources.length() > before.sources.length())
      { readStarted: after.readStarted.append(if (after.o.reads > before.o.reads) after.now else NO_INSTANT), ...after } else after
    val decodes = if (after.o.loads > before.o.loads) { decodeStarted: flights.decodeStarted.append(after.now), ...flights } else flights
    val loaders = if (after.o.loaders > before.o.loaders) { sourceStarted: decodes.sourceStarted.append(after.now), ...decodes } else decodes
    if (after.o.dumps > before.o.dumps) { dumpStarted: loaders.dumpStarted.append(after.now), ...loaders } else loaders
  }
  // The read a flight dispatched, measured to now.
  pure def readDone(state: Metered[r, q], flight: int): Metered[r, q] =
    remote(state, "get", NO_DETAIL, state.now - state.readStarted.nth(flight))

  // -- Admission -----------------------------------------------------------------

  pure def begin(state: Metered[r, q], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls, budget: int): Metered[r, q] = {
    val released = stamped(state, Diagnostics::begin(state, layout, call, resolved, ttls, budget))
    val effective = effectiveTtls(resolved, ttls)
    val admitted = if (not(Serving::participating(state, layout, call))) released else {
      val local = if (effective.localMs == 0) event(released, "disabled", Diagnostics::LOCAL_LAYER, "policy_disabled", 0) else released
      if (effective.freshMs == 0) event(local, "disabled", Diagnostics::REMOTE_LAYER, "policy_disabled", 0) else local
    }
    if (admitted.o.reads > state.o.reads) remote(admitted, "request", NO_DETAIL, 0)
    else if (admitted.d.coalesced.length() > state.d.coalesced.length()) event(admitted, "coalesced", last(admitted.d.coalesced), NO_DETAIL, 0)
    else admitted
  }

  // -- The read and the decode ----------------------------------------------------

  // The lead of a declined future-dated frame's stamp over the wall clock, 0
  // when the frame the read observed is not future-dated: a queued frame
  // reply's stamp, or the stored frame's.
  pure def futureLead(state: Metered[r, q], layout: Serving::Layout, key: int): int = {
    val stamp = if (Replies::queued(state)) (if (Replies::isFrame(state.reply)) state.replyAt else 0)
      else if (Remote::visible(state, key, layout.operationsPerEntity)) state.created.nth(key) else 0
    if (stamp > Clock::wallOf(state)) stamp - Clock::wallOf(state) else 0
  }
  // The reason a visible frame the read declined reports, the stored frame's
  // stamp or a queued frame reply's judged alike (`src/internal/redis-cache.ts`
  // `frameAge` and `getWithResolvedConfig`, `go/engine.go` `readServing`):
  // `unclassified` for a stamp ahead of the wall clock, `expired` for an age
  // that reached the freshness (`cache_rules.freshAgeAllowed` declines the
  // ceiling itself, as the ports' `ageMs >= freshAgeMs` does).
  pure def declinedFrameReason(stamp: int, wall: int): str =
    if (stamp > wall) "unclassified" else "expired"
  // The reason a read that served nothing reports: a queued miss reply's
  // normalized reason, a queued frame reply declined by its stamp, or the
  // frames': absent, hidden by the watermark, or declined by the stored stamp.
  pure def missReason(state: Metered[r, q], layout: Serving::Layout, key: int): str =
    if (Replies::queued(state))
      (if (Replies::isFrame(state.reply)) declinedFrameReason(state.replyAt, Clock::wallOf(state))
       else Replies::reason(state.tracked, state.reply))
    else if (not(state.remoteValues.nth(key) > NO_VALUE and Remote::retained(state, key))) "value_absent"
    else if (not(Remote::fenceCleared(state, key, layout.operationsPerEntity))) "watermark_fenced"
    else declinedFrameReason(state.created.nth(key), Clock::wallOf(state))
  pure def settleRead(state: Metered[r, q], layout: Serving::Layout, read: int, failed: bool, classifier: int, bufferMs: int): Metered[r, q] = {
    val held = RemoteIO::heldRead(state, read)
    val settled = stamped(state, Replies::settleRead(state, layout, read, failed, classifier, bufferMs))
    if (settled.io.aborted.length() > state.io.aborted.length()) readDone(error(settled, "cache_read_timeout"), held.flight)
    else if (not(RemoteIO::owning(held))) settled
    else if (failed) readDone(error(settled, "cache_read"), held.flight)
    else if (settled.o.loads > state.o.loads) settled
    else {
      val key = state.sources.nth(held.flight).key
      val lead = futureLead(state, layout, key)
      val offset = if (lead > 0) remote(settled, "futureOffset", NO_DETAIL, lead) else settled
      readDone(miss(offset, missReason(state, layout, key)), held.flight)
    }
  }
  pure def settleLoad(state: Metered[r, q], layout: Serving::Layout, load: int, failed: bool): Metered[r, q] = {
    val held = RemoteIO::heldLoad(state, load)
    val settled = stamped(state, Diagnostics::settleLoad(state, layout, load, failed))
    if (held.recovery) settled
    else {
      val decoded = remote(if (failed) error(settled, "serialization_load") else settled, "serialization", "load", settled.now - state.decodeStarted.nth(load))
      readDone(if (failed) miss(decoded, "unclassified") else decoded, held.flight)
    }
  }

  // -- The source ------------------------------------------------------------------

  // A loader whose flight's outcome the step recorded: its failure against the
  // layer `diagnostics` attributed it to, then its duration from its start.
  pure def sourceDone(before: Metered[r, q], after: Metered[r, q], ordinal: int, flight: int): Metered[r, q] =
    if (after.sources.nth(flight).result == before.sources.nth(flight).result) after
    else {
      val failed = if (after.d.fallbackErrors.length() > before.d.fallbackErrors.length())
        event(after, "error", last(after.d.fallbackErrors), "fallback", 0) else after
      remote(failed, "fallback", NO_DETAIL, after.now - before.sourceStarted.nth(ordinal))
    }
  pure def settleLoader(state: Metered[r, q], layout: Serving::Layout, ordinal: int, value: int, timeout: bool): Metered[r, q] = {
    val flight = state.loaders.nth(ordinal)
    sourceDone(state, stamped(state, Diagnostics::failureAttributed(state, Writes::settleLoader(state, layout, ordinal, value, timeout), flight)), ordinal, flight)
  }
  pure def expireLoader(state: Metered[r, q], layout: Serving::Layout, ordinal: int): Metered[r, q] =
    sourceDone(state, stamped(state, Diagnostics::expireLoader(state, layout, ordinal)), ordinal, state.loaders.nth(ordinal))
  pure def expireRead(state: Metered[r, q], layout: Serving::Layout, read: int): Metered[r, q] =
    readDone(error(stamped(state, Deadlines::expireRead(state, layout, read)), "cache_read_timeout"), RemoteIO::heldRead(state, read).flight)
  // Delivery from inside the kernel, as the lint requires.
  pure def advance(state: Metered[r, q], layout: Serving::Layout, ms: int): Metered[r, q] =
    Deadlines::deliver(state, ms, (current, d) =>
      if (d.kind == Deadlines::READ) expireRead(current, layout, d.index) else expireLoader(current, layout, d.index))

  // -- The refill -------------------------------------------------------------------

  // `bytes` is the serialized size of the value the source recorded (a
  // profile's constant for its fixture value).
  pure def releaseDump(state: Metered[r, q], layout: Serving::Layout, dump: int, failed: bool, bytes: int): Metered[r, q] = {
    val released = stamped(state, Writes::releaseDump(state, layout, dump, failed))
    val serialized = remote(if (failed) error(released, "serialization_dump") else released, "serialization", "dump", released.now - state.dumpStarted.nth(dump))
    if (failed) serialized
    else {
      val sized = remote(remote(serialized, "size", NO_DETAIL, bytes), "storedSize", NO_DETAIL, bytes)
      if (released.o.writes > state.o.writes) remote(sized, "writeDispatch", NO_DETAIL, state.o.writes) else sized
    }
  }
  pure def releaseWrite(state: Metered[r, q], layout: Serving::Layout, write: int, failed: bool): Metered[r, q] = {
    val released = Writes::releaseWrite(state, layout, write, failed)
    if (failed) error(released, "cache_write") else released
  }

  // -- Maintenance --------------------------------------------------------------------

  pure def invalidate(state: Metered[r, q], entity: int, bufferMs: int): Metered[r, q] = {
    val done = Serving::invalidate(state, entity, bufferMs)
    if (done.o.invalidations > state.o.invalidations) remote(done, "invalidation", NO_DETAIL, 0) else done
  }
}

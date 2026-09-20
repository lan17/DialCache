module adapter_replies {
  // The queued adapter reply (C55): what the remote adapter returns in place
  // of the stored frame, interpreted once at the trust boundary
  // (`src/internal/redis-cache.ts` `validateReadResult` and `frameAge`,
  // `src/internal/redis-payload.ts` `decodeTrackedRedisReadResult`,
  // `go/engine.go` the same). The drivers queue one reply by its class
  // (BEHAVIOR.md, the effects `adapterReply` choices 1 to 16, below); the
  // next successful raw completion consumes it whether or not DialCache still
  // owns that read (an abandoned read's completion consumes it too), and an
  // adapter failure leaves it queued. A miss reply is interpreted by its
  // discriminator: a reason that names a known cause survives (`value_absent`,
  // `expired`), an unknown reason or shape is `unclassified`, and
  // `watermark_fenced` is kept only beside a valid fence. A fence survives only
  // on a tracked key and only as a valid timestamp (a negative, fractional or
  // unsafe one is discarded), independently of the cause: the observed
  // watermark the reply carried is the refill fence of the source the miss
  // starts (C58). A frame-shaped reply with stray miss metadata is a frame,
  // stamped at the reply's wall clock and judged for freshness like a stored
  // frame's stamp (a future-dated one is declined as an unclassified miss and
  // carries no fence). No reply is ever stored: the frames are untouched.
  import cache_rules.* from "../cache-rules"
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import serving as Serving from "./serving"
  import remote_io as RemoteIO from "./remote-io"
  import remote_frames as Remote from "./remote-frames"
  import deadlines as Deadlines from "./deadlines"
  import clock as Clock from "./clock"

  pure val NO_REPLY = 0
  // The drivers' reply classes: 1 null, 2 primitive, 3 legacy watermark
  // shape, 4 kindless metadata, 5 missing miss reason, 6 unknown reason,
  // 7 unknown reason with a valid future fence, 8 fenced reason without a
  // fence, 9 negative fence, 10 fractional fence, 11 unsafe fence, 12 absent
  // reason with a valid future fence, 13 expired reason with a zero fence,
  // 14 miss with stray frame fields, 15 valid frame with stray miss metadata,
  // 16 fenced reason with a valid future fence. Codes are part of the driver
  // contract; do not renumber. Only the classes a rule names are spelled.
  pure val UNKNOWN_REASON_WITH_FENCE = 7
  pure val FRACTIONAL_FENCE = 10
  pure val UNSAFE_FENCE = 11
  pure val ABSENT_WITH_FENCE = 12
  pure val EXPIRED_ZERO_FENCE = 13
  pure val MISS_WITH_FRAME_FIELDS = 14
  pure val FRAME_WITH_MISS_FIELDS = 15
  pure val FENCED_WITH_FENCE = 16
  // The value the frame class carries (the drivers' payload "1").
  pure val FRAME_VALUE = VALUE_ONE

  // The queued reply and the wall clock it was queued at (the frame class's
  // stamp, and the instant a valid fence is measured from), beside the
  // tracking flag the fence rule reads and the clocks.
  type Queued[r] = { reply: int, replyAt: int, tracked: bool, now: int, skew: int | r }
  // The budgeted held lifecycle whose drivers queue replies.
  type QueuedHeld[r] = Deadlines::BudgetedHeld[{ reply: int, replyAt: int | r }]

  pure def queued(state: Queued[r]): bool = state.reply != NO_REPLY
  pure def queue(state: Queued[r], code: int): Queued[r] = { reply: code, replyAt: Clock::wallOf(state), ...state }
  pure def consume(state: Queued[r]): Queued[r] = { reply: NO_REPLY, ...state }
  pure def isFrame(code: int): bool = code == FRAME_WITH_MISS_FIELDS
  // A fence survives only on a tracked key and only as a valid timestamp,
  // whatever the cause beside it.
  pure def carriesFence(tracked: bool, code: int): bool =
    tracked and Set(UNKNOWN_REASON_WITH_FENCE, ABSENT_WITH_FENCE, FENCED_WITH_FENCE).contains(code)
  // The fence a queued reply carries: the watermark it observed, the reply's
  // wall clock plus the drivers' buffer (`bufferMs`), or none.
  pure def fenceOf(state: Queued[r], bufferMs: int): int =
    if (carriesFence(state.tracked, state.reply)) state.replyAt + bufferMs else NO_FENCE
  // The miss reason a reply normalizes to: a known cause survives, a fenced
  // claim needs its fence, everything else is unclassified.
  pure def reason(tracked: bool, code: int): str =
    if (Set(FRACTIONAL_FENCE, UNSAFE_FENCE, ABSENT_WITH_FENCE, MISS_WITH_FRAME_FIELDS).contains(code)) "value_absent"
    else if (code == EXPIRED_ZERO_FENCE) "expired"
    else if (code == FENCED_WITH_FENCE and carriesFence(tracked, code)) "watermark_fenced"
    else "unclassified"
  // What a read observes through the reply: the frame class is a visible frame
  // carrying the drivers' value, stamped at the reply's wall clock and served
  // while fresh for the reply's freshness (`cache_rules.freshAgeAllowed`, which
  // declines a future-dated stamp); every miss class observes nothing.
  pure def observed(state: Queued[r], freshMs: int): Remote::Observed =
    if (isFrame(state.reply)) {
      visible: true, failed: false, payload: FRAME_VALUE,
      value: if (freshAgeAllowed(state.replyAt, Clock::wallOf(state), freshMs)) FRAME_VALUE else NO_VALUE
    } else { visible: false, failed: false, payload: NO_VALUE, value: NO_VALUE }

  // A held read released under a queued reply observes the reply in place of
  // the frames and starts its source with the reply's fence
  // (`deadlines::settleObserved`); a read that owns nothing (its deadline
  // delivered, or reached undelivered, which `deadlines` expires first) drains
  // as any other. A successful completion consumes the reply, owning or not;
  // a failed one leaves it queued.
  pure def settleRead(state: QueuedHeld[r], layout: Serving::Layout, read: int, failed: bool, classifier: int, bufferMs: int): QueuedHeld[r] = {
    val held = RemoteIO::heldRead(state, read)
    val settled =
      if (queued(state) and not(failed) and RemoteIO::owning(held))
        Deadlines::settleObserved(state, layout, read, observed(state, held.ttls.freshMs), fenceOf(state, bufferMs), classifier)
      else Deadlines::settleRead(state, layout, read, failed, classifier)
    if (failed) settled else consume(settled)
  }
}

module compression {
  // The compression channel: the outcome each decode reports as it is
  // dispatched (`src/internal/compression.ts`: "decompressed" for a compressed
  // frame, "fallback_raw" for one whose compressed bytes fail to decode,
  // nothing for an uncompressed frame), what the drivers' `compression`
  // channel records. The held remote lifecycle holds a decode at two
  // transitions, a read settling on a fresh frame (`remote_io::settleRead`)
  // and a loader failing with a recovery candidate (`remote_io::settleLoader`),
  // both through `remote_io::holdLoad`, the single dispatch point. The
  // variants here apply the same transition and, when it held a decode (the one
  // with the drivers' index the step began at, `o.loads`), append the outcome
  // its payload code reports (`payloads::decodeOutcome`). A variant rather
  // than a mandatory field of `remote_io::Held`: independent would carry a
  // channel its traversal never reads. A variant rather than a wrapper in the
  // profile: a wrapper forgotten at one of the two sites is invisible to the
  // composition lint, a variant is the transition. One consumer today,
  // recovery-read.
  import serving as Serving from "./serving"
  import remote_io as RemoteIO from "./remote-io"
  import payloads as Payloads from "./payloads"

  type Compressed[r] = RemoteIO::Held[{ compression: List[str] | r }]

  // The outcome of the decode a step held, when it held one.
  pure def reported(before: Compressed[r], after: Compressed[r]): Compressed[r] =
    if (after.o.loads > before.o.loads)
      { compression: after.compression.concat(Payloads::decodeOutcome(RemoteIO::heldLoad(after, before.o.loads).value)), ...after }
    else after
  pure def settleRead(state: Compressed[r], layout: Serving::Layout, read: int, failed: bool, classifier: int): Compressed[r] =
    reported(state, RemoteIO::settleRead(state, layout, read, failed, classifier))
  pure def settleLoader(state: Compressed[r], layout: Serving::Layout, ordinal: int, value: int, timeout: bool): Compressed[r] =
    reported(state, RemoteIO::settleLoader(state, layout, ordinal, value, timeout))
}

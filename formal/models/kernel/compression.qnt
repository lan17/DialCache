module compression {
  // The compression channel: the outcome each held decode reports as it is dispatched, what
  // the drivers' `compression` channel records.
  //
  // Rules
  // - A decode reports "decompressed" for a compressed frame, "fallback_raw" for one whose
  //   compressed bytes fail to decode, and nothing for an uncompressed frame.
  // - The held lifecycle holds a decode at two transitions, `remote_io::settleRead` on a fresh
  //   frame and `remote_io::settleLoader` on a failed loader with a recovery candidate.
  // - Each variant applies the same transition and, when it held a decode, appends the outcome
  //   its payload code reports (`payloads::decodeOutcome`; `reported`).
  // - A variant rather than a mandatory `remote_io::Held` field, which independent would carry
  //   unread, or a profile wrapper, which the composition lint cannot see when a site forgets it.
  // - No variant yet records compression during source deadline delivery or shadow settlement.
  // Shapes
  // - Compressed[r]: `remote_io::Held` with the `compression` outcome list; recovery-read uses it.
  // Consumers: recovery-read.
  // Ports: typescript/src/internal/compression.ts `CompressionReadOutcome`, `decompressPayload`.
  import serving as Serving from "./serving"
  import remote_io as RemoteIO from "./remote-io"
  import payloads as Payloads from "./payloads"

  type Compressed[r] = RemoteIO::Held[{ compression: List[str] | r }]

  // The outcome of the decode a step held, when it held one: the decode with
  // the drivers' index the step began at (`o.loads`), held through
  // `remote_io::holdLoad`, the single dispatch point of both transitions.
  pure def reported(before: Compressed[r], after: Compressed[r]): Compressed[r] =
    if (after.o.loads > before.o.loads)
      { compression: after.compression.concat(Payloads::decodeOutcome(RemoteIO::heldLoad(after, before.o.loads).value)), ...after }
    else after
  pure def settleRead(state: Compressed[r], layout: Serving::Layout, read: int, failed: bool, classifier: int): Compressed[r] =
    reported(state, RemoteIO::settleRead(state, layout, read, failed, classifier))
  pure def settleLoader(state: Compressed[r], layout: Serving::Layout, ordinal: int, value: int, timeout: bool): Compressed[r] =
    reported(state, RemoteIO::settleLoader(state, layout, ordinal, value, timeout))
}

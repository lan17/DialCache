module payloads {
  // Payload validity classes: what a remote frame's stored code says about
  // the bytes the adapter returned. A frame stores a payload code; the codes
  // below ENVELOPED are the drivers' shared value codes (1..9,
  // `conformance_observations`) and any code a profile adds below 100
  // (runtime-boundaries' VALUE_UNDEFINED_STRING = 11), each of which decodes
  // to itself. The enveloped band starts at 100 so no future profile value
  // collides with a class: COMPRESSED_ONE is a compressed frame whose bytes
  // decode to VALUE_ONE (`src/internal/compression.ts` outcome
  // "decompressed"), CORRUPT_COMPRESSED a frame whose compressed bytes fail
  // to decode (outcome "fallback_raw"; the value the bytes would have carried
  // is VALUE_ONE, consulted only after `decodeFails` was judged),
  // UNSUPPORTED_ENCODING a frame whose header names an encoding the adapter
  // does not know, which throws once the frame is present and fence-cleared
  // (`src/internal/redis-payload.ts:44-52`), so the read fails.
  //
  // The judgments are consulted once, in `remote_frames::observe`, for the
  // atomic release and the held read settlement alike, at the held decode
  // (`remote_io::settleLoad`) and at candidate retention (`recovery::retain`).
  // The invariant every future class keeps: a code `readFails` excludes never
  // reaches a serve site (the read that finds it fails and observes nothing);
  // a `decodeFails` code reaches a serve site only through the held path's
  // decode step, which fails it; and every serve site judges the decoded
  // value, never the code: the fresh sites (`serving::decide`,
  // `remote_io::settleRead`) serve a positive `valueOf` only and
  // `recovery::retain` admits a candidate only when its code decodes to a
  // value, so a code whose `valueOf` is NO_VALUE (UNSUPPORTED_ENCODING, or a
  // code in the band that names no class, ENVELOPED itself among them) never
  // completes a caller with CALL_PENDING, the integer NO_VALUE shares.
  // Documented limit: the atomic release
  // (`serving::release`) has no decode step, so it serves
  // `valueOf(CORRUPT_COMPRESSED)`, VALUE_ONE, for a fresh code-102 frame; a
  // profile composed over the atomic path must not seed decode-fault
  // payloads (pinned by the payload-classes fixture,
  // `atomicReleaseOfAFreshCorruptFrameServesWithoutADecodeStepTest`).
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"

  pure val ENVELOPED = 100
  pure val COMPRESSED_ONE = 101
  pure val CORRUPT_COMPRESSED = 102
  pure val UNSUPPORTED_ENCODING = 103

  // The value a payload decodes to: itself below the band, VALUE_ONE for the
  // two compressed classes, none for UNSUPPORTED_ENCODING or for a code in the
  // band that names no class.
  pure def valueOf(payload: int): int =
    if (payload < ENVELOPED) payload
    else if (payload == COMPRESSED_ONE or payload == CORRUPT_COMPRESSED) VALUE_ONE
    else NO_VALUE
  // The adapter throws on the frame: the read fails once the frame is visible.
  pure def readFails(payload: int): bool = payload == UNSUPPORTED_ENCODING
  // The bytes fail to decode: a fresh decode restarts the loader, a recovery
  // decode keeps the loader's error.
  pure def decodeFails(payload: int): bool = payload == CORRUPT_COMPRESSED
  // The compression outcome a decode of the payload reports, none for an
  // uncompressed one.
  pure def decodeOutcome(payload: int): List[str] =
    if (payload == COMPRESSED_ONE) List("decompressed")
    else if (payload == CORRUPT_COMPRESSED) List("fallback_raw")
    else List()
}

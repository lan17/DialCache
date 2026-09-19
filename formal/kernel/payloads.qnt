module payloads {
  // Payload validity classes: what a remote frame's stored code says about
  // the bytes the adapter returned. A frame stores a payload code. The codes
  // below COMPRESSED are the drivers' shared value codes (1..9,
  // `conformance_observations`) and any code a profile adds below 100
  // (runtime-boundaries' VALUE_UNDEFINED_STRING = 11), each of which decodes
  // to itself. The enveloped band starts at 100 and keeps class and value
  // apart: a code in the band is a class hundred plus the value the bytes
  // carry, so values stay below 100 and no profile value collides with a
  // class. COMPRESSED + v is a compressed frame whose bytes decode to v
  // (`src/internal/compression.ts` outcome "decompressed"); CORRUPT + v a
  // frame whose compressed bytes fail to decode (outcome "fallback_raw"; v is
  // the value the bytes would have carried); UNSUPPORTED_ENCODING a frame
  // whose header names an encoding the adapter does not know, which throws
  // once the frame is present and fence-cleared
  // (`src/internal/redis-payload.ts` `decodeRedisPayload`), so the read
  // fails. A compressed or corrupt code must carry a positive value to reach
  // a decode step or to be a recovery candidate: `remote_frames::observe` and
  // `recovery::retain` consult the value before any decode as that
  // positivity test (`valueOf(code) > NO_VALUE`), so a bare COMPRESSED or
  // CORRUPT (value 0) is routed as a visible frame the traversal declined, a
  // miss holding no decode, reporting no compression outcome and, should its
  // loader fail, the miss label of a declined frame with no candidate (pinned
  // by the payload-classes fixture, `bareCorruptCodeIsADeclinedFrameTest`
  // and, for the failed loader,
  // `codeWithoutADecodedValueIsNoRecoveryCandidateTest`). UNSUPPORTED_ENCODING
  // is spelled bare because it names no value. The class rules read the class
  // alone; a profile spells a seed as the sum
  // (`Payloads::COMPRESSED + VALUE_ONE`), arithmetic over constants, which the
  // composition lint accepts.
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
  // value, so a class with no decoded value (UNSUPPORTED_ENCODING, or a class
  // this module names no rule for) yields NO_VALUE from `valueOf` and never
  // completes a caller with CALL_PENDING, the integer NO_VALUE shares.
  // Atomic-path limit: `serving::release` serves `valueOf` without a decode
  // step, and `shadow::settleJob` compares through `valuesMatch` without a
  // decode-failure arm. Profiles over either path schedule
  // `atomicPathSeedsDecodableFrames = Payloads::atomicSafe(s)` so a future
  // corrupt seed is refused by an invariant, rather than silently served or
  // compared. The payload-classes fixture pins the underlying limit with
  // `atomicReleaseOfAFreshCorruptFrameServesWithoutADecodeStepTest`.
  import encodings.* from "./encodings"

  // The classes, as hundreds: a payload in the band is a class plus a value
  // below 100.
  pure val COMPRESSED = 100
  pure val CORRUPT = 200
  pure val UNSUPPORTED_ENCODING = 300
  // Spellings of a value that decode like a plain one but carry other bytes
  // (the shadow drivers' payloads, C51): a text padded with whitespace
  // (`" 1"`, the drivers' seed 6) and a JSON string decoding to a value no
  // source returns (`"café"`, seed 7; the profile spells its decoded value).
  pure val PADDED = 400
  pure val UNICODE = 500
  // The form line: a payload at or above it is the binary spelling of the
  // text payload below it, the same bytes (`bytesOf`), so the confirmation
  // read compares bytes across the two forms and every class judgment reads
  // the bytes. A profile spells `Payloads::BINARY + Payloads::PADDED + VALUE_ONE`.
  pure val BINARY = 1000

  // The bytes a payload carries: the form stripped.
  pure def bytesOf(payload: int): int = payload % BINARY
  // The class of a payload: 0 below the band, its hundred in it.
  pure def classOf(payload: int): int = bytesOf(payload) / 100
  // The value a payload decodes to: itself below the band, the value its
  // code carries for the compressed, corrupt, padded and unicode classes,
  // none for UNSUPPORTED_ENCODING or for a class this module names no rule for.
  pure def valueOf(payload: int): int = {
    val bytes = bytesOf(payload)
    if (bytes < COMPRESSED) bytes
    else if (Set(classOf(COMPRESSED), classOf(CORRUPT), classOf(PADDED), classOf(UNICODE)).contains(classOf(bytes))) bytes % 100
    else NO_VALUE
  }
  // The adapter throws on the frame: the read fails once the frame is visible.
  pure def readFails(payload: int): bool = classOf(payload) == classOf(UNSUPPORTED_ENCODING)
  // The bytes fail to decode: a fresh decode restarts the loader, a recovery
  // decode keeps the loader's error.
  pure def decodeFails(payload: int): bool = classOf(payload) == classOf(CORRUPT)
  // Atomic consumers have no decode-failure settlement; held consumers do.
  // Read only the payload slots so this helper stays below remote_frames.
  pure def atomicSafe(state: { remoteValues: List[int] | r }): bool =
    state.remoteValues.indices().forall(key => not(decodeFails(state.remoteValues.nth(key))))
  // The compression outcome a decode of the payload reports, none for an
  // uncompressed one.
  pure def decodeOutcome(payload: int): List[str] =
    if (classOf(payload) == classOf(COMPRESSED)) List("decompressed")
    else if (classOf(payload) == classOf(CORRUPT)) List("fallback_raw")
    else List()
}

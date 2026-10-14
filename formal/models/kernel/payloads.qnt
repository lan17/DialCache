module payloads {
  // Payload validity classes: what the code a remote frame stores says about the bytes the
  // adapter returned, judged by the class alone.
  //
  // Rules
  // - A code below `COMPRESSED` decodes to itself; a code in the enveloped band from 100 up is a
  //   class hundred plus the value the bytes carry (`classOf`, `valueOf`).
  // - The invariant every future class keeps: a `readFails` code never reaches a serve site, and a
  //   `decodeFails` code reaches one only through the held path's decode step, which fails it.
  // - Every serve site judges the decoded value, never the code: a class with no decoded value
  //   yields `NO_VALUE` from `valueOf` and never completes a caller.
  // - A compressed or corrupt code reaches a decode step or candidacy only with a positive value;
  //   a bare class code is routed as a visible frame the traversal declined.
  // - The judgments are consulted once, in `remote_frames::observe`, `remote_io::settleLoad` and
  //   `recovery::retain`: the atomic release and held read settlement, the held decode, candidacy.
  // - Atomic release and atomic shadow comparison have no decode-failure settlement; every atomic
  //   profile schedules `atomicPathSeedsDecodableFrames` over `atomicSafe` against corrupt seeds.
  // - A payload at or above `BINARY` is the binary spelling of the text payload below it, the same
  //   bytes (`bytesOf`), which every class judgment reads and shadow confirmation compares (C51).
  // Consumers: dark-layers, layers, local-failure, policy, recovery-read, runtime-boundaries,
  //   shadow, shadow-layers; composed through `remote_frames`, `remote_io`, `remote_writes`,
  //   `recovery`, `compression` and `shadow`.
  // Ports: typescript/src/internal/compression.ts `decompressPayload`;
  //   typescript/src/internal/redis-payload.ts `decodeRedisPayload`.
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
  // The class of a payload: 0 below the band, its hundred in it. The codes
  // below COMPRESSED are the drivers' shared value codes (1..9,
  // `conformance_observations`) and any code a profile adds below 100
  // (runtime-boundaries' VALUE_UNDEFINED_STRING, 11), each of which decodes to
  // itself. The band keeps class and value apart, so values stay below 100 and
  // no profile value collides with a class. The class rules read the class
  // alone; a profile spells a seed as the sum of a class and a value,
  // arithmetic over constants, which the composition lint accepts.
  pure def classOf(payload: int): int = bytesOf(payload) / 100
  // The value a payload decodes to: itself below the band, the value its
  // code carries for the compressed, corrupt, padded and unicode classes,
  // none for UNSUPPORTED_ENCODING or for a class this module names no rule for.
  // Every serve site judges this value, never the code: the fresh sites
  // (`serving::decide`, `remote_io::settleRead`) serve a positive value only,
  // and `recovery::retain` admits a candidate only when its code decodes to a
  // value. So a class with no decoded value yields NO_VALUE and never completes
  // a caller with CALL_PENDING, the integer NO_VALUE shares.
  // A compressed or corrupt code must carry a positive value to reach a decode
  // step or to be a recovery candidate: `remote_frames::observe` and
  // `recovery::retain` consult this value before any decode as that positivity
  // test. A bare COMPRESSED or CORRUPT (value 0) is routed as a visible frame
  // the traversal declined. Such a miss holds no decode and reports no
  // compression outcome; should its loader fail, it reports the miss label of a
  // declined frame with no candidate. The payload-classes fixture pins both,
  // `bareCorruptCodeIsADeclinedFrameTest` and, for the failed loader,
  // `codeWithoutADecodedValueIsNoRecoveryCandidateTest`.
  pure def valueOf(payload: int): int = {
    val bytes = bytesOf(payload)
    if (bytes < COMPRESSED) bytes
    else if (Set(classOf(COMPRESSED), classOf(CORRUPT), classOf(PADDED), classOf(UNICODE)).contains(classOf(bytes))) bytes % 100
    else NO_VALUE
  }
  // The adapter throws on the frame: the read fails once the frame is visible.
  // UNSUPPORTED_ENCODING is a frame whose header names an encoding the adapter
  // does not know: `decodeRedisPayload` throws once the frame is present and
  // fence-cleared, so the read fails. It is spelled bare because it names no
  // value. A code this excludes never reaches a serve site; the read that
  // finds it fails and observes nothing.
  pure def readFails(payload: int): bool = classOf(payload) == classOf(UNSUPPORTED_ENCODING)
  // The bytes fail to decode: a fresh decode restarts the loader, a recovery
  // decode keeps the loader's error. A code this names reaches a serve site
  // only through the held path's decode step (`remote_io::settleLoad`), which
  // fails it.
  pure def decodeFails(payload: int): bool = classOf(payload) == classOf(CORRUPT)
  // Atomic consumers have no decode-failure settlement; held consumers do.
  // Read only the payload slots so this helper stays below remote_frames.
  // The limit: `serving::release` serves `valueOf` without a decode step, and
  // `shadow::settleJob` compares through `valuesMatch` without a decode-failure
  // arm. Profiles over either path schedule `atomicPathSeedsDecodableFrames`
  // over this judgment, so a future corrupt seed is refused by an invariant
  // rather than silently served or compared. The payload-classes fixture pins
  // the underlying limit with
  // `atomicReleaseOfAFreshCorruptFrameServesWithoutADecodeStepTest`.
  pure def atomicSafe(state: { remoteValues: List[int] | r }): bool =
    state.remoteValues.indices().forall(key => not(decodeFails(state.remoteValues.nth(key))))
  // The compression outcome a decode of the payload reports, none for an
  // uncompressed one. COMPRESSED + v is a compressed frame whose bytes decode
  // to v (the port's `decompressPayload` outcome "decompressed"); CORRUPT + v
  // is a frame whose compressed bytes fail to decode (outcome "fallback_raw"),
  // v being the value the bytes would have carried.
  pure def decodeOutcome(payload: int): List[str] =
    if (classOf(payload) == classOf(COMPRESSED)) List("decompressed")
    else if (classOf(payload) == classOf(CORRUPT)) List("fallback_raw")
    else List()
}

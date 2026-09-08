module dialcache_redis_protocol {
  // Abstract classifier for the public Redis protocol decoder. This intentionally
  // models validation/classification ordering rather than concrete Buffer bytes;
  // byte-for-byte interoperability belongs in portable protocol vectors.

  type ReplyType = NilReply | BufferReply | InvalidReply
  type FrameShape = NoFrame | ShortFrame | UnknownVersion | SupportedFrame
  type WatermarkState = MissingWatermark | ValidWatermark | MalformedWatermark | InvalidWatermarkReply
  type PayloadEncoding = Utf8Encoding | BinaryEncoding | UnsupportedEncoding
  type DecodeResult = PendingDecode | ValueAbsent | UnclassifiedMiss | WatermarkFenced | DecodedHit | PayloadEncodingError | PayloadTypeError

  var tracked: bool
  var valueReply: ReplyType
  var watermarkReply: ReplyType
  var frameShape: FrameShape
  var frameTimestamp: int
  var watermarkState: WatermarkState
  var watermarkValue: int
  var encoding: PayloadEncoding
  var result: DecodeResult
  var observedWatermarkAttached: bool

  action init = all {
    tracked' = false,
    valueReply' = BufferReply,
    watermarkReply' = NilReply,
    frameShape' = SupportedFrame,
    frameTimestamp' = 1,
    watermarkState' = MissingWatermark,
    watermarkValue' = 0,
    encoding' = Utf8Encoding,
    result' = PendingDecode,
    observedWatermarkAttached' = false,
  }

  // Environment setup before one decoder call.
  action toggleTracked = all {
    result == PendingDecode,
    tracked' = not(tracked),
  }

  action cycleValueReply = all {
    result == PendingDecode,
    valueReply' = if (valueReply == BufferReply) NilReply
      else if (valueReply == NilReply) InvalidReply
      else BufferReply,
  }

  action cycleWatermarkReply = all {
    result == PendingDecode,
    watermarkReply' = if (watermarkReply == NilReply) BufferReply
      else if (watermarkReply == BufferReply) InvalidReply
      else NilReply,
  }

  action cycleFrameShape = all {
    result == PendingDecode,
    frameShape' = if (frameShape == SupportedFrame) ShortFrame
      else if (frameShape == ShortFrame) UnknownVersion
      else SupportedFrame,
  }

  action setZeroTimestamp = all {
    result == PendingDecode,
    frameTimestamp' = if (frameTimestamp == 0) 1 else 0,
  }

  action setFencedTimestamp = all {
    result == PendingDecode,
    frameTimestamp' = 1,
    watermarkValue' = 1,
    watermarkState' = ValidWatermark,
    watermarkReply' = BufferReply,
  }

  action cycleWatermarkState = all {
    result == PendingDecode,
    watermarkReply' = BufferReply,
    watermarkState' = if (watermarkState == MissingWatermark) ValidWatermark
      else if (watermarkState == ValidWatermark) MalformedWatermark
      else MissingWatermark,
    watermarkValue' = 0,
  }

  action toggleEncoding = all {
    result == PendingDecode,
    encoding' = if (encoding == Utf8Encoding) BinaryEncoding
      else if (encoding == BinaryEncoding) UnsupportedEncoding
      else Utf8Encoding,
  }

  // Decoder ordering follows docs/redis.md and redis-payload.test.ts:
  // 1. raw reply types
  // 2. nil/short/version classification
  // 3. tracked watermark metadata and fence
  // 4. payload encoding
  action decode = all {
    result == PendingDecode,
    if (valueReply == InvalidReply or (tracked and watermarkReply == InvalidReply))
      result' = PayloadTypeError
    else if (valueReply == NilReply)
      result' = ValueAbsent
    else if (frameShape == ShortFrame or frameShape == UnknownVersion)
      all {
        result' = UnclassifiedMiss,
        observedWatermarkAttached' = tracked and watermarkReply == BufferReply and watermarkState == ValidWatermark,
      }
    else if (tracked and watermarkReply == BufferReply and watermarkState == MalformedWatermark)
      result' = UnclassifiedMiss
    else if (tracked and frameTimestamp == 0)
      all {
        result' = UnclassifiedMiss,
        observedWatermarkAttached' = watermarkReply == BufferReply and watermarkState == ValidWatermark,
      }
    else if (tracked and watermarkReply == BufferReply and watermarkState == ValidWatermark and frameTimestamp <= watermarkValue)
      all {
        result' = WatermarkFenced,
        observedWatermarkAttached' = true,
      }
    else if (encoding == UnsupportedEncoding)
      result' = PayloadEncodingError
    else
      result' = DecodedHit,
  }

  action step = any {
    toggleTracked,
    cycleValueReply,
    cycleWatermarkReply,
    cycleFrameShape,
    setZeroTimestamp,
    setFencedTimestamp,
    cycleWatermarkState,
    toggleEncoding,
    decode,
  }

  // Null value wins over malformed/missing watermark metadata after reply type
  // validation, matching MGET's value-absence semantics.
  val nilValueIsValueAbsent =
    result == PendingDecode or valueReply != NilReply or result == ValueAbsent or result == PayloadTypeError

  // Tracked frame/watermark classification happens before encoding validation,
  // so a fenced/invalid tracked frame can hide an unsupported payload encoding.
  val fenceCanPrecedeEncodingError =
    result != WatermarkFenced or tracked

  // Untracked decoders accept timestamp zero; tracked decoders fail closed.
  val trackedZeroTimestampIsNotHit =
    result == PendingDecode or not(tracked and frameTimestamp == 0) or result != DecodedHit

  // A valid paired watermark may accompany semantic misses independently of the
  // miss reason; untracked paths never attach it.
  val observedWatermarkOnlyOnTrackedReads =
    not(observedWatermarkAttached) or tracked

  // Unsupported encoding is reported only for an otherwise eligible frame.
  val encodingErrorRequiresSupportedFrame =
    result != PayloadEncodingError or
      (valueReply == BufferReply and frameShape == SupportedFrame and encoding == UnsupportedEncoding)
}
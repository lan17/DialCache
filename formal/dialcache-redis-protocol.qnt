module dialcache_redis_protocol {
  // Abstract classifier for the public Redis protocol decoder. This intentionally
  // models validation/classification ordering rather than concrete Buffer bytes;
  // byte-for-byte interoperability belongs in portable protocol vectors.

  type ReplyType = NilReply | BufferReply | InvalidReply
  type FrameShape = ShortFrame | UnknownVersion | SupportedFrame
  type WatermarkState = MissingWatermark | ValidWatermark | MalformedWatermark
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

  // Decoder ordering follows docs/redis.md and redis-payload.test.ts:
  // 1. raw reply types
  // 2. nil/short/version classification
  // 3. tracked watermark metadata and fence
  // 4. payload encoding
  val classification =
    if (valueReply == InvalidReply or (tracked and watermarkReply == InvalidReply))
      PayloadTypeError
    else if (valueReply == NilReply)
      ValueAbsent
    else if (frameShape == ShortFrame or frameShape == UnknownVersion)
      UnclassifiedMiss
    else if (tracked and watermarkReply == BufferReply and watermarkState == MalformedWatermark)
      UnclassifiedMiss
    else if (tracked and frameTimestamp == 0)
      UnclassifiedMiss
    else if (tracked and watermarkReply == BufferReply and watermarkState == ValidWatermark and frameTimestamp <= watermarkValue)
      WatermarkFenced
    else if (encoding == UnsupportedEncoding)
      PayloadEncodingError
    else
      DecodedHit

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

  action decode = all {
    result == PendingDecode,
    result' = classification,
    observedWatermarkAttached' = tracked and watermarkReply == BufferReply and
      watermarkState == ValidWatermark and
      (classification == ValueAbsent or classification == UnclassifiedMiss or classification == WatermarkFenced),
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
  // validation. An invalid raw watermark reply still fails the decoder first.
  val nilValueIsValueAbsent =
    result == PendingDecode or valueReply != NilReply or result == ValueAbsent or result == PayloadTypeError

  val fenceCanPrecedeEncodingError =
    result != WatermarkFenced or tracked

  // Untracked decoders accept timestamp zero; tracked decoders fail closed.
  val trackedZeroTimestampIsNotHit =
    result == PendingDecode or not(tracked and frameTimestamp == 0) or result != DecodedHit

  val observedWatermarkOnlyOnTrackedReads =
    not(observedWatermarkAttached) or tracked

  val encodingErrorRequiresSupportedFrame =
    result != PayloadEncodingError or
      (valueReply == BufferReply and frameShape == SupportedFrame and encoding == UnsupportedEncoding)
}
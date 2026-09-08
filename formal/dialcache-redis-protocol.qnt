module dialcache_redis_protocol {
  // Abstract public Redis decoder classification. Exact bytes live in portable
  // protocol vectors; this model checks validation/classification precedence.

  type ReplyType = NilReply | BufferReply | InvalidReply
  type FrameShape = ShortFrame | UnknownVersion | SupportedFrame
  type WatermarkState = MissingWatermark | ValidWatermark | MalformedWatermark
  type PayloadEncoding = Utf8Encoding | BinaryEncoding | UnsupportedEncoding
  type DecodeResult = PendingDecode | ValueAbsent | UnclassifiedMiss | WatermarkFenced | DecodedHit | PayloadEncodingError | PayloadTypeError

  type State = {
    tracked: bool,
    valueReply: ReplyType,
    watermarkReply: ReplyType,
    frameShape: FrameShape,
    frameTimestamp: int,
    watermarkState: WatermarkState,
    watermarkValue: int,
    encoding: PayloadEncoding,
    result: DecodeResult,
    observedWatermarkAttached: bool
  }

  var s: State

  // Ordering mirrors redis-payload.test.ts:
  // raw reply types -> nil/frame shape -> tracked watermark/fence -> encoding.
  pure def classify(st: State): DecodeResult =
    if (st.valueReply == InvalidReply or (st.tracked and st.watermarkReply == InvalidReply))
      PayloadTypeError
    else if (st.valueReply == NilReply)
      ValueAbsent
    else if (st.frameShape == ShortFrame or st.frameShape == UnknownVersion)
      UnclassifiedMiss
    else if (st.tracked and st.watermarkReply == BufferReply and st.watermarkState == MalformedWatermark)
      UnclassifiedMiss
    else if (st.tracked and st.frameTimestamp == 0)
      UnclassifiedMiss
    else if (st.tracked and st.watermarkReply == BufferReply and st.watermarkState == ValidWatermark and st.frameTimestamp <= st.watermarkValue)
      WatermarkFenced
    else if (st.encoding == UnsupportedEncoding)
      PayloadEncodingError
    else
      DecodedHit

  action init = s' = {
    tracked: false,
    valueReply: BufferReply,
    watermarkReply: NilReply,
    frameShape: SupportedFrame,
    frameTimestamp: 1,
    watermarkState: MissingWatermark,
    watermarkValue: 0,
    encoding: Utf8Encoding,
    result: PendingDecode,
    observedWatermarkAttached: false
  }

  action toggleTracked = all {
    s.result == PendingDecode,
    s' = { tracked: not(s.tracked), ...s },
  }

  action cycleValueReply = all {
    s.result == PendingDecode,
    s' = {
      valueReply: if (s.valueReply == BufferReply) NilReply
        else if (s.valueReply == NilReply) InvalidReply
        else BufferReply,
      ...s
    },
  }

  action cycleWatermarkReply = all {
    s.result == PendingDecode,
    s' = {
      watermarkReply: if (s.watermarkReply == NilReply) BufferReply
        else if (s.watermarkReply == BufferReply) InvalidReply
        else NilReply,
      ...s
    },
  }

  action cycleFrameShape = all {
    s.result == PendingDecode,
    s' = {
      frameShape: if (s.frameShape == SupportedFrame) ShortFrame
        else if (s.frameShape == ShortFrame) UnknownVersion
        else SupportedFrame,
      ...s
    },
  }

  action setZeroTimestamp = all {
    s.result == PendingDecode,
    s' = { frameTimestamp: if (s.frameTimestamp == 0) 1 else 0, ...s },
  }

  action setFencedTimestamp = all {
    s.result == PendingDecode,
    s' = {
      frameTimestamp: 1,
      watermarkValue: 1,
      watermarkState: ValidWatermark,
      watermarkReply: BufferReply,
      ...s
    },
  }

  action cycleWatermarkState = all {
    s.result == PendingDecode,
    s' = {
      watermarkReply: BufferReply,
      watermarkState: if (s.watermarkState == MissingWatermark) ValidWatermark
        else if (s.watermarkState == ValidWatermark) MalformedWatermark
        else MissingWatermark,
      watermarkValue: 0,
      ...s
    },
  }

  action toggleEncoding = all {
    s.result == PendingDecode,
    s' = {
      encoding: if (s.encoding == Utf8Encoding) BinaryEncoding
        else if (s.encoding == BinaryEncoding) UnsupportedEncoding
        else Utf8Encoding,
      ...s
    },
  }

  action decode = all {
    s.result == PendingDecode,
    s' = {
      result: classify(s),
      observedWatermarkAttached: s.tracked and s.watermarkReply == BufferReply and
        s.watermarkState == ValidWatermark and
        (classify(s) == ValueAbsent or classify(s) == UnclassifiedMiss or classify(s) == WatermarkFenced),
      ...s
    },
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

  val nilValueIsValueAbsent =
    s.result == PendingDecode or s.valueReply != NilReply or
      s.result == ValueAbsent or s.result == PayloadTypeError

  val fenceCanPrecedeEncodingError =
    s.result == PendingDecode or
      ((s.result == WatermarkFenced) ==
        (s.tracked and s.valueReply == BufferReply and s.frameShape == SupportedFrame and
         s.frameTimestamp > 0 and s.watermarkReply == BufferReply and
         s.watermarkState == ValidWatermark and s.frameTimestamp <= s.watermarkValue))

  val malformedWatermarkPrecedesEncodingError =
    s.result == PendingDecode or
      not(s.tracked and s.valueReply == BufferReply and s.frameShape == SupportedFrame and
          s.watermarkReply == BufferReply and s.watermarkState == MalformedWatermark) or
      s.result == UnclassifiedMiss

  val trackedZeroTimestampIsNotHit =
    s.result == PendingDecode or not(s.tracked and s.frameTimestamp == 0) or
      s.result != DecodedHit

  val observedWatermarkOnlyOnTrackedReads =
    not(s.observedWatermarkAttached) or s.tracked

  val encodingErrorRequiresSupportedFrame =
    s.result != PayloadEncodingError or
      (s.valueReply == BufferReply and s.frameShape == SupportedFrame and s.encoding == UnsupportedEncoding)
  run fencedEncodingTest = init.then(toggleTracked).then(setFencedTimestamp)
    .then(toggleEncoding).then(toggleEncoding).then(decode)
    .expect(s.result == WatermarkFenced and fenceCanPrecedeEncodingError)

  run reversedPrecedenceIsDetectedTest = init.then(toggleTracked).then(setFencedTimestamp)
    .then(toggleEncoding).then(toggleEncoding)
    .then(all { s' = { result: PayloadEncodingError, ...s } })
    .expect(not(fenceCanPrecedeEncodingError))

  run malformedWatermarkTest = init.then(toggleTracked)
    .then(cycleWatermarkState).then(cycleWatermarkState)
    .then(toggleEncoding).then(toggleEncoding).then(decode)
    .expect(s.result == UnclassifiedMiss and malformedWatermarkPrecedesEncodingError)
}

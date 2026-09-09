module dialcache_effects_conformance {
  // Tracked remote-only calls. Control external effects, not an event loop.
  // Calls: 0 pending, 1 value, 2 source error, 3 timeout.
  // Sources/reads: 0 registered, 1 abandoned externally, 2 settled.
  // Phase: 0 idle, 1 source, 2 write, 3 read, 4 decode, 5 serialize.
  // Portable event categories and measurements, independent of exporter names.
  // amount is milliseconds for durations/offsets, bytes for sizes, otherwise zero.
  type Event = { event: str, location: str, detail: str, amount: int }
  type State = {
    events: List[Event], readStarted: int, decodeStarted: int, tracked: int, reply: int, replyAt: int,
    now: int, wall: int, readBudget: int, baseReadBudget: int, phase: int, activeLoader: int, activeRead: int, deadline: int,
    observedFence: int, refill: int, acceptedAt: int, acceptedWall: int,
    writeTimestamp: int, storedTimestamp: int, watermark: int,
    calls: List[int], sources: List[int], readStates: List[int], readBudgets: List[int],
    loaders: int, reads: int, writes: int, invalidations: int,
    loads: int, dumps: int, policyCalls: int, readAborts: int, observerFailed: int
  }
  var s: State
  pure def finish(calls: List[int], outcome: int): List[int] =
    calls.foldl(List(), (out, result) => out.append(if (result == 0) outcome else result))
  pure def startSource(x: State, allowed: int, fence: int): State = {
    phase: 1, activeLoader: x.sources.length(), deadline: x.now + 10,
    loaders: x.loaders + 1, sources: x.sources.append(0),
    refill: allowed, observedFence: fence, ...x
  }
  pure def emit(x: State, event: str, location: str, detail: str, amount: int): State = {
    events: x.events.append({ event: event, location: location, detail: detail, amount: amount }), ...x
  }
  pure def metric(x: State, event: str, detail: str, amount: int): State = emit(x, event, "remote", detail, amount)
  pure def readDone(x: State): State = metric(x, "get", "", x.now - x.readStarted)
  pure def sourceDone(x: State, failed: bool): State = metric(
    if (failed) metric(x, "error", "fallback", 0) else x, "fallback", "", x.now - (x.deadline - 10))
  pure def decoded(x: State, failed: bool): State = {
    val measured = metric(if (failed) metric(x, "error", "serialization_load", 0) else x,
      "serialization", "load", x.now - x.decodeStarted)
    readDone(if (failed) metric(measured, "miss", "unclassified", 0) else measured)
  }
  pure def serialized(x: State, failed: bool): State = {
    val measured = metric(if (failed) metric(x, "error", "serialization_dump", 0) else x,
      "serialization", "dump", x.now - x.acceptedAt)
    if (failed) measured else metric(metric(measured, "size", "", 1), "storedSize", "", 1)
  }
  val unfenced = s.storedTimestamp > 0 and (s.tracked == 0 or s.storedTimestamp > s.watermark)
  val readable = unfenced and s.wall >= s.storedTimestamp

  pure def initial(mode: int): State = {
    events: List(), readStarted: 0, decodeStarted: 0, tracked: if (mode == 5) 0 else 1, reply: 0, replyAt: 0,
    now: 10000, wall: 100000, readBudget: List(50, 20, 10, 30, 10, 10).nth(mode),
    baseReadBudget: if (mode == 0) 50 else if (mode == 1) 20 else 10, phase: 0, activeLoader: 0, activeRead: 0, deadline: 0,
    observedFence: 0, refill: 0, acceptedAt: 0, acceptedWall: 0,
    writeTimestamp: 0, storedTimestamp: 0, watermark: 0,
    calls: List(), sources: List(), readStates: List(), readBudgets: List(),
    loaders: 0, reads: 0, writes: 0, invalidations: 0,
    loads: 0, dumps: 0, policyCalls: 0, readAborts: 0, observerFailed: 0
  }

  action init = { nondet choice = 0.to(5).oneOf()
    s' = initial(choice) }

  action beginCall = all {
    s.calls.length() < 8,
    val visited = emit(s, "disabled", "local", "policy_disabled", 0)
    val observed = if (s.phase == 0) metric(visited, "request", "", 0)
      else emit(visited, "coalesced", "process", "", 0)
    s' = {
      events: observed.events, readStarted: if (s.phase == 0) s.now else s.readStarted,
      calls: s.calls.append(0), policyCalls: s.policyCalls + 1,
      reads: if (s.phase == 0) s.reads + 1 else s.reads,
      readStates: if (s.phase == 0) s.readStates.append(0) else s.readStates,
      readBudgets: if (s.phase == 0) s.readBudgets.append(s.readBudget) else s.readBudgets,
      activeRead: if (s.phase == 0) s.reads else s.activeRead,
      deadline: if (s.phase == 0) s.now + s.readBudget else s.deadline,
      phase: if (s.phase == 0) 3 else s.phase, ...s
    }
  }

  def settledRead(index: int, failed: bool): State = {
    val x = { reply: if (failed) s.reply else 0, readStates: s.readStates.replaceAt(index, 2), ...s }
    if (s.readStates.nth(index) == 1) x
    else if (s.now >= s.deadline)
      startSource(readDone(metric({ readAborts: s.readAborts + 1, ...x }, "error", "cache_read_timeout", 0)), 0, 0)
    else if (failed) startSource(readDone(metric(x, "error", "cache_read", 0)), 0, 0)
    else if (s.reply > 0) {
      // Normalize semantic adapter observations before choosing traversal or refill.
      val validFence = s.tracked == 1 and (s.reply == 7 or s.reply == 12 or s.reply == 16)
      val reason = if (s.reply == 10 or s.reply == 11 or s.reply == 12 or s.reply == 14) "value_absent"
        else if (s.reply == 13) "expired" else if (s.reply == 16 and validFence) "watermark_fenced" else "unclassified"
      if (s.reply == 15 and s.replyAt <= s.wall) { phase: 4, loads: s.loads + 1, decodeStarted: s.now, ...x }
      else {
        val observed = if (s.reply == 15) metric(x, "futureOffset", "", s.replyAt - s.wall) else x
        startSource(readDone(metric(observed, "miss", reason, 0)), 1, if (validFence) s.replyAt + 20 else 0)
      }
    }
    else if (readable) { phase: 4, loads: s.loads + 1, decodeStarted: s.now, ...x }
    else {
      val observed = if (unfenced) metric(x, "futureOffset", "", s.storedTimestamp - s.wall) else x
      val reason = if (unfenced) "unclassified" else if (s.storedTimestamp == 0) "value_absent" else "watermark_fenced"
      startSource(readDone(metric(observed, "miss", reason, 0)), 1, if (s.tracked == 0 or unfenced) 0 else s.watermark)
    }
  }
  action releaseRead = {
    nondet choice = s.readStates.indices().filter(i => s.readStates.nth(i) != 2).oneOf()
    s' = settledRead(choice, false)
  }
  action failRead = {
    nondet choice = s.readStates.indices().filter(i => s.readStates.nth(i) != 2).oneOf()
    s' = settledRead(choice, true)
  }
  action releaseLoad = all {
    s.phase == 4,
    // The acquired snapshot survives subsequent invalidation and time passage.
    s' = { phase: 0, calls: finish(s.calls, 1), ...decoded(s, false) }
  }
  action failLoad = all { s.phase == 4, s' = startSource(decoded(s, true), 1, 0) }

  def settledSource(index: int, failed: bool): State = {
    val settled = { sources: s.sources.replaceAt(index, 2), ...s }
    val x = if (s.sources.nth(index) == 1) settled else sourceDone(settled, failed or s.now >= s.deadline)
    if (s.sources.nth(index) == 1) x
    else if (s.now >= s.deadline) { phase: 0, calls: finish(s.calls, 3), ...x }
    else if (failed) { phase: 0, calls: finish(s.calls, 2), ...x }
    else if (s.refill == 0 or s.wall <= s.observedFence)
      { phase: 0, calls: finish(s.calls, 1), ...x }
    else { phase: 5, dumps: s.dumps + 1, acceptedAt: s.now, acceptedWall: s.wall, ...x }
  }
  action resolveLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i) != 2).oneOf()
    s' = settledSource(choice, false)
  }
  action rejectLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i) != 2).oneOf()
    s' = settledSource(choice, true)
  }
  action releaseDump = all {
    s.phase == 5,
    // The native write is stamped after serialization, not at source acceptance.
    val x = serialized(s, false)
    s' = if (s.wall <= s.observedFence) { phase: 0, calls: finish(s.calls, 1), ...x }
      else { phase: 2, writes: s.writes + 1, writeTimestamp: s.wall, ...emit(x, "writeDispatch", "remote", "", s.writes) }
  }
  action failDump = all { s.phase == 5, s' = { phase: 0, calls: finish(s.calls, 1), ...serialized(s, true) } }
  action releaseWrite = all {
    s.phase == 2,
    s' = { storedTimestamp: s.writeTimestamp, phase: 0, calls: finish(s.calls, 1), ...s }
  }
  action failWrite = all { s.phase == 2, s' = { phase: 0, calls: finish(s.calls, 1), ...metric(s, "error", "cache_write", 0) } }

  action tick = {
    val x = { now: s.now + 10, wall: s.wall + 10, ...s }
    s' = if (s.phase == 3 and s.now + 10 >= s.deadline)
      startSource(readDone(metric({ readStates: s.readStates.replaceAt(s.activeRead, 1), readAborts: s.readAborts + 1, ...x }, "error", "cache_read_timeout", 0)), 0, 0)
    else if (s.phase == 1)
      { phase: 0, sources: s.sources.replaceAt(s.activeLoader, 1), calls: finish(s.calls, 3), ...sourceDone(x, true) }
    else x
  }
  // Clock observation without timer delivery also exercises settlement guards.
  action jumpClock = all {
    s.phase != 3 or s.readBudgets.nth(s.activeRead) == 10,
    s' = { now: s.now + 10, wall: s.wall + 10, ...s }
  }
  action rollbackWall = s' = { wall: s.wall - 1000, ...s }
  action seedRemote = s' = { storedTimestamp: s.wall, ...s }
  action invalidate = s' = {
    invalidations: s.invalidations + 1,
    watermark: if (s.wall > s.watermark) s.wall else s.watermark, ...metric(s, "invalidation", "", 0)
  }
  action futureFence = s' = {
    invalidations: s.invalidations + 1,
    watermark: if (s.wall + 20 > s.watermark) s.wall + 20 else s.watermark, ...metric(s, "invalidation", "", 0)
  }

  // One queued external reply, consumed by the next successfully settled raw read,
  // including abandoned reads. 0 means the normal fake Redis environment.
  action adapterReply = { nondet choice = 1.to(16).oneOf()
    all { s.reply == 0, s' = { reply: choice, replyAt: s.wall, ...s } } }
  action readBudgetPolicy = { nondet choice = 0.to(4).oneOf()
    s' = { readBudget: if (choice == 0) s.baseReadBudget else List(0, 10, 20, 30, 50).nth(choice), ...s } }
  action observerFault = { nondet choice = Set(0, 1).oneOf()
    s' = { observerFailed: choice, ...s } }

  action step = any {
    beginCall,
    any { releaseRead, releaseLoad, resolveLoader, releaseDump, releaseWrite },
    any { failRead, failLoad, rejectLoader, failDump, failWrite },
    // Favor the narrow second-fence check as well as unrestricted clock changes.
    all { s.phase == 5 and s.observedFence > 0, rollbackWall },
    any { tick, jumpClock, seedRemote, any { rollbackWall, invalidate, futureFence, observerFault, readBudgetPolicy, adapterReply } }
  }

  val oneRegisteredSource = s.sources.select(state => state == 0).length() <= 1
  val registeredFlightHasPendingCalls = s.phase == 0 or s.calls.select(result => result == 0).length() > 0
  val writeRequiresAcceptedSource = (s.phase != 2 and s.phase != 5) or
    (s.sources.nth(s.activeLoader) == 2 and s.acceptedAt < s.deadline and s.acceptedWall > s.observedFence and s.refill == 1)
  val registeredReadOwnsFlight =
    s.readStates.select(state => state == 0).length() == (if (s.phase == 3) 1 else 0) and
    (s.phase != 3 or s.readStates.nth(s.activeRead) == 0)
  val oneRequestPerRead = s.events.select(e => e.event == "request").length() == s.reads
  val oneSourceDurationPerSettlement = s.events.select(e => e.event == "fallback").length() == s.loaders - (if (s.phase == 1) 1 else 0)
  val measurementsAreNonnegative = s.events.select(e => e.amount < 0).length() == 0
  val effectCountsMatchRecords = s.reads == s.readStates.length() and s.reads == s.readBudgets.length() and s.loaders == s.sources.length()

  action tenMillisecondFixture = s' = initial(2)

  run unknownReasonKeepsValidFenceTest = tenMillisecondFixture.then(beginCall)
    .then(s' = { reply: 7, replyAt: s.wall, ...s }).then(releaseRead).then(resolveLoader)
    .expect(s.calls == List(1) and s.dumps == 0 and s.events.select(e => e.event == "miss").nth(0).detail == "unclassified")
  run untrackedReplyCannotCarryFenceTest = (s' = initial(5)).then(beginCall)
    .then(s' = { reply: 16, replyAt: s.wall, ...s }).then(releaseRead).then(resolveLoader)
    .expect(s.dumps == 1 and s.observedFence == 0 and s.events.select(e => e.event == "miss").nth(0).detail == "unclassified")
  run missDiscriminatorWinsOverFrameFieldsTest = tenMillisecondFixture.then(beginCall)
    .then(s' = { reply: 14, replyAt: s.wall, ...s }).then(releaseRead).expect(s.loads == 0 and s.loaders == 1)
  run frameWithoutMissDiscriminatorIgnoresMetadataTest = tenMillisecondFixture.then(beginCall)
    .then(s' = { reply: 15, replyAt: s.wall, ...s }).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(1) and s.loaders == 0)
  run readDurationIncludesDecodeTest = tenMillisecondFixture.then(seedRemote).then(beginCall).then(releaseRead)
    .then(tick).then(releaseLoad).expect(s.events.select(e => e.event == "get").foldl(List(), (out, e) => out.append(e.amount)) == List(10))
  run sourceDurationExcludesPublicationTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(resolveLoader)
    .then(tick).then(releaseDump).then(tick).then(releaseWrite)
    .expect(s.events.select(e => e.event == "fallback").foldl(List(), (out, e) => out.append(e.amount)) == List(0) and
      s.events.select(e => e.event == "serialization").foldl(List(), (out, e) => out.append(e.amount)) == List(10))
  run lateSourceCannotRepeatFailureMetricTest = tenMillisecondFixture.then(beginCall).then(releaseRead)
    .then(tick).then(rejectLoader).expect(s.events.select(e => e.event == "error" and e.detail == "fallback").length() == 1)
  run timedOutLoaderOverlapsNewFlightTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(tick)
    .then(beginCall).then(releaseRead).expect(s.sources == List(1, 0) and s.calls == List(3, 0))
  run acceptedWriteOutlivesDeadlineTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(resolveLoader)
    .then(tick).then(releaseDump).then(tick).expect(s.phase == 2 and s.calls == List(0))
    .then(releaseWrite).expect(s.calls == List(1))
  run delayedWriteRemainsFencedTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(resolveLoader)
    .then(releaseDump).then(tick).then(invalidate).then(releaseWrite).then(beginCall).then(releaseRead)
    .expect(not(readable) and s.calls == List(1, 0) and s.loaders == 2)
  run readTimeoutStartsIndependentSourceDeadlineTest = tenMillisecondFixture.then(beginCall).then(beginCall).then(tick)
    .expect(s.calls == List(0, 0) and s.deadline == 10020 and s.readAborts == 1)
    .then(resolveLoader).expect(s.calls == List(1, 1) and s.dumps == 0 and s.writes == 0)
  run lateReadCannotBecomeHitTest = tenMillisecondFixture.then(seedRemote).then(beginCall).then(jumpClock).then(releaseRead)
    .expect(s.loads == 0 and s.loaders == 1 and s.readAborts == 1)
  run acquiredDecodeSurvivesInvalidationAndDeadlineTest = tenMillisecondFixture.then(seedRemote).then(beginCall)
    .then(releaseRead).then(tick).then(invalidate).then(releaseLoad)
    .expect(s.calls == List(1) and s.loaders == 0 and s.readAborts == 0)
  run readFailureNeverRefillsTest = tenMillisecondFixture.then(beginCall).then(failRead).then(resolveLoader)
    .expect(s.calls == List(1) and s.dumps == 0 and s.readAborts == 0)
  run decodeFailureMayRefillTest = tenMillisecondFixture.then(seedRemote).then(beginCall).then(releaseRead).then(failLoad)
    .then(resolveLoader).then(releaseDump).then(releaseWrite)
    .expect(s.calls == List(1) and s.loads == 1 and s.writes == 1)
  run dumpFailurePreservesSourceTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(resolveLoader).then(failDump)
    .expect(s.calls == List(1) and s.writes == 0)
  run writeFailurePreservesSourceTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(resolveLoader)
    .then(releaseDump).then(failWrite).expect(s.calls == List(1) and s.storedTimestamp == 0)
  run rollbackDuringDumpRechecksObservedFenceTest = tenMillisecondFixture.then(invalidate).then(tick)
    .then(beginCall).then(releaseRead).then(resolveLoader).then(rollbackWall).then(releaseDump)
    .expect(s.calls == List(1) and s.dumps == 1 and s.writes == 0)
  run rollbackDoesNotExtendSourceDeadlineTest = tenMillisecondFixture.then(beginCall).then(releaseRead)
    .then(rollbackWall).then(tick).expect(s.calls == List(3))
  run observerFailuresCannotReplaceSourceErrorTest = tenMillisecondFixture.then(s' = { observerFailed: 1, ...s })
    .then(beginCall).then(failRead).then(rejectLoader).expect(s.calls == List(2))
  run libraryReadBudgetIsFiftyMillisecondsTest = (s' = initial(0)).then(beginCall)
    .then(tick).then(tick).then(tick).then(tick).expect(s.phase == 3 and s.loaders == 0)
    .then(tick).expect(s.phase == 1 and s.deadline == 10060 and s.readBudgets == List(50))
  run followerKeepsAcceptedReadBudgetTest = (s' = initial(3)).then(beginCall)
    .then(s' = { readBudget: 10, ...s }).then(beginCall).then(tick).then(tick)
    .expect(s.phase == 3 and s.readBudgets == List(30) and s.calls == List(0, 0))
    .then(tick).expect(s.phase == 1 and s.deadline == 10040 and s.readAborts == 1)
}

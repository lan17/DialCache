module dialcache_effects_conformance {
  // Tracked remote-only calls. Control external effects, not an event loop.
  // Calls: 0 pending, 1 value, 2 source error, 3 timeout.
  // Sources/reads: 0 registered, 1 abandoned externally, 2 settled.
  // Phase: 0 idle, 1 source, 2 write, 3 read, 4 decode, 5 serialize.
  type State = {
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
  val unfenced = s.storedTimestamp > 0 and s.storedTimestamp > s.watermark
  val readable = unfenced and s.wall >= s.storedTimestamp

  pure def initial(mode: int): State = {
    now: 10000, wall: 100000, readBudget: List(50, 20, 10, 30, 10).nth(mode),
    baseReadBudget: if (mode == 0) 50 else if (mode == 1) 20 else 10, phase: 0, activeLoader: 0, activeRead: 0, deadline: 0,
    observedFence: 0, refill: 0, acceptedAt: 0, acceptedWall: 0,
    writeTimestamp: 0, storedTimestamp: 0, watermark: 0,
    calls: List(), sources: List(), readStates: List(), readBudgets: List(),
    loaders: 0, reads: 0, writes: 0, invalidations: 0,
    loads: 0, dumps: 0, policyCalls: 0, readAborts: 0, observerFailed: 0
  }

  action init = { nondet choice = 0.to(4).oneOf()
    s' = initial(choice) }

  action beginCall = all {
    s.calls.length() < 8,
    s' = {
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
    val x = { readStates: s.readStates.replaceAt(index, 2), ...s }
    if (s.readStates.nth(index) == 1) x
    else if (s.now >= s.deadline)
      startSource({ readAborts: s.readAborts + 1, ...x }, 0, 0)
    else if (failed) startSource(x, 0, 0)
    else if (readable) { phase: 4, loads: s.loads + 1, ...x }
    else startSource(x, 1, if (unfenced) 0 else s.watermark)
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
    s' = { phase: 0, calls: finish(s.calls, 1), ...s }
  }
  action failLoad = all { s.phase == 4, s' = startSource(s, 1, 0) }

  def settledSource(index: int, failed: bool): State = {
    val x = { sources: s.sources.replaceAt(index, 2), ...s }
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
    s' = if (s.wall <= s.observedFence) { phase: 0, calls: finish(s.calls, 1), ...s }
      else { phase: 2, writes: s.writes + 1, writeTimestamp: s.wall, ...s }
  }
  action failDump = all { s.phase == 5, s' = { phase: 0, calls: finish(s.calls, 1), ...s } }
  action releaseWrite = all {
    s.phase == 2,
    s' = { storedTimestamp: s.writeTimestamp, phase: 0, calls: finish(s.calls, 1), ...s }
  }
  action failWrite = all { s.phase == 2, s' = { phase: 0, calls: finish(s.calls, 1), ...s } }

  action tick = {
    val x = { now: s.now + 10, wall: s.wall + 10, ...s }
    s' = if (s.phase == 3 and s.now + 10 >= s.deadline)
      startSource({ readStates: s.readStates.replaceAt(s.activeRead, 1), readAborts: s.readAborts + 1, ...x }, 0, 0)
    else if (s.phase == 1)
      { phase: 0, sources: s.sources.replaceAt(s.activeLoader, 1), calls: finish(s.calls, 3), ...x }
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
    watermark: if (s.wall > s.watermark) s.wall else s.watermark, ...s
  }
  action futureFence = s' = {
    invalidations: s.invalidations + 1,
    watermark: if (s.wall + 20 > s.watermark) s.wall + 20 else s.watermark, ...s
  }

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
    any { tick, jumpClock, seedRemote, any { rollbackWall, invalidate, futureFence, observerFault, readBudgetPolicy } }
  }

  val oneRegisteredSource = s.sources.select(state => state == 0).length() <= 1
  val registeredFlightHasPendingCalls = s.phase == 0 or s.calls.select(result => result == 0).length() > 0
  val writeRequiresAcceptedSource = (s.phase != 2 and s.phase != 5) or
    (s.sources.nth(s.activeLoader) == 2 and s.acceptedAt < s.deadline and s.acceptedWall > s.observedFence and s.refill == 1)
  val registeredReadOwnsFlight =
    s.readStates.select(state => state == 0).length() == (if (s.phase == 3) 1 else 0) and
    (s.phase != 3 or s.readStates.nth(s.activeRead) == 0)
  val effectCountsMatchRecords = s.reads == s.readStates.length() and s.reads == s.readBudgets.length() and s.loaders == s.sources.length()

  action tenMillisecondFixture = s' = initial(2)

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

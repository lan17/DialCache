module dialcache_recovery_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Tracked remote recovery with optional request memoization in two contexts. F=1000; runtime M=2000 or 5000 ms.
  // One registered flight, optional followers, independently held decoding.
  // Source deadline is 10 ms. Expired sources may keep running during recovery or a later flight.
  // Classifier: 0 allow, 1 deny, 2 error, 3 timeout-only default.
  // Sources: 0 registered, 1 abandoned externally, 2 settled.
  // Phase: 0 idle, 1 fresh decode, 2 source, 3 retained decode.
  type State = {
    o: Observation, d: Diagnostics, now: int, wall: int, phase: int, frame: int, created: int, expires: int,
    watermark: int, candidate: int, candidateCreated: int, maxAge: int,
    acceptedMaxAge: int, classifier: int, instanceClassifier: int, readFailed: bool, loadFailed: bool,
    canRecover: bool, canWrite: bool, observedFence: int,
    request: bool, memo: List[int], closed: List[bool], attached: List[bool],
    sources: List[int], activeLoader: int, deadline: int, sourceError: int
  }
  var s: State
  action init = {
    nondet choice = 0.to(7).oneOf()
    s' = {
    o: empty, d: noDiagnostics, now: 10000, wall: 100000, phase: 0, frame: 1, created: 99000, expires: 70000,
    watermark: 0, candidate: 0, candidateCreated: 0, maxAge: 5000,
    acceptedMaxAge: 5000, classifier: 0, instanceClassifier: List(3, 0, 1, 2).nth(choice % 4), readFailed: false, loadFailed: false,
    canRecover: false, canWrite: false, observedFence: 0,
    request: choice >= 4, memo: List(0, 0), closed: List(false, false), attached: List(false, false),
    sources: List(), activeLoader: 0, deadline: 0, sourceError: 3
    }
  }
  val readable = not(s.readFailed) and s.frame > 0 and s.now < s.expires and s.created > s.watermark
  val eligible = readable and s.created <= s.wall and s.wall - s.created < s.maxAge
  val fresh = eligible and s.wall - s.created < 1000
  pure def candidateValid(x: State): bool = x.candidate > 0 and x.candidateCreated <= x.wall and
    x.wall - x.candidateCreated < x.acceptedMaxAge

  pure def memoized(x: State, value: int): State = {
    memo: if (x.request and (value == 1 or value == 2)) x.memo.indices().fold(x.memo, (out, scope) =>
      if (x.attached.nth(scope) and not(x.closed.nth(scope))) out.replaceAt(scope, value) else out) else x.memo, ...x
  }
  def admitted(scope: int, policy: int): State =
    if (s.request and s.memo.nth(scope) > 0) {
      o: { calls: s.o.calls.append(s.memo.nth(scope)), policyCalls: s.o.policyCalls + 1, ...s.o }, ...s
    } else {
      attached: List(false, false).replaceAt(scope, true),
      o: { calls: s.o.calls.append(0), policyCalls: s.o.policyCalls + 1,
        reads: s.o.reads + 1, loads: s.o.loads + (if (fresh) 1 else 0),
        loaders: s.o.loaders + (if (fresh) 0 else 1), ...s.o },
      phase: if (fresh) 1 else 2, classifier: if (policy == 3) s.instanceClassifier else policy,
      candidate: if (eligible) s.frame else 0, candidateCreated: s.created,
      acceptedMaxAge: s.maxAge, canRecover: not(s.readFailed), canWrite: not(s.readFailed),
      observedFence: if (readable) 0 else s.watermark,
      sources: if (fresh) s.sources else s.sources.append(0),
      activeLoader: if (fresh) s.activeLoader else s.sources.length(),
      deadline: s.now + 10, sourceError: 3, ...s
    }
  action beginCall = {
    // The input encodes context 0/1 and operation classifier 0..3.
    nondet choice = 0.to(7).filter(code => not(s.closed.nth(code / 4))).oneOf()
    all { s.phase == 0, s.o.calls.length() < 8, s' = admitted(choice / 4, choice % 4) }
  }
  def joined(scope: int): State = {
    val memo = if (s.request) s.memo.nth(scope) else 0
    val joinScope = if (s.request and s.attached.nth(scope)) "request_local" else "process"
    { attached: if (memo > 0) s.attached else s.attached.replaceAt(scope, true),
      d: { coalesced: if (memo > 0) s.d.coalesced else s.d.coalesced.append(joinScope), ...s.d },
      o: { calls: s.o.calls.append(memo), policyCalls: s.o.policyCalls + 1, ...s.o }, ...s }
  }
  action joinCall = {
    nondet choice = 0.to(1).filter(scope => not(s.closed.nth(scope))).oneOf()
    all { s.phase != 0, s.o.calls.length() < 8, s' = joined(choice) }
  }
  action closeScope = {
    nondet choice = 0.to(1).filter(scope => not(s.closed.nth(scope))).oneOf()
    all { s.request, s.o.calls.length() > 0,
      s' = { closed: s.closed.replaceAt(choice, true), memo: s.memo.replaceAt(choice, 0),
        attached: s.attached.replaceAt(choice, false), ...s } }
  }
  pure def rejected(x: State, error: int, timeout: bool): State = {
    val attempt = x.canRecover and (x.classifier == 0 or (x.classifier == 3 and timeout))
    val decode = attempt and candidateValid(x)
    { d: { fallbackErrors: x.d.fallbackErrors.append("remote"), ...x.d },
      phase: if (decode) 3 else 0, sourceError: error,
      o: { classifications: x.o.classifications + (if (x.canRecover and x.classifier != 3) 1 else 0),
        loads: x.o.loads + (if (decode) 1 else 0),
        recovery: if (attempt and not(decode)) x.o.recovery.append("miss") else x.o.recovery,
        ...finish(x.o, if (decode) 0 else error) }, ...x }
  }
  def settled(index: int, failure: int): State = {
    val x = { sources: s.sources.replaceAt(index, 2), ...s }
    val write = s.canWrite and s.wall > s.observedFence
    if (s.sources.nth(index) == 1) x
    else if (failure > 0) rejected(x, 3, failure == 2)
    else { phase: 0,
      o: { dumps: s.o.dumps + (if (write) 1 else 0), writes: s.o.writes + (if (write) 1 else 0),
        writeTtls: if (write) s.o.writeTtls.append(s.acceptedMaxAge) else s.o.writeTtls,
        ...finish(s.o, 2) },
      frame: if (write) 2 else s.frame, created: if (write) s.wall else s.created,
      expires: if (write) s.now + s.acceptedMaxAge else s.expires, ...memoized(x, 2) }
  }
  action resolveLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i) != 2).oneOf()
    s' = settled(choice, 0)
  }
  action rejectLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i) != 2).oneOf()
    s' = settled(choice, 1)
  }
  action rejectTimeout = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i) != 2).oneOf()
    s' = settled(choice, 2)
  }
  action releaseLoad = all {
    s.phase == 1 or s.phase == 3,
    val recovered = not(s.loadFailed) and candidateValid(s)
    val retry = s.phase == 1 and s.loadFailed
    val result = if (retry) 0 else if (s.phase == 1 or recovered) s.candidate else s.sourceError
    s' = { memo: memoized(s, result).memo, d: if (s.phase == 3 and recovered) { ages: s.d.ages.append(s.wall - s.candidateCreated), ...s.d } else s.d,
      phase: if (retry) 2 else 0, canRecover: if (retry) false else s.canRecover,
      sources: if (retry) s.sources.append(0) else s.sources,
      activeLoader: if (retry) s.sources.length() else s.activeLoader,
      deadline: if (retry) s.now + 10 else s.deadline,
      o: { loaders: s.o.loaders + (if (retry) 1 else 0),
        recovery: if (s.phase == 1) s.o.recovery else s.o.recovery.append(
          if (s.loadFailed) "deserialization_error" else if (recovered) "served" else "miss"),
        ...finish(s.o, result) }, ...s }
  }
  action seed = {
    nondet choice = 0.to(6).oneOf()
    val age = List(0, 999, 1000, 4999, 5000, -1, 1000).nth(choice)
    s' = { frame: if (choice == 6) 2 else 1, created: s.wall - age, expires: s.now + 60000, ...s }
  }
  action advance = {
    nondet choice = Set(1, 10, 1000, 4000).oneOf()
    val timedOut = if (s.phase == 2 and s.now + choice >= s.deadline)
      rejected({ now: s.deadline, wall: s.wall + s.deadline - s.now, sources: s.sources.replaceAt(s.activeLoader, 1), ...s }, 4, true)
      else s
    s' = { now: s.now + choice, wall: s.wall + choice, ...timedOut }
  }
  action invalidate = s' = { watermark: if (s.wall > s.watermark) s.wall else s.watermark,
    o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("ok"), ...s.o }, ...s }
  action rollbackWall = s' = { wall: s.wall - 1000, ...s }
  action policy = {
    nondet choice = Set(2000, 5000).oneOf()
    s' = { maxAge: choice, ...s }
  }
  action readFault = { nondet choice = Set(0, 1).oneOf()
    s' = { readFailed: choice == 1, ...s } }
  action loadFault = { nondet choice = Set(0, 1).oneOf()
    s' = { loadFailed: choice == 1, ...s } }
  action step = any {
    any { beginCall, joinCall, resolveLoader, any { rejectLoader, rejectTimeout }, releaseLoad },
    any { seed, advance, rollbackWall, invalidate, policy, readFault, loadFault, closeScope }
  }
  val singleReadPerFlight = s.o.reads <= s.o.calls.length()
  val pendingDecodeHasCall = s.phase != 3 or s.o.calls.select(c => c == 0).length() > 0
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()

  val closedScopesHaveNoMemo = s.closed.indices().forall(scope => not(s.closed.nth(scope)) or s.memo.nth(scope) == 0)
  val agesRequireRecovery = s.d.ages.length() == s.o.recovery.select(x => x == "served").length()
  val sourcesMatchEffects = s.sources.length() == s.o.loaders
  val onlyRegisteredSourceOwnsDeadline = s.phase != 2 or s.sources.nth(s.activeLoader) == 0

  // A codec hit rejected for future age is a logical miss without a refill fence.
  action seedFutureFixture = s' = { frame: 1, created: s.wall + 1, expires: s.now + 60000, ...s }
  run futureFrameDoesNotCarryMissFenceTest = init.then(invalidate).then(seedFutureFixture)
    .then(beginCall).then(resolveLoader).expect(s.o.writes == 1)

  action defaultFixture = init.then(s' = { instanceClassifier: 3, request: false, ...s })
  action beginInheritedFixture = beginCall.then(s' = { classifier: s.instanceClassifier, ...s })
  action timeoutFixture = s' = rejected({ now: s.deadline, wall: s.wall + s.deadline - s.now, sources: s.sources.replaceAt(s.activeLoader, 1), ...s }, 4, true)
  action beginDefaultFixture = beginCall.then(s' = { classifier: 3, ...s })
  action beginDenyFixture = beginCall.then(s' = { classifier: 1, ...s })
  run defaultRecoversOwnTimeoutTest = defaultFixture.then(beginDefaultFixture).then(timeoutFixture).then(releaseLoad)
    .expect(s.o.calls == List(1) and s.o.classifications == 0 and s.o.recovery == List("served"))
  run explicitDenialReplacesDefaultTest = init.then(beginDenyFixture).then(timeoutFixture)
    .expect(s.o.calls == List(4) and s.o.classifications == 1 and s.o.loads == 0)
  run defaultRejectsOrdinaryFailureTest = defaultFixture.then(beginDefaultFixture).then(rejectLoader)
    .expect(s.o.calls == List(3) and s.o.classifications == 0 and s.o.loads == 0)
  run defaultRecoversPropagatedTimeoutTest = defaultFixture.then(beginDefaultFixture).then(rejectTimeout).then(releaseLoad)
    .expect(s.o.calls == List(1) and s.o.classifications == 0)
  run lateSuccessCannotReplaceRecoveredValueTest = defaultFixture.then(beginDefaultFixture).then(timeoutFixture)
    .then(resolveLoader).then(releaseLoad)
    .expect(s.o.calls == List(1) and s.o.writes == 0 and s.o.dumps == 0)
  run failedRecoveryPreservesDeadlineErrorTest = defaultFixture.then(beginDefaultFixture).then(timeoutFixture)
    .then(s' = { loadFailed: true, ...s }).then(releaseLoad)
    .expect(s.o.calls == List(4) and s.o.recovery == List("deserialization_error"))
  action requestFixture = init.then(s' = { request: true, instanceClassifier: 0, ...s })
  run recoveredValueMemoizesOnlyInAttachedRequestTest = requestFixture.then(s' = admitted(0, 3))
    .then(rejectLoader).then(releaseLoad).expect(s.memo == List(1, 0) and s.o.writes == 0)
    .then(s' = admitted(0, 3)).expect(s.o.calls == List(1, 1) and s.o.reads == 1)
    .then(s' = admitted(1, 3)).expect(s.o.calls == List(1, 1, 0) and s.o.reads == 2)
  run crossRequestRecoveryMemoizesBothScopesTest = requestFixture.then(s' = admitted(0, 3))
    .then(s' = joined(1)).then(s' = joined(0)).then(rejectLoader).then(releaseLoad)
    .expect(s.memo == List(1, 1) and s.o.calls == List(1, 1, 1) and s.d.coalesced == List("process", "request_local") and s.o.loads == 1)
  run closedRequestCannotReceiveLateRecoveryMemoTest = requestFixture.then(s' = admitted(0, 3)).then(rejectLoader)
    .then(s' = { closed: List(true, false), attached: List(false, false), ...s }).then(releaseLoad)
    .expect(s.memo == List(0, 0) and s.o.calls == List(1)).then(s' = admitted(1, 3))
    .expect(s.o.reads == 2 and s.o.calls == List(1, 0))
  run rollbackCannotLowerInvalidationWatermarkTest = defaultFixture.then(invalidate).then(rollbackWall).then(invalidate)
    .expect(s.watermark == 100000)
  run rollbackDuringRetainedDecodeRejectsFutureSnapshotTest = defaultFixture.then(beginDefaultFixture)
    .then(timeoutFixture).then(rollbackWall).then(rollbackWall).then(releaseLoad)
    .expect(s.o.calls == List(4) and s.o.recovery == List("miss") and s.d.ages == List())
  run instanceAllowReplacesTimeoutOnlyDefaultTest = init.then(s' = { instanceClassifier: 0, ...s })
    .then(beginInheritedFixture).then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(1) and s.o.classifications == 1)
  run instanceDenialReplacesTimeoutOnlyDefaultTest = init.then(s' = { instanceClassifier: 1, ...s })
    .then(beginInheritedFixture).then(timeoutFixture).expect(s.o.calls == List(4) and s.o.loads == 0)
  run operationDenialReplacesInstanceAllowTest = init.then(s' = { instanceClassifier: 0, ...s })
    .then(beginDenyFixture).then(rejectLoader).expect(s.o.calls == List(3) and s.o.loads == 0)
}

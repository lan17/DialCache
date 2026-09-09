module dialcache_recovery_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Remote-only tracked recovery. F=1000; runtime M=2000 or 5000 ms.
  // One registered flight, optional followers, independently held decoding.
  // Source deadline is 10 ms. Expired sources may keep running during recovery or a later flight.
  // Classifier: 0 allow, 1 deny, 2 error, 3 timeout-only default.
  // Sources: 0 registered, 1 abandoned externally, 2 settled.
  // Phase: 0 idle, 1 fresh decode, 2 source, 3 retained decode.
  type State = {
    o: Observation, now: int, phase: int, frame: int, created: int, expires: int,
    watermark: int, candidate: int, candidateCreated: int, maxAge: int,
    acceptedMaxAge: int, classifier: int, instanceClassifier: int, readFailed: bool, loadFailed: bool,
    canRecover: bool, canWrite: bool, observedFence: int,
    sources: List[int], activeLoader: int, deadline: int, sourceError: int
  }
  var s: State
  action init = {
    nondet choice = Set(0, 1, 2, 3).oneOf()
    s' = {
    o: empty, now: 10000, phase: 0, frame: 1, created: 9000, expires: 70000,
    watermark: 0, candidate: 0, candidateCreated: 0, maxAge: 5000,
    acceptedMaxAge: 5000, classifier: 0, instanceClassifier: List(3, 0, 1, 2).nth(choice), readFailed: false, loadFailed: false,
    canRecover: false, canWrite: false, observedFence: 0,
    sources: List(), activeLoader: 0, deadline: 0, sourceError: 3
    }
  }
  val readable = not(s.readFailed) and s.frame > 0 and s.now < s.expires and s.created > s.watermark
  val eligible = readable and s.created <= s.now and s.now - s.created < s.maxAge
  val fresh = eligible and s.now - s.created < 1000
  pure def candidateValid(x: State): bool = x.candidate > 0 and x.candidateCreated <= x.now and
    x.now - x.candidateCreated < x.acceptedMaxAge

  action beginCall = {
    nondet choice = Set(0, 1, 2, 3).oneOf()
    all {
      s.phase == 0, s.o.calls.length() < 8,
      s' = {
        o: { calls: s.o.calls.append(0), policyCalls: s.o.policyCalls + 1,
          reads: s.o.reads + 1, loads: s.o.loads + (if (fresh) 1 else 0),
          loaders: s.o.loaders + (if (fresh) 0 else 1), ...s.o },
        phase: if (fresh) 1 else 2, classifier: if (choice == 3) s.instanceClassifier else choice,
        candidate: if (eligible) s.frame else 0, candidateCreated: s.created,
        acceptedMaxAge: s.maxAge, canRecover: not(s.readFailed), canWrite: not(s.readFailed),
        observedFence: if (readable) 0 else s.watermark,
        sources: if (fresh) s.sources else s.sources.append(0),
        activeLoader: if (fresh) s.activeLoader else s.sources.length(),
        deadline: s.now + 10, sourceError: 3, ...s
      }
    }
  }
  action joinCall = all {
    s.phase != 0, s.o.calls.length() < 8,
    s' = { o: { calls: s.o.calls.append(0), policyCalls: s.o.policyCalls + 1, ...s.o }, ...s }
  }
  pure def rejected(x: State, error: int, timeout: bool): State = {
    val attempt = x.canRecover and (x.classifier == 0 or (x.classifier == 3 and timeout))
    val decode = attempt and candidateValid(x)
    { phase: if (decode) 3 else 0, sourceError: error,
      o: { classifications: x.o.classifications + (if (x.canRecover and x.classifier != 3) 1 else 0),
        loads: x.o.loads + (if (decode) 1 else 0),
        recovery: if (attempt and not(decode)) x.o.recovery.append("miss") else x.o.recovery,
        ...finish(x.o, if (decode) 0 else error) }, ...x }
  }
  def settled(index: int, failure: int): State = {
    val x = { sources: s.sources.replaceAt(index, 2), ...s }
    val write = s.canWrite and s.now > s.observedFence
    if (s.sources.nth(index) == 1) x
    else if (failure > 0) rejected(x, 3, failure == 2)
    else { phase: 0,
      o: { dumps: s.o.dumps + (if (write) 1 else 0), writes: s.o.writes + (if (write) 1 else 0),
        writeTtls: if (write) s.o.writeTtls.append(s.acceptedMaxAge) else s.o.writeTtls,
        ...finish(s.o, 2) },
      frame: if (write) 2 else s.frame, created: if (write) s.now else s.created,
      expires: if (write) s.now + s.acceptedMaxAge else s.expires, ...x }
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
    s' = { phase: if (retry) 2 else 0, canRecover: if (retry) false else s.canRecover,
      sources: if (retry) s.sources.append(0) else s.sources,
      activeLoader: if (retry) s.sources.length() else s.activeLoader,
      deadline: if (retry) s.now + 10 else s.deadline,
      o: { loaders: s.o.loaders + (if (retry) 1 else 0),
        recovery: if (s.phase == 1) s.o.recovery else s.o.recovery.append(
          if (s.loadFailed) "deserialization_error" else if (recovered) "served" else "miss"),
        ...finish(s.o, if (retry) 0 else if (s.phase == 1 or recovered) s.candidate else s.sourceError) }, ...s }
  }
  action seed = {
    nondet choice = 0.to(6).oneOf()
    val age = List(0, 999, 1000, 4999, 5000, -1, 1000).nth(choice)
    s' = { frame: if (choice == 6) 2 else 1, created: s.now - age, expires: s.now + 60000, ...s }
  }
  action advance = {
    nondet choice = Set(1, 10, 1000, 4000).oneOf()
    val timedOut = if (s.phase == 2 and s.now + choice >= s.deadline)
      rejected({ now: s.deadline, sources: s.sources.replaceAt(s.activeLoader, 1), ...s }, 4, true)
      else s
    s' = { now: s.now + choice, ...timedOut }
  }
  action invalidate = s' = { watermark: s.now,
    o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("ok"), ...s.o }, ...s }
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
    any { seed, advance, invalidate, policy, readFault, loadFault }
  }
  val singleReadPerFlight = s.o.reads <= s.o.calls.length()
  val pendingDecodeHasCall = s.phase != 3 or s.o.calls.select(c => c == 0).length() > 0
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()

  val sourcesMatchEffects = s.sources.length() == s.o.loaders
  val onlyRegisteredSourceOwnsDeadline = s.phase != 2 or s.sources.nth(s.activeLoader) == 0

  // A codec hit rejected for future age is a logical miss without a refill fence.
  action seedFutureFixture = s' = { frame: 1, created: s.now + 1, expires: s.now + 60000, ...s }
  run futureFrameDoesNotCarryMissFenceTest = init.then(invalidate).then(seedFutureFixture)
    .then(beginCall).then(resolveLoader).expect(s.o.writes == 1)

  action defaultFixture = init.then(s' = { instanceClassifier: 3, ...s })
  action beginInheritedFixture = beginCall.then(s' = { classifier: s.instanceClassifier, ...s })
  action timeoutFixture = s' = rejected({ now: s.deadline, sources: s.sources.replaceAt(s.activeLoader, 1), ...s }, 4, true)
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
  run instanceAllowReplacesTimeoutOnlyDefaultTest = init.then(s' = { instanceClassifier: 0, ...s })
    .then(beginInheritedFixture).then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(1) and s.o.classifications == 1)
  run instanceDenialReplacesTimeoutOnlyDefaultTest = init.then(s' = { instanceClassifier: 1, ...s })
    .then(beginInheritedFixture).then(timeoutFixture).expect(s.o.calls == List(4) and s.o.loads == 0)
  run operationDenialReplacesInstanceAllowTest = init.then(s' = { instanceClassifier: 0, ...s })
    .then(beginDenyFixture).then(rejectLoader).expect(s.o.calls == List(3) and s.o.loads == 0)
}

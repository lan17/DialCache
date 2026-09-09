module dialcache_recovery_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Remote-only tracked recovery. F=1000; runtime M=2000 or 5000 ms.
  // One registered flight, optional followers, independently held decoding.
  // No fallback deadline here: the effects profile tests deadline abandonment.
  // Phase: 0 idle, 1 fresh decode, 2 source, 3 retained decode.
  type State = {
    o: Observation, now: int, phase: int, frame: int, created: int, expires: int,
    watermark: int, candidate: int, candidateCreated: int, maxAge: int,
    acceptedMaxAge: int, classifier: int, readFailed: bool, loadFailed: bool,
    canRecover: bool, canWrite: bool, observedFence: int
  }
  var s: State
  action init = s' = {
    o: empty, now: 10000, phase: 0, frame: 1, created: 9000, expires: 70000,
    watermark: 0, candidate: 0, candidateCreated: 0, maxAge: 5000,
    acceptedMaxAge: 5000, classifier: 0, readFailed: false, loadFailed: false,
    canRecover: false, canWrite: false, observedFence: 0
  }
  val readable = not(s.readFailed) and s.frame > 0 and s.now < s.expires and s.created > s.watermark
  val eligible = readable and s.created <= s.now and s.now - s.created < s.maxAge
  val fresh = eligible and s.now - s.created < 1000
  val candidateValid = s.candidate > 0 and s.candidateCreated <= s.now and
    s.now - s.candidateCreated < s.acceptedMaxAge

  action beginCall = {
    nondet choice = Set(0, 1, 2).oneOf() // classifier: allow / deny / error
    all {
      s.phase == 0, s.o.calls.length() < 8,
      s' = {
        o: { calls: s.o.calls.append(0), policyCalls: s.o.policyCalls + 1,
          reads: s.o.reads + 1, loads: s.o.loads + (if (fresh) 1 else 0),
          loaders: s.o.loaders + (if (fresh) 0 else 1), ...s.o },
        phase: if (fresh) 1 else 2, classifier: choice,
        candidate: if (eligible) s.frame else 0, candidateCreated: s.created,
        acceptedMaxAge: s.maxAge, canRecover: not(s.readFailed), canWrite: not(s.readFailed),
        observedFence: if (readable) 0 else s.watermark, ...s
      }
    }
  }
  action joinCall = all {
    s.phase != 0, s.o.calls.length() < 8,
    s' = { o: { calls: s.o.calls.append(0), policyCalls: s.o.policyCalls + 1, ...s.o }, ...s }
  }
  action resolveLoader = all {
    s.phase == 2,
    val write = s.canWrite and s.now > s.observedFence
    s' = { phase: 0,
      o: { dumps: s.o.dumps + (if (write) 1 else 0), writes: s.o.writes + (if (write) 1 else 0),
        writeTtls: if (write) s.o.writeTtls.append(s.acceptedMaxAge) else s.o.writeTtls,
        ...finish(s.o, 2) },
      frame: if (write) 2 else s.frame, created: if (write) s.now else s.created,
      expires: if (write) s.now + s.acceptedMaxAge else s.expires, ...s }
  }
  action rejectLoader = all {
    s.phase == 2,
    val attempt = s.canRecover and s.classifier == 0
    val decode = attempt and candidateValid
    s' = { phase: if (decode) 3 else 0,
      o: { classifications: s.o.classifications + (if (s.canRecover) 1 else 0),
        loads: s.o.loads + (if (decode) 1 else 0),
        recovery: if (attempt and not(decode)) s.o.recovery.append("miss") else s.o.recovery,
        ...finish(s.o, if (decode) 0 else 3) }, ...s }
  }
  action releaseLoad = all {
    s.phase == 1 or s.phase == 3,
    val recovered = not(s.loadFailed) and candidateValid
    val retry = s.phase == 1 and s.loadFailed
    s' = { phase: if (retry) 2 else 0, canRecover: if (retry) false else s.canRecover,
      o: { loaders: s.o.loaders + (if (retry) 1 else 0),
        recovery: if (s.phase == 1) s.o.recovery else s.o.recovery.append(
          if (s.loadFailed) "deserialization_error" else if (recovered) "served" else "miss"),
        ...finish(s.o, if (retry) 0 else if (s.phase == 1 or recovered) s.candidate else 3) }, ...s }
  }
  action seed = {
    nondet choice = 0.to(6).oneOf()
    val age = List(0, 999, 1000, 4999, 5000, -1, 1000).nth(choice)
    s' = { frame: if (choice == 6) 2 else 1, created: s.now - age, expires: s.now + 60000, ...s }
  }
  action advance = {
    nondet choice = Set(1, 1000, 4000).oneOf()
    s' = { now: s.now + choice, ...s }
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
    any { beginCall, joinCall, resolveLoader, rejectLoader, releaseLoad },
    any { seed, advance, invalidate, policy, readFault, loadFault }
  }
  val singleReadPerFlight = s.o.reads <= s.o.calls.length()
  val pendingDecodeHasCall = s.phase != 3 or s.o.calls.select(c => c == 0).length() > 0
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()

  // A codec hit rejected for future age is a logical miss without a refill fence.
  action seedFutureFixture = s' = { frame: 1, created: s.now + 1, expires: s.now + 60000, ...s }
  run futureFrameDoesNotCarryMissFenceTest = init.then(invalidate).then(seedFutureFixture)
    .then(beginCall).then(resolveLoader).expect(s.o.writes == 1)
}

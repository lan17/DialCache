module dialcache_independent_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Same-key callers with coalescing disabled. Reads, source work and decoding
  // settle independently. F=1000 ms; captured M=2000/5000 ms; source budget=10 ms.
  // Call phases: 1 read, 2 source, 3 fresh decode, 4 recovery decode, 5 done.
  type Call = { source: int, phase: int, maxAge: int, candidate: int, created: int, acquiredAt: int,
    canRecover: bool, canWrite: bool, fence: int, error: int }
  type Read = { caller: int, pending: bool, active: bool }
  type Source = { caller: int, pending: bool, active: bool }
  type Load = { caller: int, pending: bool, recovery: bool, value: int }
  type Timer = { read: bool, index: int, at: int }
  type State = {
    o: Observation, io: { budgets: List[int], aborted: List[int], sourceErrors: List[int] }, now: int, wall: int,
    frame: int, created: int, expires: int, watermark: int, readBudget: int, maxAge: int,
    calls: List[Call], reads: List[Read], sources: List[Source], loads: List[Load], timers: List[Timer]
  }
  var s: State
  action init = s' = { o: empty, io: { budgets: List(), aborted: List(), sourceErrors: List() }, now: 0, wall: 100000,
    frame: 1, created: 99000, expires: 60000, watermark: 0, readBudget: 5, maxAge: 5000,
    calls: List(), reads: List(), sources: List(), loads: List(), timers: List() }
  pure def finished(x: State, caller: int, value: int): State = {
    calls: x.calls.replaceAt(caller, { phase: 5, ...x.calls.nth(caller) }),
    io: { sourceErrors: x.io.sourceErrors.replaceAt(caller, if (value == 3) x.calls.nth(caller).source + 1 else 0), ...x.io },
    o: { calls: x.o.calls.replaceAt(caller, value), ...x.o }, ...x
  }
  pure def startSource(x: State, caller: int): State = {
    calls: x.calls.replaceAt(caller, { phase: 2, source: x.sources.length(), ...x.calls.nth(caller) }),
    sources: x.sources.append({ caller: caller, active: true, pending: true }),
    timers: x.timers.append({ read: false, index: x.sources.length(), at: x.now + 10 }),
    o: { loaders: x.o.loaders + 1, ...x.o }, ...x
  }
  pure def startLoad(x: State, caller: int, recovery: bool, value: int): State = {
    calls: x.calls.replaceAt(caller, { phase: if (recovery) 4 else 3, ...x.calls.nth(caller) }),
    loads: x.loads.append({ caller: caller, pending: true, recovery: recovery, value: value }),
    o: { loads: x.o.loads + 1, ...x.o }, ...x
  }
  pure def validCandidate(x: State, caller: int): bool = {
    val call = x.calls.nth(caller)
    call.candidate > 0 and call.created <= x.wall and x.wall - call.created < call.maxAge
  }
  pure def rejected(x: State, caller: int, error: int): State = {
    val call = x.calls.nth(caller)
    val updated = { calls: x.calls.replaceAt(caller, { error: error, ...call }),
      o: { classifications: x.o.classifications + (if (call.canRecover) 1 else 0), ...x.o }, ...x }
    if (not(call.canRecover)) finished(updated, caller, error)
    else if (validCandidate(x, caller)) startLoad(updated, caller, true, call.candidate)
    else finished({ o: { recovery: updated.o.recovery.append("miss"), ...updated.o }, ...updated }, caller, error)
  }
  pure def begin(x: State): State = {
    val caller = x.calls.length()
    { calls: x.calls.append({ source: -1, phase: 1, maxAge: x.maxAge, candidate: 0, created: 0, acquiredAt: 0,
        canRecover: false, canWrite: false, fence: 0, error: 3 }),
      reads: x.reads.append({ caller: caller, active: true, pending: true }),
      timers: x.timers.append({ read: true, index: x.reads.length(), at: x.now + x.readBudget }),
      io: { budgets: x.io.budgets.append(x.readBudget), sourceErrors: x.io.sourceErrors.append(0), ...x.io },
      o: { calls: x.o.calls.append(0), reads: x.o.reads + 1, policyCalls: x.o.policyCalls + 1, ...x.o }, ...x }
  }
  action beginCall = all { s.calls.length() < 6, s' = begin(s) }
  pure def expireRead(x: State, index: int): State = {
    val read = x.reads.nth(index)
    startSource({ reads: x.reads.replaceAt(index, { active: false, ...read }),
      io: { aborted: x.io.aborted.append(index), ...x.io }, ...x }, read.caller)
  }
  pure def expireSource(x: State, index: int): State = {
    val source = x.sources.nth(index)
    rejected({ sources: x.sources.replaceAt(index, { active: false, ...source }), ...x }, source.caller, 4)
  }
  pure def readReply(x: State, index: int, failed: bool): State = {
    val read = x.reads.nth(index)
    val updated = { reads: x.reads.replaceAt(index, { pending: false, active: false, ...read }), ...x }
    val call = x.calls.nth(read.caller)
    val readable = x.frame > 0 and x.now < x.expires and x.created > x.watermark
    val fresh = readable and x.created <= x.wall and x.wall - x.created < 1000
    val stale = readable and x.created <= x.wall and x.wall - x.created >= 1000 and x.wall - x.created < call.maxAge
    val observed = { calls: updated.calls.replaceAt(read.caller, { canWrite: not(failed), canRecover: not(failed) and not(fresh),
        candidate: if (stale and not(failed)) x.frame else 0, created: x.created, acquiredAt: x.wall,
        fence: if (readable) 0 else x.watermark, ...call }), ...updated }
    if (not(read.active)) updated
    else if (failed or not(fresh)) startSource(observed, read.caller)
    else startLoad(observed, read.caller, false, x.frame)
  }
  action releaseRead = { nondet choice = s.reads.indices().filter(i => s.reads.nth(i).pending).oneOf()
    s' = readReply(s, choice, false) }
  action failRead = { nondet choice = s.reads.indices().filter(i => s.reads.nth(i).pending).oneOf()
    s' = readReply(s, choice, true) }
  pure def sourceReply(x: State, index: int, value: int): State = {
    val source = x.sources.nth(index)
    val call = x.calls.nth(source.caller)
    val updated = { sources: x.sources.replaceAt(index, { pending: false, active: false, ...source }), ...x }
    val write = call.canWrite and x.wall > call.fence
    if (not(source.active)) updated
    else if (value == 3) rejected(updated, source.caller, 3)
    else finished({ frame: if (write) value else x.frame, created: if (write) x.wall else x.created,
      expires: if (write) x.now + call.maxAge else x.expires,
      o: { writes: x.o.writes + (if (write) 1 else 0), dumps: x.o.dumps + (if (write) 1 else 0),
        writeTtls: if (write) x.o.writeTtls.append(call.maxAge) else x.o.writeTtls, ...x.o }, ...updated }, source.caller, value)
  }
  action resolveLoader = { nondet choice = 1.to(12).filter(code => (code - 1) / 2 < s.sources.length() and s.sources.nth((code - 1) / 2).pending).oneOf()
    s' = sourceReply(s, (choice - 1) / 2, (choice - 1) % 2 + 1) }
  action rejectLoader = { nondet choice = s.sources.indices().filter(i => s.sources.nth(i).pending).oneOf()
    s' = sourceReply(s, choice, 3) }
  pure def loadReply(x: State, index: int, failed: bool): State = {
    val load = x.loads.nth(index)
    val call = x.calls.nth(load.caller)
    val updated = { loads: x.loads.replaceAt(index, { pending: false, ...load }), ...x }
    if (not(load.recovery)) {
      if (failed) startSource({ calls: x.calls.replaceAt(load.caller, { canRecover: false, ...call }), ...updated }, load.caller)
      else finished(updated, load.caller, load.value)
    } else {
      val valid = validCandidate(x, load.caller)
      finished({ o: { recovery: x.o.recovery.append(if (failed) "deserialization_error" else if (valid) "served" else "miss"), ...x.o }, ...updated },
        load.caller, if (failed or not(valid)) call.error else load.value)
    }
  }
  action releaseLoad = { nondet choice = s.loads.indices().filter(i => s.loads.nth(i).pending).oneOf()
    s' = loadReply(s, choice, false) }
  action failLoad = { nondet choice = s.loads.indices().filter(i => s.loads.nth(i).pending).oneOf()
    s' = loadReply(s, choice, true) }
  pure def tick(x: State, ms: int): State = {
    val target = x.now + ms
    // At most one read deadline and one source deadline per admitted call.
    // Visit only due deadline instants, including sources started by read expiry.
    0.to(x.calls.length() * 2).fold(x, (elapsed, _) => {
      val dueAt = elapsed.timers.foldl(target, (earliest, timer) => {
        val active = if (timer.read) elapsed.reads.nth(timer.index).active else elapsed.sources.nth(timer.index).active
        if (active and timer.at > elapsed.now and timer.at < earliest) timer.at else earliest
      })
      val current = { now: dueAt, wall: elapsed.wall + dueAt - elapsed.now, ...elapsed }
      current.timers.foldl(current, (out, timer) => if (timer.at != current.now) out
        else if (timer.read and out.reads.nth(timer.index).active) expireRead(out, timer.index)
        else if (not(timer.read) and out.sources.nth(timer.index).active) expireSource(out, timer.index) else out)
    })
  }
  action advance = { nondet choice = Set(1, 5, 10, 1000).oneOf()
    s' = tick(s, choice) }
  action seed = { nondet choice = 0.to(5).oneOf()
    s' = { frame: if (choice == 2 or choice == 4) 2 else 1,
      created: s.wall - (if (choice == 0 or choice == 4) 0 else if (choice == 3) 4999 else if (choice == 5) 1999 else 1000), expires: s.now + 60000, ...s } }
  action invalidate = s' = { watermark: s.wall,
    o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("ok"), ...s.o }, ...s }
  action policy = { nondet choice = 0.to(3).oneOf()
    s' = { readBudget: if (choice % 2 == 0) 5 else 10, maxAge: if (choice < 2) 5000 else 2000, ...s } }
  action step = any { beginCall, releaseRead, any { resolveLoader, rejectLoader, releaseLoad },
    any { policy, seed }, any { advance, invalidate, failRead, failLoad } }
  val oneReadPerCall = s.o.reads == s.o.calls.length() and s.io.budgets.length() == s.o.reads and s.io.sourceErrors.length() == s.o.calls.length()
  val effectsMatchOwners = s.o.reads == s.reads.length() and s.o.loads == s.loads.length() and s.o.loaders == s.sources.length()
  val completedCallsHaveNoActiveWork = s.calls.indices().forall(i => s.calls.nth(i).phase != 5 or
    (s.reads.indices().forall(j => s.reads.nth(j).caller != i or not(s.reads.nth(j).active)) and s.sources.indices().forall(j => s.sources.nth(j).caller != i or not(s.sources.nth(j).active))))
  val retainedSnapshotsWereEligible = s.calls.indices().forall(i => { val c = s.calls.nth(i)
    c.candidate == 0 or (c.acquiredAt - c.created >= 1000 and c.acquiredAt - c.created < c.maxAge) })
  val abortsAreUnique = s.io.aborted.indices().forall(i => s.io.aborted.indices().forall(j => i == j or s.io.aborted.nth(i) != s.io.aborted.nth(j)))
  val writesKeepCapturedRetention = s.o.writeTtls.indices().forall(i => s.o.writeTtls.nth(i) == 2000 or s.o.writeTtls.nth(i) == 5000)

  run independentReadDeadlinesStartSeparateSourcesTest = init.then(beginCall).then(s' = tick(s, 1)).then(beginCall)
    .then(s' = tick(s, 4)).expect(s.io.aborted == List(0) and s.o.loaders == 1)
    .then(s' = tick(s, 1)).expect(s.io.aborted == List(0, 1) and s.o.loaders == 2)
  run independentRecoveryKeepsDistinctSnapshotsTest = init.then(beginCall).then(s' = readReply(s, 0, false))
    .then(s' = { frame: 2, ...s }).then(beginCall).then(s' = readReply(s, 1, false))
    .then(s' = sourceReply(s, 0, 3)).then(s' = sourceReply(s, 1, 3)).then(invalidate)
    .then(s' = loadReply(s, 1, false)).then(s' = loadReply(s, 0, false))
    .expect(s.o.calls == List(1, 2) and s.o.reads == 2 and s.o.writes == 0)
  run timedOutReadCannotAffectAnotherCallTest = init.then(beginCall).then(s' = tick(s, 5))
    .then(beginCall).then(s' = readReply(s, 1, false)).then(s' = readReply(s, 0, false))
    .expect(s.o.loads == 0 and s.o.loaders == 2 and s.io.aborted == List(0))
  run acceptedFreshDecodeSurvivesOtherInvalidationTest = init.then(s' = { created: s.wall, ...s }).then(beginCall)
    .then(s' = readReply(s, 0, false)).then(invalidate).then(beginCall).then(s' = readReply(s, 1, false))
    .then(s' = loadReply(s, 0, false)).expect(s.o.calls == List(1, 0) and s.o.loaders == 1)
  run readFailureCannotBorrowAnotherCallsRefillTest = init.then(beginCall).then(beginCall)
    .then(s' = readReply(s, 0, true)).then(s' = readReply(s, 1, false))
    .then(s' = sourceReply(s, 1, 2)).then(s' = sourceReply(s, 0, 1))
    .expect(s.o.calls == List(1, 2) and s.o.writes == 1 and s.frame == 2)
  run recoveryPolicyIsCapturedPerCallerTest = init.then(beginCall).then(s' = readReply(s, 0, false))
    .then(s' = { maxAge: 2000, ...s }).then(beginCall).then(s' = readReply(s, 1, false))
    .then(s' = sourceReply(s, 0, 3)).then(s' = sourceReply(s, 1, 3)).then(s' = tick(s, 1000))
    .then(s' = loadReply(s, 0, false)).then(s' = loadReply(s, 1, false))
    .expect(s.o.calls == List(1, 3) and s.io.sourceErrors == List(0, 2) and s.o.recovery == List("served", "miss"))
}

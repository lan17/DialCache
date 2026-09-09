module dialcache_admission_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Served Redis hits: three keys, two instances, two shadow slots per instance.
  // Read/decode effects are held explicitly. Only shadow jobs invoke sources.
  // Caller phases: 1 read, 2 decode, 3 done. Job phases: 1 source, 2 decode,
  // 3 confirmation, 4 done. A timed-out job retains its pending external work.
  type Call = { identity: int, shared: bool, selected: bool, phase: int, value: int }
  type Job = { identity: int, phase: int, value: int, sourceValue: int, deadline: int, timedOut: bool }
  type Effect = { job: bool, owner: int, pending: bool }
  type State = {
    o: Observation, now: int, overlay: int, frames: List[int],
    calls: List[Call], owners: List[int], registered: List[int], jobs: List[Job],
    reads: List[Effect], loads: List[Effect]
  }
  var s: State
  action init = s' = {
    o: empty, now: 0, overlay: 0, frames: List(1, 1, 1), calls: List(), owners: List(),
    registered: List(-1, -1, -1, -1, -1, -1), jobs: List(), reads: List(), loads: List()
  }
  pure def liveJobs(state: State): Set[int] = state.jobs.indices().filter(i => state.jobs.nth(i).phase != 4)
  pure def begin(state: State, identity: int): State = {
    val shared = state.overlay < 2
    val leader = if (shared) state.registered.nth(identity) else -1
    val starts = leader < 0
    val owner = if (starts) state.calls.length() else leader
    {
      calls: if (starts) state.calls.append({ identity: identity, shared: shared,
        selected: state.overlay % 2 == 0, phase: 1, value: 0 }) else state.calls,
      owners: state.owners.append(owner),
      registered: if (starts and shared) state.registered.replaceAt(identity, owner) else state.registered,
      reads: if (starts) state.reads.append({ job: false, owner: owner, pending: true }) else state.reads,
      o: { calls: state.o.calls.append(0), reads: state.o.reads + (if (starts) 1 else 0),
        policyCalls: state.o.policyCalls + 1, ...state.o }, ...state
    }
  }
  action beginCall = { nondet choice = 0.to(5).oneOf()
    all { s.o.calls.length() < 16, s' = begin(s, choice) }
  }
  pure def finishJob(state: State, job: int, outcome: str): State = {
    val entry = state.jobs.nth(job)
    {
      jobs: state.jobs.replaceAt(job, { phase: 4, ...entry }),
      o: { shadow: if (entry.timedOut) state.o.shadow else state.o.shadow.append(outcome), ...state.o }, ...state
    }
  }
  pure def finishCall(state: State, call: int): State = {
    val entry = state.calls.nth(call)
    val active = liveJobs(state)
    val duplicate = active.exists(i => state.jobs.nth(i).identity == entry.identity)
    val full = active.filter(i => state.jobs.nth(i).identity / 3 == entry.identity / 3).size() >= 2
    val admitted = entry.selected and not(duplicate or full)
    {
      calls: state.calls.replaceAt(call, { phase: 3, ...entry }),
      registered: if (state.registered.nth(entry.identity) == call) state.registered.replaceAt(entry.identity, -1) else state.registered,
      jobs: if (admitted) state.jobs.append({ identity: entry.identity, phase: 1, value: entry.value,
        sourceValue: 0, deadline: state.now + 10, timedOut: false }) else state.jobs,
      o: { calls: state.o.calls.foldl(List(), (out, value) =>
          out.append(if (state.owners.nth(out.length()) == call) entry.value else value)),
        loaders: state.o.loaders + (if (admitted) 1 else 0),
        sourceScopes: if (admitted) state.o.sourceScopes.append(false) else state.o.sourceScopes,
        shadow: if (entry.selected and not(admitted)) state.o.shadow.append("dropped") else state.o.shadow, ...state.o }, ...state
    }
  }
  pure def readReply(state: State, index: int): State = {
    val effect = state.reads.nth(index)
    val updated = { reads: state.reads.replaceAt(index, { pending: false, ...effect }), ...state }
    if (effect.job) {
      val job = state.jobs.nth(effect.owner)
      finishJob(updated, effect.owner, if (state.frames.nth(job.identity % 3) == job.value) "mismatch" else "superseded")
    } else {
      val call = state.calls.nth(effect.owner)
      { calls: state.calls.replaceAt(effect.owner, { phase: 2, value: state.frames.nth(call.identity % 3), ...call }),
        loads: state.loads.append({ job: false, owner: effect.owner, pending: true }),
        o: { loads: state.o.loads + 1, ...state.o }, ...updated }
    }
  }
  action releaseRead = { nondet choice = s.reads.indices().filter(i => s.reads.nth(i).pending).oneOf()
    s' = readReply(s, choice) }
  pure def loadReply(state: State, index: int): State = {
    val effect = state.loads.nth(index)
    val updated = { loads: state.loads.replaceAt(index, { pending: false, ...effect }), ...state }
    if (effect.job) {
      val job = state.jobs.nth(effect.owner)
      if (job.timedOut or job.value == job.sourceValue) finishJob(updated, effect.owner, "match")
      else { jobs: state.jobs.replaceAt(effect.owner, { phase: 3, ...job }),
        reads: state.reads.append({ job: true, owner: effect.owner, pending: true }),
        o: { reads: state.o.reads + 1, ...state.o }, ...updated }
    } else finishCall(updated, effect.owner)
  }
  action releaseLoad = { nondet choice = s.loads.indices().filter(i => s.loads.nth(i).pending).oneOf()
    s' = loadReply(s, choice) }
  pure def settle(state: State, loader: int, value: int): State = {
    val job = state.jobs.nth(loader)
    if (job.timedOut or value == 3) finishJob(state, loader, "source_error")
    else {
      jobs: state.jobs.replaceAt(loader, { phase: 2, sourceValue: value, ...job }),
      loads: state.loads.append({ job: true, owner: loader, pending: true }),
      o: { loads: state.o.loads + 1, ...state.o }, ...state
    }
  }
  val pendingSources = s.jobs.indices().filter(i => s.jobs.nth(i).phase == 1)
  action resolveLoader = { nondet choice = 1.to(32).filter(code => pendingSources.contains((code - 1) / 2)).oneOf()
    s' = settle(s, (choice - 1) / 2, (choice - 1) % 2 + 1) }
  action rejectLoader = { nondet choice = pendingSources.oneOf()
    s' = settle(s, choice, 3) }
  pure def tick(state: State, ms: int): State = {
    val expired = liveJobs(state).filter(i => not(state.jobs.nth(i).timedOut) and state.now + ms >= state.jobs.nth(i).deadline)
    { now: state.now + ms,
      jobs: state.jobs.foldl(List(), (out, job) => out.append({ timedOut: job.timedOut or expired.contains(out.length()), ...job })),
      o: { shadow: expired.fold(state.o.shadow, (out, _) => out.append("timeout")), ...state.o }, ...state }
  }
  action advance = { nondet choice = Set(1, 10).oneOf()
    // Stay below read deadlines and Redis expiry even in longer explorations.
    all { s.now + choice <= 600, s' = tick(s, choice) }
  }
  // 0: defaults; 1: shadow off; 2: coalescing off; 3: both off.
  action policy = { nondet choice = 0.to(3).oneOf()
    s' = { overlay: choice, ...s } }
  action seed = { nondet choice = 0.to(5).oneOf()
    s' = { frames: s.frames.replaceAt(choice / 2, choice % 2 + 1), ...s } }
  action step = any {
    beginCall, releaseRead, releaseLoad, any { resolveLoader, rejectLoader },
    any { advance, policy, seed }
  }
  val capacityIsPerInstance = Set(0, 1).forall(instance =>
    liveJobs(s).filter(i => s.jobs.nth(i).identity / 3 == instance).size() <= 2)
  val oneJobPerIdentity = liveJobs(s).forall(i => liveJobs(s).forall(j =>
    i == j or s.jobs.nth(i).identity != s.jobs.nth(j).identity))
  val registeredCallsArePending = s.registered.indices().forall(identity => {
    val owner = s.registered.nth(identity)
    owner < 0 or (s.calls.nth(owner).identity == identity and s.calls.nth(owner).shared and s.calls.nth(owner).phase != 3)
  })
  val callsKeepAcquiredValue = s.owners.indices().forall(i => {
    val call = s.calls.nth(s.owners.nth(i))
    s.o.calls.nth(i) == (if (call.phase == 3) call.value else 0)
  })
  val jobsAreDiagnostic = s.o.writes == 0 and s.o.dumps == 0 and s.o.sourceScopes.indices().forall(i => not(s.o.sourceScopes.nth(i)))
  val effectsMatchRecords = s.o.loaders == s.jobs.length() and s.o.reads == s.reads.length() and s.o.loads == s.loads.length()

  run coalescedHitAdmitsOneJobTest = init
    .then(s' = begin(s, 0)).then(s' = begin(s, 0))
    .then(s' = readReply(s, 0)).then(s' = loadReply(s, 0))
    .expect(s.o.calls == List(1, 1) and s.o.loaders == 1 and s.o.reads == 1 and s.o.shadow == List())

  run duplicateDropsBeforeCapacityIsFullTest = init
    .then(s' = begin(s, 0)).then(s' = readReply(s, 0)).then(s' = loadReply(s, 0))
    .then(s' = begin(s, 0)).then(s' = readReply(s, 1)).then(s' = loadReply(s, 1))
    .expect(s.o.calls == List(1, 1) and s.o.loaders == 1 and s.o.shadow == List("dropped"))

  run timeoutRetainsSourceCapacityTest = init
    .then(s' = begin(s, 0)).then(s' = readReply(s, 0)).then(s' = loadReply(s, 0))
    .then(s' = tick(s, 10))
    .expect(liveJobs(s) == Set(0) and s.o.shadow == List("timeout"))
    .then(s' = settle(s, 0, 2))
    .expect(liveJobs(s) == Set() and s.o.loads == 1 and s.o.calls == List(1) and s.o.shadow == List("timeout"))

  run timeoutRetainsDecodeCapacityTest = init
    .then(s' = begin(s, 0)).then(s' = readReply(s, 0)).then(s' = loadReply(s, 0))
    .then(s' = settle(s, 0, 2)).then(s' = tick(s, 10))
    .expect(liveJobs(s) == Set(0)).then(s' = loadReply(s, 1))
    .expect(liveJobs(s) == Set() and s.o.reads == 1 and s.o.shadow == List("timeout"))

  run timeoutRetainsConfirmationCapacityTest = init
    .then(s' = begin(s, 0)).then(s' = readReply(s, 0)).then(s' = loadReply(s, 0))
    .then(s' = settle(s, 0, 2)).then(s' = loadReply(s, 1)).then(s' = tick(s, 10))
    .expect(liveJobs(s) == Set(0)).then(s' = readReply(s, 1))
    .expect(liveJobs(s) == Set() and s.o.calls == List(1) and s.o.shadow == List("timeout"))

  run fullInstanceDoesNotBlockOtherInstanceTest = init
    .then(s' = begin(s, 0)).then(s' = readReply(s, 0)).then(s' = loadReply(s, 0))
    .then(s' = begin(s, 1)).then(s' = readReply(s, 1)).then(s' = loadReply(s, 1))
    .then(s' = begin(s, 2)).then(s' = readReply(s, 2)).then(s' = loadReply(s, 2))
    .expect(s.o.loaders == 2 and s.o.shadow == List("dropped"))
    .then(s' = begin(s, 3)).then(s' = readReply(s, 3)).then(s' = loadReply(s, 3))
    .expect(s.o.loaders == 3 and s.o.calls == List(1, 1, 1, 1) and s.o.shadow == List("dropped"))
}

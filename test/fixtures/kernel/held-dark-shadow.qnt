// Dark jobs (shadow) over the diagnosed budgeted held remote lifecycle
// (deadlines, remote_io, diagnostics): one instance, two keys, no request
// scope, one job slot, replies immediate, a 100 ms job budget and a 100 ms
// source budget. Pins the seams the shadow profile (one caller at a time)
// cannot reach: a second dark job dropped for a live identity or a full
// instance while the first still holds its C0 read (the read a remote_io
// record over the job's source, budgeted on the io channel and never
// deadline-registered); a caller's source deadline delivered while the job's
// C0 read is held (the job times out in the same round and its late read
// drains); a job whose budget outlives nothing; a job budget above the source
// budget, where the caller's deadline alone ends a waiting job `timeout` at
// its delivery and a reading job at its read's settlement.
module held_dark_shadow {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_io as RemoteIO from "../../../formal/kernel/remote-io"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import remote_writes as Writes from "../../../formal/kernel/remote-writes"
  import shadow as Shadow from "../../../formal/kernel/shadow"
  import deadlines as Deadlines from "../../../formal/kernel/deadlines"
  import diagnostics as Diagnostics from "../../../formal/kernel/diagnostics"
  import recovery as Recovery from "../../../formal/kernel/recovery"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 2, keysPerScope: 2, persistentContexts: 0, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true }
  pure val DARK: Resolution = { layers: { request: false, local: false, remote: false }, coalesce: false }
  pure val TTLS: Ttls = { localMs: 0, freshMs: 1000, retentionMs: 5000 }
  pure val SHADOWING: Shadow::Shadowing = { hook: true, selected: true, capacity: 1, budgetMs: 100, logging: false }
  // The same policy with a job budget above the source budget and two slots.
  pure val LONG_SHADOWING: Shadow::Shadowing = { capacity: 2, budgetMs: 200, ...SHADOWING }
  pure def call(key: int): Call = { instance: 0, key: key, context: 0, enabled: true, keyFailed: false }

  type State = {
    o: Observation, d: { configErrors: int, warnings: int, ages: List[int], coalesced: List[str], fallbackErrors: List[str], futureOffsets: List[Diagnostics::FutureOffset] },
    io: RemoteIO::IO, now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    sourceBudget: int, deadlines: List[Deadlines::Due], drained: List[bool], sourceLayers: List[str],
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], jobs: List[Shadow::Job]
  }
  var s: State
  var input: { name: str, choice: int }

  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty, d: { configErrors: 0, warnings: 0, ages: List(), coalesced: List(), fallbackErrors: List(), futureOffsets: List() },
      io: RemoteIO::NO_IO, now: 0, skew: 100000, remoteAvailable: true, tracked: true, capacity: 0,
      readFailed: false, dumpFailed: false, writeFailed: false,
      closed: List(), memo: List(), requestFlights: List(), processFlights: List(NO_OWNER, NO_OWNER),
      localValues: List(NO_VALUE, NO_VALUE), localExpires: List(0, 0), lru: List(List()),
      remoteValues: List(NO_VALUE, NO_VALUE), created: List(0, 0), expires: List(0, 0), watermark: List(0, 0),
      sources: List(), owners: List(), memoSlots: List(), held: List(),
      reads: List(), loads: List(), loaders: List(), retained: List(),
      sourceBudget: 100, deadlines: List(), drained: List(), sourceLayers: List(),
      dumps: List(), writes: List(), jobs: List()
    }
  }
  action begin(key: int): bool = all {
    input' = { name: "beginCall", choice: key },
    s' = Shadow::beginDark(s, LAYOUT, call(key), DARK, TTLS, Deadlines::UNBOUNDED, SHADOWING, Shadow::WELL_FORMED, 0)
  }
  action beginLong(key: int): bool = all {
    input' = { name: "beginCall", choice: key },
    s' = Shadow::beginDark(s, LAYOUT, call(key), DARK, TTLS, Deadlines::UNBOUNDED, LONG_SHADOWING, Shadow::WELL_FORMED, 0)
  }
  action resolve(ordinal: int, value: int): bool = all {
    input' = { name: "resolveLoader", choice: ordinal }, s' = Shadow::settleHeld(s, LAYOUT, ordinal, value, false)
  }
  action releaseRead(read: int): bool = all { input' = { name: "releaseRead", choice: read }, s' = Shadow::releaseRead(s, LAYOUT, read, false) }
  action advanceBy(ms: int): bool = all { input' = { name: "advance", choice: ms }, s' = Shadow::advanceHeld(s, LAYOUT, ms) }
  action step = any { begin(0), resolve(0, VALUE_ONE), releaseRead(0), advanceBy(1) }

  // A second dark job for the same identity is dropped while the first still
  // holds its C0 read; another key on the full instance is dropped too, and a
  // job for it is admitted once the first job's slot is released.
  run heldDarkJobIsDroppedForALiveIdentityTest = init.then(begin(0))
    .expect(s.o.reads == 1 and s.jobs.length() == 1 and s.jobs.nth(0).phase == Shadow::READING_C0 and Shadow::holdsRead(s, 0)
      and s.reads.nth(0).flight == 0 and s.io.budgets == List(Deadlines::UNBOUNDED) and s.deadlines.length() == 2)
    .then(begin(0))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 1 and s.o.shadow == List("dropped"))
  run heldDarkJobIsDroppedWhenTheInstanceIsFullTest = init.then(begin(0)).then(begin(1))
    .expect(s.o.reads == 1 and s.o.shadow == List("dropped") and s.jobs.length() == 1)
    .then(releaseRead(0)).then(resolve(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.dumps == 1 and s.jobs.nth(0).phase == Shadow::SERIALIZING)
    .then(advanceBy(100)).expect(s.o.shadow == List("dropped", "timeout") and s.o.calls == List(VALUE_ONE, DEADLINE_ERROR))
  // The caller's source deadline and the job's budget are delivered in one
  // round: the caller completes with a deadline error attributed to the local
  // layer, the job says `timeout` once, and its late C0 read drains silently.
  run sourceDeadlineAndJobBudgetExpireTogetherTest = init.then(begin(0)).then(advanceBy(100))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.shadow == List("timeout") and s.d.fallbackErrors == List("local")
      and s.jobs.length() == 1 and s.jobs.nth(0).timedOut and s.deadlines == List())
    .then(releaseRead(0))
    .expect(s.jobs == List() and s.o.shadow == List("timeout") and s.o.loads == 0 and s.o.dumps == 0)
    .then(resolve(0, VALUE_ONE))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.shadow == List("timeout") and s.o.dumps == 0)
  // A job budget above the source budget: the caller's deadline alone ends
  // the job `timeout`, at its delivery for a job waiting on the source (key
  // 0, its slot released at once) and at the read's settlement for one still
  // holding its C0 read (key 1); the job budgets due later find nothing.
  run sourceDeadlineAloneEndsTheJobTest = init.then(beginLong(0)).then(releaseRead(0)).then(beginLong(1))
    .expect(s.jobs.length() == 2 and s.jobs.nth(0).phase == Shadow::WAITING_SOURCE and s.jobs.nth(1).phase == Shadow::READING_C0
      and s.deadlines.length() == 4)
    .then(advanceBy(100))
    .expect(s.o.calls == List(DEADLINE_ERROR, DEADLINE_ERROR) and s.o.shadow == List("timeout") and s.d.fallbackErrors == List("local", "local")
      and s.jobs.length() == 1 and s.jobs.nth(0).source == 1 and not(s.jobs.nth(0).timedOut) and s.deadlines.length() == 1)
    .then(releaseRead(1))
    .expect(s.o.shadow == List("timeout", "timeout") and s.jobs == List() and s.deadlines == List() and s.o.loads == 0 and s.o.dumps == 0)
    .then(advanceBy(100)).expect(s.o.shadow == List("timeout", "timeout"))
}

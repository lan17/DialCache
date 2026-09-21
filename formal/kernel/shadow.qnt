module shadow {
  // Shadow jobs (C47 to C54, C57, C60): the diagnostic work a served remote
  // hit or a ramped-down miss admits beside the caller, in one per-instance
  // registry of bounded capacity shared by both kinds. A job is admitted
  // beside the layered release judged once (`serving::layeredRelease`): a
  // served hit admits a served job whose C0 is the payload the hit served and
  // whose source is a detached one (`serving::startDetachedSource`: no caller
  // owns it, it publishes nothing); a miss whose reply left the remote layer
  // off admits a dark job over the caller's own source, reading its C0 from
  // the remote layer itself (the read counted; the payload when the frame is
  // fresh for the reply's freshness, `acquired`, nothing otherwise); a dark C0
  // read that fails under the adapter's read fault ends `redis_error` at once
  // (the read counted, no job registered, nothing filled, as the
  // implementations return from the failed read before awaiting the source);
  // an ordinary serving miss, a request or local hit, a key whose cohort the
  // ramp does not select, an instance without the outcome hook (C47), or a
  // caller whose scope closed before its release (the bypass reply, C01)
  // admits nothing; a live job for the same instance and key, or a full
  // instance, drops the job (C47, `busy`, `dropped`). A job captures the TTLs
  // its reply resolved to (C18): the freshness its C0 read judges by and the
  // retention its fill is written with, whatever the policy says later
  // (`serving::authority` at the fill, capped for a tracked write, fenced by
  // the watermark the C0 read observed when it found no visible frame, C58).
  // The registry is pending-only, keyed by the job's source (a source has at
  // most one job: a dark job takes the caller's just-started source, a served
  // job a detached one registered for it): a finished job leaves no record,
  // as a settled held read or dump does.
  //
  // When the job's source settles: a failed source ends the job
  // (`sourceOutcome`: `source_error`, or `timeout` when the caller's deadline
  // failed it, the implementations reporting the caller's timeout as the
  // job's); with no C0 the job fills the remote layer through the
  // held refill when its captured authority still allows the write
  // (`serving::refillAllowed`, judged before serializing as the
  // implementations check the fence before encoding: a fence the wall does
  // not clear ends the job `fill_fenced` at settlement with no dump;
  // `remote_writes::holdDump`, the write stamped at dump release, where the
  // fence is judged again, and stored at write release, `filled`), never
  // publishing to request or local storage; with a C0 the job decodes it
  // (counted) and compares its value with the source's (`valuesMatch`, the
  // decoded value, `payloads::valueOf`): equal is a `match`, else a
  // confirmation read (counted, under the adapter's read fault: a failed one
  // ends `confirmation_error`) of the frame as it is now says whether the C0
  // bytes are still current (`mismatch`: the same bytes, `payloads::bytesOf`,
  // so a text and a binary spelling of one payload confirm each other, C51)
  // or were replaced meanwhile (`superseded`). A served job always has a C0,
  // so it never fills (C54). Every job has the budget its admission resolved,
  // kept by `deadlines` (kind `JOB`, keyed by the job's source): at expiry the
  // job is timed out and says so once; a dark job still waiting for its
  // source leaves the registry, releasing its slot while the caller's source
  // runs on; a served job keeps its detached source and its slot until that
  // source settles; a job holding a read, a decode or a fill keeps its record
  // until the held work drains, a dump released after the budget dispatching
  // no write while a write released after it still stores (C53). No later
  // label follows a timeout. A fill whose dump or write fails (the `failed`
  // argument of the two releases, as `remote_writes` takes it) ends
  // `fill_error`, nothing written.
  //
  // Two lifecycles compose the one registry. The atomic lifecycle (`Shadowed`,
  // over `remote_writes::Writing`) judges the hit and the policy in the same
  // step, at release (`admitJobs` reads the whole `Shadowing`), and makes the
  // dark C0 read, the decode and the confirmation read at once. The held
  // lifecycle (`HeldJobs`, over `remote_io::Held`) holds them as `remote_io`
  // holds a caller's read and decode, in the same lists under the drivers'
  // effect indices, budgeted on the io channel like every held read and never
  // deadline-registered (the job's budget bounds all its work): a held read or
  // decode over a source whose job is reading or decoding belongs to that job
  // (`holdsRead`, `holdsLoad`; a caller's flight never has one then). Its
  // rules are stated once, over `remote_io`: the source settled holds the
  // decode (`settleJobHeld`), the decode settled says `match` or holds the
  // confirmation read (`settleJobLoad`: `deserialization_error` when the
  // decode fails, the drivers' fault or a payload whose bytes fail to decode;
  // through the comparator the drivers install, `Comparison`: ordinary value
  // equality, or a callback that reports equal, unequal, or throws,
  // `comparison_error`, and consumes elapsed time first: a budget the
  // comparison exhausts ends `timeout` before any verdict, C54; the callback
  // is counted when installed, `o.comparisons`), the read settled says the
  // verdict or acquires the C0 (`settleJobRead`). A timed-out job ends
  // silently at whichever step finds it so, keeping its slot until then (C54:
  // a served job's capacity is owned through its pending source, decode and
  // confirmation). The two profiles that compose it each take one arm of the
  // held admission. Served jobs (`HeldShadowed`, the admission profile, whose
  // replies all enable the remote layer): the caller's read is dispatched
  // before the frame is judged, so the cohort selection is captured for the
  // flight when the read is dispatched (`selected`, a pending-only list of
  // flights, the kernel's consulted-record idiom as `recovery`'s snapshot) and
  // consulted when the hit is judged, at the decode's settlement for a frame
  // held for decoding, where a served hit admits the job under the instance's
  // limits read then (`settleLoad`), or at the read's settlement otherwise,
  // where no hit can follow and nothing is admitted (`settleRead`); `beginHeld`
  // and `releaseHeld` are the held release with the capture. Dark jobs
  // (`DiagnosedShadowed`, the shadow profile, whose replies all leave it off):
  // over the diagnosed budgeted held lifecycle (`deadlines`, `diagnostics`:
  // the caller's source deadline, the layer its failure is attributed to and
  // the channel the shadow drivers compare), admission (`beginDark`) registers
  // the job with its budget before the source's synchronous work moves the
  // clock (BEHAVIOR.md `sourceWorkMs`: the job's deadline and the caller's
  // source deadline are measured from the call), then dispatches the C0 read,
  // or times the job out with no read when the work already exhausted the
  // budget (C54, `dispatchC0`); the C0 read settles with the state then
  // current (`settleJobRead`: the frame acquired when fresh for the captured
  // freshness, the fence observed, a failed read `redis_error`; a job whose
  // source already settled continues at once). The channel facts are recorded
  // beside the settlements (`releaseRead`, `releaseLoad`, C57, C60): a `match`
  // or a confirmed `mismatch` samples the C0 frame's age at the verdict's
  // wall clock, clamped to zero after a rollback, and a confirmed mismatch
  // warns exactly when the admission's mismatch-logging policy was on
  // (captured, `Shadowing.logging`); a shadow read of a frame stamped after
  // the wall clock reports the offset on the `remote_shadow` layer whatever
  // the job does next; a shadow policy that fails to resolve is one
  // configuration error per call (`Malformed`: an invalid ramp always; an
  // invalid logging value only where the hook and the ramp would otherwise
  // admit the job). The caller's source deadline delivered ends the job
  // waiting on that source `timeout` at once, its slot released
  // (`expireHeld`, through `settleJobHeld`); a job still holding its C0 read
  // then ends the same way when the read settles; a job budget due in the
  // same round finds the job gone and says nothing more.
  // `held-dark-shadow.qnt` pins a source deadline below its job budget with
  // `sourceDeadlineAloneEndsTheJobTest`. That arm is fixture-only: both native
  // drivers derive both budgets from the call's fallback timeout; replaying
  // separate budgets would require a per-call sourceTimeoutMs input.
  //
  // Cohort selection is the drivers' ramp decoded by the profile through
  // `cohort_boundaries` (strict against the key's numerator); the module reads
  // the decoded selection.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import remote_frames as Remote from "./remote-frames"
  import remote_writes as Writes from "./remote-writes"
  import remote_io as RemoteIO from "./remote-io"
  import deadlines as Deadlines from "./deadlines"
  import diagnostics as Diagnostics from "./diagnostics"
  import payloads as Payloads from "./payloads"
  import clock as Clock from "./clock"

  // A job's phases: holding its C0 read (the held lifecycle), waiting for its
  // source, holding its decode, holding its confirmation read, serializing
  // its fill, writing it.
  pure val READING_C0 = 0
  pure val WAITING_SOURCE = 1
  pure val DECODING = 2
  pure val CONFIRMING = 3
  pure val SERIALIZING = 4
  pure val WRITING = 5

  // The comparator the drivers install (BEHAVIOR.md `comparator`): ordinary
  // decoded-value equality, or a callback reporting equal, unequal, or
  // throwing, which consumes `elapsedMs` of elapsed time before it returns.
  pure val COMPARE_VALUES = 0
  pure val COMPARE_EQUAL = 1
  pure val COMPARE_UNEQUAL = 2
  pure val COMPARE_ERROR = 3
  type Comparison = { comparator: int, elapsedMs: int }
  pure val VALUE_COMPARISON: Comparison = { comparator: COMPARE_VALUES, elapsedMs: 0 }

  // The shadow policy in force for a call: whether the outcome hook is
  // installed (C47), whether the key's cohort is selected, the per-instance
  // capacity, the job budget and whether a confirmed mismatch is logged (C60,
  // captured by the job at admission).
  type Shadowing = { hook: bool, selected: bool, capacity: int, budgetMs: int, logging: bool }
  // Whether the policy failed to resolve: the ramp, or the logging value.
  type Malformed = { ramp: bool, logging: bool }
  pure val WELL_FORMED: Malformed = { ramp: false, logging: false }

  // A job: the source whose result it compares or fills with (the caller's
  // own source for a dark job, a detached one for a served job), whether it is
  // dark, the payload its C0 found fresh (NO_VALUE when none) and that
  // frame's stamp (the age a verdict samples), the fence its C0 read observed
  // when it found no visible frame (C58), the TTLs its reply resolved to
  // (C18), its phase, whether its budget expired and the mismatch logging it
  // captured.
  type Job = { source: int, dark: bool, cached: int, stamp: int, fence: int, ttls: Ttls, phase: int, timedOut: bool, logging: bool }
  // The registry beside the clock and its pending budgets, over the sources
  // the jobs run for: what every lifecycle composes.
  type Jobs[r] = Deadlines::Scheduled[{ o: Observation, jobs: List[Job], sources: List[Serving::LayeredSource] | r }]
  type Shadowed[r] = Writes::Writing[{ jobs: List[Job], deadlines: List[Deadlines::Due] | r }]
  // The held lifecycle's shape: the held remote traversal with the held fills
  // (a dark job's dumps and writes) and the registry.
  type HeldJobs[r] = RemoteIO::Held[{ dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], jobs: List[Job], deadlines: List[Deadlines::Due] | r }]
  // Served jobs: the selection captured per pending flight beside it.
  type HeldShadowed[r] = HeldJobs[{ selected: List[int] | r }]
  // Dark jobs: the diagnosed budgeted held remote lifecycle (the caller's
  // source deadline, the coalesced scope, the failed layer) with the held
  // fills, the jobs and the two channel fields the shadow drivers compare
  // beside the four every descriptor parses.
  type DiagnosedShadowed[r, q] = Diagnostics::DiagnosedHeld[
    { dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], jobs: List[Job] | r },
    { configErrors: int, futureOffsets: List[Diagnostics::FutureOffset] | q }
  ]

  pure def holdsJob(state: Jobs[r], source: int): bool = state.jobs.select(job => job.source == source).length() > 0
  pure def jobOf(state: Jobs[r], source: int): Job = state.jobs.select(job => job.source == source).nth(0)
  pure def sourceOf(state: Jobs[r], job: Job): Serving::LayeredSource = state.sources.nth(job.source)
  // A source's job is in one of the phases.
  pure def jobHolds(state: Jobs[r], source: int, phases: Set[int]): bool =
    state.jobs.select(job => job.source == source and phases.contains(job.phase)).length() > 0
  pure def waiting(state: Jobs[r], source: int): bool = jobHolds(state, source, Set(WAITING_SOURCE))
  // A job already runs for the identity, or the instance's registry is full.
  pure def duplicate(state: Jobs[r], instance: int, key: int): bool =
    state.jobs.select(job => sourceOf(state, job).instance == instance and sourceOf(state, job).key == key).length() > 0
  pure def full(state: Jobs[r], instance: int, capacity: int): bool =
    state.jobs.select(job => sourceOf(state, job).instance == instance).length() >= capacity
  pure def busy(state: Jobs[r], instance: int, key: int, capacity: int): bool =
    duplicate(state, instance, key) or full(state, instance, capacity)
  pure def reading(job: Job): bool = job.phase == READING_C0 or job.phase == CONFIRMING
  pure def confirming(state: Jobs[r]): bool = state.jobs.select(job => job.phase == CONFIRMING).length() > 0
  // The held effects a job holds, by the drivers' ordinal: a held read over a
  // source whose job is reading, a held decode over one whose job is decoding.
  pure def holdsRead(state: HeldJobs[r], read: int): bool =
    state.reads.select(held => held.read == read and jobHolds(state, held.flight, Set(READING_C0, CONFIRMING))).length() > 0
  pure def readerOf(state: HeldJobs[r], read: int): Job = jobOf(state, RemoteIO::heldRead(state, read).flight)
  pure def holdsLoad(state: HeldJobs[r], load: int): bool =
    state.loads.select(held => held.load == load and jobHolds(state, held.flight, Set(DECODING))).length() > 0
  pure def decoderOf(state: HeldJobs[r], load: int): Job = jobOf(state, RemoteIO::heldLoad(state, load).flight)
  // The newest read or decode a job holds (NO_OWNER when none), for a profile
  // whose drivers release the latest effect rather than one by index.
  pure def latestRead(state: HeldJobs[r]): int =
    state.reads.foldl(NO_OWNER, (latest, held) =>
      if (held.read > latest and jobHolds(state, held.flight, Set(READING_C0, CONFIRMING))) held.read else latest)
  pure def latestLoad(state: HeldJobs[r]): int =
    state.loads.foldl(NO_OWNER, (latest, held) => if (held.load > latest and jobHolds(state, held.flight, Set(DECODING))) held.load else latest)

  // -- Admission -----------------------------------------------------------------------

  // Shadow work runs only where the outcome hook is installed and the ramp selects the key.
  pure def admits(shadowing: Shadowing): bool = shadowing.hook and shadowing.selected
  pure def dropped(state: Jobs[r]): Jobs[r] =
    { o: { shadow: state.o.shadow.append("dropped"), ...state.o }, ...state }
  pure def newJob(source: int, dark: bool, cached: int, stamp: int, fence: int, ttls: Ttls, phase: int, logging: bool): Job =
    { source: source, dark: dark, cached: cached, stamp: stamp, fence: fence, ttls: ttls, phase: phase, timedOut: false, logging: logging }
  // A job registered over its source, its budget due from now.
  pure def admit(state: Jobs[r], job: Job, budgetMs: int): Jobs[r] =
    Deadlines::due({ jobs: state.jobs.append(job), ...state }, Deadlines::JOB, job.source, budgetMs)
  pure def update(state: Jobs[r], job: Job): Jobs[r] =
    { jobs: state.jobs.foldl(List(), (out, other) => out.append(if (other.source == job.source) job else other)), ...state }
  // The C0 a dark read acquires: the payload when the frame is fresh for the
  // reply's freshness, nothing otherwise (C22 at the dark read).
  pure def acquired(observed: Remote::Observed): int = if (observed.value > NO_VALUE) observed.payload else NO_VALUE
  // A served hit's job, judged once for both lifecycles: nothing unless the
  // hook is installed and the reply selected the cohort; `dropped` for a live
  // job of the same identity or a full instance (C47); else a served job over
  // a detached source with the payload the hit served as its C0, the frame's
  // stamp as the hit is judged, the reply's TTLs and no fence.
  pure def admitServed(state: Serving::Served[{ jobs: List[Job], deadlines: List[Deadlines::Due] | r }], layout: Serving::Layout,
      who: { instance: int, key: int | q }, cached: int, ttls: Ttls, shadowing: Shadowing): Serving::Served[{ jobs: List[Job], deadlines: List[Deadlines::Due] | r }] =
    if (not(admits(shadowing))) state
    else if (busy(state, who.instance, who.key, shadowing.capacity)) dropped(state)
    else admit(Serving::startDetachedSource(state, layout, who),
      newJob(state.sources.length(), false, cached, state.created.nth(who.key), NO_FENCE, ttls, WAITING_SOURCE, shadowing.logging), shadowing.budgetMs)
  // Admission beside the release judged once, on the released state: the
  // atomic lifecycle, where a dark job's C0 read is made here.
  pure def admitJobs(state: Shadowed[r], layout: Serving::Layout, judged: Serving::LayeredRelease, ttls: Ttls, shadowing: Shadowing): Shadowed[r] = {
    val call = judged.call
    if (not(admits(shadowing))) state
    else match judged.decision.outcome {
      | ServesRemote(_) => admitServed(state, layout, call, judged.remote.payload, ttls, shadowing)
      // A bypass reply (the caller's scope closed before its release) admits
      // nothing: that caller bypasses every layer (C01), shadow work included.
      | Starts => if (not(judged.open) or judged.effective.layers.remote) state
        else if (busy(state, call.instance, call.key, shadowing.capacity)) dropped(state)
        else {
          // The dark C0 read: the frame as the reply's freshness judges it now,
          // under the adapter's read fault; the job reads the remote layer on
          // its own account. A failed read is the label alone: the read
          // counted, no job, nothing filled.
          val c0 = Remote::observe(state, call.key, layout.operationsPerEntity, ttls.freshMs, state.readFailed)
          val read = { o: { reads: state.o.reads + 1, ...state.o }, ...state }
          if (c0.failed) { o: { shadow: read.o.shadow.append("redis_error"), ...read.o }, ...read }
          else admit(read,
            newJob(state.sources.length() - 1, true, acquired(c0), state.created.nth(call.key),
              Remote::fenceFor(state, call.key, layout.operationsPerEntity, c0.visible), ttls, WAITING_SOURCE, shadowing.logging),
            shadowing.budgetMs)
        }
      | _ => state
    }
  }
  pure def release(state: Shadowed[r], layout: Serving::Layout, policyCall: int, resolved: Resolution, ttls: Ttls, classifier: int, shadowing: Shadowing): Shadowed[r] = {
    val judged = Serving::layeredRelease(state, layout, policyCall, resolved, ttls)
    admitJobs(Writes::releaseJudged(state, layout, judged, policyCall, ttls, classifier), layout, judged, ttls, shadowing)
  }
  // An immediate policy reply: admission, the release and the job in one step.
  pure def begin(state: Shadowed[r], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls, classifier: int, shadowing: Shadowing): Shadowed[r] = {
    val admitted = Serving::admit(state, layout, call)
    if (Serving::participating(state, layout, call)) release(admitted, layout, state.o.policyCalls, resolved, ttls, classifier, shadowing) else admitted
  }

  // -- Settlement ------------------------------------------------------------------------

  // A job ends with its outcome, its record and deadline gone; a timed-out
  // job said so already and adds nothing.
  pure def finishJob(state: Jobs[r], source: int, outcome: str): Jobs[r] = {
    val job = jobOf(state, source)
    Deadlines::forget({
      jobs: state.jobs.select(other => other.source != source),
      o: { shadow: if (job.timedOut) state.o.shadow else state.o.shadow.append(outcome), ...state.o },
      ...state
    }, Deadlines::JOB, source)
  }
  // The label a failed source gives its job: the caller's deadline error is
  // the job's `timeout` (the implementations race the caller's bounded
  // source and report its timeout as the job's), any other failure
  // `source_error`.
  pure def sourceOutcome(result: int): str = if (result == DEADLINE_ERROR) "timeout" else "source_error"
  // A dark fill: the authority the job captured (C18, C58), judged before
  // serializing; a fence the wall does not clear ends the job with no dump.
  pure def fill(state: Shadowed[r], layout: Serving::Layout, job: Job): Shadowed[r] = {
    val authority = Serving::authority(state, sourceOf(state, job), job.ttls, true, true, job.fence)
    if (not(Serving::refillAllowed(state, authority.retentionMs, authority.fence))) finishJob(state, job.source, "fill_fenced")
    else update(Writes::holdDump(state, job.source, authority.retentionMs, authority.fence), { phase: SERIALIZING, ...job })
  }
  // The comparison: the C0's decoded value against the source's, or what the
  // installed callback reports.
  pure def valuesMatch(cached: int, result: int): bool = Payloads::valueOf(cached) == result
  pure def matches(comparison: Comparison, cached: int, result: int): bool =
    comparison.comparator == COMPARE_EQUAL or (comparison.comparator == COMPARE_VALUES and valuesMatch(cached, result))
  // The confirmation read judged: a failed read, the same bytes, or replaced bytes.
  pure def confirmation(observed: Remote::Observed, cached: int): str =
    if (observed.failed) "confirmation_error"
    else if (Payloads::bytesOf(observed.payload) == Payloads::bytesOf(cached)) "mismatch"
    else "superseded"
  // The job's source has settled, the atomic lifecycle: the decode and the
  // confirmation read are made here.
  pure def settleJob(state: Shadowed[r], layout: Serving::Layout, source: int): Shadowed[r] = {
    val job = jobOf(state, source)
    val result = sourceOf(state, job).result
    if (job.timedOut) finishJob(state, source, "timeout")
    else if (not(accepted(result))) finishJob(state, source, sourceOutcome(result))
    else if (job.cached == NO_VALUE) fill(state, layout, job)
    else {
      val decoded = { o: { loads: state.o.loads + 1, ...state.o }, ...state }
      if (valuesMatch(job.cached, result)) finishJob(decoded, source, "match")
      else {
        val confirmed = Remote::observe(decoded, sourceOf(state, job).key, layout.operationsPerEntity, 0, state.readFailed)
        finishJob({ o: { reads: decoded.o.reads + 1, ...decoded.o }, ...decoded }, source, confirmation(confirmed, job.cached))
      }
    }
  }
  // A source settles (`remote_writes::settle`), then the job waiting on it.
  pure def settle(state: Shadowed[r], layout: Serving::Layout, index: int, value: int, timeout: bool): Shadowed[r] = {
    val settled = Writes::settle(state, layout, index, value, timeout)
    if (waiting(settled, index)) settleJob(settled, layout, index) else settled
  }

  // -- Held fills -------------------------------------------------------------------------

  // A dump released: a caller's refill dispatches its write; a job's fill
  // dispatches it and writes next, unless the job's budget expired meanwhile
  // or the dump failed (no write, the job ends: `fill_error`, a label
  // `finishJob` suppresses for a timed-out job) or the fence, judged again at
  // release, stopped the write (`fill_fenced`: a wall rollback since
  // settlement). A source carries a caller's refill or a job's fill, never
  // both: a dark job is admitted only under a reply with the remote layer off.
  pure def releaseDump(state: Shadowed[r], layout: Serving::Layout, dump: int, failed: bool): Shadowed[r] = {
    val source = Writes::heldDump(state, dump).source
    if (not(holdsJob(state, source))) Writes::releaseDump(state, layout, dump, failed)
    else {
      val job = jobOf(state, source)
      if (job.timedOut or failed) finishJob(Writes::abandonDump(state, dump), source, "fill_error")
      else {
        val dispatched = Writes::dispatch(state, dump)
        if (dispatched.o.writes > state.o.writes) update(dispatched, { phase: WRITING, ...job }) else finishJob(dispatched, source, "fill_fenced")
      }
    }
  }
  // A write released: a caller's refill stores and completes; a job's fill
  // stores (`filled`; `fill_error` when the write failed and nothing is
  // stored) and completes nobody.
  pure def releaseWrite(state: Shadowed[r], layout: Serving::Layout, write: int, failed: bool): Shadowed[r] = {
    val source = Writes::heldWrite(state, write).source
    if (not(holdsJob(state, source))) Writes::releaseWrite(state, layout, write, failed)
    else finishJob(if (failed) Writes::abandonWrite(state, write) else Writes::store(state, write), source, if (failed) "fill_error" else "filled")
  }

  // -- Budgets ------------------------------------------------------------------------------

  // A job's budget delivered: `timeout` said once; a dark job still waiting
  // leaves the registry, any other keeps its record until its held work drains.
  pure def expireJob(state: Jobs[r], due: Deadlines::Due): Jobs[r] = {
    val job = jobOf(state, due.index)
    val expired = { o: { shadow: state.o.shadow.append("timeout"), ...state.o }, ...state }
    if (job.dark and job.phase == WAITING_SOURCE) { jobs: expired.jobs.select(other => other.source != job.source), ...expired }
    else update(expired, { timedOut: true, ...job })
  }
  // Time passes, delivering each job budget at its instant (a shape whose
  // pending deadlines are job budgets alone).
  pure def advance(state: Jobs[r], ms: int): Jobs[r] = Deadlines::deliver(state, ms, expireJob)

  // -- The held lifecycle ---------------------------------------------------------------------

  // The job's source has settled: a timed-out job ends silently, a failed
  // source ends it `source_error`, a job without a C0 fills, else the job's
  // decode of its C0 is held (counted) over the job's source.
  pure def settleJobHeld(state: HeldJobs[r], layout: Serving::Layout, source: int): HeldJobs[r] = {
    val job = jobOf(state, source)
    val result = sourceOf(state, job).result
    if (job.timedOut) finishJob(state, source, "timeout")
    else if (not(accepted(result))) finishJob(state, source, sourceOutcome(result))
    else if (job.cached == NO_VALUE) fill(state, layout, job)
    else update(RemoteIO::holdLoad(state, source, NO_TTLS, job.cached, false), { phase: DECODING, ...job })
  }
  // A job's held decode settles: a timed-out job drains silently; a failed
  // decode ends `deserialization_error`; else the comparison runs, its
  // elapsed time moving the clock without delivering timers, and a budget it
  // reached ends `timeout`, a throwing callback `comparison_error`, equality
  // a `match`, and inequality holds the confirmation read (counted, under the
  // read budget in force on the io channel).
  pure def settleJobLoad(state: HeldJobs[r], layout: Serving::Layout, load: int, failed: bool, comparison: Comparison, budget: int): HeldJobs[r] = {
    val job = decoderOf(state, load)
    val source = job.source
    val settled = { loads: state.loads.select(other => other.load != load), ...state }
    if (job.timedOut) finishJob(settled, source, "timeout")
    else if (failed or Payloads::decodeFails(job.cached)) finishJob(settled, source, "deserialization_error")
    else {
      val compared = Clock::advance({
        o: { comparisons: settled.o.comparisons + (if (comparison.comparator == COMPARE_VALUES) 0 else 1), ...settled.o }, ...settled
      }, comparison.elapsedMs)
      if (Deadlines::reached(compared, Deadlines::JOB, source)) finishJob(compared, source, "timeout")
      else if (comparison.comparator == COMPARE_ERROR) finishJob(compared, source, "comparison_error")
      else if (matches(comparison, job.cached, sourceOf(state, job).result)) finishJob(compared, source, "match")
      else update(RemoteIO::holdRead(compared, source, NO_TTLS, budget), { phase: CONFIRMING, ...job })
    }
  }
  // A job's held read settles, the C0 read or the confirmation read: a
  // timed-out job drains silently; the confirmation read is judged
  // (`confirmation`); the C0 read acquires the frame when fresh for the
  // captured freshness with the fence it observed, ends `redis_error` when it
  // failed, and continues at once when the source already settled.
  pure def settleJobRead(state: HeldJobs[r], layout: Serving::Layout, read: int, failed: bool): HeldJobs[r] = {
    val job = readerOf(state, read)
    val source = job.source
    val key = sourceOf(state, job).key
    val settled = { reads: state.reads.select(other => other.read != read), ...state }
    val seen = Remote::observe(state, key, layout.operationsPerEntity, if (job.phase == READING_C0) job.ttls.freshMs else 0, failed)
    if (job.timedOut) finishJob(settled, source, "timeout")
    else if (job.phase == CONFIRMING) finishJob(settled, source, confirmation(seen, job.cached))
    else if (seen.failed) finishJob(settled, source, "redis_error")
    else {
      val waiting = update(settled, {
        cached: acquired(seen), stamp: state.created.nth(key), fence: Remote::fenceFor(state, key, layout.operationsPerEntity, seen.visible),
        phase: WAITING_SOURCE, ...job
      })
      if (sourceOf(waiting, job).result != CALL_PENDING) settleJobHeld(waiting, layout, source) else waiting
    }
  }

  // -- Served jobs over the held remote lifecycle -------------------------------------------

  // The selection captured for the flight whose read the step dispatched.
  pure def capture(before: HeldShadowed[r], after: HeldShadowed[r], selected: bool): HeldShadowed[r] =
    if (selected and after.o.reads > before.o.reads) { selected: after.selected.append(after.sources.length() - 1), ...after } else after
  pure def isSelected(state: HeldShadowed[r], flight: int): bool = state.selected.select(other => other == flight).length() > 0
  // The selection consulted: the hit judged, the record is forgotten.
  pure def forgetSelection(state: HeldShadowed[r], flight: int): HeldShadowed[r] =
    { selected: state.selected.select(other => other != flight), ...state }
  // An immediate policy reply: admission and the held release in one step
  // (`remote_io::begin`), the selection captured when a read is dispatched.
  pure def beginHeld(state: HeldShadowed[r], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls, budget: int, selected: bool): HeldShadowed[r] =
    capture(state, RemoteIO::begin(state, layout, call, resolved, ttls, budget), selected)
  // A held policy reply released: the held release (`remote_io::release`),
  // the selection captured the same way.
  pure def releaseHeld(state: HeldShadowed[r], layout: Serving::Layout, policyCall: int, resolved: Resolution, ttls: Ttls, budget: int, selected: bool): HeldShadowed[r] =
    capture(state, RemoteIO::release(state, layout, policyCall, resolved, ttls, budget), selected)
  // A held read settles: a job's read as the held lifecycle has it; a
  // caller's read as `remote_io` has it, and one that holds no decode (a
  // miss, a failed read, a read whose deadline was delivered) can serve no
  // hit, so its flight's selection is forgotten.
  pure def settleRead(state: HeldShadowed[r], layout: Serving::Layout, read: int, failed: bool, classifier: int): HeldShadowed[r] =
    if (holdsRead(state, read)) settleJobRead(state, layout, read, failed)
    else {
      val settled = RemoteIO::settleRead(state, layout, read, failed, classifier)
      if (settled.o.loads > state.o.loads) settled else forgetSelection(settled, RemoteIO::heldRead(state, read).flight)
    }
  // A held decode settles: a job's decode as the held lifecycle has it, under
  // ordinary value equality and the read budget in force; a caller's decode
  // as `remote_io` has it, the selection captured for its flight consulted
  // and forgotten: a fresh frame decoded completes the flight with a served
  // hit, which admits the job under the instance's hook and limits as read
  // now (`admitServed`, its detached source mapped to the drivers' next loader
  // ordinal, `remote_io::mapLoader`); a failed decode restarts the loader and
  // a recovery decode recovers, neither a served hit.
  pure def settleLoad(state: HeldShadowed[r], layout: Serving::Layout, load: int, failed: bool, budget: int, shadowing: Shadowing): HeldShadowed[r] =
    if (holdsLoad(state, load)) settleJobLoad(state, layout, load, failed, VALUE_COMPARISON, budget)
    else {
      val held = RemoteIO::heldLoad(state, load)
      val settled = forgetSelection(RemoteIO::settleLoad(state, layout, load, failed), held.flight)
      val served = not(held.recovery) and not(failed) and not(Payloads::decodeFails(held.value))
      if (not(served)) settled
      else RemoteIO::mapLoader(settled,
        admitServed(settled, layout, state.sources.nth(held.flight), held.value, held.ttls, { selected: isSelected(state, held.flight), ...shadowing }))
    }
  // A loader settles by the drivers' ordinal (`remote_io::settleLoader`), then
  // the job waiting on its source.
  pure def settleLoader(state: HeldJobs[r], layout: Serving::Layout, ordinal: int, value: int, timeout: bool): HeldJobs[r] = {
    val flight = state.loaders.nth(ordinal)
    val settled = RemoteIO::settleLoader(state, layout, ordinal, value, timeout)
    if (waiting(settled, flight)) settleJobHeld(settled, layout, flight) else settled
  }

  // -- Dark jobs over the diagnosed budgeted held lifecycle ------------------------------------

  // Admission beside the held release: a dark job registered over the
  // caller's source with its budget, its C0 read not yet dispatched.
  pure def admitDark(state: Jobs[r], judged: Serving::LayeredRelease, ttls: Ttls, shadowing: Shadowing): Jobs[r] = {
    val call = judged.call
    if (not(admits(shadowing))) state
    else match judged.decision.outcome {
      | Starts => if (not(judged.open) or judged.effective.layers.remote) state
        else if (busy(state, call.instance, call.key, shadowing.capacity)) dropped(state)
        else admit(state, newJob(state.sources.length() - 1, true, NO_VALUE, 0, NO_FENCE, ttls, READING_C0, shadowing.logging), shadowing.budgetMs)
      // The remote layer is unobserved at a held release: nothing serves from
      // it here, so no served job is admitted at this step.
      | _ => state
    }
  }
  // The deferred dispatch of a dark job's C0 read: a budget the source's
  // synchronous work already reached times the job out with no read (C54);
  // else the read is held under the read budget in force.
  pure def dispatchC0(state: HeldJobs[r], source: int, budget: int): HeldJobs[r] =
    if (Deadlines::reached(state, Deadlines::JOB, source)) finishJob(state, source, "timeout")
    else RemoteIO::holdRead(state, source, NO_TTLS, budget)
  // An immediate policy reply over the diagnosed held lifecycle: admission and
  // the diagnosed held release (the caller's source started at once under the
  // source budget, or its read dispatched under `budget`), the configuration
  // error a malformed shadow policy reports, the job registered, the source's
  // synchronous work (`workMs`, moving the clock without delivering timers),
  // and the C0 read dispatched or the job timed out.
  pure def beginDark(state: DiagnosedShadowed[r, q], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls, budget: int,
      shadowing: Shadowing, malformed: Malformed, workMs: int): DiagnosedShadowed[r, q] = {
    val admitted = Diagnostics::admit(state, layout, call)
    if (not(Serving::participating(state, layout, call))) Clock::advance(admitted, workMs)
    else {
      val judged = Serving::judgeRelease(admitted, layout, state.o.policyCalls, resolved, ttls, false)
      val released = Diagnostics::releaseJudged(admitted, layout, judged, state.o.policyCalls, ttls, budget)
      val reported = if (malformed.ramp or (admits(shadowing) and malformed.logging)) Diagnostics::recordConfigError(released) else released
      val registered = admitDark(reported, judged, ttls, shadowing)
      val worked = Clock::advance(registered, workMs)
      if (registered.jobs.length() > reported.jobs.length()) dispatchC0(worked, state.sources.length(), budget) else worked
    }
  }
  // A loader settles by the drivers' ordinal (`diagnostics::settleLoader`: a
  // result arriving after its deadline is a deadline error, one whose
  // deadline already completed the flight drains), then the job waiting on
  // a flight the step settled.
  pure def settleHeld(state: DiagnosedShadowed[r, q], layout: Serving::Layout, ordinal: int, value: int, timeout: bool): DiagnosedShadowed[r, q] = {
    val flight = state.loaders.nth(ordinal)
    val settled = Diagnostics::settleLoader(state, layout, ordinal, value, timeout)
    if (state.sources.nth(flight).result == CALL_PENDING and settled.sources.nth(flight).result != CALL_PENDING and waiting(settled, flight))
      settleJobHeld(settled, layout, flight)
    else settled
  }
  // The verdict the drivers observe, recorded beside the label the settlement
  // reported for the job: a `match` or a confirmed `mismatch` samples the C0
  // frame's age at the verdict, clamped to zero after a wall rollback (C57),
  // and a confirmed mismatch warns under the logging policy the job captured
  // (C60). A timed-out job reports no label and so no verdict.
  pure def recordVerdict(before: DiagnosedShadowed[r, q], after: DiagnosedShadowed[r, q], job: Job): DiagnosedShadowed[r, q] = {
    val labels = after.o.shadow
    val outcome = if (labels.length() > before.o.shadow.length()) labels.nth(labels.length() - 1) else ""
    if (outcome != "match" and outcome != "mismatch") after
    else {
      val age = Clock::wallOf(after) - job.stamp
      val warned = if (outcome == "mismatch" and job.logging) Diagnostics::recordWarning(after) else after
      Diagnostics::recordAge(warned, if (age < 0) 0 else age)
    }
  }
  // The drivers release a job's held decode: the settlement, its verdict recorded.
  pure def releaseLoad(state: DiagnosedShadowed[r, q], layout: Serving::Layout, load: int, failed: bool, comparison: Comparison, budget: int): DiagnosedShadowed[r, q] =
    recordVerdict(state, settleJobLoad(state, layout, load, failed, comparison, budget), decoderOf(state, load))
  // The drivers release a job's held read: a visible frame stamped after the
  // wall clock reports its offset on the shadow layer whatever follows, then
  // the settlement, its verdict recorded.
  pure def releaseRead(state: DiagnosedShadowed[r, q], layout: Serving::Layout, read: int, failed: bool): DiagnosedShadowed[r, q] = {
    val job = readerOf(state, read)
    val key = sourceOf(state, job).key
    val stamp = state.created.nth(key)
    val offset = stamp - Clock::wallOf(state)
    val measured = if (offset > 0 and Remote::observe(state, key, layout.operationsPerEntity, 0, failed).visible)
      Diagnostics::recordFutureOffset(state, Diagnostics::REMOTE_SHADOW_LAYER, offset) else state
    recordVerdict(measured, settleJobRead(measured, layout, read, failed), job)
  }
  // Delivery from inside the kernel, by kind: a job budget (nothing for a job
  // a source deadline of the same round already ended), a read deadline, or a
  // source deadline through the diagnosed expiry, then the job waiting on the
  // flight it completed (`settleJobHeld`: `timeout`, the slot released).
  pure def expireHeld(state: DiagnosedShadowed[r, q], layout: Serving::Layout, due: Deadlines::Due): DiagnosedShadowed[r, q] =
    if (due.kind == Deadlines::JOB) (if (holdsJob(state, due.index)) expireJob(state, due) else state)
    else if (due.kind == Deadlines::READ) Deadlines::expireRead(state, layout, due.index)
    else {
      val flight = state.loaders.nth(due.index)
      val expired = Diagnostics::expireLoader(state, layout, due.index)
      if (waiting(expired, flight)) settleJobHeld(expired, layout, flight) else expired
    }
  pure def advanceHeld(state: DiagnosedShadowed[r, q], layout: Serving::Layout, ms: int): DiagnosedShadowed[r, q] =
    Deadlines::deliver(state, ms, (current, due) => expireHeld(current, layout, due))
}

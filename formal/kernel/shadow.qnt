module shadow {
  // Shadow jobs (C47 to C54): the diagnostic work a served remote hit or a
  // ramped-down miss admits beside the caller, in one per-instance registry
  // of bounded capacity shared by both kinds. A job is admitted beside the
  // layered release judged once (`serving::layeredRelease`): a served hit
  // admits a served job whose C0 is the payload the hit served and whose
  // source is a detached one (`serving::startDetachedSource`: no caller owns
  // it, it publishes nothing); a miss whose reply left the remote layer off
  // admits a dark job over the caller's own source, reading its C0 from the
  // remote layer itself (the read counted; the payload when the frame is
  // fresh for the reply's freshness, nothing otherwise); an ordinary serving
  // miss, a request or local hit, or a key whose cohort the ramp does not
  // select admits nothing; a live job for the same instance and key, or a
  // full instance, drops the job (C47, `dropped`). Admission captures the
  // fill authority a flight's remote read fixes (`serving::authority`: the
  // retention the reply resolved to, capped for a tracked write, and the fence
  // the C0 read observed when it found no visible frame), which a fill is
  // written with whatever the policy says later (C18).
  //
  // When the job's source settles: a failed source ends the job
  // (`source_error`); with no C0 the job fills the remote layer through the
  // held refill (`remote_writes::holdDump`, the write stamped at dump release
  // and stored at write release, `filled`), never publishing to request or
  // local storage; with a C0 the job decodes it (counted) and compares its
  // value with the source's: equal is a `match`, else a confirmation read
  // (counted) of the frame as it is now says whether the C0 bytes are still
  // current (`mismatch`) or were replaced meanwhile (`superseded`). A served
  // job always has a C0, so it never fills (C54). Every job has the budget
  // its admission resolved, kept by `deadlines` (kind JOB): at expiry the job
  // is timed out and says so once; a dark job still waiting for its source
  // abandons the wait, releasing its slot while the caller's source runs on
  // unbounded; a served job keeps its detached source and its slot until
  // that source settles; a job already filling keeps its held work, a dump
  // released after the budget dispatching no write while a write released
  // after it still stores (C53). No later label follows a timeout. A fill
  // whose dump or write fails (the `failed` argument of the two releases,
  // as `remote_writes` takes it) ends `fill_error`, nothing written.
  //
  // Cohort selection is the drivers' ramp decoded by the profile through
  // `cohort_boundaries` (strict against the key's numerator); the module reads
  // the decoded selection. Payload identity: a C0 is a payload code
  // (`payloads`), compared by decoded value against the source and by code
  // against the confirmation read, so representations that share bytes or
  // decode alike (the shadow profile's) compare as the implementations do.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import remote_frames as Remote from "./remote-frames"
  import remote_writes as Writes from "./remote-writes"
  import deadlines as Deadlines from "./deadlines"
  import payloads as Payloads from "./payloads"

  // The deadline kind `deadlines` reserves for a job.
  pure val JOB = 2
  pure val WAITING_SOURCE = 0
  pure val SERIALIZING = 1
  pure val WRITING = 2
  pure val FINISHED = 3

  // The shadow policy in force for a call: whether the key's cohort is
  // selected, the per-instance capacity and the job budget.
  type Shadowing = { selected: bool, capacity: int, budgetMs: int }
  // A job: the source whose result it compares or fills with (the caller's
  // own source for a dark job, a detached one for a served job), whether it is
  // dark, the payload its C0 found fresh (NO_VALUE when none), the fill
  // authority it captured (the retention its fill is written with, C18, and
  // the fence its C0 read observed when it found no visible frame, C58; a
  // served job never fills and takes none), its phase and whether its budget
  // expired.
  type Job = { source: int, dark: bool, cached: int, retentionMs: int, fence: int, phase: int, timedOut: bool }
  type Shadowed[r] = Writes::Writing[{ jobs: List[Job], deadlines: List[Deadlines::Due] | r }]

  pure def sourceOf(state: Shadowed[r], job: Job): Serving::LayeredSource = state.sources.nth(job.source)
  pure def live(job: Job): bool = job.phase != FINISHED
  pure def liveJobs(state: Shadowed[r]): Set[int] = state.jobs.indices().filter(i => live(state.jobs.nth(i)))
  // A live job already runs for the identity, or the instance's registry is full.
  pure def duplicate(state: Shadowed[r], instance: int, key: int): bool =
    liveJobs(state).exists(i => sourceOf(state, state.jobs.nth(i)).instance == instance and sourceOf(state, state.jobs.nth(i)).key == key)
  pure def full(state: Shadowed[r], instance: int, capacity: int): bool =
    liveJobs(state).filter(i => sourceOf(state, state.jobs.nth(i)).instance == instance).size() >= capacity
  // The jobs over a source in a phase (at most one: a source has one job).
  pure def jobsOf(state: Shadowed[r], source: int, phase: int): Set[int] =
    state.jobs.indices().filter(i => state.jobs.nth(i).source == source and state.jobs.nth(i).phase == phase)

  // -- Admission -----------------------------------------------------------------------

  pure def dropped(state: Shadowed[r]): Shadowed[r] =
    { o: { shadow: state.o.shadow.append("dropped"), ...state.o }, ...state }
  // A job registered over a source, waiting for it, its budget due from now.
  pure def admit(state: Shadowed[r], source: int, dark: bool, cached: int, retentionMs: int, fence: int, budgetMs: int): Shadowed[r] =
    Deadlines::due({
      jobs: state.jobs.append({ source: source, dark: dark, cached: cached, retentionMs: retentionMs, fence: fence, phase: WAITING_SOURCE, timedOut: false }),
      ...state
    }, JOB, state.jobs.length(), budgetMs)
  // Admission beside the release judged once, on the released state.
  pure def admitJobs(state: Shadowed[r], layout: Serving::Layout, judged: Serving::LayeredRelease, ttls: Ttls, shadowing: Shadowing): Shadowed[r] = {
    val call = judged.call
    val busy = duplicate(state, call.instance, call.key) or full(state, call.instance, shadowing.capacity)
    if (not(shadowing.selected)) state
    else match judged.decision.outcome {
      | ServesRemote(_) => if (busy) dropped(state)
        else admit(Serving::startDetachedSource(state, layout, call), state.sources.length(), false, judged.remote.payload,
          Serving::authority(state, call, ttls, true, true, NO_FENCE).retentionMs, NO_FENCE, shadowing.budgetMs)
      | Starts => if (judged.effective.layers.remote) state
        else if (busy) dropped(state)
        else {
          // The dark C0 read: the frame as the reply's freshness judges it now,
          // under the adapter's read fault; the job reads the remote layer on
          // its own account, so its fill authority is a flight's that read it
          // (`serving::authority` under the reply's TTLs, not the effective ones).
          val c0 = Remote::observe(state, call.key, layout.operationsPerEntity, ttls.freshMs, state.readFailed)
          val fill = Serving::authority(state, call, ttls, true, not(c0.failed), Remote::fenceFor(state, call.key, layout.operationsPerEntity, c0.visible))
          admit({ o: { reads: state.o.reads + 1, ...state.o }, ...state }, state.sources.length() - 1, true,
            if (c0.value > NO_VALUE) c0.payload else NO_VALUE, fill.retentionMs, fill.fence, shadowing.budgetMs)
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

  // A job ends with its outcome, its deadline forgotten; a timed-out job said
  // so already and adds nothing.
  pure def finishJob(state: Shadowed[r], index: int, outcome: str): Shadowed[r] = {
    val job = state.jobs.nth(index)
    Deadlines::forget({
      jobs: state.jobs.replaceAt(index, { phase: FINISHED, ...job }),
      o: { shadow: if (job.timedOut) state.o.shadow else state.o.shadow.append(outcome), ...state.o },
      ...state
    }, JOB, index)
  }
  pure def inPhase(state: Shadowed[r], index: int, phase: int): Shadowed[r] =
    { jobs: state.jobs.replaceAt(index, { phase: phase, ...state.jobs.nth(index) }), ...state }
  // The job's source has settled.
  pure def settleJob(state: Shadowed[r], layout: Serving::Layout, index: int): Shadowed[r] = {
    val job = state.jobs.nth(index)
    val source = sourceOf(state, job)
    if (job.timedOut) finishJob(state, index, "timeout")
    else if (not(accepted(source.result))) finishJob(state, index, "source_error")
    else if (job.cached == NO_VALUE) inPhase(Writes::holdDump(state, job.source, job.retentionMs, job.fence), index, SERIALIZING)
    else {
      val decoded = { o: { loads: state.o.loads + 1, ...state.o }, ...state }
      if (Payloads::valueOf(job.cached) == source.result) finishJob(decoded, index, "match")
      else {
        val confirmed = Remote::observe(decoded, source.key, layout.operationsPerEntity, 0, false)
        finishJob({ o: { reads: decoded.o.reads + 1, ...decoded.o }, ...decoded }, index,
          if (confirmed.payload == job.cached) "mismatch" else "superseded")
      }
    }
  }
  // A source settles (`remote_writes::settle`), then the job waiting on it.
  pure def settle(state: Shadowed[r], layout: Serving::Layout, index: int, value: int, timeout: bool): Shadowed[r] = {
    val settled = Writes::settle(state, layout, index, value, timeout)
    jobsOf(settled, index, WAITING_SOURCE).fold(settled, (out, job) => settleJob(out, layout, job))
  }

  // -- Held fills -------------------------------------------------------------------------

  // A dump released: a caller's refill dispatches its write; a job's fill
  // dispatches it and writes next, unless the job's budget expired meanwhile
  // (no write, the job ends), the dump failed (`fill_error`) or the fence
  // stopped the write (`fill_fenced`).
  pure def releaseDump(state: Shadowed[r], layout: Serving::Layout, dump: int, failed: bool): Shadowed[r] = {
    val fills = jobsOf(state, Writes::heldDump(state, dump).source, SERIALIZING)
    if (fills.size() == 0) Writes::releaseDump(state, layout, dump, failed)
    else fills.fold(state, (out, index) =>
      if (out.jobs.nth(index).timedOut) finishJob(Writes::abandonDump(out, dump), index, "timeout")
      else if (failed) finishJob(Writes::abandonDump(out, dump), index, "fill_error")
      else {
        val dispatched = Writes::dispatch(out, dump)
        if (dispatched.o.writes > out.o.writes) inPhase(dispatched, index, WRITING) else finishJob(dispatched, index, "fill_fenced")
      })
  }
  // A write released: a caller's refill stores and completes; a job's fill
  // stores (`filled`; `fill_error` when the write failed and nothing is
  // stored) and completes nobody.
  pure def releaseWrite(state: Shadowed[r], layout: Serving::Layout, write: int, failed: bool): Shadowed[r] = {
    val fills = jobsOf(state, Writes::heldWrite(state, write).source, WRITING)
    if (fills.size() == 0) Writes::releaseWrite(state, layout, write, failed)
    else fills.fold(if (failed) Writes::abandonWrite(state, write) else Writes::store(state, write),
      (out, index) => finishJob(out, index, if (failed) "fill_error" else "filled"))
  }

  // -- Budgets ------------------------------------------------------------------------------

  // A job's budget delivered.
  pure def expireJob(state: Shadowed[r], due: Deadlines::Due): Shadowed[r] = {
    val job = state.jobs.nth(due.index)
    {
      jobs: state.jobs.replaceAt(due.index, {
        timedOut: true,
        phase: if (job.dark and job.phase == WAITING_SOURCE) FINISHED else job.phase,
        ...job
      }),
      o: { shadow: state.o.shadow.append("timeout"), ...state.o },
      ...state
    }
  }
  // Time passes, delivering each job budget at its instant.
  pure def advance(state: Shadowed[r], ms: int): Shadowed[r] = Deadlines::deliver(state, ms, expireJob)
}

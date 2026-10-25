module shadow {
  // Shadow jobs: diagnostic work a served remote hit or ramped-down miss admits beside the caller.
  //
  // Rules
  // - Admission needs the hook and the ramp (C47), not a bypass reply (C01); `busy` drops (C54).
  // - A served hit admits a served job over a detached source, its C0 the payload served (C48);
  //   a miss with the remote layer left off admits a dark job over the caller's own source (C49).
  // - A job captures its reply's TTLs (C18) and the fence its C0 read observed (C53); only a dark
  //   job with no C0 fills, under that authority, the fence judged again at dispatch (C52, C53).
  // - A C0 is decoded on its own and compared; an unequal comparison needs one confirmation read
  //   of the frame's bytes (C50, C51); verdict ages and mismatch warnings follow C57 and C60.
  // - A job captures the mismatch-logging leaves; a confirmed mismatch with either on warns once,
  //   its content and logging outcome judged at the verdict (C60; W10's scalar cases).
  // Shapes
  // - Comparison: the comparator the drivers install and the elapsed time it consumes.
  // - Shadowing: the shadow policy in force for a call, passed at admission.
  // - Malformed: whether the ramp or a logging input failed to resolve, passed to `beginDark`.
  // - Logging, LoggingInput: the leaves a job captures, and one config layer's written inputs.
  // - Job: one job's record, kept while it is pending.
  // - Jobs[r]: the per-instance registry of bounded capacity both kinds share, over the clock.
  // - Shadowed[r]: the atomic lifecycle over `remote_writes::Writing`, shadow-layers' shape.
  // - HeldJobs[r]: the held lifecycle over `remote_io::Held`, with the held fills.
  // - HeldShadowed[r]: the served arm (admission profile), the selection captured per flight.
  // - DiagnosedShadowed[r, q]: the dark arm (shadow profile) over `diagnostics::DiagnosedHeld`.
  // - Entry, MismatchWarning, Verdict: a warning's content, and a verdict's opt-in receipt.
  // Consumers: admission, dark-layers, shadow, shadow-layers, shadow-read-deadlines, `shadow_reads`.
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

  // -- Mismatch logging (C60) ----------------------------------------------------------
  // The leaves a confirmed-mismatch warning is logged under: `value` logs both
  // renderings, and the ordered `diff` level logs the difference's paths
  // (`paths`) or its entries too (`values`). Either on opts into a warning.
  pure val DIFF_OFF = "off"
  pure val DIFF_PATHS = "paths"
  pure val DIFF_VALUES = "values"
  type Logging = { value: bool, diff: str }
  pure val LOGGING_OFF: Logging = { value: false, diff: DIFF_OFF }
  pure def logs(logging: Logging): bool = logging.value or logging.diff != DIFF_OFF
  // One config layer's inputs as written, before expansion: the
  // `logMismatches` shorthand and the two `mismatchLogging` leaves, each
  // UNWRITTEN, the spelling of a valid value ("true", "false", a level) or
  // any other string, a value of the wrong type.
  pure val UNWRITTEN = ""
  type LoggingInput = { shorthand: str, value: str, diff: str }
  pure val NO_LOGGING_INPUT: LoggingInput = { shorthand: UNWRITTEN, value: UNWRITTEN, diff: UNWRITTEN }
  // A layer expanded (D10): its shorthand stands for leaves, `true` for
  // `{ value: true, diff: "values" }` and `false` for both off, while a
  // malformed one stands for both off and is marked invalid; a leaf written
  // beside the shorthand then overrides what it stands for.
  pure def expandLogging(written: LoggingInput): { value: str, diff: str, invalid: bool } = {
    val stands = if (written.shorthand == "true") { value: "true", diff: DIFF_VALUES }
      else if (written.shorthand == UNWRITTEN) { value: UNWRITTEN, diff: UNWRITTEN }
      else { value: "false", diff: DIFF_OFF }
    {
      value: if (written.value != UNWRITTEN) written.value else stands.value,
      diff: if (written.diff != UNWRITTEN) written.diff else stands.diff,
      invalid: not(Set(UNWRITTEN, "true", "false").contains(written.shorthand))
    }
  }
  // The runtime overlay over the defaults, leaf by leaf, each layer expanded
  // first: a runtime shorthand replaces both inherited leaves, and a leaf the
  // overlay leaves unwritten falls through to the default's. Registration
  // rejects a malformed static input, so only the overlay marks the merge.
  pure def mergeLogging(defaults: LoggingInput, overlay: LoggingInput): { value: str, diff: str, invalid: bool } = {
    val inherited = expandLogging(defaults)
    val written = expandLogging(overlay)
    {
      value: if (written.value != UNWRITTEN) written.value else inherited.value,
      diff: if (written.diff != UNWRITTEN) written.diff else inherited.diff,
      invalid: written.invalid
    }
  }
  // Each leaf resolved on its own: an unwritten leaf is off and a value of the
  // wrong type acts off, so an invalid leaf beside a valid one leaves the
  // valid one on; one configuration error covers every invalid input.
  pure def resolveLogging(merged: { value: str, diff: str, invalid: bool }): { logging: Logging, invalid: bool } = {
    val levels = Set(DIFF_OFF, DIFF_PATHS, DIFF_VALUES)
    {
      logging: { value: merged.value == "true", diff: if (levels.contains(merged.diff)) merged.diff else DIFF_OFF },
      invalid: merged.invalid or not(Set(UNWRITTEN, "true", "false").contains(merged.value))
        or not(levels.contains(merged.diff) or merged.diff == UNWRITTEN)
    }
  }

  // The shadow policy in force for a call: whether the outcome hook is
  // installed (C47), whether the key's cohort is selected, the per-instance
  // capacity, the job budget, the mismatch-logging leaves (C60) and whether a
  // `shadowMismatchDiff` hook replaces the built-in walk (D6; the model's hook
  // throws), both captured by the job at admission. Cohort selection is the
  // drivers' ramp decoded by the profile through `cohort_boundaries` (strict
  // against the key's numerator); the module reads the decoded selection.
  type Shadowing = { hook: bool, selected: bool, capacity: int, budgetMs: int, logging: Logging, diffHook: bool }
  // Whether the policy failed to resolve: the ramp, or a logging input. A
  // shadow policy that fails to resolve is one configuration error per call:
  // an invalid ramp always; any invalid logging input only where the hook and
  // the ramp would otherwise admit the job (`beginDark`).
  type Malformed = { ramp: bool, logging: bool }
  pure val WELL_FORMED: Malformed = { ramp: false, logging: false }

  // A job: the source whose result it compares or fills with (the caller's
  // own source for a dark job, a detached one for a served job), whether it is
  // dark, the payload its C0 found fresh (NO_VALUE when none) and that
  // frame's stamp (the age a verdict samples), the fence its C0 read observed
  // when it found no visible frame (C53), the TTLs its reply resolved to
  // (C18), its phase, whether its budget expired, and the mismatch logging
  // and diff hook it captured. The captured TTLs are the freshness its C0
  // read judges by and the retention its fill is written with, whatever the
  // policy says later.
  type Job = {
    source: int, dark: bool, cached: int, stamp: int, fence: int, ttls: Ttls, phase: int, timedOut: bool,
    logging: Logging, diffHook: bool
  }
  // The registry beside the clock and its pending budgets, over the sources
  // the jobs run for: what every lifecycle composes. The registry is
  // pending-only, keyed by the job's source: a finished job leaves no record,
  // as a settled held read or dump does. A source has at most one job: a dark
  // job takes the caller's just-started source, a served job a detached one
  // registered for it.
  type Jobs[r] = Deadlines::Scheduled[{ o: Observation, jobs: List[Job], sources: List[Serving::LayeredSource] | r }]
  // The atomic lifecycle's shape, over `remote_writes::Writing`: it judges
  // the hit and the policy in the same step, at release (`admitJobs` reads
  // the whole `Shadowing`), and makes the dark C0 read, the decode and the
  // confirmation read at once. Two lifecycles compose the one registry.
  type Shadowed[r] = Writes::Writing[{ jobs: List[Job], deadlines: List[Deadlines::Due] | r }]
  // The held lifecycle's shape: the held remote traversal with the held fills
  // (a dark job's dumps and writes) and the registry. It holds a job's reads
  // and decodes as `remote_io` holds a caller's read and decode, in the same
  // lists under the drivers' effect indices. They are budgeted on the io
  // channel like every held read and never deadline-registered: the job's
  // budget bounds all its work. Its rules are stated once, over `remote_io`:
  // the source settled holds the decode (`settleJobHeld`), the decode settled
  // says `match` or holds the confirmation read (`settleJobLoad`), the read
  // settled says the verdict or acquires the C0 (`settleJobRead`). The two
  // profiles that compose it each take one arm of the held admission.
  type HeldJobs[r] = RemoteIO::Held[{ dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], jobs: List[Job], deadlines: List[Deadlines::Due] | r }]
  // Served jobs, the admission profile's arm, whose replies all enable the
  // remote layer: the selection captured per pending flight beside the
  // registry. The caller's read is dispatched before the frame is judged, so
  // the cohort selection is captured for the flight when the read is
  // dispatched (`selected`, a pending-only list of flights, the kernel's
  // consulted-record idiom as `recovery`'s snapshot). It is consulted when
  // the hit is judged (`settleLoad`, `settleRead`).
  type HeldShadowed[r] = HeldJobs[{ selected: List[int] | r }]
  // Dark jobs, the shadow profile's arm, whose replies all leave the remote
  // layer off. The shape is the diagnosed budgeted held remote lifecycle
  // (`deadlines`, `diagnostics`: the caller's source deadline, the coalesced
  // scope, the layer a failure is attributed to) with the held fills and the
  // jobs. Beside the four channel fields every descriptor parses, it carries
  // the four the shadow drivers compare: the configuration errors, the future
  // offsets, the mismatch warnings with their content and one logging outcome
  // per warning (`recordMismatchWarning`); a profile whose drivers never log a
  // mismatch carries the last two empty.
  type DiagnosedShadowed[r, q] = Diagnostics::DiagnosedHeld[
    { dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], jobs: List[Job] | r },
    {
      configErrors: int, futureOffsets: List[Diagnostics::FutureOffset],
      mismatchWarnings: List[MismatchWarning], loggingOutcomes: List[str] | q
    }
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
  // A caller's flight never has one then.
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
  // A pending job, the shadow policy's mismatch logging and diff hook captured.
  pure def newJob(source: int, dark: bool, cached: int, stamp: int, fence: int, ttls: Ttls, phase: int, shadowing: Shadowing): Job = {
    source: source, dark: dark, cached: cached, stamp: stamp, fence: fence, ttls: ttls, phase: phase, timedOut: false,
    logging: shadowing.logging, diffHook: shadowing.diffHook
  }
  // A job registered over its source, its budget due from now: every job has
  // the budget its admission resolved, kept by `deadlines` (kind `JOB`, keyed
  // by the job's source).
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
  // stamp as the hit is judged, the reply's TTLs and no fence. The detached
  // source is `serving::startDetachedSource`: no caller owns it, it publishes
  // nothing. A served job always has a C0, so it never fills (C52).
  pure def admitServed(state: Serving::Served[{ jobs: List[Job], deadlines: List[Deadlines::Due] | r }], layout: Serving::Layout,
      who: { instance: int, key: int | q }, cached: int, ttls: Ttls, shadowing: Shadowing): Serving::Served[{ jobs: List[Job], deadlines: List[Deadlines::Due] | r }] =
    if (not(admits(shadowing))) state
    else if (busy(state, who.instance, who.key, shadowing.capacity)) dropped(state)
    else admit(Serving::startDetachedSource(state, layout, who),
      newJob(state.sources.length(), false, cached, state.created.nth(who.key), NO_FENCE, ttls, WAITING_SOURCE, shadowing), shadowing.budgetMs)
  // Admission beside the release judged once (`serving::layeredRelease`), on
  // the released state: the atomic lifecycle, where a dark job's C0 read is
  // made here. A served hit admits a served job (`admitServed`); a miss whose
  // reply left the remote layer off admits a dark job over the caller's own
  // source, reading its C0 from the remote layer itself. An ordinary serving
  // miss, a request or local hit, a key whose cohort the ramp does not select,
  // an instance without the outcome hook (C47) or a bypass reply (C01) admits
  // nothing.
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
          // its own account (the read counted; the payload when fresh,
          // `acquired`, nothing otherwise). A failed read ends `redis_error` at
          // once and is the label alone: the read counted, no job registered,
          // nothing filled, as the implementations return from the failed read
          // before awaiting the source.
          val c0 = Remote::observe(state, call.key, layout.operationsPerEntity, ttls.freshMs, state.readFailed)
          val read = { o: { reads: state.o.reads + 1, ...state.o }, ...state }
          if (c0.failed) { o: { shadow: read.o.shadow.append("redis_error"), ...read.o }, ...read }
          else admit(read,
            newJob(state.sources.length() - 1, true, acquired(c0), state.created.nth(call.key),
              Remote::fenceFor(state, call.key, layout.operationsPerEntity, c0.visible), ttls, WAITING_SOURCE, shadowing),
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

  // Raw work has drained: remove its registration and any remaining budget.
  // A bounded read can have reported its result before reaching this point.
  pure def retireJob(state: Jobs[r], source: int): Jobs[r] =
    Deadlines::forget({ jobs: state.jobs.select(other => other.source != source), ...state }, Deadlines::JOB, source)
  // A job ends with its outcome, its record and deadline gone; a timed-out
  // job said so already and adds nothing. A timed-out job ends silently at
  // whichever step finds it so, keeping its slot until then (C54: a served
  // job's capacity is owned through its pending source, decode and
  // confirmation). No later label follows a timeout.
  pure def finishJob(state: Jobs[r], source: int, outcome: str): Jobs[r] = {
    val job = jobOf(state, source)
    retireJob({
      o: { shadow: if (job.timedOut) state.o.shadow else state.o.shadow.append(outcome), ...state.o },
      ...state
    }, source)
  }
  // The label a failed source gives its job: the caller's deadline error is
  // the job's `timeout` (the implementations race the caller's bounded
  // source and report its timeout as the job's), any other failure
  // `source_error`.
  pure def sourceOutcome(result: int): str = if (result == DEADLINE_ERROR) "timeout" else "source_error"
  // A dark fill: the authority the job captured (C18, C53), judged before
  // serializing; a fence the wall does not clear ends the job with no dump.
  // The authority is `serving::authority` at the fill: the retention capped
  // for a tracked write, fenced by the watermark the C0 read observed when it
  // found no visible frame. The job fills the remote layer through the held
  // refill when `serving::refillAllowed` still allows the write, judged
  // before serializing as the implementations check the fence before
  // encoding (`fill_fenced` at settlement otherwise). The dump is
  // `remote_writes::holdDump`; the write is stamped at dump release, where
  // the fence is judged again, and stored at write release (`filled`). A fill
  // never publishes to request or local storage.
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
  // The confirmation read judged: a failed read (`confirmation_error`), the
  // same bytes or replaced bytes. The read of the frame as it is now says
  // whether the C0 bytes are still current (`mismatch`: the same bytes,
  // `payloads::bytesOf`, so a text and a binary spelling of one payload
  // confirm each other, C51) or replaced (`superseded`).
  pure def confirmation(observed: Remote::Observed, cached: int): str =
    if (observed.failed) "confirmation_error"
    else if (Payloads::bytesOf(observed.payload) == Payloads::bytesOf(cached)) "mismatch"
    else "superseded"
  // The job's source has settled, the atomic lifecycle: the decode and the
  // confirmation read are made here. A failed source ends the job
  // (`sourceOutcome`); with no C0 the job fills. With a C0 the job decodes it
  // (counted) and compares its value with the source's (`valuesMatch`, the
  // decoded value, `payloads::valueOf`). Equal is a `match`; else a
  // confirmation read (counted, under the adapter's read fault) of the frame
  // as it is now gives the verdict (`confirmation`).
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
  // The adapter's dump and write faults are the `failed` argument of the two
  // releases, as `remote_writes` takes them: a fill whose dump or write fails
  // ends `fill_error`, nothing written.
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
  // stored) and completes nobody. A write released after the job's budget
  // still stores (C53), where a dump released after it dispatches no write.
  pure def releaseWrite(state: Shadowed[r], layout: Serving::Layout, write: int, failed: bool): Shadowed[r] = {
    val source = Writes::heldWrite(state, write).source
    if (not(holdsJob(state, source))) Writes::releaseWrite(state, layout, write, failed)
    else finishJob(if (failed) Writes::abandonWrite(state, write) else Writes::store(state, write), source, if (failed) "fill_error" else "filled")
  }

  // -- Budgets ------------------------------------------------------------------------------

  // A job's budget delivered: `timeout` said once; a dark job still waiting
  // leaves the registry, any other keeps its record until its held work drains.
  // The dark job releases its slot while the caller's source runs on; a served
  // job keeps its detached source and its slot until that source settles. A
  // job holding a read, a decode or a fill keeps its record until the held
  // work drains (C53, C54).
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
  // decode ends `deserialization_error` (the drivers' fault or a payload whose
  // bytes fail to decode). Else the comparison runs through the comparator
  // the drivers install (`Comparison`), its elapsed time moving the clock
  // without delivering timers. A budget it reached ends `timeout` before any
  // verdict (C54), a throwing callback `comparison_error`, equality a
  // `match`, and inequality holds the confirmation read (counted, under the
  // read budget in force on the io channel). The callback is counted when
  // installed (`o.comparisons`).
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
        else admit(state, newJob(state.sources.length() - 1, true, NO_VALUE, 0, NO_FENCE, ttls, READING_C0, shadowing), shadowing.budgetMs)
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
  // and the C0 read dispatched or the job timed out. The job is registered
  // with its budget before the work moves the clock (BEHAVIOR.md
  // `sourceWorkMs`: the job's deadline and the caller's source deadline are
  // measured from the call).
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
  // -- Mismatch warnings (C60, D11 to D13) ----------------------------------------------

  // A side of a warning's value fields or of an entry: OMITTED when the
  // warning or the entry leaves it out, NO_RENDERING when it is logged as
  // `null` (a value with no JSON rendering, D13), else the value's code (a
  // source's result; a C0's decoded value, `payloads::valueOf`).
  pure val OMITTED = -1
  pure val NO_RENDERING = 0
  // One difference the walk reports: its RFC 6901 pointer and both sides.
  type Entry = { path: str, cached: int, source: int }
  // One warning's content as the drivers parse it (D12): the age of its C0 at
  // the verdict, the two value fields, which `diff` fields it carries and
  // whether they are `null`, the uncut count, the paths, the entries (logged
  // at `values` only) and the construction failure it names ("" for none).
  type MismatchWarning = {
    ageMs: int, cachedValue: int, sourceValue: int, diff: str, diffNull: bool,
    count: int, paths: List[str], entries: List[Entry], loggingOutcome: str
  }
  pure def unrendered(code: int): bool = code == VALUE_UNRENDERABLE
  // A value field: left out with `value` off, `null` for a side with no rendering.
  pure def valueField(logging: Logging, code: int): int =
    if (not(logging.value)) OMITTED else if (unrendered(code)) NO_RENDERING else code
  // The warning a confirmed mismatch logs under the job's captured leaves,
  // over two scalar values (W10's root cases; the walk over nested values is
  // the protocol vectors'). Each side is rendered once when `value` is on, or
  // when `diff` is and no hook replaces the walk; a rendered side with no
  // rendering is a `render_error`, its value field null and the walk not run.
  // The hook runs only when `diff` is on; the model's hook throws, a
  // `hook_error` that nulls every diff field it carries and never falls back
  // to the walk (D6), ranking above `render_error`. The walk reports nothing
  // for identical renderings, else one entry at the root with both sides.
  pure def warningOf(job: Job, cached: int, result: int, ageMs: int): MismatchWarning = {
    val diffOn = job.logging.diff != DIFF_OFF
    val rendered = job.logging.value or (diffOn and not(job.diffHook))
    val renderFails = rendered and (unrendered(cached) or unrendered(result))
    val hookFails = diffOn and job.diffHook
    val listed = diffOn and not(hookFails) and not(renderFails)
    val found = if (cached == result) List() else List({ path: "", cached: cached, source: result })
    {
      ageMs: ageMs, cachedValue: valueField(job.logging, cached), sourceValue: valueField(job.logging, result),
      diff: job.logging.diff, diffNull: diffOn and not(listed),
      count: if (listed) found.length() else 0,
      paths: if (listed) found.foldl(List(), (paths, entry) => paths.append(entry.path)) else List(),
      entries: if (listed and job.logging.diff == DIFF_VALUES) found else List(),
      loggingOutcome: if (hookFails) "hook_error" else if (renderFails) "render_error" else ""
    }
  }
  // The one `shadowMismatchLogging` outcome of a warning attempt (D11, D15):
  // the construction failure the warning names, else `logger_error` when the
  // logger failed after receiving it, else `logged`.
  pure def loggingOutcomeOf(warning: MismatchWarning, loggerFailed: bool): str =
    if (warning.loggingOutcome != "") warning.loggingOutcome else if (loggerFailed) "logger_error" else "logged"
  pure def recordMismatchWarning(state: DiagnosedShadowed[r, q], warning: MismatchWarning, outcome: str): DiagnosedShadowed[r, q] = {
    val counted = Diagnostics::recordWarning(state)
    {
      d: {
        mismatchWarnings: counted.d.mismatchWarnings.append(warning),
        loggingOutcomes: counted.d.loggingOutcomes.append(outcome), ...counted.d
      },
      ...counted
    }
  }
  // The verdict the drivers observe, recorded beside the label the settlement
  // reported for the job: a `match` or a confirmed `mismatch` samples the C0
  // frame's age at the verdict, clamped to zero after a wall rollback (C57),
  // and a confirmed mismatch warns once when the leaves the job captured at
  // admission opt in (`logs`), its content judged by `warningOf` and its one
  // logging outcome by `loggingOutcomeOf` under the logger's failure input.
  // A timed-out job reports no label and so no verdict.
  pure def recordVerdict(before: DiagnosedShadowed[r, q], after: DiagnosedShadowed[r, q], job: Job, loggerFailed: bool): DiagnosedShadowed[r, q] = {
    val labels = after.o.shadow
    val outcome = if (labels.length() > before.o.shadow.length()) labels.nth(labels.length() - 1) else ""
    if (outcome != "match" and outcome != "mismatch") after
    else {
      val elapsed = Clock::wallOf(after) - job.stamp
      val age = if (elapsed < 0) 0 else elapsed
      val warning = warningOf(job, Payloads::valueOf(job.cached), sourceOf(after, job).result, age)
      val warned = if (outcome == "mismatch" and logs(job.logging))
        recordMismatchWarning(after, warning, loggingOutcomeOf(warning, loggerFailed)) else after
      Diagnostics::recordAge(warned, age)
    }
  }
  // The drivers release a job's held decode: the settlement, its verdict
  // recorded. A decode never confirms a mismatch, so no logger runs here.
  pure def releaseLoad(state: DiagnosedShadowed[r, q], layout: Serving::Layout, load: int, failed: bool, comparison: Comparison, budget: int): DiagnosedShadowed[r, q] =
    recordVerdict(state, settleJobLoad(state, layout, load, failed, comparison, budget), decoderOf(state, load), false)
  // The drivers release a job's held read, the logger failing or not: a
  // visible frame stamped after the wall clock reports its offset on the
  // shadow layer whatever follows, then the settlement, its verdict recorded.
  pure def releaseReadWithLogger(state: DiagnosedShadowed[r, q], layout: Serving::Layout, read: int, failed: bool,
      loggerFailed: bool): DiagnosedShadowed[r, q] = {
    val job = readerOf(state, read)
    val key = sourceOf(state, job).key
    val stamp = state.created.nth(key)
    val offset = stamp - Clock::wallOf(state)
    val measured = if (offset > 0 and Remote::observe(state, key, layout.operationsPerEntity, 0, failed).visible)
      Diagnostics::recordFutureOffset(state, Diagnostics::REMOTE_SHADOW_LAYER, offset) else state
    recordVerdict(measured, settleJobRead(measured, layout, read, failed), job, loggerFailed)
  }
  // A profile whose logger never fails.
  pure def releaseRead(state: DiagnosedShadowed[r, q], layout: Serving::Layout, read: int, failed: bool): DiagnosedShadowed[r, q] =
    releaseReadWithLogger(state, layout, read, failed, false)
  // Opt-in record for a profile's own properties, never read by the
  // traversal: what each verdict saw, in verdict order (parallel to `d.ages`):
  // its label, the leaves and diff hook its job captured, the C0's decoded
  // value, the source's result and whether the logger failed.
  type Verdict = { outcome: str, logging: Logging, diffHook: bool, cached: int, result: int, loggerFailed: bool }
  pure def recordVerdictInputs(before: DiagnosedShadowed[{ verdicts: List[Verdict] | r }, q],
      after: DiagnosedShadowed[{ verdicts: List[Verdict] | r }, q], job: Job, loggerFailed: bool): DiagnosedShadowed[{ verdicts: List[Verdict] | r }, q] =
    if (after.d.ages.length() == before.d.ages.length()) after
    else {
      verdicts: after.verdicts.append({
        outcome: after.o.shadow.nth(after.o.shadow.length() - 1), logging: job.logging, diffHook: job.diffHook,
        cached: Payloads::valueOf(job.cached), result: sourceOf(before, job).result, loggerFailed: loggerFailed
      }),
      ...after
    }
  // Delivery from inside the kernel, by kind: a job budget (nothing for a job
  // a source deadline of the same round already ended), a read deadline, or a
  // source deadline through the diagnosed expiry, then the job waiting on the
  // flight it completed (`settleJobHeld`: `timeout`, the slot released). A
  // job still holding its C0 read then ends the same way when the read
  // settles (`settleJobRead`); a job budget due in the same round finds the
  // job gone and says nothing more. `held-dark-shadow.qnt` pins a source
  // deadline below its job budget with `sourceDeadlineAloneEndsTheJobTest`.
  // That arm is fixture-only: both native drivers derive both budgets from
  // the call's fallback timeout; replaying separate budgets would require a
  // per-call sourceTimeoutMs input.
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

module shadow_reads {
  // A shadow Redis read has two completions (C54/C56): its bounded result
  // ends at the read deadline, but the raw adapter operation retains the
  // shadow slot until it settles. The whole-job deadline is independent.
  // This variant composes the ordinary held dark lifecycle; profiles whose
  // bounds never reach a shadow read deadline retain that simpler projection.
  import conformance_observations.* from "../conformance-observations"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import remote_io as RemoteIO from "./remote-io"
  import deadlines as Deadlines from "./deadlines"
  import shadow as Shadow from "./shadow"

  // Distinct from caller READ expiry, which starts a fallback loader.
  pure val SHADOW_READ = 3
  type ReadBudget = { source: int, budget: int }
  type Bounded[r, q] = Shadow::DiagnosedShadowed[{
    expiredReads: List[int], capturedReadBudgets: List[ReadBudget] | r
  }, q]
  pure def budgetFor(state: Bounded[r, q], source: int): int =
    state.capturedReadBudgets.select(owned => owned.source == source).nth(0).budget

  // Record only a read actually dispatched by the composed transition. Its
  // deadline captures the budget at that dispatch, independently of policy.
  pure def registerRead(before: Bounded[r, q], after: Bounded[r, q], budget: int): Bounded[r, q] =
    if (after.o.reads == before.o.reads) after
    else Deadlines::due(after, SHADOW_READ, before.o.reads, budget)

  pure def begin(state: Bounded[r, q], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls,
      budget: int, shadowing: Shadow::Shadowing): Bounded[r, q] = {
    val started = Shadow::beginDark(state, layout, call, resolved, ttls, budget, shadowing, Shadow::WELL_FORMED, 0)
    val captured = if (started.jobs.length() == state.jobs.length()) started else {
      capturedReadBudgets: started.capturedReadBudgets.append({ source: state.sources.length(), budget: budget }), ...started
    }
    registerRead(state, captured, budget)
  }

  pure def releaseLoad(state: Bounded[r, q], layout: Serving::Layout, load: int, failed: bool,
      comparison: Shadow::Comparison): Bounded[r, q] = {
    val budget = budgetFor(state, Shadow::decoderOf(state, load).source)
    registerRead(state, Shadow::releaseLoad(state, layout, load, failed, comparison, budget), budget)
  }

  // A bounded read error completes the validation operation, hence its job
  // timer is forgotten. The raw read and the registration remain. If the job
  // already timed out, that earlier outcome is the only one reported.
  pure def finishReadResult(state: Bounded[r, q], read: int, job: Shadow::Job): Bounded[r, q] =
    Deadlines::forget({
      expiredReads: state.expiredReads.append(read),
      o: { shadow: if (job.timedOut) state.o.shadow else state.o.shadow.append(
        if (job.phase == Shadow::CONFIRMING) "confirmation_error" else "redis_error"), ...state.o },
      ...state
    }, Deadlines::JOB, job.source)

  pure def expireRead(state: Bounded[r, q], read: int): Bounded[r, q] = {
    val job = Shadow::readerOf(state, read)
    val aborted = { io: { aborted: state.io.aborted.append(read), ...state.io }, ...state }
    finishReadResult(aborted, read, job)
  }

  // Timers are delivered by instant, preserving their registration order.
  // Other work keeps the diagnosed source and whole-job expiry semantics.
  pure def expire(state: Bounded[r, q], layout: Serving::Layout, due: Deadlines::Due): Bounded[r, q] =
    if (due.kind == SHADOW_READ) expireRead(state, due.index)
    else Shadow::expireHeld(state, layout, due)
  pure def advance(state: Bounded[r, q], layout: Serving::Layout, ms: int): Bounded[r, q] =
    Deadlines::deliver(state, ms, (current, due) => expire(current, layout, due))

  // A raw reply after its bounded result failed is cleanup only: it cannot
  // acquire a frame, sample a future offset, decode, fill or emit a verdict.
  pure def releaseRead(state: Bounded[r, q], layout: Serving::Layout, read: int, failed: bool): Bounded[r, q] = {
    val forgotten = Deadlines::forget(state, SHADOW_READ, read)
    if (state.expiredReads.select(expired => expired == read).length() > 0) Shadow::retireJob({
      reads: forgotten.reads.select(other => other.read != read),
      expiredReads: forgotten.expiredReads.select(other => other != read),
      ...forgotten
    }, RemoteIO::heldRead(state, read).flight)
    else Shadow::releaseRead(forgotten, layout, read, failed)
  }
}

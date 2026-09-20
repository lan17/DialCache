module deadlines {
  // Deadlines (C23 to C27, C56): a source starts with the budget its start
  // resolved. A source started at admission belongs to a caller that made no
  // policy call: it is bounded only when its key failed to construct (C27); a
  // disabled context and a call outside every request run theirs unbounded
  // (C01). A source started at release, or a loader started for a flight
  // whose held read settled or expired, belongs to a caller that was enabled
  // when admitted, whether or not its scope has closed since, and is always
  // bounded. A held remote read is bounded by the read budget in force when
  // it was dispatched; a read settled in its dispatching step registers no
  // read deadline under an unbounded budget, and a finite budget is reached
  // at once only when zero. A deadline is measured from its work's own start;
  // equality belongs to the timeout (`dueAt`).
  //
  // A pending deadline (`Due`) names its work (a remote read, a source loader
  // or a shadow job), the index of that work in the drivers' order for its kind, and
  // the instant it is due. It is registered when the work starts and forgotten
  // when the work settles or the deadline is delivered; unbounded work
  // registers none, so bounded is encoded by presence. The list is in
  // registration order, which is the delivery order at equal instants across
  // kinds. Delivery is instant-ordered (`deliver`): an advance moves both
  // clocks to each due instant inside it in turn and delivers every deadline
  // due there, so work a delivery starts (a read expiry starts a loader) is
  // delivered at its own instant inside the same advance, and every judgment
  // a delivery makes (a recovery age, a caller's outcome) reads the clocks at
  // that instant. A deadline the clock passed without delivery (a bare clock
  // move) is delivered at the first instant the next advance visits, not at
  // the current instant before moving, as the implementations' timers fire
  // when the clock next runs; a deadline registered at or before the current
  // instant during a round (a zero budget started by a delivery) is likewise
  // delivered at the next visited instant. A zero budget registered at a
  // settlement step outside a round is also delivered at the next instant the
  // following advance visits, where the implementations fire a 0 ms timer
  // before the clock moves: an open design point for a budgeted recovery
  // composition, unreachable in every scheduled profile today (independent's
  // source budget is 10 ms; the local shape makes no clock judgment at
  // expiry). An expired source completes every
  // caller it owns with DEADLINE_ERROR; a result arriving after its deadline
  // is a deadline error (`arrival`); work whose deadline already completed
  // its callers drains once, when the result arrives. `drained` is per loader
  // ordinal: the source list itself in the local projection, `remote_io`'s
  // `loaders` in the held shape.
  //
  // A profile whose drivers bound sources composes the budgeted variants of
  // the local lifecycle; one whose drivers hold and bound remote reads and
  // loaders composes the held variants. A module that bounds work of its own
  // kind composes `Scheduled` alone, the clock and the pending deadlines
  // (`shadow`'s job registry): its profile's callers run no source
  // deadline, so that shape has no `sourceBudget` and no source registers
  // one. The fold's expiry is passed only from inside the kernel, by the two
  // instantiations here and by such a module's own expiry; a profile never
  // passes an operator to the library (the composition lint reports an
  // argument in a parameter position a kernel definition declares with an
  // operator type, `expire` here, unless it names a kernel definition,
  // following aliases and let-bound names).
  import cache_rules.* from "../cache-rules"
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import remote_io as RemoteIO from "./remote-io"
  import remote_frames as Remote from "./remote-frames"
  import clock as Clock from "./clock"

  pure val UNBOUNDED = -1
  // Kinds of bounded work: a remote read, a source loader, and a shadow job's
  // budget, registered, forgotten and delivered by `shadow`.
  pure val READ = 0
  pure val SOURCE = 1
  pure val JOB = 2

  type Due = { kind: int, index: int, at: int }
  // The pending deadlines beside the clock: what registration, forgetting and
  // instant-ordered delivery read. A module that bounds work of its own kind
  // composes this shape alone.
  type Scheduled[r] = { now: int, deadlines: List[Due] | r }
  // The budgeted shape adds the configured source budget and, per loader
  // ordinal, whether its external work has been delivered (a loader its
  // deadline completed still has work to drain).
  type Budgeted[r] = Scheduled[{ sourceBudget: int, drained: List[bool] | r }]
  // The budgeted local lifecycle: the local projection of the traversal with
  // the deadlines beside its source list, and per source the history its
  // properties read: when it started, its budget and when it settled (-1
  // while pending).
  type BudgetedLocal[r] = Serving::LocalServed[{
    sourceBudget: int, deadlines: List[Due], drained: List[bool], started: List[int], budgets: List[int], settledAt: List[int] | r
  }]
  // The budgeted held lifecycle: the held remote traversal with the deadlines
  // beside its reads and loaders.
  type BudgetedHeld[r] = RemoteIO::Held[{ sourceBudget: int, deadlines: List[Due], drained: List[bool] | r }]

  // The budget of a source started at admission: the configured budget when
  // the key failed to construct (C27), none for any other bypass (C01).
  pure def admissionBudget(state: Budgeted[r], call: Call): int = if (call.keyFailed) state.sourceBudget else UNBOUNDED
  // Work that just started registers its deadline; unbounded work none
  // (a finite zero is due at once).
  pure def due(state: Scheduled[r], kind: int, index: int, budget: int): Scheduled[r] =
    if (budget < 0) state else { deadlines: state.deadlines.append({ kind: kind, index: index, at: state.now + budget }), ...state }
  pure def deadlinesOf(state: Scheduled[r], kind: int, index: int): List[Due] =
    state.deadlines.select(d => d.kind == kind and d.index == index)
  pure def bounded(state: Scheduled[r], kind: int, index: int): bool = deadlinesOf(state, kind, index).length() > 0
  pure def deadlineOf(state: Scheduled[r], kind: int, index: int): int =
    if (bounded(state, kind, index)) deadlinesOf(state, kind, index).nth(0).at else UNBOUNDED
  // A deadline is reached at an instant at or after it: equality belongs to the timeout.
  pure def dueAt(now: int, d: Due): bool = not(deadlinePendingAt(now, d.at))
  // Due and not yet delivered.
  pure def reached(state: Scheduled[r], kind: int, index: int): bool =
    deadlinesOf(state, kind, index).select(d => dueAt(state.now, d)).length() > 0
  pure def forget(state: Scheduled[r], kind: int, index: int): Scheduled[r] =
    { deadlines: state.deadlines.select(d => not(d.kind == kind and d.index == index)), ...state }
  pure def pending(state: Budgeted[r], ordinal: int): bool = not(state.drained.nth(ordinal))
  pure def drain(state: Budgeted[r], ordinal: int): Budgeted[r] = { drained: state.drained.replaceAt(ordinal, true), ...state }
  // A loader's arrival: the outcome its settlement applies (its value, or
  // DEADLINE_ERROR when its deadline passed undelivered), or CALL_PENDING when
  // its deadline already completed its flight (the recorded result) and the
  // work only drains.
  pure def arrival(state: Budgeted[r], ordinal: int, result: int, value: int): int =
    if (result != CALL_PENDING) CALL_PENDING
    else if (reached(state, SOURCE, ordinal)) DEADLINE_ERROR else value
  // Settling a loader drains its work and forgets its deadline.
  pure def retire(state: Budgeted[r], ordinal: int): Budgeted[r] = forget(drain(state, ordinal), SOURCE, ordinal)

  // -- Instant-ordered delivery ------------------------------------------------

  // The earliest instant after now, at or before the target, at which a
  // pending deadline is due; the target when none is.
  pure def earliestDue(state: Scheduled[r], target: int): int =
    state.deadlines.foldl(target, (best, d) => if (d.at > state.now and d.at < best) d.at else best)
  // Time passes to the target, delivering each due instant in turn with the
  // variant's expiry: a round moves both clocks to the earliest due instant
  // and delivers, in registration order, every deadline reached there,
  // forgetting each before its expiry runs. A round delivers at least one
  // deadline until the target is reached, and a delivery registers at most
  // one deadline (a read expiry starts a bounded loader), so the rounds are
  // bounded by twice the pending deadlines plus the final move.
  pure def deliver(state: Scheduled[r], ms: int, expire: (Scheduled[r], Due) => Scheduled[r]): Scheduled[r] = {
    val target = state.now + ms
    1.to(2 * state.deadlines.length() + 1).fold(state, (current, _) => {
      val moved = Clock::advance(current, earliestDue(current, target) - current.now)
      moved.deadlines.foldl(moved, (delivered, d) =>
        if (dueAt(delivered.now, d)) expire(forget(delivered, d.kind, d.index), d) else delivered)
    })
  }

  // -- Budgeted variants of the local lifecycle ------------------------------------

  // The history the local shape keeps per source.
  type Recorded[r] = { now: int, started: List[int], budgets: List[int], settledAt: List[int] | r }
  pure def stamp(state: Recorded[r], budget: int): Recorded[r] = {
    started: state.started.append(state.now),
    budgets: state.budgets.append(budget),
    settledAt: state.settledAt.append(-1),
    ...state
  }
  pure def markSettled(state: Recorded[r], index: int): Recorded[r] = { settledAt: state.settledAt.replaceAt(index, state.now), ...state }
  // A source the step started: its deadline registered, its work outstanding,
  // its history stamped.
  pure def startedLocal(state: BudgetedLocal[r], index: int, budget: int): BudgetedLocal[r] =
    due(stamp({ drained: state.drained.append(false), ...state }, budget), SOURCE, index, budget)

  pure def admitLocal(state: BudgetedLocal[r], layout: Serving::Layout, call: Call): BudgetedLocal[r] = {
    val admitted = Serving::admitLocal(state, layout, call)
    if (admitted.sources.length() > state.sources.length()) startedLocal(admitted, state.sources.length(), admissionBudget(state, call)) else admitted
  }
  // A source started at release is bounded: its caller was enabled when
  // admitted, whether or not its scope has closed since.
  pure def releaseLocal(state: BudgetedLocal[r], layout: Serving::Layout, policyCall: int, resolved: Resolution, ttls: Ttls): BudgetedLocal[r] = {
    val released = Serving::releaseLocal(state, layout, policyCall, resolved, ttls)
    if (released.sources.length() > state.sources.length()) startedLocal(released, state.sources.length(), state.sourceBudget) else released
  }
  // A source's outcome arriving after its deadline is a deadline error; work
  // whose deadline already completed its callers drains without effect.
  pure def settleLocal(state: BudgetedLocal[r], layout: Serving::Layout, index: int, value: int): BudgetedLocal[r] = {
    val outcome = arrival(state, index, state.sources.nth(index).result, value)
    val retired = retire(state, index)
    if (outcome == CALL_PENDING) retired else markSettled(Serving::settleLocal(retired, layout, index, outcome), index)
  }
  // A delivered deadline completes the source's callers with a deadline
  // error, which publishes to no layer; its external work is not drained.
  pure def expireLocal(state: BudgetedLocal[r], layout: Serving::Layout, index: int): BudgetedLocal[r] =
    markSettled(Serving::settleLocal(state, layout, index, DEADLINE_ERROR), index)
  pure def advanceLocal(state: BudgetedLocal[r], layout: Serving::Layout, ms: int): BudgetedLocal[r] =
    deliver(state, ms, (current, d) => expireLocal(current, layout, d.index))

  // -- Budgeted variants of the held lifecycle ---------------------------------------

  // A loader the step started (at admission for a bypass source, at a release
  // without the remote layer, at read settlement, read expiry or a failed
  // decode) is bounded from now under the budget its start resolved, and has
  // work outstanding.
  pure def stampLoader(before: BudgetedHeld[r], after: BudgetedHeld[r], budget: int): BudgetedHeld[r] =
    if (after.o.loaders > before.o.loaders)
      due({ drained: after.drained.append(false), ...after }, SOURCE, after.loaders.length() - 1, budget)
    else after
  // A bypass source started at admission takes the admission budget.
  pure def admit(state: BudgetedHeld[r], layout: Serving::Layout, call: Call): BudgetedHeld[r] =
    stampLoader(state, RemoteIO::admit(state, layout, call), admissionBudget(state, call))
  // A read the release dispatched is bounded by the read budget in force; a
  // source the release started without the remote layer (under the reply, or
  // the bypass reply of a scope closed since admission) is bounded by the
  // configured source budget, as every release-started source is.
  pure def releaseJudged(state: BudgetedHeld[r], layout: Serving::Layout, judged: Serving::LayeredRelease, policyCall: int, ttls: Ttls, budget: int): BudgetedHeld[r] = {
    val released = RemoteIO::releaseJudged(state, layout, judged, policyCall, ttls, budget)
    stampLoader(state, if (released.o.reads > state.o.reads) due(released, READ, state.o.reads, budget) else released, state.sourceBudget)
  }
  pure def release(state: BudgetedHeld[r], layout: Serving::Layout, policyCall: int, resolved: Resolution, ttls: Ttls, budget: int): BudgetedHeld[r] =
    releaseJudged(state, layout, Serving::judgeRelease(state, layout, policyCall, resolved, ttls, false), policyCall, ttls, budget)
  // An immediate policy reply: admission and the held release in one step.
  pure def begin(state: BudgetedHeld[r], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls, budget: int): BudgetedHeld[r] = {
    val admitted = admit(state, layout, call)
    if (Serving::participating(state, layout, call)) release(admitted, layout, state.o.policyCalls, resolved, ttls, budget) else admitted
  }
  // A read settled in the step that dispatched it: its deadline, if the
  // budget registered one, is forgotten by the settlement (an unbounded
  // budget registers none and is the truthful one for a read that never
  // waits), and the loader the settlement starts is bounded from now.
  pure def settleDispatched(before: BudgetedHeld[r], after: BudgetedHeld[r], layout: Serving::Layout, classifier: int): BudgetedHeld[r] =
    if (after.o.reads > before.o.reads) settleRead(after, layout, before.o.reads, after.readFailed, classifier) else after
  pure def beginRead(state: BudgetedHeld[r], layout: Serving::Layout, call: Call, resolved: Resolution, ttls: Ttls, budget: int, classifier: int): BudgetedHeld[r] =
    settleDispatched(state, begin(state, layout, call, resolved, ttls, budget), layout, classifier)
  // A read whose deadline is delivered: the loader its expiry starts is bounded from now.
  pure def expireRead(state: BudgetedHeld[r], layout: Serving::Layout, read: int): BudgetedHeld[r] =
    stampLoader(state, RemoteIO::expireRead(state, layout, read), state.sourceBudget)
  // A read whose deadline passed undelivered (a bare clock move) is expired
  // before its reply is judged, so the reply drains; a delivered one owns
  // nothing already.
  pure def expiredIfReached(state: BudgetedHeld[r], layout: Serving::Layout, read: int): BudgetedHeld[r] =
    if (reached(state, READ, read)) expireRead(forget(state, READ, read), layout, read) else forget(state, READ, read)
  pure def settleRead(state: BudgetedHeld[r], layout: Serving::Layout, read: int, failed: bool, classifier: int): BudgetedHeld[r] = {
    val current = expiredIfReached(state, layout, read)
    stampLoader(current, RemoteIO::settleRead(current, layout, read, failed, classifier), state.sourceBudget)
  }
  // The same settlement applied from a judgment already made (`remote_io::settleObserved`).
  pure def settleObserved(state: BudgetedHeld[r], layout: Serving::Layout, read: int, judged: Remote::Observed, fence: int, classifier: int): BudgetedHeld[r] = {
    val current = expiredIfReached(state, layout, read)
    stampLoader(current, RemoteIO::settleObserved(current, layout, read, judged, fence, classifier), state.sourceBudget)
  }
  // A failed fresh decode's restart is a loader start like any other.
  pure def settleLoad(state: BudgetedHeld[r], layout: Serving::Layout, load: int, failed: bool): BudgetedHeld[r] =
    stampLoader(state, RemoteIO::settleLoad(state, layout, load, failed), state.sourceBudget)
  // A loader's result arriving after its deadline is a deadline error; a
  // loader whose deadline already completed its flight drains without effect.
  // `timeout` is the profile's propagated timeout, passed through; which
  // errors are timeouts for the recovery rules is `remote_io::failed`'s.
  pure def settleLoader(state: BudgetedHeld[r], layout: Serving::Layout, ordinal: int, value: int, timeout: bool): BudgetedHeld[r] = {
    val outcome = arrival(state, ordinal, state.sources.nth(state.loaders.nth(ordinal)).result, value)
    val retired = retire(state, ordinal)
    if (outcome == CALL_PENDING) retired
    else RemoteIO::settleLoader(retired, layout, ordinal, outcome, timeout)
  }
  // A delivered loader deadline completes the flight with a deadline error
  // (classified for recovery where the flight retained a snapshot); its
  // external work is not drained.
  pure def expireLoader(state: BudgetedHeld[r], layout: Serving::Layout, ordinal: int): BudgetedHeld[r] =
    RemoteIO::settleLoader(state, layout, ordinal, DEADLINE_ERROR, false)
  pure def advance(state: BudgetedHeld[r], layout: Serving::Layout, ms: int): BudgetedHeld[r] =
    deliver(state, ms, (current, d) => if (d.kind == READ) expireRead(current, layout, d.index) else expireLoader(current, layout, d.index))
}

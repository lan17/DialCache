module cache_kernel {
  import kernel_types.* from "./kernel-types"
  import cache_rules.* from "../cache-rules"
  import lifecycle_witnesses as Witness from "./lifecycle-witnesses"

  // A bounded migration pilot, not yet the complete DialCache kernel (#165).
  // The same transitions serve both views. Only the availability of external
  // read/decode/serialize/write completions changes with SETTLE. Neither view
  // may replace an outcome or assign cache state.
  const FIXTURE: (int) => Config
  const SETTLE: Settlement
  const PROJECT: (State) => a
  var s: State
  var input: Input
  var view: a
  // Witness bookkeeping advances from its previous value and the current
  // public step; it records credited labels and never reads kernel state.
  var monitor: Witness::Monitor

  pure def publicView(state: State): Witness::View = {
    calls: state.calls.mapList(call => resultCode(call.result)),
    now: state.now,
    reads: state.counts.reads,
    loaders: state.counts.loaders,
    dumps: state.counts.dumps,
    writes: state.counts.writes
  }
  action commit(updated: State, command: Input): bool = all {
    s' = updated,
    input' = command,
    view' = PROJECT(updated),
    monitor' = Witness::advance(monitor, { input: command, observation: publicView(updated) },
      not(SETTLE.read), updated.config.sourceBudget)
  }
  action initialize(choice: int): bool = {
    val config = FIXTURE(choice)
    val initial: State = {
      config: config,
      now: 10000,
      wall: config.initialWall,
      policy: 0,
      closed: List(false, false, false),
      memo: 0.to(11).fold(List(), (out, _) => out.append(Missing)),
      local: 0.to(7).fold(List(), (out, _) => out.append(Missing)),
      lru: List(List(), List()),
      remote: 0.to(3).fold(List(), (out, _) => out.append(Missing)),
      watermarks: List(0, 0),
      calls: List(),
      executions: List(),
      sources: List(),
      reads: List(),
      counts: {
        reads: 0,
        loaders: 0,
        loads: 0,
        dumps: 0,
        writes: 0,
        invalidations: 0,
        policyCalls: 0,
        readAborts: 0
      },
      events: List(),
      lastExecution: -1,
      writeTtls: List(),
      maintenance: List()
    }
    val command = { name: "init", choice: choice }
    all {
      s' = initial,
      input' = command,
      view' = PROJECT(initial),
      monitor' = Witness::advance(Witness::emptyMonitor, { input: command, observation: publicView(initial) },
        not(SETTLE.read), config.sourceBudget)
    }
  }

  // Captured execution ownership is the sole authority for completing callers.
  // A finished flight disappears from coalescing, even if its raw source runs.
  pure def update(state: State, owner: int, execution: Execution): State =
    { executions: state.executions.replaceAt(owner, execution), ...state }
  pure def event(state: State, kind: str, location: str, detail: str, amount: int): State =
    if (not(state.config.diagnostics)) state else {
      events: state.events.append({ event: kind, location: location, detail: detail, amount: amount }),
      ...state
    }
  pure def metric(state: State, kind: str, detail: str, amount: int): State = event(state, kind, "remote", detail, amount)
  pure def requestEnabled(state: State): bool = state.config.request and state.policy != 1 and state.policy != 5
  pure def localEnabled(state: State): bool = state.config.local and Set(0, 1, 3).contains(state.policy)
  pure def remoteEnabled(state: State): bool = state.config.remote and Set(0, 1, 2).contains(state.policy)
  pure def firstOwner(owners: Set[int]): int =
    owners.fold(-1, (first, owner) => if (first < 0 or owner < first) owner else first)
  pure def scopeOpen(state: State, context: int): bool = context < 0 or context >= 3 or not(state.closed.nth(context))
  pure def memoize(state: State, slot: int, value: int): State =
    if (slot < 0 or state.closed.nth(slot / 4)) state else {
      memo: state.memo.replaceAt(slot, Present({ value: value, created: state.wall })),
      ...state
    }
  pure def putLocal(state: State, instance: int, key: int, value: int): State = {
    val order = state.lru.nth(instance).select(k => k != key).append(key)
    val evicts = order.length() > state.config.capacity
    if (state.config.capacity == 0) state else {
      lru: state.lru.replaceAt(instance, if (evicts) order.slice(1, order.length()) else order),
      local: (if (evicts) state.local.replaceAt(instance * 4 + order.nth(0), Missing) else state.local)
        .replaceAt(instance * 4 + key, Present({ value: value, created: state.wall })),
      ...state
    }
  }
  pure def finish(state: State, owner: int, result: Result, warmLocal: bool): State = {
    val execution = state.executions.nth(owner)
    val completed = update({ calls: state.calls.mapList(call =>
      if (call.owner == owner) { result: result, ...call } else call), ...state },
      owner, { phase: Finished, result: result, ...execution })
    match result {
      Value(value) => {
        val local = if (warmLocal and execution.local)
          putLocal(completed, execution.instance, execution.key, value) else completed
        state.calls.foldl(local, (out, call) =>
          if (call.owner == owner) memoize(out, call.slot, value) else out)
      }
      | _ => completed
    }
  }
  pure def sourceDone(state: State, owner: int, failed: bool): State = {
    val execution = state.executions.nth(owner)
    metric(if (failed) metric(state, "error", "fallback", 0) else state,
      "fallback", "", state.now - execution.sourceStarted)
  }
  pure def startSource(state: State, owner: int, refill: bool, fence: int): State = {
    val execution = state.executions.nth(owner)
    update({
      sources: state.sources.append({ owner: owner, status: Running }),
      counts: { loaders: state.counts.loaders + 1, ...state.counts },
      ...state
    }, owner, {
      phase: Loading,
      source: state.sources.length(),
      sourceStarted: state.now,
      deadline: if (state.config.sourceBudget == 0) 0 else state.now + state.config.sourceBudget,
      refill: refill,
      fence: fence,
      ...execution
    })
  }
  pure def readDone(state: State, owner: int): State = metric(state, "get", "", state.now - state.executions.nth(owner).readStarted)
  pure def decoded(state: State, owner: int, failed: bool): State = {
    val measured = metric(if (failed) metric(state, "error", "serialization_load", 0) else state,
      "serialization", "load", state.now - state.executions.nth(owner).decodeStarted)
    readDone(if (failed) metric(measured, "miss", "unclassified", 0) else measured, owner)
  }
  pure def loadResult(state: State, owner: int, failed: bool): State = {
    val execution = state.executions.nth(owner)
    val measured = decoded(state, owner, failed)
    if (failed) startSource(measured, owner, true, 0)
    else finish(measured, owner, Value(execution.acquiredValue), true)
  }
  pure def readResult(state: State, index: int, failed: bool): State = {
    val read = state.reads.nth(index)
    val owner = read.owner
    val execution = state.executions.nth(owner)
    val settled = {
      reads: state.reads.replaceAt(index, { status: Settled, ...read }),
      ...state
    }
    if (read.status == Abandoned) settled
    else if (state.now >= execution.deadline) {
      val cancelled = {
        counts: { readAborts: state.counts.readAborts + 1, ...state.counts },
        ...settled
      }
      startSource(readDone(metric(cancelled, "error", "cache_read_timeout", 0), owner), owner, false, 0)
    }
    else if (failed) startSource(readDone(metric(settled, "error", "cache_read", 0), owner), owner, false, 0)
    else {
      val frame = state.remote.nth(execution.key)
      val stamp = entryStamp(frame)
      val watermark = state.watermarks.nth(execution.key / 2)
      val fenced = state.config.tracked and not(fenceAllows(stamp, watermark))
      val hit = entryValue(frame) > 0 and not(fenced) and stamp <= state.wall
      if (hit) {
        val loading = update({
          counts: { loads: state.counts.loads + 1, ...state.counts },
          ...settled
        }, owner, {
          phase: Decoding,
          acquiredValue: entryValue(frame),
          decodeStarted: state.now,
          ...execution
        })
        if (SETTLE.load) loadResult(loading, owner, false) else loading
      } else {
        val reason = if (entryValue(frame) == 0) "value_absent"
          else if (fenced) "watermark_fenced" else "unclassified"
        val measured = if (stamp > state.wall and entryValue(frame) > 0 and not(fenced))
          metric(settled, "futureOffset", "", stamp - state.wall) else settled
        startSource(readDone(metric(measured, "miss", reason, 0), owner), owner, true,
          // A future but unfenced frame is a semantic miss without a retained
          // fence. Only an absent or fenced tracked observation carries it.
          if (state.config.tracked and (entryValue(frame) == 0 or fenced)) watermark else 0)
      }
    }
  }

  pure def begin(state: State, instance: int, key: int, context: int): State = {
    val participating = scopeOpen(state, context)
    val slot = if (participating and context >= 0 and context < 3 and requestEnabled(state))
      context * 4 + key else -1
    val memo = if (slot >= 0) entryValue(state.memo.nth(slot)) else 0
    val requestOwners = state.calls.select(call =>
      slot >= 0 and call.slot == slot and state.executions.nth(call.owner).phase != Finished
    ).mapList(call => call.owner)
    val processOwners = state.executions.indices().filter(owner => {
      val execution = state.executions.nth(owner)
      execution.shared and execution.phase != Finished
        and execution.instance == instance and execution.key == key
    })
    val sharing = participating and (localEnabled(state) or remoteEnabled(state))
    val owner = if (requestOwners.length() > 0) requestOwners.head()
      else if (memo == 0 and sharing and processOwners.size() > 0) firstOwner(processOwners)
      else state.executions.length()
    val joining = owner < state.executions.length()
    val execution = {
      instance: instance,
      key: key,
      shared: sharing,
      local: participating and localEnabled(state),
      remote: participating and remoteEnabled(state),
      ...emptyExecution
    }
    val admitted = {
      calls: state.calls.append({
        instance: instance,
        key: key,
        context: context,
        slot: slot,
        owner: owner,
        result: Pending
      }),
      executions: if (joining) state.executions else state.executions.append(execution),
      counts: { policyCalls: state.counts.policyCalls + (if (participating) 1 else 0), ...state.counts },
      lastExecution: owner,
      ...state
    }
    val visited = event(admitted, "disabled", "local", "policy_disabled", 0)
    if (joining) event(visited, "coalesced", "process", "", 0)
    else if (memo > 0) finish(admitted, owner, Value(memo), false)
    else {
      val local = if (execution.local) entryValue(state.local.nth(instance * 4 + key)) else 0
      if (local > 0) finish(putLocal(admitted, instance, key, local), owner, Value(local), false)
      else if (not(execution.remote)) startSource(admitted, owner, false, 0)
      else {
        val started = update({
          reads: state.reads.append({ owner: owner, status: Running, budget: state.config.readBudget }),
          counts: { reads: state.counts.reads + 1, ...admitted.counts },
          ...metric(visited, "request", "", 0)
        }, owner, {
          phase: Reading,
          read: state.reads.length(),
          readStarted: state.now,
          deadline: state.now + state.config.readBudget,
          // A tracked remote miss cannot warm local storage; a validated hit can.
          ...execution
        })
        if (SETTLE.read) readResult(started, state.reads.length(), false) else started
      }
    }
  }

  // The source deadline decides acceptance. After acceptance, application-owned
  // serialization and writing retain this registered execution without that timer.
  pure def writeResult(state: State, owner: int, failed: bool): State = {
    val execution = state.executions.nth(owner)
    val written = if (failed) metric(state, "error", "cache_write", 0) else {
      remote: state.remote.replaceAt(execution.key, Present({
        value: resultCode(execution.result),
        created: execution.writeStamp
      })),
      ...state
    }
    finish(written, owner, execution.result, true)
  }
  pure def dumpResult(state: State, owner: int, failed: bool): State = {
    val execution = state.executions.nth(owner)
    val measured = metric(if (failed) metric(state, "error", "serialization_dump", 0) else state,
      "serialization", "dump", state.now - execution.acceptedAt)
    val sized = if (failed) measured else metric(metric(measured, "size", "", 1), "storedSize", "", 1)
    if (failed or not(fenceAllows(state.wall, execution.fence)))
      finish(sized, owner, execution.result, true)
    else {
      val dispatched = update({
        counts: { writes: state.counts.writes + 1, ...state.counts },
        writeTtls: state.writeTtls.append(60000),
        ...event(sized, "writeDispatch", "remote", "", state.counts.writes)
      }, owner, {
        phase: Writing,
        writeStamp: state.wall,
        ...execution
      })
      if (SETTLE.write) writeResult(dispatched, owner, false) else dispatched
    }
  }
  pure def sourceResult(state: State, index: int, value: int, failed: bool): State = {
    val source = state.sources.nth(index)
    val owner = source.owner
    val execution = state.executions.nth(owner)
    val settled = {
      sources: state.sources.replaceAt(index, { status: Settled, ...source }),
      ...state
    }
    val timely = state.config.sourceBudget == 0 or deadlinePendingAt(state.now, execution.deadline)
    val measured = if (source.status == Abandoned) settled
      else sourceDone(settled, owner, failed or not(timely))
    if (source.status == Abandoned) measured
    else if (not(timely)) finish(measured, owner, Timeout, false)
    else if (failed) finish(measured, owner, SourceError, false)
    else {
      val accepted = update(measured, owner, {
        result: Value(value),
        local: execution.local and not(state.config.tracked and execution.remote),
        ...execution
      })
      if (not(execution.refill) or not(fenceAllows(state.wall, execution.fence)))
        finish(accepted, owner, Value(value), true)
      else {
        val serializing = update({
          counts: { dumps: state.counts.dumps + 1, ...state.counts },
          ...accepted
        }, owner, {
          phase: Serializing,
          result: Value(value),
          acceptedAt: state.now,
          acceptedWall: state.wall,
          local: execution.local and not(state.config.tracked and execution.remote),
          ...execution
        })
        if (SETTLE.dump) dumpResult(serializing, owner, false) else serializing
      }
    }
  }
  pure def advance(state: State, deliver: bool): State = {
    val advanced = {
      now: state.now + state.config.tickMs,
      wall: state.wall + state.config.tickMs,
      ...state
    }
    if (not(deliver)) advanced else state.executions.indices().fold(advanced, (out, owner) => {
      val execution = out.executions.nth(owner)
      if (execution.phase == Reading and out.now >= execution.deadline) {
        val abandoned = {
          reads: out.reads.replaceAt(execution.read, { status: Abandoned, ...out.reads.nth(execution.read) }),
          counts: { readAborts: out.counts.readAborts + 1, ...out.counts },
          ...out
        }
        startSource(readDone(metric(abandoned, "error", "cache_read_timeout", 0), owner), owner, false, 0)
      }
      else if (execution.phase == Loading and out.config.sourceBudget > 0 and out.now >= execution.deadline) {
        val abandoned = {
          sources: out.sources.replaceAt(execution.source, { status: Abandoned, ...out.sources.nth(execution.source) }),
          ...out
        }
        finish(sourceDone(abandoned, owner, true), owner, Timeout, false)
      } else out
    })
  }

  // No nondeterminism occurs in kernel actions. The profile owns input choices.
  action beginCall(choice: int, instance: int, key: int, context: int): bool = all {
    s.calls.length() < s.config.maxCalls,
    commit(begin(s, instance, key, context), { name: "beginCall", choice: choice })
  }
  val pendingSources = s.sources.indices().filter(i => s.sources.nth(i).status != Settled)
  val pendingReads = s.reads.indices().filter(i => s.reads.nth(i).status != Settled)
  def inPhase(phase: Phase): Set[int] =
    s.executions.indices().filter(i => s.executions.nth(i).phase == phase)
  action settleSource(choice: int, index: int, value: int, failed: bool): bool = all {
    pendingSources.contains(index),
    commit(sourceResult(s, index, value, failed),
      { name: if (failed) "rejectLoader" else "resolveLoader", choice: choice })
  }
  action settleRead(index: int, failed: bool): bool = all {
    pendingReads.contains(index),
    commit(readResult(s, index, failed), {
      name: if (failed) "failRead" else "releaseRead",
      choice: index
    })
  }
  action settleLoad(failed: bool): bool = all {
    inPhase(Decoding).size() == 1,
    commit(loadResult(s, firstOwner(inPhase(Decoding)), failed), {
      name: if (failed) "failLoad" else "releaseLoad",
      choice: -1
    })
  }
  action settleDump(failed: bool): bool = all {
    inPhase(Serializing).size() == 1,
    commit(dumpResult(s, firstOwner(inPhase(Serializing)), failed), {
      name: if (failed) "failDump" else "releaseDump",
      choice: -1
    })
  }
  action settleWrite(failed: bool): bool = all {
    inPhase(Writing).size() == 1,
    commit(writeResult(s, firstOwner(inPhase(Writing)), failed), {
      name: if (failed) "failWrite" else "releaseWrite",
      choice: -1
    })
  }
  action tick(deliver: bool): bool = commit(advance(s, deliver), {
    name: if (deliver) "tick" else "jumpClock",
    choice: -1
  })
  action rollbackWall =
    commit({ wall: s.wall - 1000, ...s }, { name: "rollbackWall", choice: -1 })
  action seed(choice: int, key: int, value: int, name: str): bool = commit({
    remote: s.remote.replaceAt(key, Present({ value: value, created: s.wall })),
    ...s
  }, { name: name, choice: choice })
  action invalidate(choice: int, entity: int, buffer: int, name: str): bool = {
    val invalidated = if (not(s.config.remote)) { maintenance: s.maintenance.append("missing_remote"), ...s } else {
      watermarks: s.watermarks.replaceAt(entity, if (s.wall + buffer > s.watermarks.nth(entity)) s.wall + buffer else s.watermarks.nth(entity)),
      counts: { invalidations: s.counts.invalidations + 1, ...s.counts },
      maintenance: s.maintenance.append("ok"), ...metric(s, "invalidation", "", 0)
    }
    commit(invalidated, { name: name, choice: choice })
  }
  action policy(choice: int): bool = commit({ policy: choice, ...s }, { name: "policy", choice: choice })
  action closeScope(choice: int): bool = all {
    not(s.closed.nth(choice)), commit({ closed: s.closed.replaceAt(choice, true),
      memo: s.memo.indices().fold(s.memo, (out, slot) => if (slot / 4 == choice) out.replaceAt(slot, Missing) else out), ...s
    }, { name: "closeScope", choice: choice })
  }

  // Independent state properties use the records directly, not transition helpers.
  // No two registered shared executions serve the same instance and key: the
  // registered executions have as many distinct identities as members.
  val oneRegisteredFlightPerIdentity = {
    val registered = s.executions.select(execution => execution.shared and execution.phase != Finished)
    registered.foldl(Set(), (identities, execution) =>
      identities.union(Set((execution.instance, execution.key)))).size() == registered.length()
  }
  // Acceptance records survive completion, including layers' immediate dump
  // and write. The effect count requires a record for every serialization;
  // checking only active phases would be vacuous in that settlement view.
  // Monotonic time starts above zero; zero is the unused acceptance sentinel.
  val publicationHasTimelySource =
    s.counts.dumps == s.executions.select(execution => execution.acceptedAt > 0).length()
    and s.executions.indices().forall(owner => {
      val execution = s.executions.nth(owner)
      (not(Set(Serializing, Writing).contains(execution.phase)) or execution.acceptedAt > 0)
      and (execution.acceptedAt == 0 or {
        val source = s.sources.nth(execution.source)
        source.status == Settled and source.owner == owner
          and execution.acceptedAt >= execution.sourceStarted
          and (s.config.sourceBudget == 0 or execution.acceptedAt < execution.sourceStarted + s.config.sourceBudget)
          and execution.acceptedWall > execution.fence
      })
    })
  val finishedOwnersHaveFinishedCallers = s.calls.indices().forall(index => {
    val call = s.calls.nth(index)
    val execution = s.executions.nth(call.owner)
    execution.phase != Finished or (call.result != Pending and call.result == execution.result)
  })
  val registeredExecutionsHavePendingCallers = {
    val pendingOwners = s.calls.foldl(Set(), (owners, call) =>
      if (call.result == Pending) owners.union(Set(call.owner)) else owners)
    s.executions.indices().forall(owner =>
      s.executions.nth(owner).phase == Finished or pendingOwners.contains(owner))
  }
  val closedScopesHaveNoMemo = s.memo.indices().forall(slot =>
    not(s.closed.nth(slot / 4)) or s.memo.nth(slot) == Missing)
}

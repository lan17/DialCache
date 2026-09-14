module effects_pilot {
  import kernel_types.* from "./kernel-types"

  // Same lifecycle with externally held adapter effects. This first slice fixes
  // the operation read budget at 10 ms (existing fixtures 2 and 5); adapter
  // classification overrides, live budget changes and observer faults remain
  // in the original effects profile until their migration.
  pure def fixture(choice: int): Config = {
    request: false,
    local: false,
    remote: true,
    tracked: choice != 5,
    capacity: 0,
    sourceBudget: 10,
    readBudget: 10,
    tickMs: 10,
    initialWall: 100000,
    diagnostics: true,
    maxCalls: 8
  }
  pure def effectResult(result: Result): int = match result {
    Pending => 0
    | Value(value) => value
    | SourceError => 2
    | Timeout => 3
  }
  type EffectsView = {
    now: int,
    wall: int,
    readStarted: int,
    decodeStarted: int,
    tracked: int,
    reply: int,
    replyAt: int,
    readBudget: int,
    baseReadBudget: int,
    phase: int,
    activeLoader: int,
    activeRead: int,
    deadline: int,
    refill: int,
    acceptedAt: int,
    acceptedWall: int,
    observerFailed: int,
    readAborts: int,
    observedFence: int,
    writeTimestamp: int,
    storedTimestamp: int,
    watermark: int,
    loaders: int,
    reads: int,
    writes: int,
    invalidations: int,
    loads: int,
    dumps: int,
    policyCalls: int,
    calls: List[int],
    sources: List[int],
    readStates: List[int],
    readBudgets: List[int],
    events: List[Event]
  }
  // The established transport projection; private compatibility fields never
  // drive an implementation or the kernel's transition decisions.
  pure def project(state: State): EffectsView = {
    val execution = if (state.lastExecution < 0) emptyExecution
      else state.executions.nth(state.lastExecution)
    {
      now: state.now,
      wall: state.wall,
      readStarted: execution.readStarted,
      decodeStarted: execution.decodeStarted,
      tracked: if (state.config.tracked) 1 else 0,
      reply: 0,
      replyAt: 0,
      readBudget: state.config.readBudget,
      baseReadBudget: state.config.readBudget,
      phase: phaseCode(execution.phase),
      activeLoader: execution.source,
      activeRead: execution.read,
      deadline: execution.deadline,
      refill: if (execution.refill) 1 else 0,
      acceptedAt: execution.acceptedAt,
      acceptedWall: execution.acceptedWall,
      observerFailed: 0,
      readAborts: state.counts.readAborts,
      observedFence: execution.fence,
      writeTimestamp: execution.writeStamp,
      storedTimestamp: entryStamp(state.remote.nth(0)),
      watermark: state.watermarks.nth(0),
      loaders: state.counts.loaders,
      reads: state.counts.reads,
      writes: state.counts.writes,
      invalidations: state.counts.invalidations,
      loads: state.counts.loads,
      dumps: state.counts.dumps,
      policyCalls: state.counts.policyCalls,
      calls: state.calls.mapList(call => effectResult(call.result)),
      sources: state.sources.mapList(source => rawCode(source.status)),
      readStates: state.reads.mapList(read => rawCode(read.status)),
      readBudgets: state.reads.mapList(read => read.budget),
      events: state.events
    }
  }
  import cache_kernel(
    FIXTURE = fixture,
    PROJECT = project,
    SETTLE = { read: false, load: false, dump: false, write: false }
  ) as K from "./cache-kernel"

  action init = {
    nondet choice = Set(2, 5).oneOf()
    K::initialize(choice)
  }
  action beginCall = K::beginCall(-1, 0, 0, -1)
  action resolveLoader = {
    nondet choice = K::pendingSources.oneOf()
    K::settleSource(choice, choice, 1, false)
  }
  action rejectLoader = {
    nondet choice = K::pendingSources.oneOf()
    K::settleSource(choice, choice, 0, true)
  }
  action releaseRead = {
    nondet choice = K::pendingReads.oneOf()
    K::settleRead(choice, false)
  }
  action failRead = {
    nondet choice = K::pendingReads.oneOf()
    K::settleRead(choice, true)
  }
  action releaseLoad = K::settleLoad(false)
  action failLoad = K::settleLoad(true)
  action releaseDump = K::settleDump(false)
  action failDump = K::settleDump(true)
  action releaseWrite = K::settleWrite(false)
  action failWrite = K::settleWrite(true)
  action tick = K::tick(true)
  action jumpClock = K::tick(false)
  action rollbackWall = K::rollbackWall
  action seedRemote = K::seed(-1, 0, 1, "seedRemote")
  action invalidate = K::invalidate(-1, 0, 0, "invalidate")
  action futureFence = K::invalidate(-1, 0, 20, "futureFence")
  action step = any {
    beginCall,
    releaseRead,
    failRead,
    releaseLoad,
    failLoad,
    resolveLoader,
    rejectLoader,
    releaseDump,
    failDump,
    releaseWrite,
    failWrite,
    tick,
    jumpClock,
    rollbackWall,
    seedRemote,
    invalidate,
    futureFence
  }
  val oneRegisteredFlightPerIdentity = K::oneRegisteredFlightPerIdentity
  val publicationHasTimelySource = K::publicationHasTimelySource
  val finishedOwnersHaveFinishedCallers = K::finishedOwnersHaveFinishedCallers
  val registeredExecutionsHavePendingCallers = K::registeredExecutionsHavePendingCallers
  val closedScopesHaveNoMemo = K::closedScopesHaveNoMemo
}

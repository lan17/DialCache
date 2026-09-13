module layers_pilot {
  import kernel_types.* from "./kernel-types"
  import conformance_observations as Observation from "../conformance-observations"

  // The existing layers input vocabulary, with immediately available adapter
  // completions. Sources remain explicitly settled by external input.
  pure def fixture(choice: int): Config = {
    request: true,
    local: true,
    remote: choice < 4,
    tracked: choice % 2 == 1,
    capacity: if (choice == 2 or choice == 3) 0 else 2,
    sourceBudget: 0,
    readBudget: 10,
    tickMs: 1,
    initialWall: 10000,
    diagnostics: false,
    maxCalls: 20
  }
  pure def project(state: State): { o: Observation::Observation } = {
    o: {
      calls: state.calls.mapList(call => resultCode(call.result)),
      reads: state.counts.reads,
      loaders: state.counts.loaders,
      writes: state.counts.writes,
      invalidations: state.counts.invalidations,
      loads: state.counts.loads,
      dumps: state.counts.dumps,
      policyCalls: state.counts.policyCalls,
      writeTtls: state.writeTtls,
      maintenance: state.maintenance,
      ...Observation::empty
    }
  }
  import cache_kernel(
    FIXTURE = fixture,
    PROJECT = project,
    SETTLE = { read: true, load: true, dump: true, write: true }
  ) as K from "./cache-kernel"

  action init = {
    nondet choice = 0.to(5).oneOf()
    K::initialize(choice)
  }
  action beginCall = {
    nondet choice = 0.to(19).oneOf()
    val context = choice / 4
    K::beginCall(choice, if (context == 2 or context == 4) 1 else 0, choice % 4, context)
  }
  action resolveLoader = {
    nondet choice = 1.to(40).filter(code => K::pendingSources.contains((code - 1) / 2)).oneOf()
    K::settleSource(choice, (choice - 1) / 2, (choice - 1) % 2 + 1, false)
  }
  action rejectLoader = {
    nondet choice = K::pendingSources.oneOf()
    K::settleSource(choice, choice, 0, true)
  }
  action closeScope = {
    nondet choice = 0.to(2).filter(scope => not(K::s.closed.nth(scope))).oneOf()
    K::closeScope(choice)
  }
  action policy = {
    nondet choice = 0.to(5).oneOf()
    K::policy(choice)
  }
  action seed = {
    nondet choice = 0.to(7).oneOf()
    K::seed(choice, choice / 2, choice % 2 + 1, "seed")
  }
  action invalidate = {
    nondet choice = Set(0, 1).oneOf()
    K::invalidate(choice, choice, 0, "invalidate")
  }
  action tick = K::tick(true)
  action step = any {
    beginCall,
    resolveLoader,
    rejectLoader,
    closeScope,
    policy,
    seed,
    invalidate,
    tick
  }
  val oneRegisteredFlightPerIdentity = K::oneRegisteredFlightPerIdentity
  val publicationHasTimelySource = K::publicationHasTimelySource
  val finishedOwnersHaveFinishedCallers = K::finishedOwnersHaveFinishedCallers
  val registeredExecutionsHavePendingCallers = K::registeredExecutionsHavePendingCallers
  val closedScopesHaveNoMemo = K::closedScopesHaveNoMemo
}

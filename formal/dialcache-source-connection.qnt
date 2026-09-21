module dialcache_source_connection {
  import dialcache_source_budgets_conformance as profile from "./dialcache-source-budgets-conformance"
  import conformance_observations.* from "./conformance-observations"
  import cache_contract.* from "./cache-contract"
  import policy_gate as Gate from "./kernel/policy-gate"
  import deadlines as Deadlines from "./kernel/deadlines"

  // The actual source-budgets transitions are the only executing machine.
  // Project each source-start event into an immutable reference record using
  // the preceding external clock and call/policy ownership, not the library's
  // started, budgets or deadline records. This checks that their abstraction
  // preserves source-relative time (the recorded origin and, while a bounded
  // source is pending, the instant its deadline is due), owners and accepted
  // outcomes on each step.
  var sources: List[SourceExecution]
  var before: { now: int, calls: int, held: List[Gate::Held], registered: int, budget: int }

  action clearMonitor = all {
    sources' = List(),
    before' = { now: 0, calls: 0, held: List(), registered: -1, budget: 0 }
  }

  action init = all { profile::init, clearMonitor }
  // An exact fixture for the ownership receipt below; outside calls ignore
  // this finite budget, but it removes initialization choice from the run.
  action initFinite = all { profile::initialize(profile::FINITE_BUDGET_MODE), clearMonitor }

  val startedOwner = if (profile::input.name == "releasePolicy")
    Gate::entry(before, profile::input.choice).caller else before.calls
  val startedOutside = profile::input.name == "beginCall" and
    (profile::input.choice == profile::OUTSIDE or profile::input.choice == profile::OUTSIDE_INVALID_KEY)
  val observedSources = if (profile::s.o.loaders > sources.length())
    sources.append(captureSource(startedOwner, before.now,
      if (startedOutside) -1 else before.budget)) else sources

  action recordBefore = all {
    sources' = observedSources,
    before' = { now: profile::s.now, calls: profile::s.o.calls.length(),
      held: profile::s.held, registered: profile::s.processFlights.nth(0), budget: profile::s.sourceBudget }
  }
  action step = all { recordBefore, profile::step }
  action beginOutside = all { recordBefore, profile::begin(profile::OUTSIDE) }

  val sourceOriginsMatchContract = observedSources.length() == profile::s.sources.length() and
    observedSources.indices().forall(index => {
      val reference = observedSources.nth(index)
      profile::s.started.nth(index) == reference.started and profile::s.budgets.nth(index) == reference.budget and
        (profile::s.sources.nth(index).result != CALL_PENDING or reference.budget < 0 or
          Deadlines::deadlineOf(profile::s, Deadlines::SOURCE, index) == reference.started + reference.budget)
    })
  val sourceOwnersMatchContract = observedSources.indices().forall(index => {
    val reference = observedSources.nth(index)
    profile::s.owners.nth(reference.owner) == index
  })
  val acceptedSourcesMatchContract = observedSources.indices().forall(index => {
    val actual = profile::s.sources.nth(index)
    val reference = observedSources.nth(index)
    actual.result != VALUE_ONE and actual.result != VALUE_TWO or
      sourceReturnAllowed(reference, reference.owner, profile::s.settledAt.nth(index))
  })
  val followerKeepsAcquiredOwner = profile::input.name != "releasePolicy" or before.registered < 0 or
    profile::s.owners.nth(Gate::entry(before, profile::input.choice).caller) == before.registered

  // The monitor records caller identity from the external admission count,
  // independently of registerSource's owners table. Source one must belong
  // to the second outside caller even though no sharing registry is used.
  run outsideSourcesKeepDistinctOwnersTest = initFinite
    .then(beginOutside).then(beginOutside)
    .expect(sourceOwnersMatchContract and observedSources.length() == 2)
}

// The budgeted held remote lifecycle with a read settled in the step that
// admits the caller (deadlines::beginRead) and the
// diagnosed variants of that lifecycle (diagnostics): one key, one instance,
// two persistent contexts, immediate replies, decodes and loaders held.
// Pins the seams the recovery profile reaches only through its own fixtures
// and the ones it never reaches: a memo hit dispatches no read and records
// nothing; a fresh frame holds a decode and starts no loader; a stale frame
// retains its snapshot and starts the loader under the source budget; a
// follower joining the flight records the singleflight it coalesced into
// (the process registry, then the request registry of a scope that joined
// before); a failed loader is attributed to the remote layer once, a late
// result that drains records nothing, a deadline delivered inside an advance
// records the same; a served recovery decode samples the candidate's age at
// the settlement's wall clock; a source a release starts without the remote
// layer is attributed to the request memo or the shared layers' fallback, a
// bypass source started at admission to no layer; every ordinal maps to its flight.
module held_diagnostics {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_io as RemoteIO from "../../../formal/kernel/remote-io"
  import recovery as Recovery from "../../../formal/kernel/recovery"
  import deadlines as Deadlines from "../../../formal/kernel/deadlines"
  import diagnostics as Diagnostics from "../../../formal/kernel/diagnostics"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import clock as Clock from "../../../formal/kernel/clock"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true }
  pure val SHARED: Resolution = { layers: { request: true, local: false, remote: true }, coalesce: true }
  pure val PROCESS_ONLY: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: true }
  pure val LOCAL_ALONE: Resolution = { layers: { request: true, local: true, remote: false }, coalesce: true }
  pure val TTLS: Ttls = { localMs: 0, freshMs: 1000, retentionMs: 5000 }
  pure val LOCAL_TTLS: Ttls = { localMs: 1000, freshMs: 1000, retentionMs: 5000 }
  pure val SOURCE_BUDGET = 10
  pure def call(context: int): Call = { instance: 0, key: 0, context: context, enabled: true, keyFailed: false }
  pure def bypass: Call = { instance: 0, key: 0, context: 0, enabled: false, keyFailed: false }

  type State = {
    o: Observation, d: Diagnostics, io: RemoteIO::IO, now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    sourceBudget: int, deadlines: List[Deadlines::Due], drained: List[bool], sourceLayers: List[str]
  }
  var s: State
  var input: { name: str, choice: int }

  // A stale frame (age 1000 at freshness 1000) above the zero watermark.
  action init = all {
    s' = {
      o: empty, d: noDiagnostics, io: RemoteIO::NO_IO, now: 0, skew: 100000, remoteAvailable: true, tracked: true, capacity: 1,
      readFailed: false, dumpFailed: false, writeFailed: false,
      closed: List(false, false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER),
      localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
      remoteValues: List(VALUE_ONE), created: List(99000), expires: List(60000), watermark: List(0),
      sources: List(), owners: List(), memoSlots: List(), held: List(),
      reads: List(), loads: List(), loaders: List(), retained: List(),
      sourceBudget: SOURCE_BUDGET, deadlines: List(), drained: List(), sourceLayers: List()
    },
    input' = { name: "init", choice: -1 }
  }
  // Every flight has a layer and every ordinal a flight, after every step.
  val consistent = s.sourceLayers.length() == s.sources.length() and s.loaders.length() == s.o.loaders and s.reads.length() == 0

  action beginWith(context: int, resolved: Resolution, ttls: Ttls, classifier: int): bool = all {
    s' = Diagnostics::beginRead(s, LAYOUT, call(context), resolved, ttls, Deadlines::UNBOUNDED, classifier),
    input' = { name: "beginCall", choice: context }
  }.expect(consistent)
  action begin(context: int): bool = beginWith(context, SHARED, TTLS, Recovery::ALLOW)
  action beginBypass = all {
    s' = Diagnostics::beginRead(s, LAYOUT, bypass, SHARED, TTLS, Deadlines::UNBOUNDED, Recovery::ALLOW),
    input' = { name: "beginCall", choice: -1 }
  }.expect(consistent)
  // The plain budgeted form, without the channel: the same lifecycle.
  action beginPlain(context: int): bool = all {
    s' = Deadlines::beginRead(s, LAYOUT, call(context), SHARED, TTLS, Deadlines::UNBOUNDED, Recovery::ALLOW),
    input' = { name: "beginCall", choice: context }
  }
  action load(failed: bool): bool = all {
    s' = Diagnostics::settleLoad(s, LAYOUT, RemoteIO::latestLoad(s).load, failed),
    input' = { name: "releaseLoad", choice: -1 }
  }.expect(consistent)
  action settle(ordinal: int, value: int): bool = all {
    s' = Diagnostics::settleLoader(s, LAYOUT, ordinal, value, false),
    input' = { name: "resolveLoader", choice: ordinal }
  }.expect(consistent)
  action advance(ms: int): bool = all { s' = Diagnostics::advance(s, LAYOUT, ms), input' = { name: "advance", choice: ms } }.expect(consistent)
  action seedFresh = all { s' = Remote::seedAged(s, 0, VALUE_ONE, 0, 60000), input' = { name: "seed", choice: 0 } }
  action closeScope(context: int): bool = all { s' = Serving::closeScope(s, LAYOUT, context), input' = { name: "closeScope", choice: context } }
  action rollback(ms: int): bool = all { s' = Clock::shiftWall(s, -ms), input' = { name: "rollbackWall", choice: ms } }

  // The read is counted, settled and gone in one step: a stale frame retains
  // its snapshot and starts the loader with its deadline at now + budget.
  run staleReadRetainsAndStartsTheLoaderAtOnceTest = init.then(begin(0))
    .expect(s.o.reads == 1 and s.reads == List() and s.o.loaders == 1 and s.o.loads == 0
      and s.retained.length() == 1 and s.retained.nth(0).candidate == VALUE_ONE and s.retained.nth(0).created == 99000
      and Deadlines::deadlineOf(s, Deadlines::SOURCE, 0) == SOURCE_BUDGET and s.sourceLayers == List("remote") and s.d.coalesced == List())
  // A fresh frame holds its decode and starts no loader; the decode completes
  // the caller without a recovery label or an age.
  run freshReadHoldsADecodeTest = init.then(seedFresh).then(begin(0))
    .expect(s.o.reads == 1 and s.o.loads == 1 and s.o.loaders == 0 and s.retained == List())
    .then(load(false)).expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List() and s.d.ages == List())
  // A memo hit dispatches no read and records nothing.
  run memoHitDispatchesNoReadTest = init.then(seedFresh).then(begin(0)).then(load(false)).then(begin(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1 and s.d.coalesced == List() and s.sourceLayers == List("remote"))
  // A follower from another scope joins the process flight and records it; a
  // follower from a scope that already joined records the request flight.
  run followersRecordTheSingleflightTheyJoinedTest = init.then(begin(0)).then(begin(1)).then(begin(0)).then(begin(1))
    .expect(s.o.reads == 1 and s.o.calls == List(CALL_PENDING, CALL_PENDING, CALL_PENDING, CALL_PENDING)
      and s.d.coalesced == List("process", "request_local", "request_local"))
  // Without the request layer every follower records the process flight.
  run processOnlyFollowersRecordTheProcessFlightTest = init.then(beginWith(0, PROCESS_ONLY, TTLS, Recovery::ALLOW))
    .then(beginWith(0, PROCESS_ONLY, TTLS, Recovery::ALLOW)).then(beginWith(1, PROCESS_ONLY, TTLS, Recovery::ALLOW))
    .expect(s.d.coalesced == List("process", "process") and s.memoSlots == List(NO_OWNER, NO_OWNER, NO_OWNER))
  // A failed loader is attributed to the remote layer once; the recovery
  // decode it holds serves and samples the candidate's age at that wall clock.
  run failedLoaderIsAttributedOnceAndTheRecoveryAgeIsSampledTest = init.then(begin(0)).then(settle(0, SOURCE_ERROR))
    .expect(s.d.fallbackErrors == List("remote") and s.o.loads == 1 and s.o.calls == List(CALL_PENDING))
    .then(rollback(500)).then(load(false))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.d.ages == List(500) and s.d.fallbackErrors == List("remote"))
  // A missed recovery decode samples no age; a failed one neither.
  run missedRecoverySamplesNoAgeTest = init.then(begin(0)).then(settle(0, SOURCE_ERROR)).then(advance(4000)).then(load(false))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.recovery == List("miss") and s.d.ages == List())
  run failedRecoveryDecodeSamplesNoAgeTest = init.then(begin(0)).then(settle(0, SOURCE_ERROR)).then(load(true))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.recovery == List("deserialization_error") and s.d.ages == List())
  // A deadline delivered inside an advance attributes the failure like a
  // rejection; the late result then drains and records nothing more.
  run deliveredDeadlineIsAttributedOnceTest = init.then(begin(0)).then(advance(10))
    .expect(s.o.loads == 1 and s.d.fallbackErrors == List("remote"))
    .then(settle(0, VALUE_TWO))
    .expect(s.d.fallbackErrors == List("remote") and s.o.writes == 0 and Deadlines::pending(s, 0) == false)
    .then(load(false)).expect(s.o.calls == List(VALUE_ONE) and s.d.ages == List(1010))
  // An accepted settlement records no fallback error.
  run acceptedSettlementRecordsNoErrorTest = init.then(begin(0)).then(settle(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 1 and s.d.fallbackErrors == List())
  // A source a release starts without the remote layer is attributed to the
  // request memo when the call memoizes; its failure names that layer.
  run sourceWithoutRemoteLayerIsAttributedToTheRequestMemoTest = init.then(beginWith(0, LOCAL_ALONE, LOCAL_TTLS, Recovery::ALLOW))
    .expect(s.o.reads == 0 and s.o.loaders == 1 and s.sourceLayers == List("request_local"))
    .then(settle(0, SOURCE_ERROR)).expect(s.d.fallbackErrors == List("request_local") and s.o.classifications == 0)
  // A bypass source started at admission has no layer and its failure records none.
  run bypassSourceRecordsNoLayerTest = init.then(beginBypass)
    .expect(s.o.loaders == 1 and s.sourceLayers == List("") and s.o.policyCalls == 0)
    .then(settle(0, SOURCE_ERROR)).expect(s.o.calls == List(SOURCE_ERROR) and s.d.fallbackErrors == List())
  // A failed fresh decode restarts the loader; its later failure is
  // attributed to the remote layer and, without a snapshot, unclassified.
  run failedFreshDecodeRestartsAnAttributedLoaderTest = init.then(seedFresh).then(begin(0)).then(load(true))
    .expect(s.o.loaders == 1 and s.o.loads == 1 and s.sourceLayers == List("remote"))
    .then(settle(0, SOURCE_ERROR))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.d.fallbackErrors == List("remote") and s.o.classifications == 0 and s.o.recovery == List())
  // A read that fails observes nothing: no snapshot, the loader is
  // attributed to the remote layer all the same, its failure unclassified.
  run failedReadIsStillAttributedToTheRemoteLayerTest = init.then(all { s' = { readFailed: true, ...s }, input' = { name: "readFault", choice: 1 } })
    .then(begin(0)).expect(s.o.reads == 1 and s.retained == List() and s.sourceLayers == List("remote"))
    .then(settle(0, SOURCE_ERROR)).expect(s.o.calls == List(SOURCE_ERROR) and s.d.fallbackErrors == List("remote") and s.o.classifications == 0)
  // The plain budgeted form behaves as the diagnosed one, without the channel.
  run plainBeginReadMatchesTheDiagnosedLifecycleTest = init.then(beginPlain(0))
    .expect(s.o.reads == 1 and s.reads == List() and s.o.loaders == 1 and s.retained.length() == 1
      and Deadlines::deadlineOf(s, Deadlines::SOURCE, 0) == SOURCE_BUDGET and s.d == noDiagnostics and s.sourceLayers == List())
  // A closed scope's follower joins nothing: the bypass source it starts at
  // admission is attributed to no layer.
  run closedScopeCallerStartsAnUnattributedSourceTest = init.then(closeScope(0)).then(begin(0))
    .expect(s.o.reads == 0 and s.o.loaders == 1 and s.sourceLayers == List(""))
}

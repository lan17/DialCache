// The shadow job registry (shadow) over the atomic remote lifecycle with held
// writes and atomic stale-on-error (remote_writes): one instance, two keys, one
// persistent context, one job slot, replies immediate. Pins the seams the
// shadow-layers profile excludes or cannot reach: a failed source recovering
// at once from the candidate its atomic read retained (the decode counted, the
// value served, `served`), a miss reported without a candidate, DENY never
// recovering; a caller's held dump fenced by a wall rollback completing the
// caller without a write; a dark job's fill carrying the fence its C0 read
// observed (C58) and ending `fill_fenced` under a watermark the wall does not
// clear, at settlement before any dump and again at dump release after a wall
// rollback; a dark C0 read that fails ending `redis_error` with nothing filled
// and a confirmation read that fails ending `confirmation_error`; a scope
// closed between admission and release admitting no job; a dump released
// after the job's budget dispatching no write while a write released after it
// still stores; a detached source owning nobody.
module shadow_jobs {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import remote_writes as Writes from "../../../formal/kernel/remote-writes"
  import shadow as Shadow from "../../../formal/kernel/shadow"
  import deadlines as Deadlines from "../../../formal/kernel/deadlines"
  import recovery as Recovery from "../../../formal/kernel/recovery"
  import flights as Flights from "../../../formal/kernel/flights"
  import clock as Clock from "../../../formal/kernel/clock"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 2, keysPerScope: 2, persistentContexts: 1, operationsPerEntity: 1, probeSourceScope: true }
  pure val SERVING: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: false }
  pure val DARK: Resolution = { layers: { request: false, local: false, remote: false }, coalesce: false }
  pure val TTLS: Ttls = { localMs: 0, freshMs: 1000, retentionMs: 5000 }
  pure val SHADOWING: Shadow::Shadowing = { selected: true, capacity: 1, budgetMs: 100 }
  pure val UNSELECTED: Shadow::Shadowing = { selected: false, capacity: 1, budgetMs: 100 }
  pure def call(key: int): Call = { instance: 0, key: key, context: 1, enabled: true, keyFailed: false }
  // A call inside the one persistent scope, the scope a run can close.
  pure def scopedCall(key: int): Call = { instance: 0, key: key, context: 0, enabled: true, keyFailed: false }

  type State = {
    o: Observation, now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite], retained: List[Recovery::Snapshot],
    jobs: List[Shadow::Job], deadlines: List[Deadlines::Due]
  }
  var s: State
  var input: { name: str, choice: int }

  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty, now: 0, skew: 100000, remoteAvailable: true, tracked: true, capacity: 0,
      readFailed: false, dumpFailed: false, writeFailed: false,
      closed: List(false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER, NO_OWNER),
      localValues: List(NO_VALUE, NO_VALUE), localExpires: List(0, 0), lru: List(List()),
      remoteValues: List(NO_VALUE, NO_VALUE), created: List(0, 0), expires: List(0, 0), watermark: List(0, 0),
      sources: List(), owners: List(), memoSlots: List(), held: List(),
      dumps: List(), writes: List(), retained: List(), jobs: List(), deadlines: List()
    }
  }
  action beginWith(key: int, resolved: Resolution, classifier: int, shadowing: Shadow::Shadowing): bool = all {
    input' = { name: "beginCall", choice: key },
    s' = Shadow::begin(s, LAYOUT, call(key), resolved, TTLS, classifier, shadowing)
  }
  action resolve(source: int, value: int): bool = all {
    input' = { name: "resolveLoader", choice: source }, s' = Shadow::settle(s, LAYOUT, source, value, false)
  }
  action reject(source: int): bool = all {
    input' = { name: "rejectLoader", choice: source }, s' = Shadow::settle(s, LAYOUT, source, SOURCE_ERROR, false)
  }
  action releaseDump(dump: int): bool = all { input' = { name: "releaseDump", choice: dump }, s' = Shadow::releaseDump(s, LAYOUT, dump, false) }
  action releaseWrite(write: int): bool = all { input' = { name: "releaseWrite", choice: write }, s' = Shadow::releaseWrite(s, LAYOUT, write, false) }
  action failDump(dump: int): bool = all { input' = { name: "failDump", choice: dump }, s' = Shadow::releaseDump(s, LAYOUT, dump, true) }
  action failWrite(write: int): bool = all { input' = { name: "failWrite", choice: write }, s' = Shadow::releaseWrite(s, LAYOUT, write, true) }
  // The adapter's read fault, in force for every read until switched off.
  action readFault(failed: bool): bool = all { input' = { name: "readFault", choice: if (failed) 1 else 0 }, s' = { readFailed: failed, ...s } }
  // A policy reply the drivers hold: admission alone, then the release by its
  // policy call, with the scope closed in between.
  action admitHeld(key: int): bool = all { input' = { name: "beginCall", choice: key }, s' = Serving::admit(s, LAYOUT, scopedCall(key)) }
  action releaseHeld(policyCall: int, resolved: Resolution): bool = all {
    input' = { name: "releasePolicy", choice: policyCall },
    s' = Shadow::release(s, LAYOUT, policyCall, resolved, TTLS, Recovery::ALLOW, SHADOWING)
  }
  action closeScope(context: int): bool = all { input' = { name: "closeScope", choice: context }, s' = Serving::closeScope(s, LAYOUT, context) }
  // A reply whose retention exceeds the tracked cap.
  pure val LONG_TTLS: Ttls = { localMs: 0, freshMs: 1000, retentionMs: Remote::TRACKED_RETENTION_CAP_MS * 2 }
  action beginLong(key: int, resolved: Resolution, shadowing: Shadow::Shadowing): bool = all {
    input' = { name: "beginCall", choice: key },
    s' = Shadow::begin(s, LAYOUT, call(key), resolved, LONG_TTLS, Recovery::ALLOW, shadowing)
  }
  action advanceBy(ms: int): bool = all { input' = { name: "advance", choice: ms }, s' = Shadow::advance(s, ms) }
  action seedAged(key: int, value: int, age: int): bool = all {
    input' = { name: "seed", choice: key }, s' = Remote::seedAged(s, key, value, age, 60000)
  }
  action invalidate(entity: int): bool = all { input' = { name: "invalidate", choice: entity }, s' = Serving::invalidate(s, entity) }
  action rollback(ms: int): bool = all { input' = { name: "rollback", choice: ms }, s' = Clock::shiftWall(s, -ms) }
  action step = any { beginWith(0, DARK, Recovery::ALLOW, SHADOWING), resolve(0, VALUE_ONE), advanceBy(1) }

  // A visible frame past the reply's freshness is retained at the atomic read
  // and served when the source fails: classified once, decoded once, `served`.
  run atomicRecoveryServesARetainedCandidateTest = init.then(seedAged(0, VALUE_ONE, 2000))
    .then(beginWith(0, SERVING, Recovery::ALLOW, UNSELECTED))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.loads == 0 and s.retained.length() == 1)
    .then(reject(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.classifications == 1 and s.o.recovery == List("served")
      and s.o.loads == 1 and s.o.dumps == 0 and s.retained == List())
  run atomicRecoveryWithoutACandidateReportsAMissTest = init
    .then(beginWith(0, SERVING, Recovery::ALLOW, UNSELECTED)).then(reject(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 1 and s.o.recovery == List("miss") and s.o.loads == 0)
  run deniedClassifierNeverRecoversTest = init.then(seedAged(0, VALUE_ONE, 2000))
    .then(beginWith(0, SERVING, Recovery::DENY, UNSELECTED)).then(reject(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 1 and s.o.recovery == List() and s.o.loads == 0)
  run noClassifierRetainsNothingTest = init.then(seedAged(0, VALUE_ONE, 2000))
    .then(beginWith(0, SERVING, Recovery::NONE, UNSELECTED)).expect(s.retained == List())
    .then(reject(0)).expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 0 and s.o.recovery == List())
  // A caller's refill: the dump held at settlement, the write dispatched at
  // its release with the retention captured and stamped then, the frame
  // stored and the caller completed at the write's release.
  run heldRefillCompletesTheCallerAtItsWriteTest = init
    .then(beginWith(0, SERVING, Recovery::ALLOW, UNSELECTED)).then(resolve(0, VALUE_TWO))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.dumps == 1 and s.o.writes == 0 and Writes::holdsDump(s, 0))
    .then(advanceBy(7)).then(releaseDump(0))
    .expect(s.o.writes == 1 and s.o.writeTtls == List(5000) and Writes::holdsWrite(s, 0) and s.writes.nth(0).stamp == 100007)
    .then(releaseWrite(0))
    .expect(s.o.calls == List(VALUE_TWO) and s.remoteValues == List(VALUE_TWO, NO_VALUE) and s.created == List(100007, 0)
      and s.expires == List(5007, 0) and s.writes == List())
  // A wall rollback below the fence the miss observed stops the write at the
  // dump's release; the caller completes with its value all the same.
  run rolledBackWallFencesAHeldDumpTest = init.then(invalidate(0)).then(advanceBy(1))
    .then(beginWith(0, SERVING, Recovery::ALLOW, UNSELECTED))
    .expect(s.sources.nth(0).fence == 100000)
    .then(resolve(0, VALUE_ONE)).expect(s.o.dumps == 1 and s.o.calls == List(CALL_PENDING))
    .then(rollback(1)).then(releaseDump(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.writes == 0 and s.dumps == List() and s.remoteValues == List(NO_VALUE, NO_VALUE))
  // A dark job's fill carries the fence its C0 read observed: under a
  // watermark the wall does not yet clear the fill is fenced at settlement,
  // before it serializes: no dump, no write, `fill_fenced` at once.
  run darkFillCarriesTheC0FenceTest = init.then(invalidate(0))
    .then(beginWith(0, DARK, Recovery::ALLOW, SHADOWING))
    .expect(s.o.reads == 1 and s.jobs.length() == 1 and s.jobs.nth(0).fence == 100000 and s.sources.nth(0).fence == NO_FENCE)
    .then(resolve(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.o.writes == 0 and s.dumps == List()
      and s.o.shadow == List("fill_fenced") and s.jobs.nth(0).phase == Shadow::FINISHED)
  // The fence is judged again when the dump is released: a wall rollback below
  // the watermark between settlement and release fences the write.
  run rolledBackWallFencesADarkFillAtDumpReleaseTest = init.then(invalidate(0)).then(advanceBy(1))
    .then(beginWith(0, DARK, Recovery::ALLOW, SHADOWING)).then(resolve(0, VALUE_ONE))
    .expect(s.o.dumps == 1 and s.jobs.nth(0).phase == Shadow::SERIALIZING)
    .then(rollback(1)).then(releaseDump(0))
    .expect(s.o.writes == 0 and s.o.shadow == List("fill_fenced") and s.jobs.nth(0).phase == Shadow::FINISHED and s.dumps == List())
  // The same fill a millisecond later clears the watermark and writes.
  run darkFillClearsTheWatermarkAfterItTest = init.then(invalidate(0)).then(advanceBy(1))
    .then(beginWith(0, DARK, Recovery::ALLOW, SHADOWING)).then(resolve(0, VALUE_ONE)).then(releaseDump(0))
    .expect(s.o.writes == 1 and s.o.shadow == List())
    .then(releaseWrite(0)).expect(s.o.shadow == List("filled") and s.remoteValues == List(VALUE_ONE, NO_VALUE))
  // A dump released after the job's budget dispatches no write; a write
  // released after it still stores; neither adds a label after `timeout`.
  run dumpReleasedAfterTheBudgetDispatchesNoWriteTest = init
    .then(beginWith(0, DARK, Recovery::ALLOW, SHADOWING)).then(resolve(0, VALUE_ONE))
    .expect(s.o.dumps == 1 and s.jobs.nth(0).phase == Shadow::SERIALIZING)
    .then(advanceBy(100)).expect(s.o.shadow == List("timeout") and s.jobs.nth(0).timedOut and s.deadlines == List())
    .then(releaseDump(0))
    .expect(s.o.writes == 0 and s.o.shadow == List("timeout") and s.jobs.nth(0).phase == Shadow::FINISHED and s.dumps == List())
  run writeReleasedAfterTheBudgetStillStoresTest = init
    .then(beginWith(0, DARK, Recovery::ALLOW, SHADOWING)).then(resolve(0, VALUE_ONE)).then(releaseDump(0))
    .expect(s.o.writes == 1 and s.jobs.nth(0).phase == Shadow::WRITING)
    .then(advanceBy(100)).expect(s.o.shadow == List("timeout"))
    .then(releaseWrite(0))
    .expect(s.remoteValues == List(VALUE_ONE, NO_VALUE) and s.o.shadow == List("timeout") and s.jobs.nth(0).phase == Shadow::FINISHED)
  // A dump fault along a caller's held refill dispatches no write and completes
  // the caller; a write fault stores nothing and completes it all the same.
  run heldRefillDumpFaultCompletesWithoutWriteTest = init
    .then(beginWith(0, SERVING, Recovery::ALLOW, UNSELECTED)).then(resolve(0, VALUE_TWO)).then(failDump(0))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.dumps == 1 and s.o.writes == 0 and s.dumps == List() and s.remoteValues == List(NO_VALUE, NO_VALUE))
  run heldRefillWriteFaultStoresNothingTest = init
    .then(beginWith(0, SERVING, Recovery::ALLOW, UNSELECTED)).then(resolve(0, VALUE_TWO)).then(releaseDump(0)).then(failWrite(0))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 1 and s.writes == List() and s.remoteValues == List(NO_VALUE, NO_VALUE))
  // A dark fill whose dump or write fails ends `fill_error` with nothing written.
  run darkFillDumpFaultEndsFillErrorTest = init
    .then(beginWith(0, DARK, Recovery::ALLOW, SHADOWING)).then(resolve(0, VALUE_ONE)).then(failDump(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.writes == 0 and s.o.shadow == List("fill_error") and s.jobs.nth(0).phase == Shadow::FINISHED and s.dumps == List())
  run darkFillWriteFaultEndsFillErrorTest = init
    .then(beginWith(0, DARK, Recovery::ALLOW, SHADOWING)).then(resolve(0, VALUE_ONE)).then(releaseDump(0)).then(failWrite(0))
    .expect(s.o.writes == 1 and s.o.shadow == List("fill_error") and s.remoteValues == List(NO_VALUE, NO_VALUE) and s.writes == List())
  // A dark C0 read that fails ends the job at once: the read counted, no fill
  // authority captured, no budget pending, the slot released (the next same-key
  // dark job is admitted), the caller's source running on to complete it alone.
  run failedDarkC0ReadEndsRedisErrorTest = init.then(readFault(true))
    .then(beginWith(0, DARK, Recovery::ALLOW, SHADOWING))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.reads == 1 and s.o.shadow == List("redis_error")
      and s.jobs.length() == 1 and s.jobs.nth(0).phase == Shadow::FINISHED and s.jobs.nth(0).retentionMs == 0
      and s.jobs.nth(0).fence == NO_FENCE and s.deadlines == List() and Shadow::liveJobs(s) == Set())
    .then(readFault(false)).then(beginWith(0, DARK, Recovery::ALLOW, SHADOWING))
    .expect(s.o.reads == 2 and s.jobs.length() == 2 and Shadow::liveJobs(s) == Set(1) and s.o.shadow == List("redis_error"))
    .then(resolve(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.dumps == 0 and s.o.writes == 0 and s.o.shadow == List("redis_error"))
  // A confirmation read that fails ends `confirmation_error`: the decode and
  // the read counted, no verdict on the bytes, nothing written.
  run failedConfirmationReadEndsConfirmationErrorTest = init.then(seedAged(0, VALUE_ONE, 0))
    .then(beginWith(0, DARK, Recovery::ALLOW, SHADOWING))
    .expect(s.o.reads == 1 and s.jobs.nth(0).cached == VALUE_ONE)
    .then(readFault(true)).then(resolve(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loads == 1 and s.o.reads == 2 and s.o.dumps == 0
      and s.o.shadow == List("confirmation_error") and s.jobs.nth(0).phase == Shadow::FINISHED)
  // A scope closed between admission and release resolves to the bypass
  // reply: the caller's own unshared source, no job, no read, no label.
  run closedScopeReleaseAdmitsNoJobTest = init.then(admitHeld(0))
    .expect(s.o.policyCalls == 1 and s.o.loaders == 0)
    .then(closeScope(0)).then(releaseHeld(0, DARK))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.loaders == 1 and s.o.reads == 0 and s.jobs == List() and s.o.shadow == List())
    .then(resolve(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 0 and s.jobs == List())
  // A job's fill authority is a tracked flight's: a retention above the cap is
  // captured capped and the fill is written with the cap (C18 through
  // `serving::authority`, one statement for callers and jobs).
  run darkFillRetentionIsCappedForATrackedWriteTest = init
    .then(beginLong(0, DARK, SHADOWING))
    .expect(s.jobs.nth(0).retentionMs == Remote::TRACKED_RETENTION_CAP_MS and s.sources.nth(0).retentionMs == 0)
    .then(resolve(0, VALUE_ONE)).then(releaseDump(0))
    .expect(s.o.writeTtls == List(Remote::TRACKED_RETENTION_CAP_MS) and s.writes.nth(0).retentionMs == Remote::TRACKED_RETENTION_CAP_MS)
  // A served job's detached source owns nobody, publishes nothing, is probed
  // as not participating; its settlement ends the job and completes no caller.
  run servedJobsDetachedSourceCompletesNobodyTest = init.then(seedAged(0, VALUE_ONE, 0))
    .then(beginWith(0, SERVING, Recovery::ALLOW, SHADOWING))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 1 and s.o.sourceScopes == List(false)
      and Flights::ownedBy(s, 0) == Set() and s.sources.nth(0).retentionMs == 0 and s.jobs.nth(0).cached == VALUE_ONE)
    .then(resolve(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.shadow == List("mismatch") and s.o.loads == 2 and s.o.reads == 2 and s.o.dumps == 0)
  // A budget delivered inside an advance is delivered at its own instant, in
  // registration order, before the clock reaches the target.
  run budgetsDeliverInRegistrationOrderTest = init
    .then(beginWith(0, DARK, Recovery::ALLOW, { selected: true, capacity: 2, budgetMs: 100 })).then(advanceBy(10))
    .then(beginWith(1, DARK, Recovery::ALLOW, { selected: true, capacity: 2, budgetMs: 100 }))
    .expect(s.deadlines.length() == 2)
    .then(advanceBy(1000))
    .expect(s.o.shadow == List("timeout", "timeout") and s.now == 1010 and s.deadlines == List()
      and s.jobs.nth(0).phase == Shadow::FINISHED and s.jobs.nth(1).phase == Shadow::FINISHED and s.o.calls == List(CALL_PENDING, CALL_PENDING))
}

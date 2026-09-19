// The served job registry (shadow) over the held remote lifecycle
// (remote_io): one instance, two keys, no persistent context, one job slot,
// replies immediate unless a run holds one, reads and decodes held and
// released by index, loaders settled by ordinal. Pins the seams the admission
// profile reaches only through its own fixtures or cannot reach: the cohort
// selection captured when the caller's read is dispatched and consulted when
// its decode completes the hit, so a policy change in between neither revokes
// nor grants an admission; a selection forgotten when the read settles
// without a decode (a miss) or the decode fails (the loader restarts), so the
// flight's later completion admits nothing; a held policy reply released
// capturing the selection the same way; the job's decode held when its source
// settles and its confirmation read held when the decode disagrees, each
// counted and released by the drivers' index (the read budgeted on the io
// channel like every held read); `match` without a read when the C0 agrees;
// `mismatch` when the confirmation read finds the C0 bytes, `superseded` when
// a seed replaced them; `confirmation_error` when that read fails and
// `deserialization_error` when the job's decode fails; a timed-out served
// job ending silently at whichever step finds it so while its slot stays
// owned until then; the one slot dropping a second key's hit while a job is
// live and readmitting once it finished.
module held_shadow {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import remote_io as RemoteIO from "../../../formal/kernel/remote-io"
  import remote_writes as Writes from "../../../formal/kernel/remote-writes"
  import shadow as Shadow from "../../../formal/kernel/shadow"
  import deadlines as Deadlines from "../../../formal/kernel/deadlines"
  import recovery as Recovery from "../../../formal/kernel/recovery"
  import remote_frames as Remote from "../../../formal/kernel/remote-frames"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val LAYOUT: Serving::Layout = { keysPerInstance: 2, keysPerScope: 2, persistentContexts: 1, operationsPerEntity: 1, probeSourceScope: true, policyProvider: true }
  pure val REMOTE: Resolution = { layers: { request: false, local: false, remote: true }, coalesce: true }
  pure val TTLS: Ttls = { localMs: 0, freshMs: 1000, retentionMs: 5000 }
  pure val SHADOWING: Shadow::Shadowing = { hook: true, selected: true, capacity: 1, budgetMs: 100, logging: false }
  pure val READ_BUDGET = 50
  pure def call(key: int): Call = { instance: 0, key: key, context: 1, enabled: true, keyFailed: false }
  // A call inside the one persistent scope, the one a run can hold a reply for.
  pure def scopedCall(key: int): Call = { instance: 0, key: key, context: 0, enabled: true, keyFailed: false }

  type State = {
    o: Observation, io: RemoteIO::IO, now: int, skew: int, remoteAvailable: bool, tracked: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    dumps: List[Writes::HeldDump], writes: List[Writes::HeldWrite],
    jobs: List[Shadow::Job], deadlines: List[Deadlines::Due], selected: List[int]
  }
  var s: State
  var input: { name: str, choice: int }

  // Key 0 holds a fresh value 1; key 1 holds nothing.
  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty, io: RemoteIO::NO_IO, now: 0, skew: 100000, remoteAvailable: true, tracked: true, capacity: 0,
      readFailed: false, dumpFailed: false, writeFailed: false,
      closed: List(false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER, NO_OWNER),
      localValues: List(), localExpires: List(), lru: List(List()),
      remoteValues: List(VALUE_ONE, NO_VALUE), created: List(100000, 0), expires: List(5000, 0), watermark: List(0, 0),
      sources: List(), owners: List(), memoSlots: List(), held: List(),
      reads: List(), loads: List(), loaders: List(), retained: List(),
      dumps: List(), writes: List(), jobs: List(), deadlines: List(), selected: List()
    }
  }
  action beginWith(key: int, selected: bool): bool = all {
    input' = { name: "beginCall", choice: key },
    s' = Shadow::beginHeld(s, LAYOUT, call(key), REMOTE, TTLS, READ_BUDGET, selected)
  }
  action releaseRead(read: int): bool = all { input' = { name: "releaseRead", choice: read }, s' = Shadow::settleRead(s, LAYOUT, read, false, Recovery::NONE) }
  action failRead(read: int): bool = all { input' = { name: "failRead", choice: read }, s' = Shadow::settleRead(s, LAYOUT, read, true, Recovery::NONE) }
  action releaseLoad(load: int): bool = all { input' = { name: "releaseLoad", choice: load }, s' = Shadow::settleLoad(s, LAYOUT, load, false, READ_BUDGET, SHADOWING) }
  action failLoad(load: int): bool = all { input' = { name: "failLoad", choice: load }, s' = Shadow::settleLoad(s, LAYOUT, load, true, READ_BUDGET, SHADOWING) }
  action resolve(ordinal: int, value: int): bool = all { input' = { name: "resolveLoader", choice: ordinal }, s' = Shadow::settleLoader(s, LAYOUT, ordinal, value, false) }
  action reject(ordinal: int): bool = all { input' = { name: "rejectLoader", choice: ordinal }, s' = Shadow::settleLoader(s, LAYOUT, ordinal, SOURCE_ERROR, false) }
  action advanceBy(ms: int): bool = all { input' = { name: "advance", choice: ms }, s' = Shadow::advance(s, ms) }
  action seed(key: int, value: int): bool = all { input' = { name: "seed", choice: key }, s' = Remote::seedFrame(s, key, value, 5000) }
  // A policy reply the drivers hold: admission alone, then the release by its policy call.
  action admitHeld(key: int): bool = all { input' = { name: "beginCall", choice: key }, s' = RemoteIO::admit(s, LAYOUT, scopedCall(key)) }
  action releaseHeld(policyCall: int, selected: bool): bool = all {
    input' = { name: "releasePolicy", choice: policyCall },
    s' = Shadow::releaseHeld(s, LAYOUT, policyCall, REMOTE, TTLS, READ_BUDGET, selected)
  }
  action step = any { beginWith(0, true), releaseRead(0), releaseLoad(0), advanceBy(1) }

  // The selection is captured at dispatch and consulted at the decode: a
  // selected caller's hit admits its job however the policy reads then, an
  // unselected caller's hit admits none and says nothing.
  run capturedSelectionOutlivesThePolicyTest = init
    .then(beginWith(0, true))
    .expect(s.o.reads == 1 and s.selected == List(0) and s.io.budgets == List(READ_BUDGET))
    .then(releaseRead(0)).expect(s.o.loads == 1 and s.selected == List(0))
    .then(releaseLoad(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 1 and s.o.sourceScopes == List(false) and s.loaders == List(1)
      and s.jobs.length() == 1 and s.jobs.nth(0).cached == VALUE_ONE and s.jobs.nth(0).source == 1 and s.selected == List()
      and Deadlines::deadlinesOf(s, Deadlines::JOB, 1).length() == 1 and s.o.shadow == List())
    .then(resolve(0, VALUE_ONE))
    .expect(s.o.loads == 2 and RemoteIO::holdsLoad(s, 1) and Shadow::holdsLoad(s, 1) and s.jobs.nth(0).phase == Shadow::DECODING and s.o.shadow == List())
    .then(releaseLoad(1)).expect(s.o.shadow == List("match") and s.o.reads == 1 and s.jobs == List())
    .then(beginWith(0, false)).expect(s.selected == List())
    .then(releaseRead(1)).then(releaseLoad(2))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.jobs == List() and s.o.shadow == List("match"))
  // A follower joining the pending flight shares its one admission.
  run followerSharesTheLeadersAdmissionTest = init
    .then(beginWith(0, true)).then(beginWith(0, true))
    .expect(s.o.reads == 1 and s.selected == List(0) and s.owners == List(0, 0))
    .then(releaseRead(0)).then(releaseLoad(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.jobs.length() == 1 and s.selected == List())
  // A read that holds no decode (a miss) forgets the selection: the loader
  // runs the caller's source and its completion admits nothing.
  run missedReadForgetsTheSelectionTest = init
    .then(beginWith(1, true)).expect(s.selected == List(0))
    .then(releaseRead(0))
    .expect(s.o.loads == 0 and s.o.loaders == 1 and s.selected == List() and s.loaders == List(0))
    .then(resolve(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.jobs == List() and s.o.shadow == List() and s.o.writes == 1)
  // A caller's decode that fails restarts the loader and forgets the
  // selection: no hit was served, so nothing is admitted.
  run failedCallerDecodeAdmitsNothingTest = init
    .then(beginWith(0, true)).then(releaseRead(0)).then(failLoad(0))
    .expect(s.o.loaders == 1 and s.selected == List() and s.jobs == List())
    .then(resolve(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_TWO) and s.jobs == List() and s.o.shadow == List())
  // A held policy reply released captures the selection like an immediate one.
  run heldReplyReleaseCapturesTheSelectionTest = init
    .then(admitHeld(0)).expect(s.o.policyCalls == 1 and s.o.reads == 0 and s.selected == List())
    .then(releaseHeld(0, true)).expect(s.o.reads == 1 and s.selected == List(0))
    .then(releaseRead(0)).then(releaseLoad(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.jobs.length() == 1 and s.selected == List())
  // The job's decode is held when its source settles with another value, the
  // confirmation read when the decode disagrees, each under the drivers'
  // next index and the read budgeted; the C0 bytes still current are a mismatch.
  run disagreeingSourceHoldsTheDecodeThenTheConfirmationTest = init
    .then(beginWith(0, true)).then(releaseRead(0)).then(releaseLoad(0))
    .then(resolve(0, VALUE_TWO))
    .expect(s.o.loads == 2 and RemoteIO::holdsLoad(s, 1) and s.loads.nth(0).flight == 1 and s.loads.nth(0).value == VALUE_ONE
      and s.jobs.nth(0).phase == Shadow::DECODING and s.o.shadow == List())
    .then(releaseLoad(1))
    .expect(s.o.reads == 2 and RemoteIO::holdsRead(s, 1) and Shadow::holdsRead(s, 1) and s.reads.nth(0).flight == 1 and s.io.budgets == List(READ_BUDGET, READ_BUDGET)
      and s.jobs.nth(0).phase == Shadow::CONFIRMING and s.o.shadow == List())
    .then(releaseRead(1))
    .expect(s.o.shadow == List("mismatch") and s.jobs == List() and s.reads == List() and s.deadlines == List()
      and s.o.calls == List(VALUE_ONE) and s.o.writes == 0)
  run replacedC0IsSupersededAtTheConfirmationTest = init
    .then(beginWith(0, true)).then(releaseRead(0)).then(releaseLoad(0)).then(resolve(0, VALUE_TWO)).then(releaseLoad(1))
    .then(seed(0, VALUE_TWO)).then(releaseRead(1))
    .expect(s.o.shadow == List("superseded") and s.o.calls == List(VALUE_ONE))
  run failedConfirmationReadEndsConfirmationErrorTest = init
    .then(beginWith(0, true)).then(releaseRead(0)).then(releaseLoad(0)).then(resolve(0, VALUE_TWO)).then(releaseLoad(1))
    .then(failRead(1))
    .expect(s.o.shadow == List("confirmation_error") and s.jobs == List() and s.reads == List())
  run failedJobDecodeEndsDeserializationErrorTest = init
    .then(beginWith(0, true)).then(releaseRead(0)).then(releaseLoad(0)).then(resolve(0, VALUE_TWO))
    .then(failLoad(1))
    .expect(s.o.shadow == List("deserialization_error") and s.o.reads == 1 and s.jobs == List() and s.loads == List())
  run failedSourceEndsSourceErrorTest = init
    .then(beginWith(0, true)).then(releaseRead(0)).then(releaseLoad(0)).then(reject(0))
    .expect(s.o.shadow == List("source_error") and s.o.loads == 1 and s.o.calls == List(VALUE_ONE) and s.jobs == List())
  // A timed-out served job ends silently at whichever step finds it so, and
  // owns its slot until then: a second key's hit is dropped meanwhile.
  run timedOutJobEndsSilentlyAtItsDecodeTest = init
    .then(beginWith(0, true)).then(releaseRead(0)).then(releaseLoad(0)).then(resolve(0, VALUE_TWO))
    .then(advanceBy(100))
    .expect(s.o.shadow == List("timeout") and s.jobs.length() == 1 and s.jobs.nth(0).timedOut and s.deadlines == List())
    .then(seed(1, VALUE_ONE)).then(beginWith(1, true)).then(releaseRead(1)).then(releaseLoad(2))
    .expect(s.o.shadow == List("timeout", "dropped") and s.o.loaders == 1)
    .then(releaseLoad(1))
    .expect(s.o.shadow == List("timeout", "dropped") and s.jobs == List() and s.o.reads == 2)
    .then(beginWith(1, true)).then(releaseRead(2)).then(releaseLoad(3))
    .expect(s.o.loaders == 2 and s.o.shadow == List("timeout", "dropped"))
  run timedOutJobEndsSilentlyAtItsConfirmationTest = init
    .then(beginWith(0, true)).then(releaseRead(0)).then(releaseLoad(0)).then(resolve(0, VALUE_TWO)).then(releaseLoad(1))
    .then(advanceBy(100)).expect(s.o.shadow == List("timeout") and s.jobs.length() == 1 and s.jobs.nth(0).timedOut)
    .then(releaseRead(1)).expect(s.o.shadow == List("timeout") and s.jobs == List())
  run timedOutJobEndsSilentlyAtItsSourceTest = init
    .then(beginWith(0, true)).then(releaseRead(0)).then(releaseLoad(0)).then(advanceBy(100))
    .then(resolve(0, VALUE_TWO))
    .expect(s.o.shadow == List("timeout") and s.o.loads == 1 and s.jobs == List())
}

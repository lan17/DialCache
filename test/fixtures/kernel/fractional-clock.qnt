// The fractional clock over the local projection with inline sources: two
// default instances, one key each, a one-second local TTL, environment time
// in microsecond ticks. Pins that an advance moves the monotonic clock only
// across a millisecond boundary, that a fill at a fractional instant expires
// at the whole-millisecond boundary its grid instant plus the TTL names, that
// an inline call either serves a live entry without a source or runs and
// settles its source in one step, that construction is bookkeeping the clock
// never reads, and that no policy call is counted without a provider.
module fractional_clock {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import clock as Clock from "../../../formal/kernel/clock"
  import instances as Instances from "../../../formal/kernel/instances"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val TICKS_PER_MS = 1000
  pure val TTL_MS = 1000
  pure val LAYOUT: Serving::Layout =
    { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 1, probeSourceScope: false, policyProvider: false }
  pure val LOCAL: Resolution = { layers: { request: false, local: true, remote: false }, coalesce: true }
  pure val TTLS: Ttls = { localMs: TTL_MS, freshMs: 0, retentionMs: 0 }
  pure def callOn(instance: int): Call = { instance: instance, key: 0, context: 0, enabled: true, keyFailed: false }

  type State = {
    o: Observation, now: int, ticks: int, capacity: int, constructed: List[bool],
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    sources: List[Serving::LocalSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }

  action init = all {
    s' = {
      o: empty, now: 0, ticks: 0, capacity: 1, constructed: List(false, false),
      closed: List(), memo: List(), requestFlights: List(), processFlights: List(NO_OWNER, NO_OWNER),
      localValues: List(NO_VALUE, NO_VALUE), localExpires: List(0, 0), lru: List(List(), List()),
      sources: List(), owners: List(), memoSlots: List(), held: List()
    },
    input' = { name: "init", choice: -1 }
  }
  action construct(instance: int): bool = all {
    s' = Instances::construct(s, instance), input' = { name: "constructInstance", choice: instance }
  }
  action elapse(ticks: int): bool = all {
    s' = Clock::advanceTicks(s, ticks, TICKS_PER_MS), input' = { name: "advanceTicks", choice: ticks }
  }
  action call(instance: int, offered: int): bool = all {
    s' = Serving::callLocal(s, LAYOUT, callOn(instance), LOCAL, TTLS, offered),
    input' = { name: "call", choice: instance * 2 + offered - 1 }
  }

  // The clock moves only across a millisecond boundary; the raw ticks keep the fraction.
  run advanceMovesTheClockOnTheGridTest = init
    .then(elapse(700)).expect(s.now == 0 and s.ticks == 700)
    .then(elapse(299)).expect(s.now == 0 and s.ticks == 999)
    .then(elapse(1)).expect(s.now == 1 and s.ticks == 1000)
    .then(elapse(1500)).expect(s.now == 2 and s.ticks == 2500)

  // A fill at 0.7 ms is stamped from grid instant 0 and expires at 1000 ms:
  // live at 999.9 ms, gone at 1000.0 ms; the miss runs and settles its source
  // in the one call, with no policy call counted for a default instance.
  run fractionalFillExpiresAtTheWholeMillisecondTest = init
    .then(construct(0)).then(elapse(700)).then(call(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 1 and s.o.policyCalls == 0
      and s.localValues == List(VALUE_ONE, NO_VALUE) and s.localExpires == List(TTL_MS, 0)
      and s.sources.nth(0).result == VALUE_ONE and s.owners == List(0) and s.held == List())
    .then(elapse(999200)).then(call(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.owners == List(0, NO_OWNER)
      and s.localExpires == List(TTL_MS, 0))
    .then(elapse(100)).then(call(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO) and s.o.loaders == 2
      and s.localValues == List(VALUE_TWO, NO_VALUE) and s.localExpires == List(2 * TTL_MS, 0))

  // Construction at a fractional instant is bookkeeping: both instances share
  // the grid, so fills at 0.4 ms and 0.7 ms both expire at 1000 ms.
  run constructionPhaseDoesNotMoveTheGridTest = init
    .then(construct(0)).then(elapse(400)).then(construct(1)).then(elapse(300))
    .then(call(0, VALUE_ONE)).then(call(1, VALUE_ONE))
    .expect(s.constructed == List(true, true) and s.localExpires == List(TTL_MS, TTL_MS))
    .then(elapse(999200)).then(call(0, VALUE_TWO)).then(call(1, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 2)
    .then(elapse(100)).then(call(0, VALUE_TWO)).then(call(1, VALUE_TWO))
    .expect(s.o.loaders == 4 and s.localExpires == List(2 * TTL_MS, 2 * TTL_MS))
}

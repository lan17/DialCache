module dialcache_local_clock_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import clock as Clock from "./kernel/clock"
  import instances as Instances from "./kernel/instances"
  import policy_gate as Gate from "./kernel/policy-gate"

  // C09/B02: default instances share a whole-millisecond local expiry grid.
  // Environment time is expressed in microsecond ticks, while local insertion
  // and lookup project that common time to whole milliseconds. This differs
  // from source/read/shadow budgets, which measure precise elapsed intervals.
  // Two instances, one key per instance, healthy immediate sources, a fixed
  // one-second local TTL, and no request memo or remote layer bound this model.
  // The replay creates real default caches at the declared fractional times.
  // Every rule is a kernel transition (formal/kernel): the local projection of
  // the traversal with an inline source (`Serving::callLocal`) over the
  // fractional clock (`Clock::advanceTicks`). This module owns the bounded
  // state, the instance decoding, the input choices and the guards.

  pure val TICKS_PER_MS = 1000
  pure val LOCAL_TTL_MS = 1000
  pure val INSTANCE_IDS = Set(0, 1)
  pure val ADVANCES = Set(1, 100, 300, 400, 700, 999200, 999999, 1000000)
  pure val MAX_CALLS = 20
  // One key on each of two instances, no request scope, no remote layer; the
  // default instances resolve policy from the key's configuration and make no
  // provider call; every reply enables the local layer with sharing.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 0, operationsPerEntity: 1, probeSourceScope: false, policyProvider: false
  }
  pure val LOCAL: Resolution = { layers: { request: false, local: true, remote: false }, coalesce: true }
  pure val TTLS: Ttls = { localMs: LOCAL_TTL_MS, freshMs: 0, retentionMs: 0 }

  type State = {
    o: Observation,
    now: int,
    ticks: int,
    capacity: int,
    constructed: List[bool],
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    localValues: List[int],
    localExpires: List[int],
    lru: List[List[int]],
    sources: List[Serving::LocalSource],
    owners: List[int],
    memoSlots: List[int],
    held: List[Gate::Held]
  }
  var s: State
  var input: { name: str, choice: int }

  // Input decoding: a call names its instance; every call is enabled and runs
  // in a context that is not a persistent scope.
  pure def callOn(instance: int): Call = { instance: instance, key: 0, context: 0, enabled: true, keyFailed: false }

  action init = all {
    s' = {
      o: empty,
      now: 0,
      ticks: 0,
      capacity: 1,
      constructed: List(false, false),
      closed: List(),
      memo: List(),
      requestFlights: List(),
      processFlights: List(NO_OWNER, NO_OWNER),
      localValues: List(NO_VALUE, NO_VALUE),
      localExpires: List(0, 0),
      lru: List(List(), List()),
      sources: List(),
      owners: List(),
      memoSlots: List(),
      held: List()
    },
    input' = { name: "init", choice: -1 }
  }

  action construct(instance: int): bool = all {
    not(s.constructed.nth(instance)),
    s' = Instances::construct(s, instance),
    input' = { name: "constructInstance", choice: instance }
  }
  action constructInstance = {
    nondet choice = INSTANCE_IDS.filter(instance => not(s.constructed.nth(instance))).oneOf()
    construct(choice)
  }

  action elapse(ticks: int): bool = all {
    s' = Clock::advanceTicks(s, ticks, TICKS_PER_MS),
    input' = { name: "advanceTicks", choice: ticks }
  }
  action advanceTicks = {
    nondet choice = ADVANCES.oneOf()
    elapse(choice)
  }

  action callWith(instance: int, offered: int): bool = all {
    s.constructed.nth(instance),
    s.o.calls.length() < MAX_CALLS,
    s' = Serving::callLocal(s, LAYOUT, callOn(instance), LOCAL, TTLS, offered),
    input' = { name: "call", choice: instance * 2 + offered - 1 }
  }
  action call = {
    nondet choice = 0.to(3).filter(code => s.constructed.nth(code / 2)).oneOf()
    callWith(choice / 2, choice % 2 + 1)
  }
  action step = any { constructInstance, advanceTicks, call }

  // -- Independently stated safety properties --------------------------------
  // The clock the layers read is the environment's time on the whole
  // millisecond grid, stated here as the integer projection of the raw ticks,
  // not through the clock module.
  val clockIsOnTheGrid = s.now == s.ticks / TICKS_PER_MS
  // The call that just happened, on the instance the input names: served
  // locally, it returned a live entry's value (strictly before that entry's
  // expiry on the grid) and started no source; otherwise it ran its source,
  // returned what the source offered and left the entry stamped from this
  // instant for the local TTL.
  val newest = s.o.calls.length() - 1
  val calledInstance = input.choice / 2
  val offeredValue = input.choice % 2 + 1
  val callsServeLiveEntriesOrRunTheSource = input.name != "call" or {
    val owner = s.owners.nth(newest)
    val value = s.o.calls.nth(newest)
    if (owner < 0) value == s.localValues.nth(calledInstance) and s.now < s.localExpires.nth(calledInstance)
    else value == offeredValue and s.sources.nth(owner).result == value and s.sources.nth(owner).instance == calledInstance
      and s.localValues.nth(calledInstance) == value and s.localExpires.nth(calledInstance) == s.now + LOCAL_TTL_MS
  }
  // Public calls and sources agree with the records: one source per loader,
  // every call completed by its own source's outcome, and every entry the
  // value of a source on its instance.
  val publicCallsMatchSources = s.o.loaders == s.sources.length()
    and s.owners.indices().forall(caller => s.owners.nth(caller) < 0 or s.o.calls.nth(caller) == s.sources.nth(s.owners.nth(caller)).result)
    and INSTANCE_IDS.forall(instance => s.localValues.nth(instance) == NO_VALUE
      or s.sources.indices().exists(i => s.sources.nth(i).instance == instance and s.sources.nth(i).result == s.localValues.nth(instance)))

  run fractionalInsertionExpiresAtWholeMillisecondTest = init
    .then(construct(0)).then(elapse(700)).then(callWith(0, VALUE_ONE))
    .then(elapse(999200)).then(callWith(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
    .then(elapse(100)).then(callWith(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO) and s.o.loaders == 2)

  run fractionalConstructionKeepsCommonInstanceGridTest = init
    .then(construct(0)).then(elapse(400)).then(construct(1)).then(elapse(300))
    .then(callWith(0, VALUE_ONE)).then(callWith(1, VALUE_ONE))
    .then(elapse(999200)).then(callWith(0, VALUE_TWO)).then(callWith(1, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 2)
    .then(elapse(100)).then(callWith(0, VALUE_TWO)).then(callWith(1, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_TWO)
      and s.o.loaders == 4)

  run nonzeroOriginKeepsWholeMillisecondBoundaryTest = init
    .then(elapse(1000000)).then(construct(0)).then(elapse(700)).then(callWith(0, VALUE_ONE))
    .then(elapse(999200)).then(callWith(0, VALUE_TWO)).then(elapse(100)).then(callWith(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO) and s.o.loaders == 2)

  run integerInsertionRetainsFullTtlTest = init
    .then(construct(0)).then(callWith(0, VALUE_ONE))
    .then(elapse(999999)).then(callWith(0, VALUE_TWO)).then(elapse(1)).then(callWith(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO) and s.o.loaders == 2)
}

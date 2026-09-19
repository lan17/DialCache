// The budgeted local lifecycle (deadlines over the local projection): one
// instance, two persistent contexts, a disabled context and a key that failed
// to construct, policy replies held and released one at a time. Pins which
// source starts are bounded (a failed key at admission and every start at
// release, a scope closed since admission included; a disabled context and a
// closed scope at admission are not), the local insertion expiry boundary and
// eviction, a zero budget settling late before any advance, and, over two
// keys, that a source settles into its own key's slot.
module budgeted_local {
  import conformance_observations.* from "../../../formal/conformance-observations"
  import encodings.* from "../../../formal/kernel/encodings"
  import calls.* from "../../../formal/kernel/calls"
  import layer_policy.* from "../../../formal/kernel/layer-policy"
  import serving as Serving from "../../../formal/kernel/serving"
  import local_storage as Local from "../../../formal/kernel/local-storage"
  import deadlines as Deadlines from "../../../formal/kernel/deadlines"
  import policy_gate as Gate from "../../../formal/kernel/policy-gate"

  pure val BUDGET = 10
  pure val LOCAL_TTL_MS = 1000
  pure val START = 10000
  pure val LAYOUT: Serving::Layout = { keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, probeSourceScope: false }
  pure val TWO_KEYS: Serving::Layout = { keysPerInstance: 2, keysPerScope: 2, persistentContexts: 2, operationsPerEntity: 2, probeSourceScope: false }
  pure val LOCAL: Resolution = { layers: { request: false, local: true, remote: false }, coalesce: true }
  pure val TTLS: Ttls = { localMs: LOCAL_TTL_MS, freshMs: 0, retentionMs: 0 }

  // Admission kinds: an enabled caller in persistent context 0 or 1, a caller
  // in a disabled context, a caller whose key failed to construct, and an
  // enabled caller for key 1 (the two-key layout only).
  pure val ENABLED = 0
  pure val ENABLED_OTHER = 1
  pure val DISABLED = 2
  pure val FAILED_KEY = 3
  pure val ENABLED_KEY_ONE = 4
  pure def call(kind: int): Call = {
    instance: 0, key: if (kind == ENABLED_KEY_ONE) 1 else 0, context: if (kind == ENABLED_OTHER) 1 else 0,
    enabled: kind == ENABLED or kind == ENABLED_OTHER or kind == ENABLED_KEY_ONE, keyFailed: kind == FAILED_KEY
  }

  type State = {
    o: Observation, now: int, sourceBudget: int, capacity: int,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    sources: List[Serving::LocalSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    deadlines: List[Deadlines::Due], started: List[int], budgets: List[int], settledAt: List[int], drained: List[bool]
  }
  var s: State
  var input: { name: str, choice: int }

  action initialize(budget: int): bool = all {
    s' = { o: empty, now: START, sourceBudget: budget, capacity: 1,
      closed: List(false, false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER),
      localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
      sources: List(), owners: List(), memoSlots: List(), held: List(),
      deadlines: List(), started: List(), budgets: List(), settledAt: List(), drained: List() },
    input' = { name: "init", choice: budget }
  }
  action init = initialize(BUDGET)
  // Two keys on one instance with room for both.
  action initializeTwoKeys = all {
    s' = { o: empty, now: START, sourceBudget: BUDGET, capacity: 2,
      closed: List(false, false), memo: List(NO_VALUE, NO_VALUE, NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER, NO_OWNER, NO_OWNER),
      processFlights: List(NO_OWNER, NO_OWNER), localValues: List(NO_VALUE, NO_VALUE), localExpires: List(0, 0), lru: List(List()),
      sources: List(), owners: List(), memoSlots: List(), held: List(),
      deadlines: List(), started: List(), budgets: List(), settledAt: List(), drained: List() },
    input' = { name: "init", choice: 2 }
  }
  action admit(kind: int): bool = all {
    s' = Deadlines::admitLocal(s, LAYOUT, call(kind)),
    input' = { name: "beginCall", choice: kind }
  }
  // One reply is held at a time, so each release names the latest.
  action release = all {
    s' = Deadlines::releaseLocal(s, LAYOUT, Gate::latest(s), LOCAL, TTLS),
    input' = { name: "releasePolicy", choice: -1 }
  }
  action settle(index: int, value: int): bool = all {
    s' = Deadlines::settleLocal(s, LAYOUT, index, value),
    input' = { name: "resolveLoader", choice: index }
  }
  action advance(ms: int): bool = all {
    s' = Deadlines::advanceLocal(s, LAYOUT, ms),
    input' = { name: "advance", choice: ms }
  }
  action close(context: int): bool = all {
    s' = Serving::closeScope(s, LAYOUT, context),
    input' = { name: "closeScope", choice: context }
  }
  action admitTwoKeys(kind: int): bool = all {
    s' = Deadlines::admitLocal(s, TWO_KEYS, call(kind)),
    input' = { name: "beginCall", choice: kind }
  }
  action releaseTwoKeys = all {
    s' = Deadlines::releaseLocal(s, TWO_KEYS, Gate::latest(s), LOCAL, TTLS),
    input' = { name: "releasePolicy", choice: -1 }
  }
  action settleTwoKeys(index: int, value: int): bool = all {
    s' = Deadlines::settleLocal(s, TWO_KEYS, index, value),
    input' = { name: "resolveLoader", choice: index }
  }

  // A source started at admission is bounded only when the key failed to
  // construct (C27): a disabled context and a scope already closed run theirs
  // unbounded (C01). A source started at release is bounded.
  run admissionBudgetsFollowTheFailedKeyTest = init
    .then(admit(DISABLED)).then(admit(FAILED_KEY))
    .expect(s.o.loaders == 2 and s.o.policyCalls == 0 and s.budgets == List(Deadlines::UNBOUNDED, BUDGET)
      and s.started == List(START, START))
    .then(close(0)).then(admit(ENABLED))
    .expect(s.o.loaders == 3 and s.o.policyCalls == 0 and s.budgets.nth(2) == Deadlines::UNBOUNDED)
    .then(admit(ENABLED_OTHER)).then(release)
    .expect(s.o.loaders == 4 and s.o.policyCalls == 1 and s.budgets.nth(3) == BUDGET and s.sources.nth(3).shared)

  // A caller whose scope closed between admission and release starts its
  // source at release, outside the cache, with the configured budget: it
  // was enabled when admitted.
  run releasedSourceIsBoundedAfterItsScopeClosedTest = init
    .then(admit(ENABLED)).then(close(0)).then(release)
    .expect(s.o.loaders == 1 and s.o.policyCalls == 1 and s.budgets == List(BUDGET)
      and not(s.sources.nth(0).shared) and s.sources.nth(0).localMs == 0)
    .then(advance(BUDGET))
    .expect(s.o.calls == List(DEADLINE_ERROR))

  // A local entry serves strictly before its expiry instant and not at it;
  // an eviction clears the evicted slot's value and its expiry.
  pure val STORE = { now: 0, capacity: 1, localValues: List(NO_VALUE, NO_VALUE), localExpires: List(0, 0), lru: List(List()) }
  pure val STORED = Local::putLocal(STORE, 0, 0, VALUE_ONE, LOCAL_TTL_MS, 2)
  run localEntryServesBeforeItsExpiryOnlyTest = init
    .expect(STORED.localValues == List(VALUE_ONE, NO_VALUE) and STORED.localExpires == List(LOCAL_TTL_MS, 0)
      and Local::localValue({ now: LOCAL_TTL_MS - 1, ...STORED }, 0, 0, 2) == VALUE_ONE
      and Local::localValue({ now: LOCAL_TTL_MS, ...STORED }, 0, 0, 2) == NO_VALUE
      and Local::putLocal({ now: 500, ...STORED }, 0, 1, VALUE_TWO, LOCAL_TTL_MS, 2)
        == { now: 500, capacity: 1, localValues: List(NO_VALUE, VALUE_TWO), localExpires: List(0, 1500), lru: List(List(1)) })

  // A source carries the identity it serves: a key-1 source settles into key
  // 1's slot, a key-0 caller still misses and starts its own source, and a
  // later key-1 caller is served from the published entry.
  run localSourceSettlesIntoItsOwnKeyTest = initializeTwoKeys
    .then(admitTwoKeys(ENABLED_KEY_ONE)).then(releaseTwoKeys).then(settleTwoKeys(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE) and s.sources.nth(0).instance == 0 and s.sources.nth(0).key == 1
      and s.localValues == List(NO_VALUE, VALUE_ONE) and s.localExpires == List(0, START + LOCAL_TTL_MS) and s.lru == List(List(1)))
    .then(admitTwoKeys(ENABLED)).then(releaseTwoKeys)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2 and s.sources.nth(1).key == 0)
    .then(admitTwoKeys(ENABLED_KEY_ONE)).then(releaseTwoKeys)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING, VALUE_ONE) and s.o.loaders == 2)

  // A finite zero budget is already expired when the source starts: its
  // result arriving before any advance is a deadline error, stamped as
  // settled now, its work drained, nothing warmed.
  run zeroBudgetSourceSettlesAsDeadlineErrorTest = initialize(0)
    .then(admit(ENABLED)).then(release).then(settle(0, VALUE_ONE))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.sources.nth(0).result == DEADLINE_ERROR
      and s.settledAt == List(START) and s.drained == List(true) and s.localValues == List(NO_VALUE))
}

module dialcache_policy_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Two logical keys, one process-local slot, untracked Redis. At most one
  // provider reply is held at a time, but accepted sources can overlap and
  // settle in either order. Every source owns its accepted publication policy.
  type Source = { key: int, localTtl: int, remoteTtl: int, retention: int, shared: bool, result: int }
  type State = {
    o: Observation, now: int, wall: int, policyCall: int, overlay: int, key: int,
    localKey: int, localValue: int, localExpires: int,
    remoteValues: List[int], remoteCreated: List[int], remoteExpires: List[int],
    sources: List[Source], owners: List[int], registered: List[int],
    providerFailed: bool, readFailed: bool, dumpFailed: bool, writeFailed: bool
  }
  var s: State
  action init = s' = {
    o: empty, now: 0, wall: 100000, policyCall: -1, overlay: 0, key: 0,
    localKey: 0, localValue: 0, localExpires: 0,
    remoteValues: List(0, 0), remoteCreated: List(0, 0), remoteExpires: List(0, 0),
    sources: List(), owners: List(), registered: List(-1, -1),
    providerFailed: false, readFailed: false, dumpFailed: false, writeFailed: false
  }
  // Choices 10..19 repeat the same sparse overlays with coalescing disabled.
  val base = s.overlay % 10
  val localTtl = if (s.providerFailed or Set(3, 5, 8).contains(base)) 0
    else if (base == 1) 2000 else 1000
  val remoteTtl = if (s.providerFailed or Set(4, 6, 8).contains(base)) 0
    else if (base == 2) 2000 else if (base == 9) 4000 else 1000
  val retention = if (base == 7) 2000 else if (base == 9) 4000 else 5000
  val pendingSources = s.sources.indices().filter(i => s.sources.nth(i).result == 0)

  pure def begin(state: State, key: int): State = {
    key: key, policyCall: state.o.calls.length(), owners: state.owners.append(-1),
    o: { calls: state.o.calls.append(0), policyCalls: state.o.policyCalls + 1, ...state.o }, ...state
  }
  action beginCall = { nondet choice = Set(0, 1).oneOf()
    all { s.policyCall == -1, s.o.calls.length() < 12, s' = begin(s, choice) }
  }
  action releasePolicy = all {
    s.policyCall >= 0,
    val shared = s.overlay < 10 and (localTtl > 0 or remoteTtl > 0)
    val joins = shared and s.registered.nth(s.key) >= 0
    // Flight admission precedes reading the first participating cache layer.
    val localHit = not(joins) and localTtl > 0 and s.localKey == s.key and s.localValue > 0 and s.now < s.localExpires
    val read = not(joins) and not(localHit) and remoteTtl > 0
    val remoteHit = read and not(s.readFailed) and s.remoteValues.nth(s.key) > 0 and
      s.now < s.remoteExpires.nth(s.key) and s.wall >= s.remoteCreated.nth(s.key) and s.wall - s.remoteCreated.nth(s.key) < remoteTtl
    val value = if (localHit) s.localValue else if (remoteHit) s.remoteValues.nth(s.key) else 0
    val starts = not(joins) and value == 0
    val owner = if (joins) s.registered.nth(s.key) else if (starts) s.sources.length() else -1
    s' = { policyCall: -1,
      owners: s.owners.replaceAt(s.policyCall, owner),
      sources: if (starts) s.sources.append({ key: s.key, localTtl: localTtl,
        remoteTtl: if (read and not(s.readFailed)) remoteTtl else 0,
        retention: retention, shared: shared, result: 0 }) else s.sources,
      registered: if (starts and shared) s.registered.replaceAt(s.key, owner) else s.registered,
      localKey: if (remoteHit and localTtl > 0) s.key else s.localKey,
      localValue: if (remoteHit and localTtl > 0) value else s.localValue,
      localExpires: if (remoteHit and localTtl > 0) s.now + localTtl else s.localExpires,
      o: { calls: s.o.calls.replaceAt(s.policyCall, value),
        reads: s.o.reads + (if (read) 1 else 0), loads: s.o.loads + (if (remoteHit) 1 else 0),
        loaders: s.o.loaders + (if (starts) 1 else 0), ...s.o }, ...s }
  }

  pure def settle(state: State, loader: int, value: int): State = {
    val source = state.sources.nth(loader)
    val dump = value != 3 and source.remoteTtl > 0
    val write = dump and not(state.dumpFailed)
    val stored = write and not(state.writeFailed)
    val local = value != 3 and source.localTtl > 0
    {
      sources: state.sources.replaceAt(loader, { result: value, ...source }),
      registered: if (state.registered.nth(source.key) == loader) state.registered.replaceAt(source.key, -1) else state.registered,
      localKey: if (local) source.key else state.localKey,
      localValue: if (local) value else state.localValue,
      localExpires: if (local) state.now + source.localTtl else state.localExpires,
      remoteValues: if (stored) state.remoteValues.replaceAt(source.key, value) else state.remoteValues,
      remoteCreated: if (stored) state.remoteCreated.replaceAt(source.key, state.wall) else state.remoteCreated,
      remoteExpires: if (stored) state.remoteExpires.replaceAt(source.key, state.now + source.retention) else state.remoteExpires,
      o: { calls: state.o.calls.foldl(List(), (out, result) => out.append(if (state.owners.nth(out.length()) == loader) value else result)),
        dumps: state.o.dumps + (if (dump) 1 else 0), writes: state.o.writes + (if (write) 1 else 0),
        writeTtls: if (write) state.o.writeTtls.append(source.retention) else state.o.writeTtls, ...state.o }, ...state
    }
  }
  action resolveLoader = {
    // One portable choice records both the actual source index and its value.
    nondet choice = 1.to(84).filter(code => pendingSources.contains((code - 1) / 7)).oneOf()
    s' = settle(s, (choice - 1) / 7, values.nth((choice - 1) % 7))
  }
  action rejectLoader = { nondet choice = pendingSources.oneOf()
    s' = settle(s, choice, 3)
  }
  action policy = { nondet choice = 0.to(19).oneOf()
    s' = { overlay: choice, ...s } }
  action advance = { nondet choice = Set(1, 1000, 2000, 5000).oneOf()
    s' = { now: s.now + choice, wall: s.wall + choice, ...s } }
  action rollbackWall = s' = { wall: s.wall - 1000, ...s }
  action providerFault = { nondet choice = Set(0, 1).oneOf()
    s' = { providerFailed: choice == 1, ...s } }
  action readFault = { nondet choice = Set(0, 1).oneOf()
    s' = { readFailed: choice == 1, ...s } }
  action dumpFault = { nondet choice = Set(0, 1).oneOf()
    s' = { dumpFailed: choice == 1, ...s } }
  action writeFault = { nondet choice = Set(0, 1).oneOf()
    s' = { writeFailed: choice == 1, ...s } }
  action step = any {
    any { beginCall, releasePolicy, resolveLoader, rejectLoader },
    any { policy, advance, rollbackWall, providerFault, readFault, dumpFault, writeFault }
  }
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()
  val hitsSkipSource = s.o.loaders <= s.o.calls.length()
  val callsKeepSourceOutcome = s.o.calls.indices().forall(i =>
    if (s.owners.nth(i) >= 0) s.o.calls.nth(i) == s.sources.nth(s.owners.nth(i)).result
    else (s.o.calls.nth(i) == 0) == (i == s.policyCall))
  val sourceCountsMatchEffects = s.sources.length() == s.o.loaders and s.owners.length() == s.o.calls.length()
  val registeredSourcesArePending = s.registered.indices().forall(key => {
    val loader = s.registered.nth(key)
    loader < 0 or (s.sources.nth(loader).key == key and s.sources.nth(loader).result == 0 and s.sources.nth(loader).shared)
  })
  val sharedSourcesKeepRegistration = pendingSources.forall(i =>
    not(s.sources.nth(i).shared) or s.registered.nth(s.sources.nth(i).key) == i)

  run wallRollbackDoesNotExtendLocalTtlTest = init.then(s' = { overlay: 4, ...s })
    .then(s' = begin(s, 0)).then(releasePolicy).then(s' = settle(s, 0, 1)).then(rollbackWall)
    .then(s' = begin(s, 0)).then(releasePolicy).expect(s.o.calls == List(1, 1))
    .then(s' = { now: s.now + 1000, wall: s.wall + 1000, ...s })
    .then(s' = begin(s, 0)).then(releasePolicy).expect(s.o.calls == List(1, 1, 0) and s.o.loaders == 2)
  run wallRollbackRejectsFutureRemoteFrameTest = init.then(s' = { overlay: 3, ...s })
    .then(s' = begin(s, 0)).then(releasePolicy).then(s' = settle(s, 0, 1)).then(rollbackWall)
    .then(s' = begin(s, 0)).then(releasePolicy).expect(s.o.calls == List(1, 0) and s.o.loaders == 2)

  run independentCompletionKeepsRegisteredLeaderTest = init
    .then(s' = begin(s, 0)).then(releasePolicy)
    .then(s' = { overlay: 10, ...s }).then(s' = begin(s, 0)).then(releasePolicy)
    .then(s' = settle(s, 1, 2))
    .expect(s.o.calls == List(0, 2) and s.registered == List(0, -1))
    .then(s' = { overlay: 0, ...s }).then(s' = begin(s, 0)).then(releasePolicy)
    .expect(s.o.calls == List(0, 2, 0) and s.o.loaders == 2 and s.o.reads == 2)
    .then(s' = settle(s, 0, 1)).expect(s.o.calls == List(1, 2, 1))

  run independentFailureKeepsRegisteredLeaderTest = init
    .then(s' = begin(s, 0)).then(releasePolicy)
    .then(s' = { overlay: 10, ...s }).then(s' = begin(s, 0)).then(releasePolicy)
    .then(s' = settle(s, 1, 3)).expect(s.o.calls == List(0, 3) and s.registered == List(0, -1))
    .then(s' = { overlay: 0, ...s }).then(s' = begin(s, 0)).then(releasePolicy)
    .then(s' = settle(s, 0, 1)).expect(s.o.calls == List(1, 3, 1))

  run eachSourceKeepsPublicationPolicyTest = init
    .then(s' = begin(s, 0)).then(releasePolicy)
    .then(s' = { overlay: 19, ...s }).then(s' = begin(s, 0)).then(releasePolicy)
    .then(s' = settle(s, 1, 2)).then(s' = settle(s, 0, 1))
    .expect(s.o.writeTtls == List(4000, 5000) and s.remoteValues == List(1, 0))
  run absentValueIsStoredAndReusedTest = init.then(s' = begin(s, 0)).then(releasePolicy)
    .then(s' = settle(s, 0, 5)).then(s' = begin(s, 0)).then(releasePolicy)
    .expect(s.o.calls == List(5, 5) and s.o.loaders == 1 and s.o.writes == 1)
}

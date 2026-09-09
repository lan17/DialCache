module dialcache_policy_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Two logical keys, one process-local slot, untracked Redis. Policy fetch is
  // held; its release captures a sparse overlay for this invocation. A later
  // change cannot alter that invocation or an entry's physical insertion TTL.
  type State = {
    o: Observation, now: int, phase: int, overlay: int, key: int,
    localKey: int, localValue: int, localExpires: int,
    remoteValues: List[int], remoteCreated: List[int], remoteExpires: List[int],
    acceptedLocalTtl: int, acceptedRemoteTtl: int, acceptedRetention: int,
    providerFailed: bool, readFailed: bool, dumpFailed: bool, writeFailed: bool
  }
  var s: State
  action init = s' = {
    o: empty, now: 0, phase: 0, overlay: 0, key: 0,
    localKey: 0, localValue: 0, localExpires: 0,
    remoteValues: List(0, 0), remoteCreated: List(0, 0), remoteExpires: List(0, 0),
    acceptedLocalTtl: 0, acceptedRemoteTtl: 0, acceptedRetention: 0,
    providerFailed: false, readFailed: false, dumpFailed: false, writeFailed: false
  }
  val localTtl = if (s.providerFailed or Set(3, 5, 8).contains(s.overlay)) 0
    else if (s.overlay == 1) 2000 else 1000
  val remoteTtl = if (s.providerFailed or Set(4, 6, 8).contains(s.overlay)) 0
    else if (s.overlay == 2) 2000 else if (s.overlay == 9) 4000 else 1000
  val retention = if (s.overlay == 7) 2000 else if (s.overlay == 9) 4000 else 5000

  action beginCall = { nondet choice = Set(0, 1).oneOf()
    all { s.phase == 0, s.o.calls.length() < 12,
      s' = { key: choice, phase: 1,
        o: { calls: s.o.calls.append(0), policyCalls: s.o.policyCalls + 1, ...s.o }, ...s } }
  }
  action releasePolicy = all {
    s.phase == 1,
    val localHit = localTtl > 0 and s.localKey == s.key and s.localValue > 0 and s.now < s.localExpires
    val read = not(localHit) and remoteTtl > 0
    val remoteHit = read and not(s.readFailed) and s.remoteValues.nth(s.key) > 0 and
      s.now < s.remoteExpires.nth(s.key) and s.now - s.remoteCreated.nth(s.key) < remoteTtl
    val value = if (localHit) s.localValue else if (remoteHit) s.remoteValues.nth(s.key) else 0
    s' = { phase: if (value > 0) 0 else 2,
      acceptedLocalTtl: localTtl,
      acceptedRemoteTtl: if (read and not(s.readFailed)) remoteTtl else 0,
      acceptedRetention: retention,
      localKey: if (remoteHit and localTtl > 0) s.key else s.localKey,
      localValue: if (remoteHit and localTtl > 0) value else s.localValue,
      localExpires: if (remoteHit and localTtl > 0) s.now + localTtl else s.localExpires,
      o: { reads: s.o.reads + (if (read) 1 else 0), loads: s.o.loads + (if (remoteHit) 1 else 0),
        loaders: s.o.loaders + (if (value == 0) 1 else 0), ...finish(s.o, value) }, ...s }
  }
  action resolveLoader = { nondet choice = Set(1, 2).oneOf()
    all { s.phase == 2,
      val dump = s.acceptedRemoteTtl > 0
      val write = dump and not(s.dumpFailed)
      val stored = write and not(s.writeFailed)
      s' = { phase: 0,
        localKey: if (s.acceptedLocalTtl > 0) s.key else s.localKey,
        localValue: if (s.acceptedLocalTtl > 0) choice else s.localValue,
        localExpires: if (s.acceptedLocalTtl > 0) s.now + s.acceptedLocalTtl else s.localExpires,
        remoteValues: if (stored) s.remoteValues.replaceAt(s.key, choice) else s.remoteValues,
        remoteCreated: if (stored) s.remoteCreated.replaceAt(s.key, s.now) else s.remoteCreated,
        remoteExpires: if (stored) s.remoteExpires.replaceAt(s.key, s.now + s.acceptedRetention) else s.remoteExpires,
        o: { dumps: s.o.dumps + (if (dump) 1 else 0), writes: s.o.writes + (if (write) 1 else 0),
          writeTtls: if (write) s.o.writeTtls.append(s.acceptedRetention) else s.o.writeTtls,
          ...finish(s.o, choice) }, ...s }
    }
  }
  action rejectLoader = all { s.phase == 2, s' = { phase: 0, o: finish(s.o, 3), ...s } }
  action policy = { nondet choice = 0.to(9).oneOf()
    s' = { overlay: choice, ...s } }
  action advance = { nondet choice = Set(1, 1000, 2000, 5000).oneOf()
    s' = { now: s.now + choice, ...s } }
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
    any { policy, advance, providerFault, readFault, dumpFault, writeFault }
  }
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()
  val hitsSkipSource = s.o.loaders <= s.o.calls.length()
  val pendingCallHasPhase = (s.o.calls.select(c => c == 0).length() == 1) == (s.phase != 0)
}

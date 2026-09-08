module dialcache_effects_conformance {
  // Tracked remote-only calls, with independently settled loaders and native
  // writes. Values are always 1; loader/read counts distinguish hits/refills.
  // Calls: 0 pending, 1 returned value, 2 original source error, 3 timeout.
  // Sources: 0 registered, 1 abandoned externally, 2 settled.
  // Phase: 0 no registered flight, 1 fallback, 2 accepted publication.
  type State = {
    now: int, phase: int, activeLoader: int, deadline: int,
    observedFence: int, writeTimestamp: int, storedTimestamp: int, watermark: int,
    calls: List[int], sources: List[int],
    loaders: int, reads: int, writes: int, invalidations: int,
    loads: int, dumps: int, policyCalls: int
  }
  var s: State
  pure def finish(calls: List[int], outcome: int): List[int] =
    calls.foldl(List(), (out, result) => out.append(if (result == 0) outcome else result))
  val readable = s.storedTimestamp > 0 and s.storedTimestamp > s.watermark

  action init = s' = {
    now: 1, phase: 0, activeLoader: 0, deadline: 0,
    observedFence: 0, writeTimestamp: 0, storedTimestamp: 0, watermark: 0,
    calls: List(), sources: List(),
    loaders: 0, reads: 0, writes: 0, invalidations: 0, loads: 0, dumps: 0, policyCalls: 0
  }

  action beginCall = all {
    s.calls.length() < 6,
    s.phase != 0 or readable or s.sources.length() < 3,
    s' = {
      calls: s.calls.append(if (s.phase == 0 and readable) 1 else 0),
      policyCalls: s.policyCalls + 1,
      reads: if (s.phase == 0) s.reads + 1 else s.reads,
      loads: if (s.phase == 0 and readable) s.loads + 1 else s.loads,
      loaders: if (s.phase == 0 and not(readable)) s.loaders + 1 else s.loaders,
      sources: if (s.phase == 0 and not(readable)) s.sources.append(0) else s.sources,
      activeLoader: if (s.phase == 0 and not(readable)) s.sources.length() else s.activeLoader,
      deadline: if (s.phase == 0 and not(readable)) s.now + 10 else s.deadline,
      observedFence: if (s.phase == 0 and not(readable)) s.watermark else s.observedFence,
      phase: if (s.phase == 0 and not(readable)) 1 else s.phase, ...s
    },
  }

  action resolveLoader = {
    nondet loader = s.sources.indices().filter(i => s.sources.nth(i) != 2).oneOf()
    all {
      s' = {
        sources: s.sources.replaceAt(loader, 2),
        phase: if (s.sources.nth(loader) == 1) s.phase
          else if (s.now >= s.deadline or s.now <= s.observedFence) 0 else 2,
        calls: if (s.sources.nth(loader) == 1) s.calls
          else if (s.now >= s.deadline) finish(s.calls, 3)
          else if (s.now <= s.observedFence) finish(s.calls, 1) else s.calls,
        writeTimestamp: if (s.sources.nth(loader) == 0 and s.now < s.deadline and s.now > s.observedFence) s.now else s.writeTimestamp,
        writes: if (s.sources.nth(loader) == 0 and s.now < s.deadline and s.now > s.observedFence) s.writes + 1 else s.writes,
        dumps: if (s.sources.nth(loader) == 0 and s.now < s.deadline and s.now > s.observedFence) s.dumps + 1 else s.dumps,
        ...s
      },
    }
  }

  action rejectLoader = {
    nondet loader = s.sources.indices().filter(i => s.sources.nth(i) != 2).oneOf()
    s' = {
      sources: s.sources.replaceAt(loader, 2),
      phase: if (s.sources.nth(loader) == 1) s.phase else 0,
      calls: if (s.sources.nth(loader) == 1) s.calls
        else finish(s.calls, if (s.now >= s.deadline) 3 else 2), ...s
    }
  }

  action releaseWrite = all {
    s.phase == 2,
    s' = { storedTimestamp: s.writeTimestamp, phase: 0, calls: finish(s.calls, 1), ...s },
  }

  // Delivering 10 ms always exhausts a pending fallback's 10 ms timer. A
  // clock jump changes the monotonic observation without delivering that timer;
  // the settlement path must independently reject results at/after deadline.
  action tick = s' = {
    now: s.now + 10,
    phase: if (s.phase == 1) 0 else s.phase,
    sources: if (s.phase == 1) s.sources.replaceAt(s.activeLoader, 1) else s.sources,
    calls: if (s.phase == 1) finish(s.calls, 3) else s.calls, ...s
  }
  action jumpClock = s' = { now: s.now + 10, ...s }

  action invalidate = s' = {
    invalidations: s.invalidations + 1,
    watermark: if (s.now > s.watermark) s.now else s.watermark, ...s
  }
  action futureFence = s' = {
    invalidations: s.invalidations + 1,
    watermark: if (s.now + 20 > s.watermark) s.now + 20 else s.watermark, ...s
  }

  action step = any { beginCall, resolveLoader, rejectLoader, releaseWrite, tick, jumpClock, invalidate, futureFence }

  val oneRegisteredSource = s.sources.select(state => state == 0).length() <= 1
  val registeredFlightHasPendingCalls =
    s.phase == 0 or s.calls.select(result => result == 0).length() > 0
  val writeRequiresAcceptedSource =
    s.phase != 2 or (s.sources.nth(s.activeLoader) == 2 and s.writeTimestamp < s.deadline and s.writeTimestamp > s.observedFence)

  run timedOutLoaderOverlapsNewFlightTest = init.then(beginCall).then(tick).then(beginCall)
    .expect(s.sources == List(1, 0) and s.calls == List(3, 0))

  run acceptedWriteOutlivesDeadlineTest = init.then(beginCall).then(resolveLoader).then(tick)
    .expect(s.phase == 2 and s.calls == List(0)).then(releaseWrite)
    .expect(s.calls == List(1))

  run delayedWriteRemainsFencedTest = init.then(beginCall).then(resolveLoader).then(tick)
    .then(invalidate).then(releaseWrite).then(beginCall)
    .expect(not(readable) and s.calls == List(1, 0) and s.loaders == 2)
}

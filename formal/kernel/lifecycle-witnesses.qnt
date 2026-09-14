module lifecycle_witnesses {
  // This monitor reads only external inputs and public replay observations.
  // It cannot import the kernel or influence which cache transition is enabled.
  // Outcome codes match the portable feature observations: pending 0, values
  // 1/2, source error 3, deadline error 4. now is the controlled elapsed clock.
  type View = {
    calls: List[int], now: int, reads: int, loaders: int, dumps: int, writes: int
  }
  type Input = { name: str, choice: int }
  type Step = { input: Input, observation: View }
  type Pair = { leader: int, follower: int }
  type Monitor = {
    before: View, initialized: bool, identity: int, mixed: bool,
    joins: List[Pair], starts: List[int], settled: Set[int],
    failedCalls: int, failedLoaders: int, timedOutSource: int, replacement: bool,
    acceptedDeadline: int, preparationPastDeadline: bool,
    publishedValue: int, probeCall: int, probeValue: int, probeLoaders: int,
    labels: Set[str]
  }

  pure val emptyView: View = {
    calls: List(), now: 0, reads: 0, loaders: 0, dumps: 0, writes: 0
  }
  pure val emptyMonitor: Monitor = {
    before: emptyView, initialized: false, identity: -1, mixed: false,
    joins: List(), starts: List(), settled: Set(),
    failedCalls: -1, failedLoaders: 0, timedOutSource: -1, replacement: false,
    acceptedDeadline: -1, preparationPastDeadline: false,
    publishedValue: 0, probeCall: -1, probeValue: 0, probeLoaders: 0, labels: Set()
  }
  pure def isValue(result: int): bool = result == 1 or result == 2
  pure def positions(values: List[int]): List[int] =
    values.foldl(List(), (out, _) => out.append(out.length()))
  pure def credit(labels: Set[str], condition: bool, label: str): Set[str] =
    if (condition) labels.union(Set(label)) else labels
  pure def identityOf(choice: int, heldEffects: bool): int = if (heldEffects) 0 else {
    val context = choice / 4
    (if (context == 2 or context == 4) 4 else 0) + choice % 4
  }
  pure def sourceOf(input: Input, heldEffects: bool): int =
    if (input.name == "resolveLoader" and not(heldEffects)) (input.choice - 1) / 2
    else input.choice

  pure def advance(monitor: Monitor, step: Step, heldEffects: bool, budget: int): Monitor = {
    val before = monitor.before
    val observed = step.observation
    val input = step.input
    val begin = input.name == "beginCall"
    val identity = if (begin) identityOf(input.choice, heldEffects) else monitor.identity
    // Conservatively stop earning new labels after another operation/instance
    // enters a history. Previously earned labels remain earned. This avoids
    // claiming a retry or cache probe from an unrelated operation's outcome.
    val mixed = monitor.mixed or (begin and monitor.identity >= 0 and identity != monitor.identity)
    val safe = monitor.initialized and not(mixed)
    val pending = positions(before.calls).select(i => before.calls.nth(i) == 0)
    val joins = if (safe and begin and observed.calls.length() == before.calls.length() + 1
      and observed.calls.nth(observed.calls.length() - 1) == 0 and pending.length() > 0
      and observed.reads == before.reads and observed.loaders == before.loaders)
      monitor.joins.append({ leader: pending.nth(0), follower: before.calls.length() })
      else monitor.joins
    val sharedValue = safe and joins.select(pair =>
      isValue(observed.calls.nth(pair.leader))
      and observed.calls.nth(pair.leader) == observed.calls.nth(pair.follower)).length() > 0
    val sharedFailure = safe and monitor.joins.select(pair =>
      before.calls.nth(pair.leader) == 0 and before.calls.nth(pair.follower) == 0
      and observed.calls.nth(pair.leader) == 3 and observed.calls.nth(pair.follower) == 3).length() > 0
    val failedCalls = if (sharedFailure) observed.calls.length() else monitor.failedCalls
    val failedLoaders = if (sharedFailure) observed.loaders else monitor.failedLoaders
    val retrySucceeded = safe and monitor.failedCalls >= 0
      and observed.loaders > monitor.failedLoaders
      and observed.calls.indices().exists(i => i >= monitor.failedCalls and isValue(observed.calls.nth(i)))
    val starts = if (observed.loaders > before.loaders)
      monitor.starts.append(if (input.name == "tick") observed.now else before.now)
      else monitor.starts
    val sourceSettles = input.name == "resolveLoader" or input.name == "rejectLoader"
    val source = if (sourceSettles) sourceOf(input, heldEffects) else -1
    val unsettled = positions(monitor.starts).select(i => not(monitor.settled.contains(i)))
    val timesOut = safe and not(sourceSettles) and pending.select(i => observed.calls.nth(i) == 4).length() > 0
    val timedOutSource = if (timesOut and unsettled.length() > 0 and monitor.timedOutSource < 0)
      unsettled.nth(unsettled.length() - 1) else monitor.timedOutSource
    val replacement = monitor.replacement or (safe and monitor.timedOutSource >= 0
      and not(monitor.settled.contains(monitor.timedOutSource)) and observed.loaders > before.loaders)
    val lateOldSuppressed = safe and monitor.replacement and sourceSettles
      and source == monitor.timedOutSource and observed.calls == before.calls
      and before.calls.select(result => result == 0).length() > 0
      and observed.dumps == before.dumps and observed.writes == before.writes
    val lateSettlementRejected = safe and heldEffects and sourceSettles and budget > 0
      and source >= 0 and source == starts.length() - 1 and source != timedOutSource
      and not(monitor.settled.contains(source)) and before.now >= starts.nth(source) + budget
      and pending.length() > 0 and pending.select(i => observed.calls.nth(i) != 4).length() == 0
      and observed.dumps == before.dumps and observed.writes == before.writes
    val accepted = safe and heldEffects and input.name == "resolveLoader"
      and source >= 0 and source < starts.length() and source != timedOutSource
      and before.now < starts.nth(source) + budget and observed.dumps > before.dumps
    val acceptedDeadline = if (accepted) starts.nth(source) + budget else monitor.acceptedDeadline
    val preparationPastDeadline = if (accepted) false else monitor.preparationPastDeadline or
      (safe and input.name == "releaseDump" and monitor.acceptedDeadline >= 0
        and before.now >= monitor.acceptedDeadline and observed.writes > before.writes
        and observed.calls.select(result => result == 0).length() > 0)
    val completed = pending.select(i => isValue(observed.calls.nth(i)))
    val latePublication = safe and input.name == "releaseWrite"
      and monitor.preparationPastDeadline and before.now >= monitor.acceptedDeadline
      and completed.length() > 0
    val publication = safe and completed.length() > 0 and
      (input.name == "releaseWrite" or (not(heldEffects)
        and input.name == "resolveLoader" and observed.writes > before.writes))
    val storageReplaced = Set("seed", "seedRemote", "invalidate", "futureFence").contains(input.name)
    val publishedValue = if (storageReplaced) 0 else if (publication)
      observed.calls.nth(completed.nth(0)) else monitor.publishedValue
    val startsProbe = safe and begin and monitor.publishedValue > 0 and pending.length() == 0
      and observed.calls.length() == before.calls.length() + 1
    val probeCall = if (storageReplaced) -1 else if (startsProbe) before.calls.length() else monitor.probeCall
    val probeValue = if (startsProbe) monitor.publishedValue else monitor.probeValue
    val probeLoaders = if (startsProbe) before.loaders else monitor.probeLoaders
    val reused = safe and probeCall >= 0 and observed.calls.nth(probeCall) == probeValue
      and observed.loaders == probeLoaders
    val coalescingLabels = credit(monitor.labels, sharedValue, "coalesced-success")
    val retryLabels = credit(coalescingLabels, retrySucceeded, "shared-failure-retry")
    val timeoutLabels = credit(retryLabels, lateOldSuppressed, "abandoned-source-replacement")
    val settlementLabels = credit(timeoutLabels, lateSettlementRejected,
      if (input.name == "resolveLoader") "late-resolve-rejected" else "late-reject-rejected")
    val publicationLabels = credit(settlementLabels, latePublication, "accepted-publication-after-deadline")
    {
      before: observed, initialized: true,
      identity: if (monitor.identity < 0) identity else monitor.identity, mixed: mixed,
      joins: joins, starts: starts,
      settled: if (sourceSettles) monitor.settled.union(Set(source)) else monitor.settled,
      failedCalls: failedCalls, failedLoaders: failedLoaders,
      timedOutSource: timedOutSource, replacement: replacement,
      acceptedDeadline: acceptedDeadline, preparationPastDeadline: preparationPastDeadline,
      publishedValue: publishedValue,
      probeCall: probeCall, probeValue: probeValue, probeLoaders: probeLoaders,
      labels: credit(publicationLabels, reused, "published-value-reused")
    }
  }

  // This deliberately narrow public setup makes a tracked frame newer than
  // its watermark, then moves the application clock behind the frame. The
  // input prefix establishes the environment; the observations must expose
  // rejection of that future hit followed by completed source publication.
  // No watermark or phase is copied from the kernel into witness bookkeeping.
  pure val futureFrameInputs: List[Input] = List(
    { name: "init", choice: 2 },
    { name: "invalidate", choice: -1 },
    { name: "tick", choice: -1 },
    { name: "seedRemote", choice: -1 },
    { name: "rollbackWall", choice: -1 },
    { name: "beginCall", choice: -1 },
    { name: "releaseRead", choice: 0 },
    { name: "resolveLoader", choice: 0 },
    { name: "releaseDump", choice: -1 },
    { name: "releaseWrite", choice: -1 }
  )
  pure def futureFrameRefills(history: List[Step]): bool =
    history.length() >= futureFrameInputs.length()
      and futureFrameInputs.indices().forall(i => history.nth(i).input == futureFrameInputs.nth(i))
      and history.nth(5).observation.loaders == 0
      and history.nth(6).observation.loaders == 1
      and history.nth(6).observation.calls == List(0)
      and history.nth(7).observation.dumps == 1
      and history.nth(7).observation.calls == List(0)
      and history.nth(8).observation.writes == 1
      and history.nth(9).observation.calls == List(1)

  // These small tracked histories fix input order and identity so public
  // counters distinguish acquired-fence handling from current-watermark
  // handling, and validated local warming from direct source publication.
  // The inputs establish those boundaries; no private fence or cache state
  // participates in the witness predicate.
  pure def hasInputs(history: List[Step], inputs: List[Input]): bool =
    history.length() >= inputs.length()
      and inputs.indices().forall(i => history.nth(i).input == inputs.nth(i))
  pure def hasCounts(view: View, reads: int, loaders: int, dumps: int, writes: int): bool =
    view.reads == reads and view.loaders == loaders and view.dumps == dumps and view.writes == writes

  pure val invalidationBeforeAcquisitionInputs: List[Input] = List(
    { name: "init", choice: 1 },
    { name: "invalidate", choice: 0 },
    { name: "beginCall", choice: 0 },
    { name: "resolveLoader", choice: 1 }
  )
  pure def acquiredFenceSuppressesPublication(history: List[Step]): bool =
    hasInputs(history, invalidationBeforeAcquisitionInputs)
      and history.nth(2).observation.calls == List(0)
      and hasCounts(history.nth(2).observation, 1, 1, 0, 0)
      and history.nth(3).observation.calls == List(1)
      and hasCounts(history.nth(3).observation, 1, 1, 0, 0)

  pure val invalidationAfterAcquisitionInputs: List[Input] = List(
    { name: "init", choice: 1 },
    { name: "beginCall", choice: 0 },
    { name: "invalidate", choice: 0 },
    { name: "resolveLoader", choice: 1 },
    { name: "beginCall", choice: 16 }
  )
  pure def inflightPublicationRemainsFenced(history: List[Step]): bool =
    hasInputs(history, invalidationAfterAcquisitionInputs)
      and history.nth(1).observation.calls == List(0)
      and hasCounts(history.nth(1).observation, 1, 1, 0, 0)
      and history.nth(3).observation.calls == List(1)
      and hasCounts(history.nth(3).observation, 1, 1, 1, 1)
      and history.nth(4).observation.calls == List(1, 0)
      and hasCounts(history.nth(4).observation, 2, 2, 1, 1)

  pure val trackedLocalWarmingInputs: List[Input] = List(
    { name: "init", choice: 1 },
    { name: "beginCall", choice: 12 },
    { name: "resolveLoader", choice: 1 },
    { name: "beginCall", choice: 12 },
    { name: "beginCall", choice: 12 }
  )
  pure def trackedRedisWarmsLocal(history: List[Step]): bool =
    hasInputs(history, trackedLocalWarmingInputs)
      and history.nth(1).observation.calls == List(0)
      and hasCounts(history.nth(1).observation, 1, 1, 0, 0)
      and history.nth(2).observation.calls == List(1)
      and hasCounts(history.nth(2).observation, 1, 1, 1, 1)
      // Every call uses a fresh request scope on the same instance/key.
      // The first probe must validate Redis; only the second may skip it.
      and history.nth(3).observation.calls == List(1, 1)
      and hasCounts(history.nth(3).observation, 2, 1, 1, 1)
      and history.nth(4).observation.calls == List(1, 1, 1)
      and hasCounts(history.nth(4).observation, 2, 1, 1, 1)

  pure def reached(history: List[Step], heldEffects: bool, sourceBudget: int): Set[str] = {
    val lifecycle = history.foldl(emptyMonitor, (monitor, step) => advance(monitor, step, heldEffects, sourceBudget)).labels
    val futureFrameLabels = credit(lifecycle, heldEffects and futureFrameRefills(history), "future-frame-refills-after-source")
    val acquiredFenceLabels = credit(futureFrameLabels,
      not(heldEffects) and acquiredFenceSuppressesPublication(history), "acquired-fence-suppresses-publication")
    val inflightLabels = credit(acquiredFenceLabels,
      not(heldEffects) and inflightPublicationRemainsFenced(history), "inflight-publication-remains-fenced")
    credit(inflightLabels, not(heldEffects) and trackedRedisWarmsLocal(history), "tracked-redis-warms-local")
  }
}

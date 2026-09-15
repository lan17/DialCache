module lifecycle_witnesses {
  // This monitor reads only external inputs and public replay observations.
  // It cannot import the kernel or influence which cache transition is enabled.
  // Outcome codes match the portable feature observations: pending 0, values
  // 1/2, source error 3, deadline error 4. now is the controlled elapsed clock.
  // The kernel advances one Monitor value per step from the previous value and
  // the current step alone; no input history is retained or refolded.
  type View = {
    calls: List[int], now: int, reads: int, loaders: int, dumps: int, writes: int
  }
  type Input = { name: str, choice: int }
  type Step = { input: Input, observation: View }
  type Pair = { leader: int, follower: int }
  // A scripted step fixes one public input and the observation fields that
  // establish its consequence; Any leaves a field unchecked.
  type Expect[a] = Any | Exactly(a)
  type Scripted = {
    input: Input, calls: Expect[List[int]], reads: Expect[int], loaders: Expect[int], dumps: Expect[int], writes: Expect[int]
  }
  type Script = { label: str, heldEffects: bool, steps: List[Scripted] }
  type Monitor = {
    before: View, initialized: bool, identity: int, mixed: bool,
    joins: List[Pair], starts: List[int], settled: Set[int],
    failedCalls: int, failedLoaders: int, timedOutSource: int, replacement: bool,
    acceptedDeadline: int, preparationPastDeadline: bool,
    publishedValue: int, probeCall: int, probeValue: int, probeLoaders: int,
    // Matched prefix length per script, in the order of scripts; -1 once the
    // history departs from that script's inputs or observations.
    cursors: List[int],
    labels: Set[str]
  }

  pure val emptyView: View = {
    calls: List(), now: 0, reads: 0, loaders: 0, dumps: 0, writes: 0
  }
  pure def isValue(result: int): bool = result == 1 or result == 2
  pure def positions(values: List[a]): List[int] =
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

  // Scripted prefixes. Each fixes the public input order and identity so the
  // public counters distinguish the boundary from its nearest alternative,
  // and applies to one view only. The inputs establish the environment; no
  // private fence, watermark, phase or cache state participates.
  pure def scripted(name: str, choice: int): Scripted = {
    input: { name: name, choice: choice },
    calls: Any, reads: Any, loaders: Any, dumps: Any, writes: Any
  }
  pure def expectCalls(step: Scripted, calls: List[int]): Scripted = { calls: Exactly(calls), ...step }
  pure def expectLoaders(step: Scripted, loaders: int): Scripted = { loaders: Exactly(loaders), ...step }
  pure def expectDumps(step: Scripted, dumps: int): Scripted = { dumps: Exactly(dumps), ...step }
  pure def expectWrites(step: Scripted, writes: int): Scripted = { writes: Exactly(writes), ...step }
  pure def expectCounts(step: Scripted, reads: int, loaders: int, dumps: int, writes: int): Scripted = {
    reads: Exactly(reads), loaders: Exactly(loaders), dumps: Exactly(dumps), writes: Exactly(writes), ...step
  }

  // A tracked frame newer than its watermark, then the application clock
  // moved behind the frame. The observations must expose rejection of that
  // future hit followed by completed source publication.
  pure val futureFrameRefills: Script = {
    label: "future-frame-refills-after-source", heldEffects: true,
    steps: List(
      scripted("init", 2),
      scripted("invalidate", -1),
      scripted("tick", -1),
      scripted("seedRemote", -1),
      scripted("rollbackWall", -1),
      scripted("beginCall", -1).expectLoaders(0),
      scripted("releaseRead", 0).expectLoaders(1).expectCalls(List(0)),
      scripted("resolveLoader", 0).expectDumps(1).expectCalls(List(0)),
      scripted("releaseDump", -1).expectWrites(1),
      scripted("releaseWrite", -1).expectCalls(List(1))
    )
  }
  // Invalidation before acquisition: the value returns without serialization
  // or a write.
  pure val acquiredFenceSuppressesPublication: Script = {
    label: "acquired-fence-suppresses-publication", heldEffects: false,
    steps: List(
      scripted("init", 1),
      scripted("invalidate", 0),
      scripted("beginCall", 0).expectCalls(List(0)).expectCounts(1, 1, 0, 0),
      scripted("resolveLoader", 1).expectCalls(List(1)).expectCounts(1, 1, 0, 0)
    )
  }
  // Invalidation after acquisition: publication proceeds under the acquired
  // fence, and a later read of the published frame misses.
  pure val inflightPublicationRemainsFenced: Script = {
    label: "inflight-publication-remains-fenced", heldEffects: false,
    steps: List(
      scripted("init", 1),
      scripted("beginCall", 0).expectCalls(List(0)).expectCounts(1, 1, 0, 0),
      scripted("invalidate", 0),
      scripted("resolveLoader", 1).expectCalls(List(1)).expectCounts(1, 1, 1, 1),
      scripted("beginCall", 16).expectCalls(List(1, 0)).expectCounts(2, 2, 1, 1)
    )
  }
  // Every call uses a fresh request scope on the same instance/key. The first
  // probe must validate Redis; only the second may skip it.
  pure val trackedRedisWarmsLocal: Script = {
    label: "tracked-redis-warms-local", heldEffects: false,
    steps: List(
      scripted("init", 1),
      scripted("beginCall", 12).expectCalls(List(0)).expectCounts(1, 1, 0, 0),
      scripted("resolveLoader", 1).expectCalls(List(1)).expectCounts(1, 1, 1, 1),
      scripted("beginCall", 12).expectCalls(List(1, 1)).expectCounts(2, 1, 1, 1),
      scripted("beginCall", 12).expectCalls(List(1, 1, 1)).expectCounts(2, 1, 1, 1)
    )
  }
  pure val scripts: List[Script] = List(
    futureFrameRefills, acquiredFenceSuppressesPublication, inflightPublicationRemainsFenced, trackedRedisWarmsLocal
  )

  pure val emptyMonitor: Monitor = {
    before: emptyView, initialized: false, identity: -1, mixed: false,
    joins: List(), starts: List(), settled: Set(),
    failedCalls: -1, failedLoaders: 0, timedOutSource: -1, replacement: false,
    acceptedDeadline: -1, preparationPastDeadline: false,
    publishedValue: 0, probeCall: -1, probeValue: 0, probeLoaders: 0,
    cursors: scripts.foldl(List(), (out, _) => out.append(0)),
    labels: Set()
  }

  pure def expected(expectation: Expect[a], actual: a): bool = match expectation {
    Any => true
    | Exactly(value) => value == actual
  }
  pure def matches(scriptedStep: Scripted, step: Step): bool =
    step.input == scriptedStep.input
      and expected(scriptedStep.calls, step.observation.calls)
      and expected(scriptedStep.reads, step.observation.reads)
      and expected(scriptedStep.loaders, step.observation.loaders)
      and expected(scriptedStep.dumps, step.observation.dumps)
      and expected(scriptedStep.writes, step.observation.writes)
  // A departed history stays departed. A completed cursor stays put so the
  // recorded value is stable; the label itself is retained because advance
  // accumulates labels from the previous monitor.
  pure def follow(cursor: int, script: Script, step: Step, heldEffects: bool): int =
    if (cursor < 0 or script.heldEffects != heldEffects) -1
    else if (cursor >= script.steps.length()) cursor
    else if (matches(script.steps.nth(cursor), step)) cursor + 1
    else -1

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
    val cursors = scripts.foldl(List(), (out, script) =>
      out.append(follow(monitor.cursors.nth(out.length()), script, step, heldEffects)))
    val coalescingLabels = credit(monitor.labels, sharedValue, "coalesced-success")
    val retryLabels = credit(coalescingLabels, retrySucceeded, "shared-failure-retry")
    val timeoutLabels = credit(retryLabels, lateOldSuppressed, "abandoned-source-replacement")
    val settlementLabels = credit(timeoutLabels, lateSettlementRejected,
      if (input.name == "resolveLoader") "late-resolve-rejected" else "late-reject-rejected")
    val publicationLabels = credit(settlementLabels, latePublication, "accepted-publication-after-deadline")
    val lifecycleLabels = credit(publicationLabels, reused, "published-value-reused")
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
      cursors: cursors,
      labels: positions(scripts).foldl(lifecycleLabels, (out, i) =>
        credit(out, cursors.nth(i) == scripts.nth(i).steps.length(), scripts.nth(i).label))
    }
  }

  // The labels a complete history earns: the fold of the incremental monitor.
  // The kernel records the same values step by step; this form serves the
  // monitor's own positive and negative controls.
  pure def reached(history: List[Step], heldEffects: bool, sourceBudget: int): Set[str] =
    history.foldl(emptyMonitor, (monitor, step) => advance(monitor, step, heldEffects, sourceBudget)).labels
}

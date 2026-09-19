module dialcache_independent_connection {
  import dialcache_independent_conformance as profile from "./dialcache-independent-conformance"
  import conformance_observations.* from "./conformance-observations"
  import cache_contract.* from "./cache-contract"
  import encodings.* from "./kernel/encodings"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import deadlines as Deadlines from "./kernel/deadlines"
  import clock as Clock from "./kernel/clock"

  // Each independent caller owns its admission policy and later read snapshot.
  // The real profile executes; this projection captures external acquisition
  // fields separately from the library's records and checks retained
  // snapshots, returned values, deadlines and loader origins against them,
  // including reversed completion. A caller's flight is `owners[caller]`
  // (registered when its read is dispatched at admission, so every caller has
  // one), a held read or decode names its flight, a loader ordinal maps to
  // its flight through `loaders`, and a pending deadline is a `Due` the
  // monitor reads before the step.
  var snapshots: List[RecoverySnapshot]
  var sources: List[SourceExecution]
  var before: {
    frame: int, created: int, maximum: int, wall: int, now: int, calls: int, loaderCount: int,
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], deadlines: List[Deadlines::Due], owners: List[int]
  }
  action init = all {
    profile::init,
    snapshots' = List(),
    sources' = List(),
    before' = { frame: 0, created: 0, maximum: 0, wall: 0, now: 0, calls: 0, loaderCount: 0,
      reads: List(), loads: List(), deadlines: List(), owners: List() }
  }

  // The caller a flight completes (no caller coalesces, so at most one), or
  // NO_OWNER for a flight no caller owns; a disowned read names no caller.
  pure def ownerOf(owners: List[int], flight: int): int =
    if (flight < 0) NO_OWNER
    else owners.indices().filter(c => owners.nth(c) == flight).fold(NO_OWNER, (acc, c) => if (acc < 0) c else acc)
  pure def readOwner(owners: List[int], reads: List[RemoteIO::HeldRead], read: int): int = {
    val held = reads.select(h => h.read == read)
    if (held.length() == 0) NO_OWNER else ownerOf(owners, held.nth(0).flight)
  }
  // A reference slot read defensively: a fault that leaves a flight without an
  // owner is a violation of the clause that asked, not an out-of-bounds read.
  pure def snapshotReference(list: List[RecoverySnapshot], owner: int): RecoverySnapshot =
    if (owner < 0 or owner >= list.length()) captureRecovery(NO_OWNER, NO_VALUE, 0, 0, 0) else list.nth(owner)
  pure def sourceReference(list: List[SourceExecution], owner: int): SourceExecution =
    if (owner < 0 or owner >= list.length()) captureSource(NO_OWNER, -1, 0) else list.nth(owner)

  // Snapshots per caller: the maximum admitted from the policy in force before
  // the admission; the frame and stamp acquired when the caller's held read
  // settles while it still owns its flight.
  val admitted = if (profile::s.o.calls.length() > snapshots.length())
    snapshots.append(captureRecovery(before.calls, NO_VALUE, 0, before.maximum, 0)) else snapshots
  val acquired = if (profile::input.name == "releaseRead" or profile::input.name == "failRead") {
    val owner = readOwner(before.owners, before.reads, profile::input.choice)
    if (owner >= 0) admitted.replaceAt(owner, captureRecovery(owner, before.frame, before.created,
      snapshotReference(admitted, owner).maximum, before.wall)) else admitted
  } else admitted

  // One reference slot per caller; -1 means its loader has not started. A
  // read settlement or a failed fresh decode starts the loader at the
  // preceding clock; an advance starts one at each owned read deadline it
  // delivers, even when the advance ends much later. These origins never
  // come from the library's deadline records.
  val sourceSlots = if (profile::s.o.calls.length() > sources.length())
    sources.append(captureSource(before.calls, -1, profile::SOURCE_BUDGET_MS)) else sources
  val observedSources = if (profile::input.name == "advance") {
    before.deadlines.foldl(sourceSlots, (references, due) => {
      val owner = if (due.kind == Deadlines::READ) readOwner(before.owners, before.reads, due.index) else NO_OWNER
      if (owner >= 0 and due.at > before.now and due.at <= before.now + profile::input.choice)
        references.replaceAt(owner, captureSource(owner, due.at, profile::SOURCE_BUDGET_MS))
      else references
    })
  } else if (profile::s.loaders.length() > before.loaderCount) {
    val owner = ownerOf(profile::s.owners, profile::s.loaders.nth(profile::s.loaders.length() - 1))
    if (owner >= 0) sourceSlots.replaceAt(owner, captureSource(owner, before.now, profile::SOURCE_BUDGET_MS)) else sourceSlots
  } else sourceSlots

  action step = all {
    snapshots' = acquired,
    sources' = observedSources,
    before' = { frame: profile::s.remoteValues.nth(0), created: profile::s.created.nth(0), maximum: profile::s.ttls.retentionMs,
      wall: Clock::wallOf(profile::s), now: profile::s.now, calls: profile::s.o.calls.length(),
      loaderCount: profile::s.loaders.length(), reads: profile::s.reads, loads: profile::s.loads,
      deadlines: profile::s.deadlines, owners: profile::s.owners },
    profile::step
  }

  // Every held read that owns its flight carries the maximum its caller was
  // admitted with; every retained snapshot carries that maximum and, when it
  // retains a candidate, the bytes and stamp the caller's own read acquired.
  val independentSnapshotsMatchAcquisition = acquired.length() == profile::s.o.calls.length() and
    profile::s.reads.indices().forall(i => {
      val held = profile::s.reads.nth(i)
      val owner = ownerOf(profile::s.owners, held.flight)
      not(RemoteIO::owning(held)) or (owner >= 0 and held.ttls.retentionMs == snapshotReference(acquired, owner).maximum)
    }) and
    profile::s.retained.indices().forall(i => {
      val snapshot = profile::s.retained.nth(i)
      val owner = ownerOf(profile::s.owners, snapshot.flight)
      val reference = snapshotReference(acquired, owner)
      owner >= 0 and snapshot.maximum == reference.maximum and (snapshot.candidate == NO_VALUE or
        (reference.owner == owner and snapshot.candidate == reference.payload and snapshot.created == reference.created))
    })
  // A served recovery decode returns the acquired bytes to their caller within
  // the acquired maximum at the wall clock of its release.
  val independentRecoveryMatchesContract = profile::input.name != "releaseLoad" or {
    val held = before.loads.select(load => load.load == profile::input.choice)
    held.length() == 0 or not(held.nth(0).recovery) or {
      val owner = ownerOf(before.owners, held.nth(0).flight)
      val returned = if (owner >= 0) profile::s.o.calls.nth(owner) else CALL_PENDING
      owner >= 0 and (profile::s.o.recovery.nth(profile::s.o.recovery.length() - 1) != "served" or
        recoveryReturnAllowed(snapshotReference(snapshots, owner), owner, returned, before.wall))
    }
  }
  // Every loader belongs to the caller whose read settled, failed to decode or
  // expired at its start; while its flight is pending its deadline is that
  // start plus the configured budget and once settled it has none; a value
  // accepted at this resolve step arrived inside that budget. The former
  // timer contract is this clause.
  val independentSourceOriginsMatchContract =
    observedSources.select(source => source.started >= 0).length() == profile::s.loaders.length() and
    profile::s.loaders.indices().forall(ordinal => {
      val flight = profile::s.loaders.nth(ordinal)
      val owner = ownerOf(profile::s.owners, flight)
      val reference = sourceReference(observedSources, owner)
      val source = profile::s.sources.nth(flight)
      owner >= 0 and reference.started >= 0 and reference.owner == owner and
        (source.result != CALL_PENDING or
          Deadlines::deadlineOf(profile::s, Deadlines::SOURCE, ordinal) == reference.started + reference.budget) and
        (source.result == CALL_PENDING or not(Deadlines::bounded(profile::s, Deadlines::SOURCE, ordinal))) and
        (profile::input.name != "resolveLoader" or profile::resolvedSource(profile::input.choice) != ordinal or
          not(accepted(source.result)) or sourceReturnAllowed(reference, owner, profile::s.now))
    })
}

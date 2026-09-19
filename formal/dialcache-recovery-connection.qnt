module dialcache_recovery_connection {
  import dialcache_recovery_read_conformance as profile from "./dialcache-recovery-read-conformance"
  import conformance_observations.* from "./conformance-observations"
  import cache_contract.* from "./cache-contract"
  import encodings.* from "./kernel/encodings"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import remote_frames as Remote from "./kernel/remote-frames"
  import payloads as Payloads from "./kernel/payloads"
  import clock as Clock from "./kernel/clock"

  // Bounded correspondence for the real recovery-read profile, not a second
  // replay machine. Its actions execute unchanged. This monitor acquires a
  // reference snapshot from storage when the held read settles (the frame's
  // payload code decoded, its stamp, the maximum admitted from the policy in
  // force before the caller's admission, the wall clock of the settlement)
  // and checks the library's held reads, retained snapshots, pending sources
  // and returned observations against that acquired record, reading storage
  // fields and library records only, never a kernel judgment under test. One
  // active call and the profile's finite domain bound this connection; no
  // fairness claim.
  var snapshot: RecoverySnapshot
  var capturedMaximum: int
  var before: {
    payload: int, created: int, wall: int, calls: int, maximum: int, valid: bool,
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], dumps: int, writes: int, localValues: List[int]
  }

  action init = all {
    profile::init,
    snapshot' = captureRecovery(NO_OWNER, NO_VALUE, 0, 0, 0),
    capturedMaximum' = 0,
    before' = { payload: NO_VALUE, created: 0, wall: 0, calls: 0, maximum: 0, valid: false,
      reads: List(), loads: List(), dumps: 0, writes: 0, localValues: List() }
  }
  // Admission acquires the preceding policy reply's retention as the maximum,
  // independently of the held read's record. A held read cannot acquire a
  // later reply; one caller at a time, so one captured maximum suffices.
  val admittedMaximum = if (profile::input.name == "beginCall") before.maximum else capturedMaximum
  // Capture immediately after the profile's read settles, from the storage
  // fields the read observed (the state before the step), not from the
  // library's snapshot: confusing those must be detectable. The payload is
  // recorded decoded, as a recovery returns it.
  val acquired = if (profile::input.name == "releaseRead")
    captureRecovery(before.calls - 1, Payloads::valueOf(before.payload), before.created, admittedMaximum, before.wall)
    else snapshot

  action step = all {
    snapshot' = acquired,
    capturedMaximum' = admittedMaximum,
    before' = {
      payload: profile::s.remoteValues.nth(0), created: profile::s.created.nth(0), wall: Clock::wallOf(profile::s),
      calls: profile::s.o.calls.length(), maximum: profile::s.ttls.retentionMs,
      // A frame a read can observe: visible, and not of a code that fails the read.
      valid: Remote::visible(profile::s, 0, 1) and not(Payloads::readFails(profile::s.remoteValues.nth(0))),
      reads: profile::s.reads, loads: profile::s.loads, dumps: profile::s.o.dumps, writes: profile::s.o.writes,
      localValues: profile::s.localValues
    },
    profile::step
  }

  // Every held read carries the maximum its caller was admitted with; every
  // retained snapshot carries that maximum and, when it retains a candidate,
  // the bytes (decoded) and stamp the caller's own read acquired.
  val retainedSnapshotMatchesAcquisition =
    profile::s.reads.indices().forall(i => profile::s.reads.nth(i).ttls.retentionMs == admittedMaximum) and
    profile::s.retained.indices().forall(i => {
      val retained = profile::s.retained.nth(i)
      retained.maximum == admittedMaximum and (retained.candidate == NO_VALUE or
        (acquired.owner == profile::s.o.calls.length() - 1 and
          Payloads::valueOf(retained.candidate) == acquired.payload and retained.created == acquired.created))
    })
  // A served recovery decode returns the acquired bytes to their caller within
  // the acquired maximum at the wall clock of its release.
  val recoveryReturnMatchesAcquiredContract = profile::input.name != "releaseLoad" or
    before.loads.select(load => load.recovery).length() == 0 or
    profile::s.o.recovery.nth(profile::s.o.recovery.length() - 1) != "served" or
    recoveryReturnAllowed(snapshot, before.calls - 1, profile::s.o.calls.nth(before.calls - 1), before.wall)
  // When a held read settles on a frame it can observe, a decode is held
  // exactly when the frame's age at the settlement wall clock lies in [0, the
  // admitted freshness). The arithmetic is restated here rather than taken
  // from cache_rules, so the clause is independent of the judgment under test.
  val freshnessUsesReadSettlement = profile::input.name != "releaseRead" or
    before.reads.length() == 0 or not(before.valid) or {
      val age = before.wall - before.created
      (profile::s.loads.length() > 0) == (age >= 0 and age < before.reads.nth(0).ttls.freshMs)
    }
  // A recovery decode's settlement publishes nothing shared: no dump, no
  // write and no local entry (C43, C45).
  val recoveredResultsNeverPublishShared = profile::input.name != "releaseLoad" or
    before.loads.select(load => load.recovery).length() == 0 or
    (profile::s.o.dumps == before.dumps and profile::s.o.writes == before.writes and profile::s.localValues == before.localValues)
  // Every held read carries the admitted TTLs; every pending source captured
  // either no retention (its read has not settled, or it may not refill) or
  // the admitted maximum, capped at the tracked cap for a tracked entity
  // (C37): the write that follows carries exactly this retention.
  val sourcesCarryCappedAdmittedRetention =
    profile::s.reads.indices().forall(i => profile::s.reads.nth(i).ttls.retentionMs == admittedMaximum) and
    profile::s.sources.indices().forall(i => {
      val source = profile::s.sources.nth(i)
      source.result != CALL_PENDING or source.retentionMs == 0 or source.retentionMs ==
        (if (profile::s.tracked and admittedMaximum > Remote::TRACKED_RETENTION_CAP_MS) Remote::TRACKED_RETENTION_CAP_MS else admittedMaximum)
    })
}

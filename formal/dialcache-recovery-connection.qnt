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
  // payload code, raw and decoded, its stamp, the maximum admitted from the
  // policy in force before the caller's admission, the wall clock of the
  // settlement) and checks the library's held reads, retained snapshots,
  // pending sources and returned observations against that acquired record,
  // reading storage fields and library records only: whether the frame is
  // present, retained and fence-cleared is restated here from the raw fields,
  // never taken from the kernel judgment under test. Two payload tables are
  // shared with the kernel, `Payloads::valueOf` (cache_contract's
  // recoveryReturnAllowed compares decoded values) and the class test
  // `Payloads::readFails`. The monitor assumes every seed is a value below
  // 100 or a class code plus a positive value, as the profile's seed table
  // is: a fresh observable frame storing a bare class code decodes to
  // NO_VALUE and holds no decode where `freshnessUsesReadSettlement` expects
  // one. One active call and the profile's finite domain bound this
  // connection; no fairness claim.
  var snapshot: RecoverySnapshot
  // The raw code the read acquired, beside the decoded snapshot: a retained
  // candidate must be that code, not another code with the same value.
  var snapshotCode: int
  var capturedMaximum: int
  var before: {
    payload: int, created: int, wall: int, calls: int, maximum: int, valid: bool,
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], dumps: int, writes: int,
    localValues: List[int], localExpires: List[int], lru: List[List[int]]
  }

  action init = all {
    profile::init,
    snapshot' = captureRecovery(NO_OWNER, NO_VALUE, 0, 0, 0),
    snapshotCode' = NO_VALUE,
    capturedMaximum' = 0,
    before' = { payload: NO_VALUE, created: 0, wall: 0, calls: 0, maximum: 0, valid: false,
      reads: List(), loads: List(), dumps: 0, writes: 0, localValues: List(), localExpires: List(), lru: List() }
  }
  // Admission acquires the preceding policy reply's retention as the maximum,
  // independently of the held read's record. A held read cannot acquire a
  // later reply; one caller at a time, so one captured maximum suffices.
  val admittedMaximum = if (profile::input.name == "beginCall") before.maximum else capturedMaximum
  // The step that settled the held read, and the one that settled a recovery
  // decode (a held decode released while a recovery decode was held).
  val settlingRead = profile::input.name == "releaseRead"
  val recoveryDecodeSettling = profile::input.name == "releaseLoad" and before.loads.select(load => load.recovery).length() > 0
  // Capture immediately after the profile's read settles, from the storage
  // fields the read observed (the state before the step), not from the
  // library's snapshot: confusing those must be detectable. The payload is
  // recorded decoded, as a recovery returns it, and raw, as a snapshot
  // retains it.
  val acquired = if (settlingRead)
    captureRecovery(before.calls - 1, Payloads::valueOf(before.payload), before.created, admittedMaximum, before.wall)
    else snapshot
  val acquiredCode = if (settlingRead) before.payload else snapshotCode

  action step = all {
    snapshot' = acquired,
    snapshotCode' = acquiredCode,
    capturedMaximum' = admittedMaximum,
    before' = {
      payload: profile::s.remoteValues.nth(0), created: profile::s.created.nth(0), wall: Clock::wallOf(profile::s),
      calls: profile::s.o.calls.length(), maximum: profile::s.ttls.retentionMs,
      // A frame a read can observe, from the raw fields: present, retained
      // (the monotonic clock before its expiry, cache_rules.deadlinePendingAt
      // restated), fence-cleared for a tracked reader (stamped strictly above
      // its entity's watermark, cache_rules.fenceAllows restated) and not of
      // a class that fails the read.
      valid: profile::s.remoteValues.nth(0) > NO_VALUE and profile::s.now < profile::s.expires.nth(0) and
        (not(profile::s.tracked) or profile::s.created.nth(0) > profile::s.watermark.nth(0)) and
        not(Payloads::readFails(profile::s.remoteValues.nth(0))),
      reads: profile::s.reads, loads: profile::s.loads, dumps: profile::s.o.dumps, writes: profile::s.o.writes,
      localValues: profile::s.localValues, localExpires: profile::s.localExpires, lru: profile::s.lru
    },
    profile::step
  }

  // Every held read carries the maximum its caller was admitted with.
  val heldReadsCarryAdmittedMaximum =
    profile::s.reads.indices().forall(i => profile::s.reads.nth(i).ttls.retentionMs == admittedMaximum)
  // Every held read carries the admitted maximum; every retained snapshot
  // carries that maximum and, when it retains a candidate, the very code and
  // the stamp the caller's own read acquired.
  val retainedSnapshotMatchesAcquisition =
    heldReadsCarryAdmittedMaximum and
    profile::s.retained.indices().forall(i => {
      val retained = profile::s.retained.nth(i)
      retained.maximum == admittedMaximum and (retained.candidate == NO_VALUE or
        (acquired.owner == profile::s.o.calls.length() - 1 and
          retained.candidate == acquiredCode and retained.created == acquired.created))
    })
  // A served recovery decode returns the acquired bytes to their caller within
  // the acquired maximum at the wall clock of its release.
  val recoveryReturnMatchesAcquiredContract = not(recoveryDecodeSettling) or
    profile::s.o.recovery.nth(profile::s.o.recovery.length() - 1) != "served" or
    recoveryReturnAllowed(snapshot, before.calls - 1, profile::s.o.calls.nth(before.calls - 1), before.wall)
  // When a held read settles, a decode is held exactly when the frame is
  // observable (present, retained, fence-cleared and readable, from the raw
  // fields) and its age at the settlement wall clock lies in [0, the admitted
  // freshness). Stated both ways, so a kernel that holds a decode of a frame
  // the raw fields say is expired or fenced fails it too. The arithmetic is
  // restated here rather than taken from cache_rules, so the clause is
  // independent of the judgment under test.
  val freshnessUsesReadSettlement = not(settlingRead) or
    before.reads.length() == 0 or {
      val age = before.wall - before.created
      (profile::s.loads.length() > 0) == (before.valid and age >= 0 and age < before.reads.nth(0).ttls.freshMs)
    }
  // A recovery decode's settlement publishes nothing shared: no dump, no
  // write and no local publication, the slot's value, expiry and recency
  // unchanged, so a re-warm of the value the slot already holds is seen too
  // (C43, C45).
  val recoveredResultsNeverPublishShared = not(recoveryDecodeSettling) or
    (profile::s.o.dumps == before.dumps and profile::s.o.writes == before.writes and
      profile::s.localValues == before.localValues and profile::s.localExpires == before.localExpires and profile::s.lru == before.lru)
  // Every pending source captured either no retention (its read has not
  // settled, or it may not refill) or the admitted maximum, capped at the
  // tracked cap for a tracked entity (C37): the write that follows carries
  // exactly this retention.
  val sourcesCarryCappedAdmittedRetention =
    profile::s.sources.indices().forall(i => {
      val source = profile::s.sources.nth(i)
      source.result != CALL_PENDING or source.retentionMs == 0 or source.retentionMs ==
        (if (profile::s.tracked and admittedMaximum > Remote::TRACKED_RETENTION_CAP_MS) Remote::TRACKED_RETENTION_CAP_MS else admittedMaximum)
    })
}

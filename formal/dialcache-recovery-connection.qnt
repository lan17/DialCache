module dialcache_recovery_connection {
  import dialcache_recovery_conformance as profile from "./dialcache-recovery-conformance"
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import recovery as Recovery from "./kernel/recovery"
  import payloads as Payloads from "./kernel/payloads"
  import clock as Clock from "./kernel/clock"

  // Bounded correspondence for the composed recovery profile, not a second
  // replay machine: its actions execute unchanged and this monitor keeps the
  // profile's previous state to state one-step facts the profile's own
  // invariants cannot (the profile carries no receipt of a served recovery and
  // no record of who was pending). It reads storage fields, the drivers'
  // channels and the library records; the age arithmetic is restated here,
  // never taken from cache_rules. One flight at a time bounds it; no fairness claim.
  var before: profile::State

  action init = all { profile::init, before' = profile::initialState(0) }
  action step = all { before' = profile::s, profile::step }

  // The step that settled a recovery decode, and whether it served.
  val recoveryDecodeSettling = profile::input.name == "releaseLoad" and
    before.loads.length() > 0 and RemoteIO::latestLoad(before).recovery
  val served = profile::s.o.recovery.length() > before.o.recovery.length() and
    profile::s.o.recovery.nth(profile::s.o.recovery.length() - 1) == "served"
  val servedFlight = RemoteIO::latestLoad(before).flight
  val servedSnapshot = Recovery::retainedFor(before, servedFlight)
  // The step that dispatched a read, and the flight it registered (the newest source).
  val readDispatched = profile::s.o.reads > before.o.reads
  val newFlight = profile::s.sources.length() - 1

  // C45: a recovered value was served at a wall clock at or after its stamp
  // and strictly less than the maximum admitted for it, at the settlement's
  // wall clock (clocks do not move in a release). The former profile
  // invariant of the same name over receipts, restated one step.
  val recoveredValueWasWithinAcceptedAge = not(recoveryDecodeSettling and served) or {
    val wall = Clock::wallOf(before)
    servedSnapshot.created <= wall and wall - servedSnapshot.created < servedSnapshot.maximum
  }
  // C24/C43: a served recovery completes every caller its flight owned that
  // was pending with the value the candidate decodes to, and changes no
  // other caller's outcome (the former legacy monitor's flightRecoveryMatchesContract).
  val recoveredFlightCompletesEveryOwner = not(recoveryDecodeSettling and served) or
    before.o.calls.indices().forall(c =>
      if (before.owners.nth(c) == servedFlight and before.o.calls.nth(c) == CALL_PENDING)
        profile::s.o.calls.nth(c) == Payloads::valueOf(servedSnapshot.candidate)
      else profile::s.o.calls.nth(c) == before.o.calls.nth(c))
  // C44: the snapshot a read retains is the frame the read acquired, under
  // the maximum in force at admission: its candidate is that frame's code
  // (or none), its stamp the frame's, its maximum the policy's retention
  // (the former legacy monitor's flightKeepsAcquiredSnapshot).
  val retainedSnapshotMatchesAcquisition = not(readDispatched) or
    profile::s.retained.indices().forall(i => {
      val snapshot = profile::s.retained.nth(i)
      snapshot.flight != newFlight or (snapshot.maximum == before.ttls.retentionMs and
        snapshot.created == before.created.nth(profile::KEY) and
        (snapshot.candidate == NO_VALUE or snapshot.candidate == before.remoteValues.nth(profile::KEY)))
    })
  // A recovered value publishes nothing shared: no dump and no write.
  val recoveredResultsNeverPublishShared = not(recoveryDecodeSettling) or
    (profile::s.o.dumps == before.o.dumps and profile::s.o.writes == before.o.writes)

  // Follow-up recorded for this slice (PR 188): the candidate window pinned
  // against the raw frame age at acquisition, independently of the recheck.
  // At a step that dispatched a read, the new flight holds a snapshot unless
  // the read failed or the frame was fresh; its candidate is the frame code
  // exactly when the frame was visible (present, unexpired, above the
  // watermark) at an age in [fresh, maximum), else none.
  val retainedCandidateWindow = not(readDispatched) or {
    val wall = Clock::wallOf(before)
    val created = before.created.nth(profile::KEY)
    val code = before.remoteValues.nth(profile::KEY)
    val visible = code > NO_VALUE and before.now < before.expires.nth(profile::KEY) and created > before.watermark.nth(profile::ENTITY)
    val age = wall - created
    val isFresh = visible and created <= wall and age < before.ttls.freshMs
    val window = visible and created <= wall and age >= before.ttls.freshMs and age < before.ttls.retentionMs
    val snapshot = Recovery::retainedFor(profile::s, newFlight)
    if (before.readFailed or isFresh) snapshot.flight == NO_OWNER
    else snapshot.flight == newFlight and snapshot.candidate == (if (window) code else NO_VALUE)
  }
}

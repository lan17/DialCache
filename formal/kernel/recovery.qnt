module recovery {
  // Stale-on-error recovery (C40 to C46, C57): the snapshot a flight retains
  // when its held remote read settles without serving, the classification of
  // the flight's loader failure, and the recheck of the snapshot's age when
  // the recovery decode settles. This module holds codes, one pending-only
  // record and judgments; `remote_io` consults them at read settlement
  // (`retain`), at loader failure (`failure`, `missed`) and at recovery-decode
  // settlement (`recovered`), and drops the snapshot when the flight
  // completes. No profile composes a recovery transition: a held profile
  // passes the classifier in force to `remote_io::settleRead` (`NONE` where
  // stale-on-error is not configured, so no snapshot is ever created and
  // every judgment reads NO_SNAPSHOT).
  //
  // The rules: a candidate is the frame the read found visible whose payload
  // code decodes to a value (`payloads::valueOf`; a code whose bytes fail to
  // decode still decodes to the value they would carry, so it is a candidate
  // its recovery decode fails) and whose age on the wall clock at settlement
  // lies in [freshness, maximum) (`cache_rules.retainedAgeAllowed`), with
  // both from the effective TTLs the reply resolved to, the maximum being the
  // logical retention (C45: a later policy is not consulted); its stamp is
  // the frame's `created` at the read. A visible frame outside that window,
  // or one whose code decodes to nothing (a code in the enveloped band that
  // names no class; a code that fails the read never reaches `retain`),
  // leaves the flight recoverable without a candidate, so a classification
  // then reports a miss. A loader failure is
  // classified once (the classifications count instruments every classifier
  // but the built-in timeout-only default); recovery is allowed by ALLOW, or
  // by TIMEOUT_ONLY for a timeout (a delivered or late deadline, or a
  // propagated timeout the profile names; `failure` decides which errors are
  // timeouts, judged once for whichever path consults it, `remote_io::failed`
  // today); DENY never recovers, and a profile decodes a
  // classifier that throws to DENY, as the implementations do. A recovery
  // decode is held while the candidate's age still allows it
  // (`cache_rules.recoveryAgeAllowed`, no fresh lower bound: a wall rollback
  // may make it fresh again) and its settlement rechecks the same; the served
  // value is what the candidate's code decodes to, and a flight that does not
  // serve it completes with the outcome its source recorded
  // (`remote_io::settleLoad`). A recovered value completes its flight without
  // publication.
  import cache_rules.* from "../cache-rules"
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import layer_policy.* from "./layer-policy"
  import clock as Clock from "./clock"
  import remote_frames as Remote from "./remote-frames"
  import payloads as Payloads from "./payloads"

  // Classifier codes (a profile decodes its drivers' codes to these); NONE
  // is the code of a profile without stale-on-error, which retains nothing.
  pure val NONE = -1
  pure val TIMEOUT_ONLY = 0
  pure val ALLOW = 1
  pure val DENY = 2

  // Per recoverable flight: the candidate's payload code (0 when none), the
  // frame's stamp at the read, the maximum admitted for it and the classifier
  // in force. A flight retains at most once (its one held read settles once)
  // and `drop` runs at its completion, so the list holds one snapshot per
  // flight.
  type Snapshot = { flight: int, candidate: int, created: int, maximum: int, classifier: int }
  pure val NO_SNAPSHOT: Snapshot = { flight: NO_OWNER, candidate: NO_VALUE, created: 0, maximum: 0, classifier: NONE }
  type Recovering[r] = Remote::Frames[{ o: Observation, retained: List[Snapshot] | r }]

  pure def retainedFor(state: Recovering[r], flight: int): Snapshot = {
    val found = state.retained.select(snapshot => snapshot.flight == flight)
    if (found.length() == 0) NO_SNAPSHOT else found.nth(0)
  }
  pure def drop(state: Recovering[r], flight: int): Recovering[r] =
    { retained: state.retained.select(other => other.flight != flight), ...state }

  // At read settlement, for a read that completed without serving: the
  // snapshot of the flight under the classifier in force, with the visible
  // frame's code as its candidate when it decodes to a value and its age lies
  // in [freshness, maximum).
  pure def retain(state: Recovering[r], flight: int, key: int, visible: bool, ttls: Ttls, classifier: int): Recovering[r] =
    if (classifier == NONE) state else {
      val created = state.created.nth(key)
      val code = state.remoteValues.nth(key)
      val stale = visible and retainedAgeAllowed(created, Clock::wallOf(state), ttls.freshMs, ttls.retentionMs)
      { retained: state.retained.append({
        flight: flight,
        candidate: if (stale and Payloads::valueOf(code) > NO_VALUE) code else NO_VALUE,
        created: created,
        maximum: ttls.retentionMs,
        classifier: classifier
      }), ...state }
    }

  // Classification at loader failure, for the snapshot the flight retained.
  pure def classifies(snapshot: Snapshot): bool = snapshot.classifier != TIMEOUT_ONLY
  pure def mayRecover(snapshot: Snapshot, timeout: bool): bool =
    snapshot.classifier == ALLOW or (snapshot.classifier == TIMEOUT_ONLY and timeout)
  pure def validCandidate(state: Recovering[r], snapshot: Snapshot): bool =
    snapshot.candidate > NO_VALUE and recoveryAgeAllowed(snapshot.created, Clock::wallOf(state), snapshot.maximum)
  // The classification counted.
  pure def classified(state: Recovering[r], snapshot: Snapshot): Recovering[r] =
    { o: { classifications: state.o.classifications + (if (classifies(snapshot)) 1 else 0), ...state.o }, ...state }
  pure def recordOutcome(state: Recovering[r], label: str): Recovering[r] =
    { o: { recovery: state.o.recovery.append(label), ...state.o }, ...state }
  // A loader failure judged once for whichever path consults it: the
  // classification counted; whether recovery is allowed (the classifier, and
  // whether the failure is a timeout: a deadline error, or a propagated
  // timeout the profile names); whether the candidate then serves (recovery
  // allowed and its age still admitted). What follows is the path's: a held
  // recovery decode (`remote_io::failed`).
  type Failure[r] = { state: Recovering[r], recovers: bool, serves: bool }
  pure def failure(state: Recovering[r], snapshot: Snapshot, error: int, timeout: bool): Failure[r] = {
    val counted = classified(state, snapshot)
    val recovers = mayRecover(snapshot, timeout or error == DEADLINE_ERROR)
    { state: counted, recovers: recovers, serves: recovers and validCandidate(counted, snapshot) }
  }
  // A failure that does not serve: a miss reported when recovery was allowed.
  pure def missed(judged: Failure[r]): Recovering[r] =
    if (judged.recovers) recordOutcome(judged.state, "miss") else judged.state
  // What a recovery decode settles to: the label and whether the candidate serves.
  type Recovered = { label: str, served: bool }
  pure def recovered(state: Recovering[r], snapshot: Snapshot, failed: bool): Recovered = {
    val served = not(failed) and validCandidate(state, snapshot)
    { label: if (failed) "deserialization_error" else if (served) "served" else "miss", served: served }
  }
}

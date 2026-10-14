module recovery {
  // Stale-on-error recovery (C40 to C46, C57) as a consulted record: the snapshot a flight
  // retains when its remote read completes without serving, and the judgments read when its
  // loader fails and when its recovery decode settles.
  //
  // Rules
  // - A candidate is the visible frame whose code decodes to a value and whose age at settlement
  //   lies in [freshness, maximum), both from the reply's effective TTLs (`retain`; C40, C44, C45).
  // - A loader failure is classified once; ALLOW recovers, TIMEOUT_ONLY recovers a timeout, DENY
  //   never does, and a classifier that throws decodes to DENY (`failure`, `mayRecover`; C41, C43).
  // - A recovery decode is held while the candidate's age still allows it and its settlement
  //   rechecks the same (`validCandidate`, `recovered`; C45).
  // - A recovered value completes its flight without publication (C43); a flight that does not
  //   serve it completes with the outcome its source recorded (`remote_io::settleLoad`).
  // - No profile composes a recovery transition: `remote_io` and `remote_writes` consult these
  //   judgments and a profile passes the classifier in force (`NONE` without stale-on-error).
  // Shapes
  // - Snapshot: the candidate code, its stamp, its maximum and the classifier; one per flight.
  // - Recovering[r]: `remote_frames::Frames` with the retained snapshots; what the judgments read.
  // - Failure[r], Recovered: what `failure` and `recovered` return, each saying whether it serves.
  // Consumers: admission, dark-layers, effects, independent, recovery, recovery-read, shadow,
  //   shadow-layers, shadow-read-deadlines; composed through `remote_io`, `remote_writes` and
  //   `diagnostics`.
  import cache_rules.* from "../cache-rules"
  import cache_contract as Contract from "../cache-contract"
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

  // Per recoverable flight, a pending-only record: the candidate's payload
  // code (0 when none), the frame's stamp at the read, the maximum admitted
  // for it and the classifier in force. A flight retains at most once (its
  // one held read settles once) and `drop` runs at its completion, so the
  // list holds one snapshot per flight. A profile passes the classifier in
  // force to `remote_io::settleRead` or `remote_writes::releaseJudged`; under
  // `NONE` no snapshot is ever created and every judgment reads NO_SNAPSHOT.
  type Snapshot = { flight: int, candidate: int, created: int, maximum: int, classifier: int }
  pure val NO_SNAPSHOT: Snapshot = { flight: NO_OWNER, candidate: NO_VALUE, created: 0, maximum: 0, classifier: NONE }
  type Recovering[r] = Remote::Frames[{ o: Observation, retained: List[Snapshot] | r }]

  pure def retainedFor(state: Recovering[r], flight: int): Snapshot = {
    val found = state.retained.select(snapshot => snapshot.flight == flight)
    if (found.length() == 0) NO_SNAPSHOT else found.nth(0)
  }
  // The snapshot dropped when its flight completes: `remote_io` and
  // `remote_writes` drop it beside `serving::complete`.
  pure def drop(state: Recovering[r], flight: int): Recovering[r] =
    { retained: state.retained.select(other => other.flight != flight), ...state }

  // At read settlement, for a read that completed without serving: the
  // snapshot of the flight under the classifier in force, with the visible
  // frame's code as its candidate when it decodes to a value and its age lies
  // in [freshness, maximum). `remote_io` retains here when a held read
  // settles, `remote_writes` at release on the atomic path. The code decodes
  // through `payloads::valueOf`: a code whose bytes fail to decode still
  // decodes to the value they would carry, so it is a candidate its recovery
  // decode fails. The age is judged on the wall clock at settlement
  // (`cache_rules.retainedAgeAllowed`) against the effective TTLs the reply
  // resolved to, the maximum being the logical retention (C45: a later policy
  // is not consulted). The stamp is the frame's `created` at the read. A
  // visible frame outside that window, or one whose code decodes to nothing
  // (a code in the enveloped band that names no class), leaves the flight
  // recoverable without a candidate, so a classification then reports a
  // miss. A code that fails the read never reaches `retain`.
  pure def retain(state: Recovering[r], flight: int, key: int, visible: bool, ttls: Ttls, classifier: int): Recovering[r] =
    if (classifier == NONE) state else {
      val created = state.created.nth(key)
      val code = state.remoteValues.nth(key)
      val stale = visible and retainedAgeAllowed(created, Clock::wallOf(state), ttls.freshMs, ttls.retentionMs)
      { retained: state.retained.append({
        flight: flight,
        candidate: if (stale and Payloads::valueOf(code) > NO_VALUE) code else NO_VALUE,
        created: Contract::retainedFrameStamp(created, Clock::wallOf(state)),
        maximum: ttls.retentionMs,
        classifier: classifier
      }), ...state }
    }

  // Classification at loader failure, for the snapshot the flight retained:
  // the classifications count instruments every classifier but the built-in
  // timeout-only default (`classifies`); recovery is allowed by ALLOW, or by
  // TIMEOUT_ONLY for a timeout, and DENY never recovers (`mayRecover`). A
  // profile decodes a classifier that throws to DENY, as the implementations
  // do.
  pure def classifies(snapshot: Snapshot): bool = snapshot.classifier != TIMEOUT_ONLY
  pure def mayRecover(snapshot: Snapshot, timeout: bool): bool =
    snapshot.classifier == ALLOW or (snapshot.classifier == TIMEOUT_ONLY and timeout)
  // The candidate still serves while its age allows it under the maximum the
  // snapshot captured, judged at loader failure and again at recovery-decode
  // settlement (C45). The judgment is `cache_rules.retainedCandidateAgeAllowed`,
  // which is `recoveryAgeAllowed`: no fresh lower bound, since a wall rollback
  // may make the candidate fresh again.
  pure def validCandidate(state: Recovering[r], snapshot: Snapshot): bool =
    snapshot.candidate > NO_VALUE and retainedCandidateAgeAllowed(snapshot.created, Clock::wallOf(state), snapshot.maximum)
  // The classification counted.
  pure def classified(state: Recovering[r], snapshot: Snapshot): Recovering[r] =
    { o: { classifications: state.o.classifications + (if (classifies(snapshot)) 1 else 0), ...state.o }, ...state }
  pure def recordOutcome(state: Recovering[r], label: str): Recovering[r] =
    { o: { recovery: state.o.recovery.append(label), ...state.o }, ...state }
  // A loader failure judged once for the path that consults it, the held one
  // (`remote_io::failed`) or the atomic one (`remote_writes::failed`). The
  // classification is counted. Recovery is allowed by the classifier and by
  // whether the failure is a timeout: a delivered or late deadline (the
  // deadline error) or a propagated timeout the profile names; `failure`
  // decides which errors are timeouts. The candidate then serves when
  // recovery is allowed and its age is still admitted; a miss is recorded
  // when recovery was allowed and it does not. What follows is the path's: a
  // held recovery decode or an immediate one.
  type Failure[r] = { state: Recovering[r], serves: bool }
  pure def failure(state: Recovering[r], snapshot: Snapshot, error: int, timeout: bool): Failure[r] = {
    val counted = classified(state, snapshot)
    val recovers = mayRecover(snapshot, timeout or error == DEADLINE_ERROR)
    val serves = recovers and validCandidate(counted, snapshot)
    { state: if (recovers and not(serves)) recordOutcome(counted, "miss") else counted, serves: serves }
  }
  // What a recovery decode settles to: the label and whether the candidate
  // serves, its age rechecked at settlement (C45). The served value is what
  // the candidate's code decodes to; a flight that does not serve it
  // completes with the outcome its source recorded (`remote_io::settleLoad`),
  // and a recovered value completes its flight without publication (C43).
  type Recovered = { label: str, served: bool }
  pure def recovered(state: Recovering[r], snapshot: Snapshot, failed: bool): Recovered = {
    val served = not(failed) and validCandidate(state, snapshot)
    { label: if (failed) "deserialization_error" else if (served) "served" else "miss", served: served }
  }
}

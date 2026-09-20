module dialcache_shadow_layers_connection {
  import dialcache_shadow_layers_conformance as profile from "./dialcache-shadow-layers-conformance"
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import remote_frames as Remote from "./kernel/remote-frames"
  import flights as Flights from "./kernel/flights"
  import shadow as Shadow from "./kernel/shadow"

  // The profile executes; this monitor keeps the state before each step and
  // states, one step at a time, what the old text's captured records stated
  // over the whole history: a job's admission facts (the policy in force, the
  // frame it read) and the writer of a local slot exist only in the pre-state
  // of the step that admitted the job or published the value, so the clauses
  // read that pre-state instead of a record the kernel does not carry.
  var before: profile::State
  action init = all { profile::init, before' = profile::INITIAL }
  action step = all { before' = profile::s, profile::step }

  pure def owned(state: profile::State, source: int): bool = Flights::ownedBy(state, source).size() > 0
  pure def identityOf(state: profile::State, source: int): int =
    state.sources.nth(source).instance * profile::KEYS + state.sources.nth(source).key
  val admitted = profile::s.jobs.indices().filter(i => i >= before.jobs.length())
  val lastCall = profile::s.o.calls.length() - 1

  // A caller no source owns was served by a layer at its release and keeps
  // that outcome: no settlement names it (hitResultsAreImmutable).
  val servedCallersKeepTheirOutcome = before.o.calls.indices().forall(c =>
    before.owners.nth(c) >= 0 or profile::s.o.calls.nth(c) == before.o.calls.nth(c))
  // A job is admitted only under a policy whose cohort selection is on
  // (disabledCohortsNeverOwnJobs: the disabled codes are the ones whose
  // decoded selection is false), at a caller's release.
  val jobsAdmittedOnlyWhenSelected = admitted.forall(_ => before.shadow and profile::input.name == "beginCall")
  // A job captures the retention the reply in force at its admission resolved
  // to (retentionComesFromAdmissionPolicy: 180 s under the changed-fill code,
  // 120 s otherwise, which is `ttlsFor`'s table).
  val jobsCaptureAdmissionRetention = admitted.forall(i => profile::s.jobs.nth(i).retentionMs == before.ttls.retentionMs)
  // A job's C0, when it has one, is the payload the remote layer held fresh
  // for the admitting reply's freshness at admission (retainedC0WasFreshWhenAcquired).
  val retainedC0WasFreshWhenAcquired = admitted.forall(i => {
    val job = profile::s.jobs.nth(i)
    val key = profile::s.sources.nth(job.source).key
    val seen = Remote::observe(before, key, 1, before.ttls.freshMs, false)
    job.cached == NO_VALUE or (seen.value > NO_VALUE and job.cached == seen.payload)
  })
  // A local slot changes only by a publication that belongs to a caller: at
  // a release, the remote hit the last caller was served (a decode counted);
  // at a settlement, the settled source, which a caller owns and which
  // carried local authority, with the value it recorded
  // (localPublicationBelongsToCaller); a detached source and a job's fill
  // never write it.
  val localPublicationBelongsToCaller = profile::s.localValues.indices().forall(slot =>
    profile::s.localValues.nth(slot) == before.localValues.nth(slot) or {
      val value = profile::s.localValues.nth(slot)
      if (profile::input.name == "beginCall")
        profile::s.o.loads > before.o.loads and value == profile::s.o.calls.nth(lastCall)
      else if (profile::input.name == "resolveLoader") {
        val source = (profile::input.choice - 1) / 2
        owned(profile::s, source) and identityOf(profile::s, source) == slot
          and profile::s.sources.nth(source).localMs > 0 and profile::s.sources.nth(source).result == value
      } else false
    })
}

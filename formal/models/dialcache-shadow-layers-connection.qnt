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
  // The jobs this step admitted: registered over a source no job held before.
  val admitted = profile::s.jobs.indices().filter(i => not(Shadow::holdsJob(before, profile::s.jobs.nth(i).source)))
  val lastCall = profile::s.o.calls.length() - 1

  // A caller no source owns was served by a layer at its release and keeps
  // that outcome: no settlement names it (hitResultsAreImmutable).
  val servedCallersKeepTheirOutcome = before.o.calls.indices().forall(c =>
    before.owners.nth(c) >= 0 or profile::s.o.calls.nth(c) == before.o.calls.nth(c))
  // A job is admitted only under a policy whose cohort selects the key
  // (disabledCohortsNeverOwnJobs), at a caller's release: the drivers' code
  // table spelled here rather than the profile's decoder, so the clause binds
  // the decoder too (codes 5, 6, 7 and 13 disable shadow; of the cohort
  // codes only 11, the numerator above the boundary, selects).
  val jobsAdmittedOnlyWhenSelected = admitted.forall(_ => profile::input.name == "beginCall"
    and (before.policy == 11 or not(Set(5, 6, 7, 9, 10, 13).contains(before.policy))))
  // A job captures the TTLs the reply in force at its admission resolved to
  // (retentionComesFromAdmissionPolicy: a 180 s retention under the drivers'
  // changed-fill codes 8 and 13, 120 s otherwise; the table, not `ttlsFor`).
  val jobsCaptureAdmissionRetention = admitted.forall(i =>
    profile::s.jobs.nth(i).ttls.retentionMs == (if (before.policy == 8 or before.policy == 13) 180000 else 120000))
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

module runtime_policy {
  // How a runtime policy reply resolves against an instance's configured
  // baseline (C06/C13/C16/C19): which layers serve this call and whether it
  // coalesces. Policy codes are the runtime-boundaries drivers' contract
  // (formal/replay/profiles/runtime-boundaries.mjs); do not renumber. Codes
  // 0..11 are a serving-cohort relation (cohort_boundaries) times three plus
  // a sharing leaf; the rest are named replies.
  import cohort_boundaries.* from "../cohort-boundaries"
  import layer_policy.* from "./layer-policy"

  pure val INHERIT_SHARING = 0
  pure val DISABLE_SHARING = 1
  pure val ENABLE_SHARING = 2
  pure val FULL_COHORT = 3
  pure val NULL_PROVIDER = 12
  pure val DISABLE_REQUEST = 13
  pure val INVALID_COALESCE = 14
  pure val INVALID_REQUEST_LOCAL = 15
  pure val NULL_COALESCE = 16
  pure val NULL_REQUEST_LOCAL = 17
  pure val RUNTIME_LOCAL_TTL = 18
  pure val RUNTIME_REMOTE_TTL = 19
  pure val RAMP_UP_DISABLED_BASELINE = 20
  pure val KILL_ALL_FEATURES = 21

  // The configured baseline of an instance: which layers have a TTL, the
  // operation default for coalescing (omitted is true), and whether every ramp
  // is explicitly zero (a disabled baseline admits nobody until a runtime ramp
  // overrides it).
  type Baseline = { request: bool, local: bool, remote: bool, coalesce: bool, disabled: bool }
  // The W03 cohort numerators the fixture binds to its key.
  type Samples = { local: int, remote: int }
  type Configured[r] = { baseline: Baseline, remoteAvailable: bool, policy: int | r }

  pure def cohortRelation(policy: int): int = if (policy >= NULL_PROVIDER) FULL_COHORT else policy / 3
  pure def sharingMode(policy: int): int = if (policy >= NULL_PROVIDER) INHERIT_SHARING else policy % 3
  // Strict admission against the ramp the relation selects; a full cohort admits everyone.
  pure def admits(sample: int, policy: int): bool = cohortRelation(policy) == FULL_COHORT
    or cohortAdmits(sample, thresholdForRelation(sample, cohortRelation(policy)))
  // Invalid or explicit-null boolean leaves fail closed on every layer; the kill switch disables all.
  pure def valid(policy: int): bool = policy != KILL_ALL_FEATURES
    and not(Set(INVALID_COALESCE, INVALID_REQUEST_LOCAL, NULL_COALESCE, NULL_REQUEST_LOCAL).contains(policy))
  // A runtime TTL configures an unconfigured layer at the default full ramp; a
  // disabled baseline stays disabled until a runtime ramp overrides it.
  pure def localConfigured(baseline: Baseline, policy: int): bool =
    (baseline.local or policy == RUNTIME_LOCAL_TTL or policy == RAMP_UP_DISABLED_BASELINE)
      and (not(baseline.disabled) or policy == RAMP_UP_DISABLED_BASELINE)
  pure def remoteConfigured(baseline: Baseline, policy: int): bool =
    (baseline.remote or policy == RUNTIME_REMOTE_TTL) and not(baseline.disabled)

  pure def resolve(state: Configured[r], samples: Samples): Resolution = {
    val policy = state.policy
    val baseline = state.baseline
    {
      layers: {
        request: valid(policy) and baseline.request and policy != DISABLE_REQUEST,
        local: valid(policy) and localConfigured(baseline, policy) and admits(samples.local, policy),
        remote: valid(policy) and state.remoteAvailable and remoteConfigured(baseline, policy) and admits(samples.remote, policy)
      },
      coalesce: sharingMode(policy) == ENABLE_SHARING
        or (sharingMode(policy) == INHERIT_SHARING and baseline.coalesce)
    }
  }
}

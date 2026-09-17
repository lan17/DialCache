module policy_overlay {
  // How a runtime policy overlay (the policy drivers' codes 0 to 25,
  // formal/replay/features.mjs policyOverlays) resolves against a fixture whose
  // local and remote layers both serve with configured TTLs (C13, C17, C20 to
  // C22): each layer's TTL, the retention a refill is written with, whether
  // the call coalesces, and whether the reply failed (a provider fault or an
  // invalid read budget: reported once as a config_resolution error and served
  // with every layer off). Codes are the drivers' contract; do not renumber:
  // 10..19 repeat 0..9 with coalescing disabled, 20..25 are the invalid
  // overlays. The overlay decides the TTLs; the reply's layer set is the
  // shape's (local, and remote where remote storage exists), and the traversal
  // gates each layer on its TTL at release (`layer_policy::gated`): a positive
  // reply TTL enables the layer, a zero one turns it off.
  import layer_policy.* from "./layer-policy"

  pure val INHERIT = 0
  pure val LOCAL_TTL_TWO_SECONDS = 1
  pure val REMOTE_TTL_TWO_SECONDS = 2
  pure val NO_LOCAL = 3
  pure val NO_REMOTE = 4
  pure val INVALID_LOCAL_TTL = 5
  pure val INVALID_REMOTE_TTL = 6
  pure val RECOVERY_TWO_SECONDS = 7
  pure val NO_SERVING = 8
  pure val REMOTE_FOUR_SECONDS_NO_RECOVERY = 9
  pure val INDEPENDENT_OFFSET = 10
  pure val INVALID_READ_BUDGET = 20
  pure val INVALID_LOCAL_RAMP = 21
  pure val INVALID_REMOTE_RAMP = 22
  pure val INVALID_RECOVERY_AGE = 23
  pure val NEGATIVE_RECOVERY_AGE = 24
  pure val INVALID_SHADOW_RAMP = 25
  pure val TWO_SECONDS_MS = 2000
  pure val FOUR_SECONDS_MS = 4000

  // The overlay in force, whether the provider fails to reply, and whether
  // remote storage exists.
  type Overlaid[r] = { policy: int, providerFailed: bool, remoteAvailable: bool | r }

  // The sparse overlay a code repeats; an invalid overlay inherits the baseline.
  pure def base(policy: int): int = if (policy < INVALID_READ_BUDGET) policy % INDEPENDENT_OFFSET else INHERIT
  // Codes 10..19 disable coalescing; every other reply coalesces.
  pure def independent(policy: int): bool = policy >= INDEPENDENT_OFFSET and policy < INVALID_READ_BUDGET
  // A failed reply: the provider threw or the overlay is unusable as a whole.
  pure def failed(state: Overlaid[r]): bool = state.providerFailed or state.policy == INVALID_READ_BUDGET
  // Each layer's TTL: none when the reply failed, the layer is ramped off or
  // its own leaf is invalid (an invalid leaf disables only its layer); else
  // the overlay's TTL or the baseline's.
  pure def localTtl(state: Overlaid[r], baseline: Ttls): int =
    if (failed(state) or state.policy == INVALID_LOCAL_RAMP
      or Set(NO_LOCAL, INVALID_LOCAL_TTL, NO_SERVING).contains(base(state.policy))) 0
    else if (base(state.policy) == LOCAL_TTL_TWO_SECONDS) TWO_SECONDS_MS
    else baseline.localMs
  pure def remoteTtl(state: Overlaid[r], baseline: Ttls): int =
    if (failed(state) or state.policy == INVALID_REMOTE_RAMP
      or Set(NO_REMOTE, INVALID_REMOTE_TTL, NO_SERVING).contains(base(state.policy))) 0
    else if (base(state.policy) == REMOTE_TTL_TWO_SECONDS) TWO_SECONDS_MS
    else if (base(state.policy) == REMOTE_FOUR_SECONDS_NO_RECOVERY) FOUR_SECONDS_MS
    else baseline.freshMs
  // Physical retention: an invalid or negative recovery age retains for the
  // fresh TTL, a recovery overlay for its maximum, otherwise the baseline's.
  pure def retention(state: Overlaid[r], baseline: Ttls): int =
    if (state.policy == INVALID_RECOVERY_AGE or state.policy == NEGATIVE_RECOVERY_AGE) baseline.freshMs
    else if (base(state.policy) == RECOVERY_TWO_SECONDS) TWO_SECONDS_MS
    else if (base(state.policy) == REMOTE_FOUR_SECONDS_NO_RECOVERY) FOUR_SECONDS_MS
    else baseline.retentionMs
  pure def ttls(state: Overlaid[r], baseline: Ttls): Ttls =
    { localMs: localTtl(state, baseline), freshMs: remoteTtl(state, baseline), retentionMs: retention(state, baseline) }
  // The reply: the shape's layers (no request layer; the remote layer where
  // remote storage exists) and whether the call coalesces.
  pure def resolve(state: Overlaid[r]): Resolution =
    { layers: { request: false, local: true, remote: state.remoteAvailable }, coalesce: not(independent(state.policy)) }
}

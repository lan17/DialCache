module config_errors {
  // The policy-error channel the policy drivers compare (`policyErrors`).
  //
  // Rules
  // - A policy reply that fails to resolve is reported once, against no layer, as a configuration
  //   error (C20): `recordConfigError` appends `CONFIG_RESOLUTION` when the reply failed.
  // - The record is opt-in: a wrapper composes it around the release whose reply failed, and the
  //   traversal never reads it.
  // Shapes
  // - PolicyError: one reported error, the layer it is against and its type.
  // - Reported[r]: the `policyErrors` channel the policy profile composes around its release.
  // Consumers: policy.
  type PolicyError = { layer: str, errorType: str }
  type Reported[r] = { policyErrors: List[PolicyError] | r }
  pure val CONFIG_RESOLUTION: PolicyError = { layer: "noop", errorType: "config_resolution" }

  pure def recordConfigError(state: Reported[r], failed: bool): Reported[r] =
    if (failed) { policyErrors: state.policyErrors.append(CONFIG_RESOLUTION), ...state } else state
}

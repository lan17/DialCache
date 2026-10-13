module config_errors {
  // The policy-error channel the policy drivers compare (`policyErrors`): a
  // policy reply that fails to resolve is reported once, against no layer, as
  // a configuration error (C20). An opt-in record a wrapper composes around
  // the release whose reply failed; the traversal never reads it.
  type PolicyError = { layer: str, errorType: str }
  type Reported[r] = { policyErrors: List[PolicyError] | r }
  pure val CONFIG_RESOLUTION: PolicyError = { layer: "noop", errorType: "config_resolution" }

  pure def recordConfigError(state: Reported[r], failed: bool): Reported[r] =
    if (failed) { policyErrors: state.policyErrors.append(CONFIG_RESOLUTION), ...state } else state
}

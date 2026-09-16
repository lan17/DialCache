module encodings {
  // Sentinels the concern modules share. Values are the drivers' outcome codes
  // (conformance_observations); storage slots hold 0 when absent, registries
  // hold -1 when no execution owns a slot, and an untracked flight has no fence.
  pure val NO_VALUE = 0
  pure val NO_OWNER = -1
  pure val NO_FENCE = 0
}

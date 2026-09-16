module encodings {
  // Sentinels the concern modules share. Values are the drivers' outcome codes
  // (conformance_observations); storage slots hold 0 when absent, registries
  // hold -1 when no execution owns a slot, and an untracked flight has no fence.
  import conformance_observations.* from "../conformance-observations"

  pure val NO_VALUE = 0
  pure val NO_OWNER = -1
  pure val NO_FENCE = 0

  // An outcome a source may publish: neither pending nor an error (a source
  // error or a deadline error is completed to its callers and cached nowhere).
  pure def accepted(value: int): bool =
    value != CALL_PENDING and value != SOURCE_ERROR and value != DEADLINE_ERROR
}

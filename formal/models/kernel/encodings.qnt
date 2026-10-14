module encodings {
  // Sentinels the concern modules share, and the `accepted` judgment over outcome codes.
  //
  // Rules
  // - Values are the drivers' outcome codes (`conformance_observations`); storage slots hold
  //   `NO_VALUE` (0) when absent and registries `NO_OWNER` (-1) when no execution owns a slot.
  // - An untracked flight has no fence (`NO_FENCE`, 0).
  // - A source may publish an accepted outcome alone: neither pending nor an error (`accepted`).
  // Consumers: every composed profile.
  import conformance_observations.* from "../conformance-observations"

  pure val NO_VALUE = 0
  pure val NO_OWNER = -1
  pure val NO_FENCE = 0

  // An outcome a source may publish: neither pending nor an error (a source
  // error or a deadline error is completed to its callers and cached nowhere).
  pure def accepted(value: int): bool =
    value != CALL_PENDING and value != SOURCE_ERROR and value != DEADLINE_ERROR
}

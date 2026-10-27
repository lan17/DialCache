module mismatch_logging {
  // How the mismatch-logging inputs a shadow policy writes resolve to the leaves a job captures (C60).
  //
  // Rules
  // - Each config layer is expanded on its own: the `logMismatches` shorthand stands for both
  //   leaves, and a leaf written beside it overrides what it stands for (`expandLogging`).
  // - The runtime overlay is merged over the defaults leaf by leaf (`mergeLogging`).
  // - Each leaf resolves on its own: an unwritten leaf is off, a value of the wrong type acts off,
  //   and one configuration error covers every invalid input (`resolveLogging`).
  // - The result is the `{ value, diff }` record `shadow::Logging` names: a profile resolves its
  //   inputs here and hands the record to the job at admission, so `shadow` never imports this.
  // Shapes
  // - LoggingInput: one config layer's inputs as written, before expansion.
  // Consumers: shadow.

  // The diff levels, spelled as `shadow` spells them: the drivers' encoding
  // of `mismatchLogging.diff`, in order.
  pure val DIFF_OFF = "off"
  pure val DIFF_PATHS = "paths"
  pure val DIFF_VALUES = "values"
  // One config layer's inputs as written, before expansion: the
  // `logMismatches` shorthand and the two `mismatchLogging` leaves, each
  // UNWRITTEN, the spelling of a valid value ("true", "false", a level) or
  // any other string, a value of the wrong type.
  pure val UNWRITTEN = ""
  type LoggingInput = { shorthand: str, value: str, diff: str }
  pure val NO_LOGGING_INPUT: LoggingInput = { shorthand: UNWRITTEN, value: UNWRITTEN, diff: UNWRITTEN }
  // A layer expanded (D10): its shorthand stands for leaves, `true` for
  // `{ value: true, diff: "values" }` and `false` for both off, while a
  // malformed one stands for both off and is marked invalid; a leaf written
  // beside the shorthand then overrides what it stands for.
  pure def expandLogging(written: LoggingInput): { value: str, diff: str, invalid: bool } = {
    val stands = if (written.shorthand == "true") { value: "true", diff: DIFF_VALUES }
      else if (written.shorthand == UNWRITTEN) { value: UNWRITTEN, diff: UNWRITTEN }
      else { value: "false", diff: DIFF_OFF }
    {
      value: if (written.value != UNWRITTEN) written.value else stands.value,
      diff: if (written.diff != UNWRITTEN) written.diff else stands.diff,
      invalid: not(Set(UNWRITTEN, "true", "false").contains(written.shorthand))
    }
  }
  // The runtime overlay over the defaults, leaf by leaf, each layer expanded
  // first: a runtime shorthand replaces both inherited leaves, and a leaf the
  // overlay leaves unwritten falls through to the default's. Registration
  // rejects a malformed static input, so only the overlay marks the merge.
  pure def mergeLogging(defaults: LoggingInput, overlay: LoggingInput): { value: str, diff: str, invalid: bool } = {
    val inherited = expandLogging(defaults)
    val written = expandLogging(overlay)
    {
      value: if (written.value != UNWRITTEN) written.value else inherited.value,
      diff: if (written.diff != UNWRITTEN) written.diff else inherited.diff,
      invalid: written.invalid
    }
  }
  // Each leaf resolved on its own: an unwritten leaf is off and a value of the
  // wrong type acts off, so an invalid leaf beside a valid one leaves the
  // valid one on; one configuration error covers every invalid input.
  pure def resolveLogging(merged: { value: str, diff: str, invalid: bool }): {
    logging: { value: bool, diff: str }, invalid: bool
  } = {
    val levels = Set(DIFF_OFF, DIFF_PATHS, DIFF_VALUES)
    {
      logging: { value: merged.value == "true", diff: if (levels.contains(merged.diff)) merged.diff else DIFF_OFF },
      invalid: merged.invalid or not(Set(UNWRITTEN, "true", "false").contains(merged.value))
        or not(levels.contains(merged.diff) or merged.diff == UNWRITTEN)
    }
  }
}

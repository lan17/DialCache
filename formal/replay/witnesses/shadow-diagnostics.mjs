import { publicPrefixWitnesses, publicPrefixRule as rule, publicCheckpoint as check, witnessCommand as command } from "./public-prefix.mjs";

const init = fixture => command("init", fixture);
const seed = command("seed", 1), begin = command("beginCall"), read = command("releaseRead");
const resolve = command("resolveLoader", 2), load = command("releaseLoad");
const rollback = command("rollbackWall");
const mismatch = { calls: [2], reads: 2, loads: 1, writes: 0, comparisons: 1, shadow: ["mismatch"] };
const futureShadow = [{ layer: "remote_shadow", offsetMs: 1000 }];
// A confirmed mismatch at C0 age 0 (the regressions' confirmMismatch) and the
// warnings it logs: neither value field nor diff field to start from.
const confirm = value => [seed, begin, read, command("resolveLoader", value), load, read];
const logPolicy = choice => command("logPolicy", choice);
const omitted = { ageMs: 0, cachedValue: -1, sourceValue: -1, diff: "off", diffNull: false, count: 0, paths: [], entries: [], loggingOutcome: "" };
const everything = { ...omitted, cachedValue: 1, sourceValue: 2, diff: "values", count: 1, paths: [""], entries: [{ path: "", cached: 1, source: 2 }] };
const failedDiff = (sourceValue, loggingOutcome) => ({ ...omitted, cachedValue: 1, sourceValue, diff: "values", diffNull: true, loggingOutcome });
const warned = (step, warning, outcome, more = {}) => check(step, { shadow: ["mismatch"] },
  { mismatchWarnings: [warning], loggingOutcomes: [outcome], ...more });

export const shadowDiagnosticsWitnessRules = [
  rule("omitted-shadow-logging-keeps-mismatch-metrics-only", "omittedLoggingKeepsMismatchMetricsOnlyTest",
    [init(2), seed, begin, read, resolve, load, read],
    check(6, mismatch, { warnings: 0, configErrors: 0, ages: [0], futureOffsets: [] })),
  rule("explicit-false-shadow-logging-overrides-enabled-default", "explicitFalseLoggingOverridesEnabledDefaultTest",
    [init(6), command("logPolicy", 0), seed, begin, read, resolve, load, read],
    check(7, mismatch, { warnings: 0, configErrors: 0, ages: [0], futureOffsets: [] })),
  rule("shadow-confirmation-past-freshness-preserves-payload-and-age", "confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest",
    [init(6), seed, begin, read, resolve, load, command("advanceWall", 60_000), read],
    check(5, { calls: [2], reads: 2, loads: 1, writes: 0, shadow: [] }, { warnings: 0, ages: [] }),
    check(7, mismatch, { warnings: 1, ages: [60_000], futureOffsets: [] })),
  rule("shadow-confirmation-rollback-keeps-payload-and-reports-offset", "confirmationRollbackKeepsPayloadAndClampsAgeTest",
    [init(6), seed, begin, read, resolve, load, rollback, read],
    check(5, { calls: [2], reads: 2, loads: 1, writes: 0, shadow: [] }, { warnings: 0, ages: [], futureOffsets: [] }),
    check(7, mismatch, { warnings: 1, ages: [0], futureOffsets: futureShadow })),
  rule("future-dark-c0-reports-offset-and-fills-semantic-miss", "futureDarkAcquisitionReportsOffsetAndFillsMissTest",
    [init(0), seed, rollback, begin, read, resolve, command("releaseDump"), command("releaseWrite")],
    check(4, { calls: [0], reads: 1, loads: 0, dumps: 0, shadow: [] }, { futureOffsets: futureShadow }),
    check(7, { calls: [2], reads: 1, loads: 0, dumps: 1, writes: 1, shadow: ["filled"] },
      { warnings: 0, ages: [], futureOffsets: futureShadow })),
  rule("late-dark-read-reports-offset-without-reviving-job", "futureLateDarkReadKeepsTimeoutAndReportsOffsetTest",
    [init(0), seed, rollback, begin, command("advance", 10), read],
    check(4, { calls: [4], shadow: ["timeout"], reads: 1 }, { futureOffsets: [] }),
    check(5, { calls: [4], shadow: ["timeout"], reads: 1, loads: 0, dumps: 0, writes: 0 },
      { futureOffsets: [{ layer: "remote_shadow", offsetMs: 990 }] })),
  // The record's shorthand table, one rule per row.
  rule("shorthand-true-with-value-false-logs-diff-only", "trueShorthandWithValueFalseLogsDiffOnlyTest",
    [init(0), logPolicy(6), ...confirm(2)], warned(7, { ...everything, cachedValue: -1, sourceValue: -1 }, "logged", { configErrors: 0 })),
  rule("shorthand-false-with-diff-paths-logs-paths-only", "falseShorthandWithDiffPathsLogsPathsOnlyTest",
    [init(0), logPolicy(7), ...confirm(2)], warned(7, { ...omitted, diff: "paths", count: 1, paths: [""] }, "logged", { configErrors: 0 })),
  rule("runtime-false-shorthand-overrides-default-diff", "runtimeFalseShorthandOverridesDefaultDiffTest",
    [init(14), logPolicy(0), ...confirm(2)],
    check(7, { shadow: ["mismatch"] }, { warnings: 0, ages: [0], mismatchWarnings: [], loggingOutcomes: [], configErrors: 0 })),
  rule("runtime-true-shorthand-overrides-default-value", "runtimeTrueShorthandOverridesDefaultValueTest",
    [init(15), logPolicy(1), ...confirm(2)], warned(7, everything, "logged")),
  // Each failure outcome, and all three together.
  rule("hook-error-nulls-diff-fields", "hookErrorNullsDiffFieldsTest",
    [init(13), ...confirm(2)], warned(6, failedDiff(2, "hook_error"), "hook_error")),
  rule("render-error-nulls-unrenderable-source", "renderErrorNullsUnrenderableSourceTest",
    [init(4), ...confirm(12)], check(6, { calls: [12], shadow: ["mismatch"] },
      { mismatchWarnings: [failedDiff(0, "render_error")], loggingOutcomes: ["render_error"] })),
  rule("logger-error-still-delivers-warning", "loggerErrorStillDeliversWarningTest",
    [init(4), command("loggerFault", 1), ...confirm(2)], warned(7, everything, "logger_error")),
  rule("hook-error-outranks-both-failures", "hookErrorOutranksBothFailuresTest",
    [init(13), command("loggerFault", 1), ...confirm(12)], warned(7, failedDiff(0, "hook_error"), "hook_error")),
];

export function shadowDiagnosticsWitnesses(histories, recorder) {
  return publicPrefixWitnesses(histories, shadowDiagnosticsWitnessRules, recorder);
}

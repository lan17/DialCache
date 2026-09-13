import { flowLabels } from "./labels.mjs";
import { createWitnessRecorder } from "./recorder.mjs";

// Shadow-comparison flow witnesses. Model-private payload values classify
// reached comparison schedules only; replay has already compared the public
// callbacks and results independently.
export function shadowWitnesses(histories, recorder = createWitnessRecorder()) {
  flowLabels(histories, true, recorder);
  for (const { path, steps, states: shadowStates } of histories) {
    recorder.enter(path);
    let c0Released = false;
    let shadowTimedOut = false;
    let logging = steps[0].choice >= 4 && steps[0].choice < 8;
    const defaultLogging = logging;
    let sawShadowPolicy = false, acceptedDefaultLogging = false;
    let shadowPolicy = 0, jobAdmitted = false, changedAdmittedJob = false;
    let acceptedLogging = false;
    let acceptedInvalidLogging = false;
    let invalidLoggingReportedAtAdmission = false;
    let wallRolledAfterC0 = false;
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      const o = step.expected;
      const previous = steps[i - 1]?.expected;
      if (previous === undefined) continue;
      if (step.action === "beginCall") {
        c0Released = false; shadowTimedOut = false;
        acceptedLogging = logging; wallRolledAfterC0 = false;
        acceptedInvalidLogging = shadowStates[i - 1].invalidLog === true;
        invalidLoggingReportedAtAdmission = step.diagnostics.configErrors === steps[i - 1].diagnostics.configErrors + 1;
        acceptedDefaultLogging = !defaultLogging && !sawShadowPolicy;
        jobAdmitted = o.reads > previous.reads; changedAdmittedJob = false;
        if (steps[0].choice === 11 && jobAdmitted && o.calls.at(-1) === 0 && o.shadow.length === previous.shadow.length) {
          recorder.credit("source-work-before-deadline-dispatches-read");
        }
        if (steps[0].choice === 12 && o.reads === previous.reads && o.calls.at(-1) === 0 &&
          o.shadow.length === previous.shadow.length + 1 && o.shadow.at(-1) === "timeout" &&
          step.diagnostics.fallbackErrors.length === steps[i - 1].diagnostics.fallbackErrors.length) {
          recorder.credit("source-work-exhausts-deferred-job");
        }
        if (!jobAdmitted && o.loaders > previous.loaders) {
          if (steps[0].choice === 8) recorder.credit("missing-hook-skips-job");
          else if (shadowPolicy > 0) recorder.credit(`shadow-policy-skips-job:${shadowPolicy}`);
        }
      }
      if (step.action === "logPolicy" || step.action === "shadowPolicy") sawShadowPolicy = true;
      if (step.action === "logPolicy") { logging = step.choice === 1; shadowPolicy = 0; }
      if (step.action === "shadowPolicy") {
        shadowPolicy = step.choice; logging = defaultLogging;
        if (jobAdmitted && step.choice > 0) changedAdmittedJob = true;
      }
      if (step.action === "rollbackWall" && c0Released) wallRolledAfterC0 = true;
      if (steps[0].choice === 12 && ["resolveLoader", "rejectLoader"].includes(step.action) &&
        previous.calls.at(-1) === 0 && o.calls.at(-1) === 4 && o.reads === previous.reads &&
        o.shadow.length === previous.shadow.length && step.diagnostics.fallbackErrors.length === steps[i - 1].diagnostics.fallbackErrors.length + 1 &&
        step.diagnostics.fallbackErrors.at(-1) === "local") {
        recorder.credit(step.action === "resolveLoader" ? "expired-job-source-resolve-keeps-deadline" : "expired-job-source-reject-keeps-deadline");
      }
      if (o.shadow.length > previous.shadow.length) {
        const outcome = o.shadow.at(-1);
        if (changedAdmittedJob && shadowPolicy > 0 && ["match", "mismatch", "filled"].includes(outcome)) recorder.credit("admitted-job-keeps-shadow-policy");
        const c0Payload = shadowStates[i - 1].c0;
        const frame = shadowStates[i - 1].frame;
        const decoded = payload => payload >= 7 ? 3 : [3, 5, 6].includes(payload) ? 1 : payload === 4 ? 2 : payload;
        const c0Value = decoded(c0Payload);
        const binary = payload => [3, 4, 5, 8].includes(payload);
        if (step.action === "releaseRead" && outcome === "mismatch" && c0Payload >= 7 && frame >= 7 && binary(c0Payload) !== binary(frame)) {
          recorder.credit(binary(c0Payload) ? "binary-to-text-confirmation" : "text-to-binary-confirmation");
        }
        if (step.action === "releaseRead" && outcome === "superseded" && frame > 0 && decoded(frame) === c0Value) recorder.credit("different-bytes-same-value-superseded");
        if (step.action === "releaseLoad" && outcome === "match" && binary(c0Payload) && steps[0].choice % 4 === 0) recorder.credit("binary-c0-compares-decoded-value");
        if (step.action === "releaseLoad" && outcome === "timeout" && o.comparisons > previous.comparisons) recorder.credit(`comparison-crosses-deadline:${steps[0].choice}`);
        const sourceValue = shadowStates[i - 1].sourceValue;
        if (outcome === "match" && c0Value !== sourceValue && steps[0].choice % 4 === 1) recorder.credit("custom-equal-overrides-values");
        if (outcome === "mismatch" && c0Value === sourceValue && steps[0].choice % 4 === 2) recorder.credit("custom-unequal-confirms-equal-values");
        if (outcome === "mismatch" && acceptedLogging !== logging) recorder.credit(`captured-logging:${acceptedLogging}`);
        if (outcome === "mismatch") recorder.credit(`mismatch-logging:${acceptedLogging}`);
        if (outcome === "mismatch" && acceptedDefaultLogging && step.diagnostics.warnings === steps[i - 1].diagnostics.warnings) recorder.credit("omitted-logging-defaults-off");
        if (outcome === "mismatch" && acceptedInvalidLogging && invalidLoggingReportedAtAdmission &&
          step.diagnostics.warnings === steps[i - 1].diagnostics.warnings) recorder.credit("invalid-logging-compares-without-warning");
        if (acceptedLogging && step.diagnostics.warnings === steps[i - 1].diagnostics.warnings) {
          if (outcome === "match") recorder.credit("enabled-logging-match-has-no-warning");
          if (outcome === "superseded") recorder.credit("enabled-logging-superseded-has-no-warning");
        }
        if (step.diagnostics.ages.length > steps[i - 1].diagnostics.ages.length) {
          if (wallRolledAfterC0 && step.diagnostics.ages.at(-1) === 0) recorder.credit("age-clamped-after-rollback");
          if (step.diagnostics.ages.at(-1) > 0) recorder.credit("age-at-verdict");
        }
      }
      if (step.action === "releaseRead") {
        c0Released = true;
        if (o.calls.includes(0) && o.shadow.length === previous.shadow.length) recorder.credit("c0-before-source");
      }
      if (step.action === "resolveLoader" && jobAdmitted && !c0Released && previous.calls.at(-1) === 0 && [1, 2].includes(o.calls.at(-1))) recorder.credit("source-before-c0");
      if (o.shadow.length > previous.shadow.length && o.shadow.at(-1) === "timeout") shadowTimedOut = true;
      if (step.action === "releaseWrite" && shadowTimedOut) recorder.credit("write-completes-after-timeout");
    }
  }
  return recorder.labels();
}

import { flowLabels } from "./labels.mjs";
import { createWitnessRecorder } from "./recorder.mjs";
import { fidelityBinding } from "./fidelity.mjs";

// The shadow profile's witnesses, decided from the recorded inputs and the
// asserted public channels alone. What a rule needs beyond the observation
// deltas is shadowed here: the fixture the init choice names (comparator,
// comparison time, source work, hook, default logging), both clocks, the
// frame a seed or a fill stored with its stamp, the watermark an invalidation
// raised, the fault switches, and the one dark job the drivers run at a time
// (its phase, its acquired C0 with the frame's stamp and the fence it observed,
// whether its budget expired). The shadow replays the profile's rules over the
// inputs and is bound to the model two ways: at every step the outcome label
// and the read, decode, dump and write counts it predicts must equal the
// observed ones or the classifier refuses the history, and wherever a history
// still carries the model's private predictions the fidelity check compares
// the shadow after every step with the composed layout
// (dialcache-shadow-conformance.qnt over the kernel library): the frame, its
// stamp and the watermark, the two clocks, the fault switches, the one live
// job as a shadow::Job record and the read or decode it holds by ordinal.

const IDLE = 0, C0_READ = 1, SOURCE_WAIT = 2, SNAPSHOT_DECODE = 3, CONFIRMATION_READ = 4, FILL_SERIALIZE = 5, FILL_WRITE = 6, JOB_DONE = 7;
const NOT_STARTED = 0, PENDING = 1, ACCEPTED = 2, FAILED = 3, TIMED_OUT = 4;
const VALUES = 0, EQUAL = 1, UNEQUAL = 2, ERROR = 3;
const BUDGET = 10, FRESH = 60000;
// The drivers' seed choices: byte identity (a binary spelling shares the
// bytes of its text form), decoded value and form.
const payloadBytes = payload => ({ 3: 1, 4: 2, 6: 5, 8: 7 })[payload] ?? payload;
const decoded = payload => payload >= 7 ? 3 : [3, 5, 6].includes(payload) ? 1 : payload === 4 ? 2 : payload;
const binary = payload => [3, 4, 5, 8].includes(payload);

function fixtureOf(choice) {
  return {
    comparator: choice >= 11 ? VALUES : choice === 10 ? ERROR : choice % 4,
    comparisonMs: choice === 9 || choice === 10 ? BUDGET : 0,
    sourceWorkMs: choice === 12 ? BUDGET : choice === 11 ? BUDGET - 1 : 0,
    hook: choice !== 8,
    defaultLog: choice >= 4 && choice < 8,
  };
}
function initial(choice) {
  const fixture = fixtureOf(choice);
  return { ...fixture, now: 10000, wall: 100000, frame: 0, created: 0, watermark: 0, c0: 0, c0Created: 0, phase: IDLE, abandoned: false, deadline: 0,
    source: NOT_STARTED, sourcePending: false, sourceValue: 0, fence: 0, writeStamp: 0,
    readFailed: false, loadFailed: false, dumpFailed: false, writeFailed: false,
    shadowActive: fixture.hook, log: fixture.defaultLog, invalidLog: false, invalidShadow: false, acceptedLog: false, acceptedInvalidLog: false,
    predicted: { outcome: undefined, reads: 0, loads: 0, dumps: 0, writes: 0 } };
}
// The profile's rules over the shadow; `predicted` collects what the step must
// show on the public channels.
function done(s, outcome) { s.phase = JOB_DONE; s.predicted.outcome = outcome; }
function continueJob(s) {
  if (s.phase !== SOURCE_WAIT || s.source === PENDING) return;
  if (s.source === FAILED) return done(s, "source_error");
  if (s.source === TIMED_OUT) return done(s, "timeout");
  if (s.c0 > 0) { s.phase = SNAPSHOT_DECODE; s.predicted.loads++; return; }
  if (!(s.wall > s.fence)) return done(s, "fill_fenced");
  s.phase = FILL_SERIALIZE; s.predicted.dumps++;
}
function apply(before, action, choice) {
  const s = { ...before, predicted: { outcome: undefined, reads: 0, loads: 0, dumps: 0, writes: 0 } };
  switch (action) {
    case "beginCall": {
      const jobExpired = s.shadowActive && s.sourceWorkMs >= BUDGET;
      s.deadline = s.now + BUDGET; s.now += s.sourceWorkMs; s.wall += s.sourceWorkMs;
      s.phase = s.shadowActive && !jobExpired ? C0_READ : JOB_DONE;
      s.source = PENDING; s.sourcePending = true; s.sourceValue = 0; s.abandoned = jobExpired;
      s.c0 = 0; s.c0Created = 0; s.fence = 0; s.acceptedLog = s.log; s.acceptedInvalidLog = s.invalidLog;
      if (s.shadowActive && !jobExpired) s.predicted.reads++;
      if (jobExpired) s.predicted.outcome = "timeout";
      break;
    }
    case "resolveLoader": case "rejectLoader": {
      const expired = s.source === TIMED_OUT || s.now >= s.deadline;
      s.sourcePending = false;
      s.source = expired ? TIMED_OUT : action === "resolveLoader" ? ACCEPTED : FAILED;
      if (action === "resolveLoader") s.sourceValue = choice;
      continueJob(s);
      break;
    }
    case "releaseRead": {
      const readable = s.frame > 0 && s.created > s.watermark;
      const snapshot = readable ? s.frame : 0;
      const acquired = s.created <= s.wall && s.wall - s.created < FRESH ? snapshot : 0;
      if (s.abandoned) { s.phase = JOB_DONE; break; }
      if (s.phase === CONFIRMATION_READ) { done(s, s.readFailed ? "confirmation_error" : payloadBytes(snapshot) === payloadBytes(s.c0) ? "mismatch" : "superseded"); break; }
      if (s.readFailed) { done(s, "redis_error"); break; }
      s.phase = SOURCE_WAIT; s.c0 = acquired; s.c0Created = s.created; s.fence = readable ? 0 : s.watermark;
      continueJob(s);
      break;
    }
    case "releaseLoad": {
      if (s.abandoned) { s.phase = JOB_DONE; break; }
      if (s.loadFailed) { done(s, "deserialization_error"); break; }
      s.now += s.comparisonMs; s.wall += s.comparisonMs;
      const match = s.comparator === EQUAL || (s.comparator === VALUES && decoded(s.c0) === s.sourceValue);
      if (s.now >= s.deadline) { s.abandoned = true; done(s, "timeout"); break; }
      if (s.comparator === ERROR) { done(s, "comparison_error"); break; }
      if (match) { done(s, "match"); break; }
      s.phase = CONFIRMATION_READ; s.predicted.reads++;
      break;
    }
    case "releaseDump": {
      if (s.abandoned) { s.phase = JOB_DONE; break; }
      if (s.dumpFailed) { done(s, "fill_error"); break; }
      if (!(s.wall > s.fence)) { done(s, "fill_fenced"); break; }
      s.phase = FILL_WRITE; s.writeStamp = s.wall; s.predicted.writes++;
      break;
    }
    case "releaseWrite": {
      if (!s.writeFailed) { s.frame = s.sourceValue; s.created = s.writeStamp; }
      if (s.abandoned) { s.phase = JOB_DONE; break; }
      done(s, s.writeFailed ? "fill_error" : "filled");
      break;
    }
    case "advance": {
      const expired = s.now + choice >= s.deadline;
      if (s.source === PENDING && expired) s.source = TIMED_OUT;
      if (s.phase > IDLE && s.phase < JOB_DONE && !s.abandoned && expired) {
        s.abandoned = true; s.predicted.outcome = "timeout";
        if (s.phase === SOURCE_WAIT) s.phase = JOB_DONE;
      }
      s.now += choice; s.wall += choice;
      break;
    }
    case "seed": case "seedUnicode": case "reencode": s.frame = choice; s.created = s.wall; break;
    case "invalidate": if (!s.writeFailed) s.watermark = Math.max(s.watermark, s.wall + choice); break;
    case "rollbackWall": s.wall -= 1000; break;
    case "advanceWall": s.wall += choice; break;
    case "logPolicy": s.log = choice === 1; s.invalidLog = choice === 2; s.invalidShadow = false; s.shadowActive = s.hook; break;
    case "shadowPolicy": s.shadowActive = s.hook && choice === 0; s.log = s.defaultLog; s.invalidShadow = choice === 2; s.invalidLog = false; break;
    case "readFault": s.readFailed = choice === 1; break;
    case "loadFault": s.loadFailed = choice === 1; break;
    case "dumpFault": s.dumpFailed = choice === 1; break;
    case "writeFault": s.writeFailed = choice === 1; break;
    default: throw new Error(`unknown action ${action}`);
  }
  return s;
}
// The shadow bound to the history: what the step predicts must be what the
// drivers observed, or the history is refused rather than classified.
function bind(path, index, s, previous, actual) {
  const appended = actual.shadow.slice(previous.shadow.length);
  const expect = (name, want, got) => { if (want !== got) throw new Error(`${path} step ${index}: shadow predicts ${name} ${want}, observed ${got}`); };
  expect("outcome", s.predicted.outcome ?? "none", appended[0] ?? "none");
  expect("appended count", s.predicted.outcome === undefined ? 0 : 1, appended.length);
  expect("reads", previous.reads + s.predicted.reads, actual.reads);
  expect("loads", previous.loads + s.predicted.loads, actual.loads);
  expect("dumps", previous.dumps + s.predicted.dumps, actual.dumps);
  expect("writes", previous.writes + s.predicted.writes, actual.writes);
}

// The composed layout's payload codes for the drivers' seed choices
// (payloads: BINARY 1000, PADDED 400, UNICODE 500) and its job phases.
const codeOf = [0, 1, 2, 1001, 1002, 1401, 401, 503, 1503];
const phaseOf = { [C0_READ]: 0, [SOURCE_WAIT]: 1, [SNAPSHOT_DECODE]: 2, [CONFIRMATION_READ]: 3, [FILL_SERIALIZE]: 4, [FILL_WRITE]: 5 };
// The shadow in the composed layout's names: the one frame with its stamp and
// watermark, the monotonic clock and the wall skew, the fault switches, the
// one live job the pending-only registry keeps (none once the job finished, or
// timed out while waiting for its source) and the read or decode it holds
// under the drivers' latest ordinal.
function modelView(shadow, o) {
  const live = shadow.phase > IDLE && shadow.phase < JOB_DONE;
  const source = o.calls.length - 1;
  const job = live ? {
    source, dark: true, cached: codeOf[shadow.c0], stamp: shadow.c0Created, fence: shadow.fence,
    ttls: { localMs: 0, freshMs: FRESH, retentionMs: FRESH }, phase: phaseOf[shadow.phase], timedOut: shadow.abandoned, logging: shadow.acceptedLog,
  } : undefined;
  const reading = live && (shadow.phase === C0_READ || shadow.phase === CONFIRMATION_READ);
  const decoding = live && shadow.phase === SNAPSHOT_DECODE;
  return { remoteValues: [codeOf[shadow.frame]], created: [shadow.created], watermark: [shadow.watermark], now: shadow.now, skew: shadow.wall - shadow.now,
    readFailed: shadow.readFailed, loadFailed: shadow.loadFailed, dumpFailed: shadow.dumpFailed, writeFailed: shadow.writeFailed, jobs: job ? [job] : [],
    reads: reading ? [{ read: o.reads - 1, flight: source }] : [], loads: decoding ? [{ load: o.loads - 1, flight: source }] : [] };
}
const layoutFields = ["remoteValues", "created", "watermark", "now", "skew", "readFailed", "loadFailed", "dumpFailed", "writeFailed", "jobs", "reads", "loads"];
const binding = fidelityBinding({ publicChannels: ["o", "d"], layoutFields,
  view: (shadow, state) => [modelView(shadow, shadow.observed), { ...state,
    reads: state.reads.map(held => ({ read: held.read, flight: held.flight })), loads: state.loads.map(held => ({ load: held.load, flight: held.flight })) }] });

export function shadowWitnesses(histories, recorder = createWitnessRecorder()) {
  flowLabels(histories, true, recorder);
  for (const { path, steps, predictions } of histories) {
    recorder.enter(path);
    // shadows[i] is the shadow after step i; a rule reading the state a step
    // began from reads shadows[i - 1].
    const shadows = [{ ...initial(steps[0].choice), observed: steps[0].expected }];
    for (let i = 1; i < steps.length; i++) {
      const next = apply(shadows[i - 1], steps[i].action, steps[i].choice);
      bind(path, i, next, steps[i - 1].expected, steps[i].expected);
      next.observed = steps[i].expected;
      shadows.push(next);
    }
    if (binding.carriesPrivateState(predictions)) binding.checkFidelity(shadows, predictions, path);
    // -- Comparison, captured policy and verdict flow ----------------------------------
    let c0Released = false, shadowTimedOut = false;
    let logging = steps[0].choice >= 4 && steps[0].choice < 8;
    const defaultLogging = logging;
    let sawShadowPolicy = false, acceptedDefaultLogging = false;
    let shadowPolicy = 0, jobAdmitted = false, changedAdmittedJob = false;
    let acceptedLogging = false, acceptedInvalidLogging = false, invalidLoggingReportedAtAdmission = false, wallRolledAfterC0 = false;
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      const o = step.expected;
      const previous = steps[i - 1]?.expected;
      if (previous === undefined) continue;
      const before = shadows[i - 1];
      if (step.action === "beginCall") {
        c0Released = false; shadowTimedOut = false;
        acceptedLogging = logging; wallRolledAfterC0 = false;
        acceptedInvalidLogging = before.invalidLog === true;
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
        const c0Payload = before.c0, frame = before.frame, c0Value = decoded(c0Payload);
        if (step.action === "releaseRead" && outcome === "mismatch" && c0Payload >= 7 && frame >= 7 && binary(c0Payload) !== binary(frame)) {
          recorder.credit(binary(c0Payload) ? "binary-to-text-confirmation" : "text-to-binary-confirmation");
        }
        if (step.action === "releaseRead" && outcome === "superseded" && frame > 0 && decoded(frame) === c0Value) recorder.credit("different-bytes-same-value-superseded");
        if (step.action === "releaseLoad" && outcome === "match" && binary(c0Payload) && steps[0].choice % 4 === 0) recorder.credit("binary-c0-compares-decoded-value");
        if (step.action === "releaseLoad" && outcome === "timeout" && o.comparisons > previous.comparisons) recorder.credit(`comparison-crosses-deadline:${steps[0].choice}`);
        const sourceValue = before.sourceValue;
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
    // -- Caller preservation, fences, byte identity and late effects --------------------
    let c0Future = false, c0Fenced = false, failedReadWhileCallerPending = false, callStart;
    for (let index = 1; index < steps.length; index++) {
      recorder.step(index);
      const before = shadows[index - 1], previous = steps[index - 1].expected, actual = steps[index].expected, action = steps[index].action;
      const phase = before.phase;
      const appended = actual.shadow.slice(previous.shadow.length);
      if (action === "beginCall") { callStart = actual; c0Future = false; c0Fenced = false; failedReadWhileCallerPending = false; }
      if (callStart === undefined) continue;
      const keepsCaller = JSON.stringify(previous.calls) === JSON.stringify(actual.calls);
      const noWrite = actual.writes === callStart.writes;
      if (action === "releaseRead" && phase === C0_READ && before.abandoned === false) {
        c0Future = before.frame > 0 && before.created > before.wall && before.created > before.watermark && before.readFailed === false;
        c0Fenced = before.frame > 0 && before.created <= before.watermark && before.readFailed === false;
        failedReadWhileCallerPending = previous.calls.at(-1) === 0 && appended.includes("redis_error");
      }
      const settled = value => actual.calls.some((result, i) => previous.calls[i] === 0 && result === value);
      const unchangedWork = actual.reads === previous.reads && actual.loads === previous.loads && actual.dumps === previous.dumps && actual.writes === previous.writes;
      if (action === "resolveLoader" && failedReadWhileCallerPending && (settled(1) || settled(2)) && unchangedWork && appended.length === 0) {
        recorder.credit("dark-read-error-still-allows-source-result");
      }
      if (appended.includes("filled") && actual.loads === callStart.loads && keepsCaller) {
        if (c0Future) recorder.credit("future-dark-c0-fills-without-decoding");
        if (c0Fenced) recorder.credit("fenced-dark-c0-can-fill-after-cutoff");
      }
      if (action === "releaseRead" && phase === CONFIRMATION_READ && keepsCaller && noWrite) {
        const sameBytes = payloadBytes(before.frame) === payloadBytes(before.c0);
        if (appended.includes("superseded") && before.frame > 0 && sameBytes && before.readFailed === false && before.created <= before.watermark) {
          recorder.credit("fenced-c1-supersedes-without-repair");
        }
        const visibleC1 = before.frame > 0 && before.created > before.watermark && before.readFailed === false;
        if (visibleC1 && sameBytes && appended.includes("mismatch")) {
          recorder.credit("same-c1-bytes-confirm-mismatch");
          if (before.created > before.wall) recorder.credit("future-c1-confirms-payload-without-repair");
        }
        if (visibleC1 && !sameBytes && appended.includes("superseded")) recorder.credit("different-c1-bytes-supersede");
      }
      if (action === "releaseLoad" && phase === SNAPSHOT_DECODE && noWrite && keepsCaller) {
        if (appended.includes("match") && actual.reads === previous.reads) recorder.credit("equal-comparison-skips-c1");
        if (appended.includes("deserialization_error") && actual.dumps === previous.dumps) recorder.credit("present-undecodable-c0-is-not-repaired");
      }
      if (appended.includes("source_error") && noWrite && actual.loads === callStart.loads && actual.calls.at(-1) === 3) recorder.credit("dark-source-error-never-decodes-or-fills");
      if (action === "releaseDump" && phase === FILL_SERIALIZE && appended.includes("fill_error") && noWrite && keepsCaller) recorder.credit("fill-serialization-error-preserves-caller");
      if (action === "releaseWrite" && phase === FILL_WRITE && appended.includes("fill_error") && before.writeFailed === true && actual.writes === previous.writes && keepsCaller) {
        recorder.credit("fill-write-error-preserves-caller");
      }
      if (before.abandoned === true && keepsCaller && appended.length === 0 && unchangedWork) {
        if (action === "releaseRead" && phase === C0_READ) recorder.credit("late-c0-cannot-start-new-shadow-work");
        if (action === "releaseRead" && phase === CONFIRMATION_READ) recorder.credit("late-c1-cannot-emit-second-verdict");
        if (action === "releaseLoad" && phase === SNAPSHOT_DECODE) recorder.credit("late-shadow-decode-cannot-start-c1");
        if (action === "releaseDump" && phase === FILL_SERIALIZE) recorder.credit("late-shadow-dump-cannot-dispatch-write");
        if (action === "releaseWrite" && phase === FILL_WRITE) recorder.credit("late-shadow-write-cannot-change-caller-or-verdict");
      }
    }
  }
  return recorder.labels();
}

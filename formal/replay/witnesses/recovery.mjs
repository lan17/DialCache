import { isDeepStrictEqual } from "node:util";
import { flowLabels } from "./labels.mjs";
import { createWitnessRecorder } from "./recorder.mjs";

// The recovery witnesses are decided from the recorded inputs and the two
// driver channels (`o`, `d`) alone; no rule reads the model's private state,
// so the profile can be recomposed without changing a count. What a rule needs
// beyond the observation deltas is shadowed here from the inputs, in the
// drivers' own terms: both clocks (the init fixture, `advance`, `rollbackWall`),
// the frame a `seed` stores and its stamp, the frame a stored refill leaves,
// the watermark an `invalidate` raises, the maximum a `policy` sets, the fault
// switches, the fixture's request flag and instance classifier, the scopes a
// `closeScope` closes, and the flight's private facts restated once: the
// candidate the acquiring read retained (readable, unfenced and aged in
// [F, M) at the read), its stamp and the maximum in force, the classifier the
// begin code names, the loader deadline and the abandoned or settled sources.
// Which phase the flight is in is read from the observation (a read
// dispatched, a decode held, a loader started, callers completed), never
// re-decided. The fidelity check binds the shadow to the model by comparing
// it, after every step, with the model's private predictions in every history
// that carries them, re-encoded against the composed layout (storage lists,
// `ttls`, `resolved`, the kernel classifier codes, `loads`, `deadlines`,
// `retained`, `drained`).

const IDLE = 0, FRESH_DECODE = 1, SOURCE_RUNNING = 2, RECOVERY_DECODE = 3;
const REGISTERED = 0, ABANDONED = 1, SETTLED = 2;
// The drivers' classifier codes: beginCall choice % 4 (allow, deny, error,
// inherit) and init choice % 4 (timeout-only, allow, deny, error).
const ALLOW = 0, DENY = 1, ERROR = 2, TIMEOUT_ONLY = 3, INHERIT = 3;
const FRESH_AGE_MS = 1000, SOURCE_BUDGET_MS = 10, FIXTURE_TTL_MS = 60000, INITIAL_MAX_AGE_MS = 5000;
const SEED_AGES = [0, 999, 1000, 4999, 5000, -1, 1000];
const INSTANCE_CLASSIFIERS = [TIMEOUT_ONLY, ALLOW, DENY, ERROR];
const VALUE_ONE = 1, VALUE_TWO = 2, SOURCE_ERROR = 3, DEADLINE_ERROR = 4;

const initialShadow = choice => ({
  now: 10000, wall: 100000, frame: VALUE_ONE, created: 99000, expires: 70000, watermark: 0, maxAge: INITIAL_MAX_AGE_MS,
  readFailed: false, loadFailed: false, request: choice >= 4, instanceClassifier: INSTANCE_CLASSIFIERS[choice % 4],
  closed: [false, false], attached: [false, false], memo: [0, 0], phase: IDLE,
  candidate: 0, candidateCreated: 0, acceptedMaxAge: INITIAL_MAX_AGE_MS, classifier: ALLOW, canRecover: false,
  deadline: 0, sources: [], activeLoader: 0,
});
// The one value the step's completed callers received, if any completed.
const completedWith = (prior, current) => {
  const values = new Set(current.calls.filter((v, j) => prior.calls[j] === 0 && v !== 0));
  return values.size === 1 ? [...values][0] : undefined;
};
const memoized = (s, value) => {
  if (!s.request || !(value === VALUE_ONE || value === VALUE_TWO)) return s.memo;
  return s.memo.map((m, scope) => s.attached[scope] && !s.closed[scope] ? value : m);
};
// The shadow after one recorded step: the inputs decide the environment and
// the selections, the observation decides what the flight did.
function advanceShadow(before, step, prior, current) {
  const s = { ...before, closed: [...before.closed], attached: [...before.attached], memo: [...before.memo], sources: [...before.sources] };
  const { action, choice } = step;
  const completed = completedWith(prior, current);
  const readDispatched = current.reads > prior.reads, loadHeld = current.loads > prior.loads, loaderStarted = current.loaders > prior.loaders;
  switch (action) {
    case "beginCall": {
      const scope = Math.floor(choice / 4), policy = choice % 4;
      if (!readDispatched) break; // a memo hit: nothing changes in the flight
      const readable = !s.readFailed && s.frame > 0 && s.now < s.expires && s.created > s.watermark;
      const eligible = readable && s.created <= s.wall && s.wall - s.created < s.maxAge;
      s.attached = [false, false]; s.attached[scope] = true;
      s.phase = loadHeld ? FRESH_DECODE : SOURCE_RUNNING;
      s.classifier = policy === INHERIT ? s.instanceClassifier : policy;
      s.candidate = eligible ? s.frame : 0; s.candidateCreated = s.created; s.acceptedMaxAge = s.maxAge;
      s.canRecover = !s.readFailed;
      if (loaderStarted) { s.sources.push(REGISTERED); s.activeLoader = s.sources.length - 1; }
      s.deadline = s.now + SOURCE_BUDGET_MS;
      break;
    }
    case "joinCall": if (current.calls.at(-1) === 0) s.attached[choice] = true; break;
    case "closeScope": s.closed[choice] = true; s.memo[choice] = 0; s.attached[choice] = false; break;
    case "resolveLoader": case "rejectLoader": case "rejectTimeout": {
      const abandoned = s.sources[choice] === ABANDONED;
      s.sources[choice] = SETTLED;
      if (abandoned) break;
      if (action === "resolveLoader") {
        s.phase = IDLE;
        if (current.writes > prior.writes) { s.frame = VALUE_TWO; s.created = s.wall; s.expires = s.now + s.acceptedMaxAge; }
        s.memo = memoized(s, VALUE_TWO);
      } else s.phase = loadHeld ? RECOVERY_DECODE : IDLE;
      break;
    }
    case "releaseLoad": {
      const retry = s.phase === FRESH_DECODE && loaderStarted;
      if (completed !== undefined) s.memo = memoized(s, completed);
      if (retry) { s.phase = SOURCE_RUNNING; s.canRecover = false; s.sources.push(REGISTERED); s.activeLoader = s.sources.length - 1; s.deadline = s.now + SOURCE_BUDGET_MS; }
      else s.phase = IDLE;
      break;
    }
    case "seed": s.frame = choice === 6 ? VALUE_TWO : VALUE_ONE; s.created = s.wall - SEED_AGES[choice]; s.expires = s.now + FIXTURE_TTL_MS; break;
    case "advance": {
      // The loader deadline is delivered inside the advance: the source is
      // abandoned and the flight holds its recovery decode or completes.
      if (s.phase === SOURCE_RUNNING && s.now + choice >= s.deadline) {
        s.sources[s.activeLoader] = ABANDONED;
        s.phase = loadHeld ? RECOVERY_DECODE : IDLE;
      }
      s.now += choice; s.wall += choice;
      break;
    }
    case "invalidate": if (s.wall > s.watermark) s.watermark = s.wall; break;
    case "rollbackWall": s.wall -= 1000; break;
    case "policy": s.maxAge = choice; break;
    case "readFault": s.readFailed = choice === 1; break;
    case "loadFault": s.loadFailed = choice === 1; break;
    default: throw new Error(`unknown recovery action ${action}`);
  }
  return s;
}
function shadowHistory(steps) {
  const shadows = [initialShadow(steps[0].choice)];
  for (let i = 1; i < steps.length; i++) shadows.push(advanceShadow(shadows[i - 1], steps[i], steps[i - 1].expected, steps[i].expected));
  return shadows;
}

// The binding between the public-only shadow and the model: after each step
// the shadow, re-encoded into the composed layout, must equal the model's
// private predictions field by field. The kernel's classifier codes are
// recovery.qnt's (TIMEOUT_ONLY 0, ALLOW 1, DENY 2; a classifier that throws
// is DENY); a decode is held while `loads` is nonempty, a loader runs while a
// source deadline is registered, and the flight's snapshot is `retained`.
const KERNEL_CLASSIFIER = { [TIMEOUT_ONLY]: 0, [ALLOW]: 1, [DENY]: 2, [ERROR]: 2 };
function modelView(shadow) {
  const running = shadow.phase === SOURCE_RUNNING, recovering = shadow.phase === RECOVERY_DECODE;
  return {
    now: shadow.now, skew: shadow.wall - shadow.now, remoteValues: [shadow.frame], created: [shadow.created], expires: [shadow.expires], watermark: [shadow.watermark],
    readFailed: shadow.readFailed, loadFailed: shadow.loadFailed, closed: shadow.closed, memo: shadow.memo,
    ttls: { localMs: 0, freshMs: FRESH_AGE_MS, retentionMs: shadow.maxAge },
    resolved: { layers: { request: shadow.request, local: false, remote: true }, coalesce: true },
    instanceClassifier: KERNEL_CLASSIFIER[shadow.instanceClassifier],
    decoding: shadow.phase === FRESH_DECODE || recovering, recoveryDecoding: recovering,
    deadlines: running ? [shadow.deadline] : [],
    snapshot: (running || recovering) && shadow.canRecover
      ? { candidate: shadow.candidate, created: shadow.candidateCreated, maximum: shadow.acceptedMaxAge, classifier: KERNEL_CLASSIFIER[shadow.classifier] } : null,
    drained: shadow.sources.map(source => source === SETTLED),
  };
}
const publicChannels = ["o", "d"];
const carriesPrivateState = predictions => predictions !== undefined
  && predictions.some(state => Object.keys(state).some(field => !publicChannels.includes(field)));
// The composed layout's fields the view reads; a history in another layout
// (the retired text's corpus until the hosted run regenerates it) is named at
// its first missing field rather than misread.
const layoutFields = ["now", "skew", "remoteValues", "created", "expires", "watermark", "readFailed", "loadFailed", "closed", "memo", "ttls", "resolved", "instanceClassifier", "loads", "deadlines", "retained", "drained"];
function checkFidelity(shadows, predictions, path) {
  for (const [index, shadow] of shadows.entries()) {
    const m = predictions[index];
    for (const field of layoutFields) if (!Object.hasOwn(m, field)) throw new Error(`${path} step ${index}: private layout is missing ${field}`);
    const actual = {
      now: m.now, skew: m.skew, remoteValues: m.remoteValues, created: m.created, expires: m.expires, watermark: m.watermark,
      readFailed: m.readFailed, loadFailed: m.loadFailed, closed: m.closed, memo: m.memo, ttls: m.ttls, resolved: m.resolved, instanceClassifier: m.instanceClassifier,
      decoding: m.loads.length > 0, recoveryDecoding: m.loads.length > 0 && m.loads[0].recovery === true,
      deadlines: m.deadlines.map(due => due.at),
      snapshot: m.retained.length > 0 ? { candidate: m.retained[0].candidate, created: m.retained[0].created, maximum: m.retained[0].maximum, classifier: m.retained[0].classifier } : null,
      drained: m.drained,
    };
    for (const [field, value] of Object.entries(modelView(shadow))) {
      if (!isDeepStrictEqual(value, actual[field])) throw new Error(`${path} step ${index}: shadow ${field} ${JSON.stringify(value)} differs from the model's ${JSON.stringify(actual[field])}`);
    }
  }
}

// -- Request-scope memoization of a recovered value -----------------------------
function recoveryScopeWitnesses(histories, recorder) {
  for (const { path, steps, shadows } of histories) {
    recorder.enter(path);
    const memo = new Map();
    const probes = new Map();
    let closedDuringDecode = false, probeAfterClosedRecovery = false;
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      if (i === 0 || steps[0].choice < 4) continue;
      const before = shadows[i - 1], after = shadows[i];
      const previous = steps[i - 1].expected, o = step.expected;
      if (step.action === "closeScope") {
        memo.delete(step.choice);
        if (before.phase === RECOVERY_DECODE && before.attached[step.choice]) closedDuringDecode = true;
      }
      if (step.action === "releaseLoad" && o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "served") {
        const group = o.recovery.length;
        for (const scope of [0, 1]) if (before.attached[scope] && !before.closed[scope]) memo.set(scope, { value: after.memo[scope], group });
        if (closedDuringDecode) probeAfterClosedRecovery = true;
        closedDuringDecode = false;
      } else if (step.action === "releaseLoad" || (step.action === "resolveLoader" && o.calls.some((v, j) => v > 0 && previous.calls[j] === 0))) {
        for (const scope of [0, 1]) if (before.attached[scope]) memo.delete(scope);
      }
      if (step.action === "releaseLoad") closedDuringDecode = false;
      if (step.action === "beginCall" || step.action === "joinCall") {
        const scope = step.action === "beginCall" ? Math.floor(step.choice / 4) : step.choice;
        const recovered = memo.get(scope);
        if (recovered !== undefined && o.calls.at(-1) === recovered.value && o.reads === previous.reads && o.loaders === previous.loaders) {
          recorder.credit("recovered-value-request-hit");
          const groupProbes = probes.get(recovered.group) ?? new Set();
          groupProbes.add(scope); probes.set(recovered.group, groupProbes);
          if (groupProbes.size === 2) recorder.credit("recovery-memoizes-both-requests");
        }
        if (probeAfterClosedRecovery && o.reads > previous.reads) { recorder.credit("closed-recovery-does-not-memoize-another-scope"); probeAfterClosedRecovery = false; }
      }
      if (step.action === "joinCall" && step.diagnostics.coalesced.length > steps[i - 1].diagnostics.coalesced.length && step.diagnostics.coalesced.at(-1) === "request_local") recorder.credit("request-follower-shares-recovery-flight");
    }
  }
}

// A wall rollback during decode leaves the retained candidate stamped after
// the observed wall; the recovery must miss.
function rollbackWitnesses(histories, recorder) {
  for (const { path, steps, shadows } of histories) {
    recorder.enter(path);
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      if (i === 0) continue;
      const before = shadows[i - 1], previous = steps[i - 1].expected, o = step.expected;
      if (step.action === "releaseLoad" && before.phase === RECOVERY_DECODE && before.loadFailed === false &&
        before.wall < before.candidateCreated && o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "miss") recorder.credit("rollback-rejects-retained-future");
    }
  }
}

// -- Classification and settlement flow over the public channels -----------------
// Classifier choices come from the init and beginCall inputs of the history.
function flowWitnesses(histories, recorder) {
  for (const { path, steps } of histories) {
    recorder.enter(path);
    let invalidatedDuringFlight = false, advancedDuringDecode = false, decoding = false;
    let classifier = -1, operationClassifier = -1, recoveryCause = "", recoveryErrorCount = 0;
    const abandoned = new Set();
    let currentSource = -1;
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      const o = step.expected, previous = steps[i - 1]?.expected;
      if (previous === undefined) continue;
      if (step.action === "beginCall") {
        invalidatedDuringFlight = false; advancedDuringDecode = false; decoding = false;
        operationClassifier = step.choice % 4; recoveryErrorCount = step.diagnostics.fallbackErrors.length;
        classifier = step.choice % 4 === INHERIT ? INSTANCE_CLASSIFIERS[steps[0].choice % 4] : step.choice % 4;
      }
      if (o.loaders > previous.loaders) {
        if (abandoned.size > 0) recorder.credit("recovery-abandoned-overlap");
        currentSource = o.loaders - 1; decoding = false;
      }
      const rejected = step.action === "rejectLoader" || step.action === "rejectTimeout";
      if (step.action === "advance" && currentSource >= 0 && !decoding &&
        (o.loads > previous.loads || o.recovery.length > previous.recovery.length || o.calls.some((c, j) => c === DEADLINE_ERROR && previous.calls[j] === 0))) {
        abandoned.add(currentSource);
        recoveryCause = "deadline";
        if (classifier === DENY && o.calls.includes(DEADLINE_ERROR)) {
          if (operationClassifier === DENY) recorder.credit("explicit-denial-overrides-timeout");
          if (operationClassifier === INHERIT && steps[0].choice % 4 === 2) recorder.credit("instance-denial-overrides-timeout-default");
        }
      }
      if (rejected && !abandoned.has(step.choice)) {
        const instance = steps[0].choice % 4;
        if (instance === 1 && operationClassifier === DENY && o.calls.some((c, j) => c === SOURCE_ERROR && previous.calls[j] === 0)) recorder.credit("operation-denial-overrides-instance-allow");
        if (instance === 3 && operationClassifier === INHERIT && o.calls.some((c, j) => c === SOURCE_ERROR && previous.calls[j] === 0)) recorder.credit("instance-classifier-error-preserves-source");
        recoveryCause = step.action === "rejectTimeout" ? "propagated-timeout" : "source-error";
        if (classifier === TIMEOUT_ONLY && step.action === "rejectLoader" && o.calls.includes(SOURCE_ERROR) && o.loads === previous.loads) recorder.credit("default-denies-ordinary-error");
      }
      if ((rejected || step.action === "resolveLoader") && abandoned.has(step.choice)) {
        recorder.credit("recovery-late-source-settles"); abandoned.delete(step.choice);
      }
      if (o.loads > previous.loads && step.action !== "beginCall") decoding = true;
      if (o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "served") {
        if (step.diagnostics.fallbackErrors.length === recoveryErrorCount + 1 && step.diagnostics.fallbackErrors.at(-1) === "remote") recorder.credit("recovery-keeps-source-failure-trail");
        if (steps[0].choice % 4 === 1 && operationClassifier === INHERIT && recoveryCause === "source-error") recorder.credit("instance-allow-recovers-ordinary-error");
        if (steps[0].choice % 4 === 2 && operationClassifier === ALLOW) recorder.credit("operation-allow-overrides-instance-denial");
        if (classifier === TIMEOUT_ONLY) recorder.credit(`default-recovers-${recoveryCause}`);
      }
      if (step.action === "releaseLoad" && o.recovery.at(-1) === "deserialization_error" && o.calls.some((c, j) => c === DEADLINE_ERROR && previous.calls[j] === 0)) recorder.credit("recovery-failure-preserves-timeout");
      if (step.action === "invalidate" && o.calls.includes(0)) invalidatedDuringFlight = true;
      if (step.action === "rejectLoader" && o.loads > previous.loads) decoding = true;
      if (step.action === "advance" && decoding) advancedDuringDecode = true;
      if (o.recovery.length > previous.recovery.length) {
        const outcome = o.recovery.at(-1);
        if (outcome === "served" && invalidatedDuringFlight) recorder.credit("retained-across-invalidation");
        if (outcome === "served" && previous.calls.filter(c => c === 0).length > 1) recorder.credit("coalesced-recovery");
        if (outcome === "miss" && step.action === "releaseLoad" && advancedDuringDecode) recorder.credit("expired-during-decode");
      }
    }
  }
}

// -- The F/M boundaries, the fence and the decode rules, over the shadow ----------
// Each witness requires its distinguishing input, an otherwise eligible
// candidate and the visible consequence, never merely a phase or a label.
const settled = (before, after, value) => after.calls.some((result, index) => before.calls[index] === 0 && result === value);
function ruleWitnesses(histories, recorder) {
  for (const { path, steps, shadows, predictions } of histories) {
    recorder.enter(path);
    let acquired, acquisitionObservations, failedFreshDecode = false, decodeStartedAge;
    for (let index = 1; index < steps.length; index++) {
      recorder.step(index);
      const before = shadows[index - 1], after = shadows[index];
      const previous = steps[index - 1].expected, actual = steps[index].expected, action = steps[index].action;
      if (action === "beginCall" && actual.reads === previous.reads + 1) {
        acquired = before; acquisitionObservations = actual; failedFreshDecode = false; decodeStartedAge = undefined;
      }
      if (acquired === undefined || acquisitionObservations === undefined) continue;
      const ageAtRead = acquired.wall - acquired.created;
      const ageNow = before.wall - before.candidateCreated;
      const phase = before.phase;
      if (after.phase === RECOVERY_DECODE && phase !== RECOVERY_DECODE) {
        // advance() delivers the source deadline before completing its clock
        // jump: recovery decoding starts at that instant, not at the final clock.
        const untilDeadline = action === "advance" ? before.deadline - before.now : 0;
        decodeStartedAge = ageNow + untilDeadline;
      }
      const initialBytesPresent = acquired.frame > 0 && acquired.readFailed === false && acquired.now < acquired.expires;
      const initialBytesUnfenced = acquired.created > acquired.watermark;
      const appendedRecovery = actual.recovery.slice(previous.recovery.length);
      const noSharedWrite = actual.dumps === acquisitionObservations.dumps && actual.writes === acquisitionObservations.writes;
      const noReread = actual.reads === acquisitionObservations.reads;
      const returnsCandidate = settled(previous, actual, before.candidate);
      const returnsSourceError = settled(previous, actual, SOURCE_ERROR);
      const returnsDeadline = settled(previous, actual, DEADLINE_ERROR);
      if (action === "releaseLoad" && phase === FRESH_DECODE) {
        failedFreshDecode = before.loadFailed === true;
        if (!failedFreshDecode && returnsCandidate && actual.loaders === acquisitionObservations.loaders
          && actual.recovery.length === previous.recovery.length && noSharedWrite) {
          if (ageAtRead === 0) recorder.credit("fresh-zero-age-skips-source");
          if (ageAtRead === 999) recorder.credit("last-fresh-age-skips-source");
        }
      }
      if (action === "resolveLoader" && phase === SOURCE_RUNNING && before.candidate > 0 && ageAtRead >= 1000
        && settled(previous, actual, VALUE_TWO) && actual.loads === previous.loads && actual.recovery.length === previous.recovery.length) {
        recorder.credit("source-success-skips-stale-decode");
      }
      if (action === "rejectLoader" && phase === SOURCE_RUNNING && returnsSourceError && actual.loads === previous.loads && noSharedWrite && noReread) {
        if (before.classifier === ERROR && actual.classifications === previous.classifications + 1
          && before.candidate > 0 && ageNow >= 0 && ageNow < before.acceptedMaxAge) recorder.credit("classifier-error-keeps-error-without-decode");
        if (failedFreshDecode && actual.classifications === previous.classifications && appendedRecovery.length === 0) recorder.credit("failed-fresh-decode-is-not-recovery");
        if (acquired.readFailed === true && actual.classifications === previous.classifications && appendedRecovery.length === 0) recorder.credit("failed-initial-read-skips-recovery");
      }
      if (appendedRecovery.includes("miss") && phase === SOURCE_RUNNING && (returnsSourceError || returnsDeadline)
        && actual.loads === previous.loads && noReread && noSharedWrite) {
        // Isolate the rejection rule: a fenced or physically missing value cannot
        // establish that the age check itself prevented recovery, and vice versa.
        if (initialBytesPresent && initialBytesUnfenced) {
          if (ageAtRead === acquired.maxAge) recorder.credit("maximum-age-read-preserves-source-error");
          if (ageAtRead < 0) recorder.credit("future-read-preserves-source-error");
        }
        if (initialBytesPresent && !initialBytesUnfenced && ageAtRead >= 0 && ageAtRead < acquired.maxAge) recorder.credit("fenced-read-does-not-retain");
        if (before.candidate > 0 && ageNow >= before.acceptedMaxAge) recorder.credit("maximum-age-before-decode-skips-load");
      }
      if (action === "releaseLoad" && phase === RECOVERY_DECODE && noSharedWrite && noReread) {
        if (appendedRecovery.includes("served") && returnsCandidate) {
          if (ageAtRead === 1000) recorder.credit("first-stale-age-recovers-without-publication");
          if (ageNow === before.acceptedMaxAge - 1) recorder.credit("last-recovery-age-serves");
          if (ageNow >= 0 && ageNow < 1000 && ageAtRead >= 1000) recorder.credit("rollback-below-fresh-age-still-recovers");
          if (before.frame !== before.candidate) recorder.credit("replacement-cannot-change-recovered-value");
          // The drivers' age channel in milliseconds (the parsed step carries seconds).
          const ages = predictions[index].d.ages;
          if (decodeStartedAge !== undefined && ageNow !== decodeStartedAge && ages.at(-1) === ageNow) recorder.credit("recovery-age-sampled-at-successful-decode");
        }
        if (appendedRecovery.includes("miss") && ageNow === before.acceptedMaxAge && (returnsSourceError || returnsDeadline)) recorder.credit("exact-maximum-after-decode-rejects");
      }
    }
  }
}

export function recoveryWitnesses(histories, recorder = createWitnessRecorder()) {
  const shadowed = histories.map(history => {
    const shadows = shadowHistory(history.steps);
    if (carriesPrivateState(history.predictions)) checkFidelity(shadows, history.predictions, history.path);
    return { ...history, shadows };
  });
  rollbackWitnesses(shadowed, recorder);
  recoveryScopeWitnesses(shadowed, recorder);
  flowLabels(shadowed, true, recorder);
  flowWitnesses(shadowed, recorder);
  ruleWitnesses(shadowed, recorder);
  return recorder.labels();
}

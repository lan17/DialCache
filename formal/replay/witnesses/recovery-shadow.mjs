import { explicitInput, integer } from "./trace.mjs";
import { createWitnessRecorder } from "./recorder.mjs";

// The shadow profile's witnesses, classified only after every driver has
// independently replayed its public observations. Private Quint state
// identifies the external boundary (the profile is not yet composed; see the
// migration list in formal/kernel/README.md); each witness also requires its
// visible consequence, never merely an input. The committed smoke traces omit
// private state and are not coverage evidence.
const number = (state, name) => integer(state[name], name);
function settled(before, after, value) {
  return after.calls.some((result, index) => before.calls[index] === 0 && result === value);
}
function unchangedWork(before, after) {
  return after.reads === before.reads && after.loads === before.loads
    && after.dumps === before.dumps && after.writes === before.writes;
}

// Normalize the published text/binary fixture encodings to byte identities.
// Whitespace-distinct JSON remains distinct even when decoded values agree.
function payloadBytes(payload) {
  return ({ 3: 1, 4: 2, 6: 5, 8: 7 })[payload] ?? payload;
}

function shadowWitnesses(steps, recorder) {
  const C0_READ = 1, SNAPSHOT_DECODE = 3, CONFIRMATION_READ = 4;
  const FILL_SERIALIZE = 5, FILL_WRITE = 6;
  let c0Future = false, c0Fenced = false, failedReadWhileCallerPending = false;
  let callStart;
  for (let index = 1; index < steps.length; index++) {
    recorder.step(index);
    const before = steps[index - 1].s, after = steps[index].s;
    const previous = before.o, actual = after.o, action = steps[index].input.name;
    const phase = number(before, "phase");
    const appended = actual.shadow.slice(previous.shadow.length);
    if (action === "beginCall") {
      callStart = actual; c0Future = false; c0Fenced = false; failedReadWhileCallerPending = false;
    }
    if (callStart === undefined) continue;
    const keepsCaller = JSON.stringify(previous.calls) === JSON.stringify(actual.calls);
    const noWrite = actual.writes === callStart.writes;
    if (action === "releaseRead" && phase === C0_READ && before.abandoned === false) {
      c0Future = number(before, "frame") > 0 && number(before, "created") > number(before, "wall")
        && number(before, "created") > number(before, "watermark") && before.readFailed === false;
      c0Fenced = number(before, "frame") > 0 && number(before, "created") <= number(before, "watermark")
        && before.readFailed === false;
      failedReadWhileCallerPending = previous.calls.at(-1) === 0 && appended.includes("redis_error");
    }
    if (action === "resolveLoader" && failedReadWhileCallerPending
      && (settled(previous, actual, 1) || settled(previous, actual, 2))
      && unchangedWork(previous, actual) && appended.length === 0) {
      recorder.credit("dark-read-error-still-allows-source-result");
    }
    if (appended.includes("filled") && actual.loads === callStart.loads && keepsCaller) {
      if (c0Future) recorder.credit("future-dark-c0-fills-without-decoding");
      if (c0Fenced) recorder.credit("fenced-dark-c0-can-fill-after-cutoff");
    }
    if (action === "releaseRead" && phase === CONFIRMATION_READ && keepsCaller && noWrite) {
      const sameBytes = payloadBytes(number(before, "frame")) === payloadBytes(number(before, "c0"));
      if (appended.includes("superseded") && number(before, "frame") > 0 && sameBytes
        && before.readFailed === false && number(before, "created") <= number(before, "watermark")) {
        recorder.credit("fenced-c1-supersedes-without-repair");
      }
      const visibleC1 = number(before, "frame") > 0
        && number(before, "created") > number(before, "watermark") && before.readFailed === false;
      if (visibleC1 && sameBytes && appended.includes("mismatch")) {
        recorder.credit("same-c1-bytes-confirm-mismatch");
        if (number(before, "created") > number(before, "wall")) {
          recorder.credit("future-c1-confirms-payload-without-repair");
        }
      }
      if (visibleC1 && !sameBytes && appended.includes("superseded")) {
        recorder.credit("different-c1-bytes-supersede");
      }
    }
    if (action === "releaseLoad" && phase === SNAPSHOT_DECODE && noWrite && keepsCaller) {
      if (appended.includes("match") && actual.reads === previous.reads) recorder.credit("equal-comparison-skips-c1");
      if (appended.includes("deserialization_error") && actual.dumps === previous.dumps) {
        recorder.credit("present-undecodable-c0-is-not-repaired");
      }
    }
    if (appended.includes("source_error") && noWrite && actual.loads === callStart.loads
      && actual.calls.at(-1) === 3) recorder.credit("dark-source-error-never-decodes-or-fills");
    if (action === "releaseDump" && phase === FILL_SERIALIZE && appended.includes("fill_error")
      && noWrite && keepsCaller) recorder.credit("fill-serialization-error-preserves-caller");
    if (action === "releaseWrite" && phase === FILL_WRITE && appended.includes("fill_error")
      && before.writeFailed === true && actual.writes === previous.writes && keepsCaller) {
      recorder.credit("fill-write-error-preserves-caller");
    }
    if (before.abandoned === true && keepsCaller && appended.length === 0
      && unchangedWork(previous, actual)) {
      if (action === "releaseRead" && phase === C0_READ) recorder.credit("late-c0-cannot-start-new-shadow-work");
      if (action === "releaseRead" && phase === CONFIRMATION_READ) recorder.credit("late-c1-cannot-emit-second-verdict");
      if (action === "releaseLoad" && phase === SNAPSHOT_DECODE) recorder.credit("late-shadow-decode-cannot-start-c1");
      if (action === "releaseDump" && phase === FILL_SERIALIZE) recorder.credit("late-shadow-dump-cannot-dispatch-write");
      if (action === "releaseWrite" && phase === FILL_WRITE) recorder.credit("late-shadow-write-cannot-change-caller-or-verdict");
    }
  }
}

export function recoveryShadowWitnesses(profile, histories, recorder = createWitnessRecorder()) {
  if (profile !== "shadow") return recorder.labels();
  for (const { path, states, predictions } of histories) {
    recorder.enter(path);
    if (states[0]?.s?.phase === undefined) continue;
    shadowWitnesses(predictions.map((s, index) => ({ s, input: index === 0 ? undefined : explicitInput(states[index], `${path} step ${index}`) })), recorder);
  }
  return recorder.labels();
}

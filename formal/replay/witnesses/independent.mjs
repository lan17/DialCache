import { createWitnessRecorder } from "./recorder.mjs";

const SOURCE_BUDGET_MS = 10, DEADLINE_ERROR = 4;
const settled = value => value === 1 || value === 2;

// Independent-call witnesses: public results, read IO and recovery outcomes,
// plus private call/read/load predictions that identify the schedule probed.
// The source-budget rule reads inputs, o and the asserted io channel only.
export function independentWitnesses(histories, recorder = createWitnessRecorder()) {
  for (const { path, steps, predictions: states } of histories) {
    recorder.enter(path);
    sourceBudgetWitnesses(path, steps, recorder);
    const recovered = new Map();
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      recorder.credit(`action:${step.action}`);
      if (i === 0) continue;
      const before = states[i - 1], previous = steps[i - 1].expected, o = step.expected;
      if (step.action === "beginCall" && states[i].reads.filter(r => r.active === true).length > 1) recorder.credit("independent-read-overlap");
      if (new Set(step.io.sourceErrors.filter(id => id > 0)).size >= 2) recorder.credit("independent-source-error-identities");
      if (step.io.budgets.includes(5) && step.io.budgets.includes(10)) recorder.credit("independent-read-budgets");
      if (step.io.aborted.length > steps[i - 1].io.aborted.length && o.calls.includes(0) &&
        states[i].reads.some(r => r.active === true)) recorder.credit("one-read-times-out-before-another");
      if ((step.action === "releaseRead" || step.action === "failRead") && before.reads[step.choice].active === false &&
        previous.calls.includes(0) && JSON.stringify(o) === JSON.stringify(previous)) recorder.credit("late-read-does-not-affect-other-call");
      if (step.action === "releaseLoad" || step.action === "failLoad") {
        const load = before.loads[step.choice], caller = load.caller, call = before.calls[caller];
        if (load.recovery === true && step.action === "failLoad" && o.calls[caller] === 3 && step.io.sourceErrors[caller] === call.source + 1) {
          recorder.credit("failed-recovery-keeps-source-error");
        }
        if (load.recovery === true && o.calls[caller] === load.value) {
          recovered.set(caller, o.calls[caller]);
          if (new Set(recovered.values()).size === 2) recorder.credit("distinct-retained-recovery-values");
          if (before.watermark >= call.created) recorder.credit("acquired-recovery-survives-invalidation");
        }
        if (load.recovery === false && step.action === "releaseLoad" && before.watermark >= call.acquiredAt) recorder.credit("acquired-fresh-decode-survives-invalidation");
        if (load.recovery === true && o.recovery.at(-1) === "miss" && before.calls.some(c => c.maxAge !== call.maxAge && c.phase !== 5)) recorder.credit("independent-recovery-age-boundary");
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const source = before.sources[step.action === "rejectLoader" ? step.choice : Math.floor((step.choice - 1) / 2)];
        if (source.active === false && previous.calls.includes(0) && JSON.stringify(o) === JSON.stringify(previous)) recorder.credit("late-source-does-not-affect-other-call");
        if (o.writes > previous.writes && before.calls.some(c => c.phase === 2 && c.canWrite === false)) recorder.credit("refill-authority-is-per-call");
      }
      for (const outcome of o.recovery) recorder.credit(`recovery:${outcome}`);
      if (o.calls.includes(4)) recorder.credit("source-deadline");
    }
  }
  return recorder.labels();
}

// Independent source budgets. The shadow keeps the clock (the sum of advance
// choices) and attributes every source start to its caller from public deltas:
// a read reply (releaseRead/failRead k) whose o.loaders grows starts caller k's
// source now; an advance starts one source per newly aborted read at that
// read's beginCall time plus its budget; a failed fresh decode (failLoad j)
// starts the load owner's source, loads being attributed at the read reply or
// rejectLoader that produced them. Any other growth leaves the history
// unattributable and it earns neither label. A caller's result moving 0 -> 4 is
// its last source expiring at startedAt + SOURCE_BUDGET_MS; a 4 recorded ahead
// of that instant contradicts the shadowed clock. The delivery is exact when
// the step is the advance crossing the instant; a 4 surfacing later, after a
// recovery decode, is recorded but not exact.
// later-source-survives-earlier-deadline: B's source, started after A's and
// inside A's budget, settles a value after A's deadline was delivered.
// later-source-expires-at-own-deadline: such a B expires exactly at its own
// later deadline after A expired at an earlier step. Two deadlines in one
// advance, or sources started at one instant, credit neither label.
export function sourceBudgetWitnesses(path, steps, recorder) {
  let now = 0;
  const beginNow = [], budgets = [], sources = [], loads = [], expired = new Map(), survives = [], ownDeadline = [];
  const staggered = (earlier, source) => earlier.startedAt < source.startedAt && source.startedAt < earlier.deadline;
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i], prior = steps[i - 1];
    const { action, choice, expected: current, io } = step, previous = prior.expected;
    const started = current.loaders - previous.loaders, loaded = current.loads - previous.loads;
    if (action === "beginCall") {
      // One read per call: the read index is the caller index.
      if (io.budgets.length !== current.calls.length) return;
      beginNow.push(now); budgets.push(io.budgets.at(-1));
    }
    if (action === "advance") {
      const aborted = io.aborted.slice(prior.io.aborted.length);
      if (started !== aborted.length) return;
      for (const read of aborted) sources.push({ caller: read, startedAt: beginNow[read] + budgets[read] });
      for (let k = 0; k < loaded; k++) loads.push({ caller: undefined });
      now += choice;
    } else if (action === "releaseRead" || action === "failRead") {
      if (started > 1 || loaded > 1) return;
      if (started === 1) sources.push({ caller: choice, startedAt: now });
      if (loaded === 1) loads.push({ caller: choice });
    } else if (action === "rejectLoader") {
      if (started > 0 || loaded > 1) return;
      if (loaded === 1) loads.push({ caller: sources[choice]?.caller });
    } else if (action === "failLoad") {
      if (started > 1 || loaded > 0) return;
      if (started === 1) {
        const caller = loads[choice]?.caller;
        if (caller === undefined) return;
        sources.push({ caller, startedAt: now });
      }
    } else if (started > 0 || loaded > 0) return;
    for (let caller = 0; caller < previous.calls.length; caller++) {
      if (previous.calls[caller] !== 0) continue;
      const result = current.calls[caller];
      if (result === DEADLINE_ERROR) {
        const source = sources.findLast(candidate => candidate.caller === caller);
        if (source === undefined) return;
        const deadline = source.startedAt + SOURCE_BUDGET_MS;
        if (now < deadline) throw new Error(`${path} step ${i}: caller ${caller} deadline ${deadline} after now ${now}`);
        const exact = action === "advance" && now - choice < deadline;
        if (exact) for (const earlier of expired.values()) if (staggered(earlier, source) && earlier.step < i) ownDeadline.push(i);
        expired.set(caller, { startedAt: source.startedAt, deadline, step: i });
      } else if (settled(result) && action === "resolveLoader") {
        const source = sources[Math.floor((choice - 1) / 2)];
        if (source === undefined || source.caller !== caller) return;
        for (const earlier of expired.values()) if (staggered(earlier, source) && earlier.step < i && now >= earlier.deadline) survives.push(i);
      }
    }
  }
  if (survives.length) recorder.credit("later-source-survives-earlier-deadline", ...new Set(survives));
  if (ownDeadline.length) recorder.credit("later-source-expires-at-own-deadline", ...new Set(ownDeadline));
}

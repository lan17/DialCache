import { createWitnessRecorder } from "./recorder.mjs";
import { fidelityBinding } from "./fidelity.mjs";

// Shadow-job admission witnesses use declared inputs and public observations
// only. Job bookkeeping below mirrors the observed effect indices; it never
// reads private model admissions. Wherever a history still carries the
// model's private predictions, the fidelity check compares the shadow after
// every step with the composed layout (dialcache-admission-conformance.qnt
// over the kernel library): the live jobs by loader ordinal with their
// identity, phase, expiry and timeout, each pending held read and decode as a
// caller flight's (its identity, captured selection and callers) or a job's,
// the flights registered for sharing, and the clock.
export function admissionWitnesses(histories, recorder = createWitnessRecorder()) {
  for (const { path, steps, predictions } of histories) {
    recorder.enter(path);
    let overlay = 0;
    const shadow = { now: 0, registered: new Map(), jobs: new Map(), reads: new Map(), loads: new Map() };
    const { registered, jobs, reads, loads } = shadow;
    const shadows = [];
    const released = new Set();
    const instance = identity => Math.floor(identity / 3);
    const finish = index => {
      const job = jobs.get(index);
      if (job.timedOut) released.add(job.identity);
      jobs.delete(index);
    };
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      recorder.credit(`action:${step.action}`);
      const o = step.expected;
      const previous = steps[i - 1]?.expected;
      if (previous === undefined) { shadows.push(structuredClone(shadow)); continue; }
      for (const outcome of o.shadow) recorder.credit(`outcome:${outcome}`);
      if (step.action === "policy") overlay = step.choice;
      if (step.action === "advance") {
        shadow.now += step.choice;
        for (const job of jobs.values()) if (shadow.now >= job.deadline) job.timedOut = true;
      }
      if (step.action === "beginCall") {
        if (o.reads > previous.reads) {
          const flight = { identity: step.choice, selected: overlay % 2 === 0, callers: [o.calls.length - 1] };
          if (overlay >= 2 && registered.has(step.choice)) recorder.credit("uncoalesced-hit-overlap");
          if (overlay < 2) registered.set(step.choice, flight);
          reads.set(o.reads - 1, { flight });
        } else {
          const flight = registered.get(step.choice);
          if (flight === undefined) throw new Error(`${path}: no observed read for follower`);
          flight.callers.push(o.calls.length - 1);
        }
      }
      if (step.action === "releaseRead") {
        const effect = reads.get(step.choice);
        if (effect === undefined) throw new Error(`${path}: unknown read ${step.choice}`);
        if ("flight" in effect) loads.set(o.loads - 1, effect);
        else finish(effect.job);
        reads.delete(step.choice);
      }
      if (step.action === "releaseLoad") {
        const effect = loads.get(step.choice);
        if (effect === undefined) throw new Error(`${path}: unknown load ${step.choice}`);
        if ("flight" in effect) {
          const flight = effect.flight;
          const active = [...jobs.values()].filter(job => instance(job.identity) === instance(flight.identity));
          const duplicate = active.find(job => job.identity === flight.identity);
          if (o.loaders > previous.loaders) {
            if (flight.callers.length > 1) recorder.credit("coalesced-hit-one-job");
            if (overlay % 2 === 1) recorder.credit("accepted-shadow-policy");
            if ([...jobs.values()].filter(job => instance(job.identity) !== instance(flight.identity)).length === 2) recorder.credit("other-instance-full-admission");
            if ([...jobs.values()].some(job => job.identity % 3 === flight.identity % 3)) recorder.credit("per-instance-deduplication");
            if (released.has(flight.identity)) recorder.credit("readmission-after-timeout-drains");
            jobs.set(o.loaders - 1, { identity: flight.identity, phase: "source", deadline: shadow.now + 10, timedOut: false });
          } else if (o.shadow.length > previous.shadow.length) {
            if (duplicate && active.length < 2) recorder.credit("duplicate-with-free-capacity");
            if (!duplicate && active.length === 2) recorder.credit("full-capacity-drop");
            // An expired job must be a cause of this drop, not merely coexist
            // with a different live duplicate that would already block it.
            for (const job of duplicate ? [duplicate] : active.length === 2 ? active : []) {
              if (job.timedOut) recorder.credit(`${job.phase}-timeout-keeps-slot`);
            }
          } else if (!flight.selected) recorder.credit("unselected-hit-skips-job");
          if (registered.get(flight.identity) === flight) registered.delete(flight.identity);
        } else if (o.reads > previous.reads) {
          jobs.get(effect.job).phase = "confirmation";
          reads.set(o.reads - 1, { job: effect.job });
        } else finish(effect.job);
        loads.delete(step.choice);
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const loader = step.action === "resolveLoader" ? Math.floor((step.choice - 1) / 2) : step.choice;
        if (o.loads > previous.loads) {
          jobs.get(loader).phase = "decode";
          loads.set(o.loads - 1, { job: loader });
        } else finish(loader);
      }
      shadows.push(structuredClone(shadow));
    }
    if (carriesPrivateState(predictions)) checkFidelity(shadows, predictions, path);
  }
  return recorder.labels();
}

// The composed layout read back in the shadow's terms. A job is live while
// its phase is not FINISHED and runs over the detached flight its loader
// ordinal maps to; its phase is the held lifecycle's (waiting for its source,
// decoding, confirming) and its deadline is compared while the budget is
// pending. A held read or decode over a source with a job confirming or
// decoding is that job's; any other is a caller flight's, whose identity is
// its source's, whose selection is the one captured for the flight and whose
// callers are the owners the registry names. A flight registered for sharing
// is the process registry's entry for its identity.
const KEYS = 3, WAITING_SOURCE = 0, FINISHED = 3, DECODING = 4, CONFIRMING = 5, JOB_DEADLINE = 2;
const PHASES = new Map([[WAITING_SOURCE, "source"], [DECODING, "decode"], [CONFIRMING, "confirmation"]]);
const layoutFields = ["now", "sources", "owners", "processFlights", "jobs", "deadlines", "selected", "loaders", "reads", "loads"];
function modelView(state, context) {
  const { sources, owners, processFlights, jobs, deadlines, selected, loaders, reads, loads } = state;
  const identityOf = flight => sources[flight].instance * KEYS + sources[flight].key;
  const flightView = flight => ({ identity: identityOf(flight), selected: selected.includes(flight), callers: owners.flatMap((owned, caller) => owned === flight ? [caller] : []) });
  const effectView = (flight, phase) => {
    const job = jobs.findIndex(candidate => candidate.source === flight && candidate.phase === phase);
    return job >= 0 ? { job } : { flight: flightView(flight) };
  };
  const jobViews = new Map();
  for (const [index, job] of jobs.entries()) {
    if (job.phase === FINISHED) continue;
    if (loaders[index] !== job.source) throw new Error(`${context}: job ${index} runs over flight ${job.source} but loader ${index} maps to ${loaders[index]}`);
    const phase = PHASES.get(job.phase);
    if (phase === undefined) throw new Error(`${context}: job ${index} is in phase ${job.phase}, which the held lifecycle never takes`);
    const due = deadlines.find(deadline => deadline.kind === JOB_DEADLINE && deadline.index === index);
    jobViews.set(index, { identity: identityOf(job.source), phase, timedOut: job.timedOut, ...(due !== undefined ? { deadline: due.at } : {}) });
  }
  return {
    now: state.now,
    registered: new Map(processFlights.flatMap((flight, identity) => flight >= 0 ? [[identity, flightView(flight)]] : [])),
    jobs: jobViews,
    reads: new Map(reads.map(held => [held.read, effectView(held.flight, CONFIRMING)])),
    loads: new Map(loads.map(held => [held.load, effectView(held.flight, DECODING)])),
  };
}
// The shadow projected to the fields the layout carries: a job's deadline is
// compared only while the model still holds its budget.
function shadowView(shadow, model) {
  const flight = ({ identity, selected, callers }) => ({ identity, selected, callers });
  const effect = held => "job" in held ? { job: held.job } : { flight: flight(held.flight) };
  const project = entries => new Map([...entries].map(([key, value]) => [key, effect(value)]));
  return {
    now: shadow.now,
    registered: new Map([...shadow.registered].map(([identity, held]) => [identity, flight(held)])),
    jobs: new Map([...shadow.jobs].map(([ordinal, job]) => [ordinal, Object.fromEntries(Object.keys(model.jobs.get(ordinal) ?? { identity: 0, phase: 0, timedOut: 0 }).map(key => [key, job[key]]))])),
    reads: project(shadow.reads),
    loads: project(shadow.loads),
  };
}
const { carriesPrivateState, checkFidelity } = fidelityBinding({ publicChannels: ["o"], layoutFields,
  view: (shadow, state, context) => { const model = modelView(state, context); return [shadowView(shadow, model), model]; } });

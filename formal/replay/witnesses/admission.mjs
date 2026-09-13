import { createWitnessRecorder } from "./recorder.mjs";

// Shadow-job admission witnesses use declared inputs and public observations
// only. Job bookkeeping below mirrors the observed effect indices; it never
// reads private model admissions.
export function admissionWitnesses(histories, recorder = createWitnessRecorder()) {
  for (const { path, steps } of histories) {
    recorder.enter(path);
    let now = 0;
    let overlay = 0;
    const registered = new Map();
    const jobs = new Map();
    const reads = new Map();
    const loads = new Map();
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
      if (previous === undefined) continue;
      for (const outcome of o.shadow) recorder.credit(`outcome:${outcome}`);
      if (step.action === "policy") overlay = step.choice;
      if (step.action === "advance") {
        now += step.choice;
        for (const job of jobs.values()) if (now >= job.deadline) job.timedOut = true;
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
            jobs.set(o.loaders - 1, { identity: flight.identity, phase: "source", deadline: now + 10, timedOut: false });
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
    }
  }
  return recorder.labels();
}

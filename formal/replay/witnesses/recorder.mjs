import { basename } from "node:path";

// Every classifier credits its labels through one recorder, which keeps, per
// label, the history that earned it and the checkpoint step at which the
// classifier credited it. The recorder decides nothing: a classifier calls
// enter(path) when it starts a history and step(index) at the top of its step
// loop, and credit(label) records the label at that step. Rules whose
// consequence spans several public steps pass every establishing step
// explicitly (declared public-prefix checkpoints, the two expiring calls of
// the local-clock shared grid). Labels credited before a history's first
// step(...) call (fixture labels, the init choice) record checkpoint 0.
//
// A label derived from a cumulative public list (an event kind, a read
// budget) is credited again at every later step of the same history. Only the
// step at which a run of consecutive credits begins establishes the
// consequence, so implicit credits record that establishing step and skip the
// continuation; a credit after a gap starts a new establishing checkpoint.
// Explicit checkpoints are always recorded as given.
export function createWitnessRecorder() {
  const credits = new Map();
  const lastImplicit = new Map();
  let history, current = 0;
  const checkpoint = index => {
    if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid witness checkpoint ${index}`);
    return index;
  };
  const recorder = {
    enter(path) {
      if (typeof path !== "string" || path === "") throw new Error("A witness history needs a path");
      history = basename(path);
      current = 0;
    },
    step(index) { current = checkpoint(index); },
    credit(label, ...steps) {
      if (typeof label !== "string" || label === "") throw new Error("A witness label must be a nonempty string");
      if (history === undefined) throw new Error(`Witness ${label} credited outside a history`);
      let histories = credits.get(label);
      if (histories === undefined) credits.set(label, histories = new Map());
      let recorded = histories.get(history);
      if (recorded === undefined) histories.set(history, recorded = new Set());
      if (steps.length) { for (const step of steps) recorded.add(checkpoint(step)); return; }
      const key = `${label}\u0000${history}`;
      const previous = lastImplicit.get(key);
      lastImplicit.set(key, current);
      if (previous === undefined || current !== previous + 1) recorded.add(current);
    },
    labels() { return new Set(credits.keys()); },
    // { label: [{ name, checkpoints }] }: histories in first-credit order,
    // checkpoints ascending. The evidence writer sorts and adds corpus kinds.
    provenance() {
      return Object.fromEntries([...credits].map(([label, histories]) => [label,
        [...histories].map(([name, steps]) => ({ name, checkpoints: [...steps].sort((a, b) => a - b) }))]));
    },
  };
  return recorder;
}

// A recorder already inside one history, for classifiers evaluated on a raw
// trace without a path (tests and per-trace helpers).
export function standaloneRecorder(name = "trace.itf.json") {
  const recorder = createWitnessRecorder();
  recorder.enter(name);
  return recorder;
}

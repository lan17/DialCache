import { basename } from "node:path";

// Every classifier credits its labels through one recorder, which keeps, per
// label, the history that earned it and the checkpoint step at which the
// classifier credited it. The recorder decides nothing: a classifier calls
// enter(path) when it starts a history and step(index) at the top of its step
// loop, and credit(label) records the label at that step. Rules whose public
// checkpoints are declared (public-prefix rules) pass them explicitly. Labels
// credited before a history's first step(...) call (fixture labels, the init
// choice) record checkpoint 0; labels credited after the loop (whole-history
// facts) record the last step the loop visited.
export function createWitnessRecorder() {
  const credits = new Map();
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
      for (const step of steps.length ? steps : [current]) recorded.add(checkpoint(step));
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

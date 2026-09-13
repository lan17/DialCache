import { createWitnessRecorder } from "./recorder.mjs";

// Labels shared by every feature profile: each declared action, every recovery
// and shadow outcome, and (for recovery/shadow) the selected init fixture.
export function actionLabels(histories, recorder = createWitnessRecorder()) {
  for (const { path, steps } of histories) {
    recorder.enter(path);
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      recorder.credit(`action:${step.action}`);
    }
  }
  return recorder.labels();
}
export function flowLabels(histories, fixtures = false, recorder = createWitnessRecorder()) {
  for (const { path, steps } of histories) {
    recorder.enter(path);
    if (fixtures) recorder.credit(`fixture:${steps[0].choice}`);
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      recorder.credit(`action:${step.action}`);
      if (i === 0) continue;
      for (const outcome of step.expected.recovery.concat(step.expected.shadow)) recorder.credit(`outcome:${outcome}`);
    }
  }
  return recorder.labels();
}

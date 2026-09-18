import type { Step } from "../features.mjs";
import type { FeatureHistory } from "./index.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export function independentWitnesses(histories: readonly FeatureHistory[], recorder?: WitnessRecorder): Set<string>;
export function sourceBudgetWitnesses(path: string, steps: readonly Step[], recorder: WitnessRecorder): void;

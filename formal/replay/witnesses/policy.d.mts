import type { FeatureHistory } from "./index.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export function clockWitnesses(name: "policy" | "recovery", histories: readonly FeatureHistory[], recorder?: WitnessRecorder): Set<string>;
export function policyWitnesses(histories: readonly FeatureHistory[], recorder?: WitnessRecorder): Set<string>;

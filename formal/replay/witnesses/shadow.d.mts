import type { FeatureHistory } from "./index.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export function shadowWitnesses(histories: readonly FeatureHistory[], recorder?: WitnessRecorder): Set<string>;

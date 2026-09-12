import type { FeatureHistory } from "./index.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export function layersWitnesses(histories: readonly FeatureHistory[], recorder?: WitnessRecorder): Set<string>;

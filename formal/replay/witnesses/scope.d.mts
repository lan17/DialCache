import type { FeatureHistory } from "./index.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export function scopeWitnesses(histories: readonly FeatureHistory[], recorder?: WitnessRecorder): Set<string>;

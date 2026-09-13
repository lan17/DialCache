import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export const shadowLayersWitnessRules: readonly PublicPrefixWitnessRule[];
export function shadowLayersWitnesses(paths: readonly string[], recorder?: WitnessRecorder): Set<string>;

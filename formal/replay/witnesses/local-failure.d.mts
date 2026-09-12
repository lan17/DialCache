import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export const localFailureWitnessRules: readonly PublicPrefixWitnessRule[];
export function localFailureWitnesses(paths: readonly string[], recorder?: WitnessRecorder): Set<string>;

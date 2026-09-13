import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export const sourceBudgetsWitnessRules: readonly PublicPrefixWitnessRule[];
export function sourceBudgetsWitnesses(paths: readonly string[], recorder?: WitnessRecorder): Set<string>;

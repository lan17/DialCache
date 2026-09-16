import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
import type { RawHistory } from "./trace.mjs";
export const sourceBudgetsWitnessRules: readonly PublicPrefixWitnessRule[];
export function sourceBudgetsWitnesses(histories: readonly RawHistory[], recorder?: WitnessRecorder): Set<string>;

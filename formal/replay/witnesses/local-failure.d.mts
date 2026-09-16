import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
import type { RawHistory } from "./trace.mjs";
export const localFailureWitnessRules: readonly PublicPrefixWitnessRule[];
export function localFailureWitnesses(histories: readonly RawHistory[], recorder?: WitnessRecorder): Set<string>;

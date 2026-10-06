import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
import type { RawHistory } from "./trace.mjs";
export const deletionWitnessRules: readonly PublicPrefixWitnessRule[];
export function deletionWitnesses(histories: readonly RawHistory[], recorder?: WitnessRecorder): Set<string>;

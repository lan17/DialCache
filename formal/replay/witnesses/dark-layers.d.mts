import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
import type { RawHistory } from "./trace.mjs";
export const darkLayersWitnessRules: readonly PublicPrefixWitnessRule[];
export function darkLayersWitnesses(histories: readonly RawHistory[], recorder?: WitnessRecorder): Set<string>;

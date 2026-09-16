import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
import type { RawHistory } from "./trace.mjs";
export const shadowLayersWitnessRules: readonly PublicPrefixWitnessRule[];
export function shadowLayersWitnesses(histories: readonly RawHistory[], recorder?: WitnessRecorder): Set<string>;

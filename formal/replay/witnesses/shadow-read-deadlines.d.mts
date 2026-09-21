import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
import type { RawHistory } from "./trace.mjs";
export const shadowReadDeadlinesWitnessRules: readonly PublicPrefixWitnessRule[];
export function shadowReadDeadlinesWitnesses(histories: readonly RawHistory[], recorder?: WitnessRecorder): Set<string>;

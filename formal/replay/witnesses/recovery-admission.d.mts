import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
import type { RawHistory } from "./trace.mjs";
export const recoveryAdmissionWitnessRules: readonly PublicPrefixWitnessRule[];
export function recoveryAdmissionWitnesses(histories: readonly RawHistory[], recorder?: WitnessRecorder): Set<string>;

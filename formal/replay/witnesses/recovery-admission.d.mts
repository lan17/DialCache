import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export const recoveryAdmissionWitnessRules: readonly PublicPrefixWitnessRule[];
export function recoveryAdmissionWitnesses(paths: readonly string[], recorder?: WitnessRecorder): Set<string>;

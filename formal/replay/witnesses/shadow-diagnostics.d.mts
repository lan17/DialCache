import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export const shadowDiagnosticsWitnessRules: readonly PublicPrefixWitnessRule[];
export function shadowDiagnosticsWitnesses(paths: readonly string[], recorder?: WitnessRecorder): Set<string>;

import type { PublicPrefixWitnessRule } from "./public-prefix.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
import type { RawHistory } from "./trace.mjs";
export const shadowDiagnosticsWitnessRules: readonly PublicPrefixWitnessRule[];
export function shadowDiagnosticsWitnesses(histories: readonly RawHistory[], recorder?: WitnessRecorder): Set<string>;

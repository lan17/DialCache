import type { WitnessRecorder } from "./recorder.mjs";
import type { RawHistory } from "./trace.mjs";

export interface RecoveryReadWitnessRule {
  name: string;
  regression: string;
  commands: string[];
  outcome: Record<string, unknown>;
}
export const recoveryReadWitnessRules: readonly RecoveryReadWitnessRule[];
export function recoveryReadWitnesses(histories: readonly RawHistory[], recorder?: WitnessRecorder): Set<string>;

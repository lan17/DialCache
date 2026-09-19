import type { Expected, Trace } from "../effects.mjs";
import type { WitnessRecorder } from "./recorder.mjs";

export interface EffectsAuthorityRule {
  name: string;
  regression: string;
  commands: string[];
  consequence: (expected: Expected) => boolean;
}
export const effectsAuthorityRules: readonly EffectsAuthorityRule[];
export function effectsAuthorityWitnesses(histories: readonly Trace[], recorder?: WitnessRecorder): Set<string>;

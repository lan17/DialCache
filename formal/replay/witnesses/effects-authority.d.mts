import type { WitnessRecorder } from "./recorder.mjs";

export interface EffectsPublicState {
  calls: number[];
  reads: number;
  loaders: number;
  loads: number;
  dumps: number;
  writes: number;
  events: Array<{ event: string; location: string; detail: string; amount: number }>;
}
export interface EffectsAuthorityRule {
  name: string;
  regression: string;
  commands: string[];
  consequence: (state: EffectsPublicState) => boolean;
}
export interface EffectsAuthorityHistory {
  path: string;
  states: unknown[];
}
export const effectsAuthorityRules: readonly EffectsAuthorityRule[];
export function effectsAuthorityWitnesses(histories: readonly EffectsAuthorityHistory[], recorder?: WitnessRecorder): Set<string>;

import type { Trace as EffectsTrace } from "../effects.mjs";
import type { Trace as FeatureTrace } from "../features.mjs";
import type { LocalClockTrace } from "../local-clock.mjs";
import type { WitnessProvenance, WitnessRecorder } from "./recorder.mjs";
export type FeatureHistory = FeatureTrace & { states: Array<Record<string, unknown>> };
export type WitnessHistory = FeatureHistory | EffectsTrace | LocalClockTrace;
export type WitnessCorpus = FeatureHistory[] | EffectsTrace[] | LocalClockTrace[];
export interface HistorySequences {
  name: string;
  actions: string;
  observations: string;
}
export interface WitnessCheck {
  profile: string;
  traces: number;
  seen: Set<string>;
  required: string[];
  missing: string[];
  provenance: WitnessProvenance;
  histories: HistorySequences[];
}
export const witnessProfiles: readonly string[];
export function loadCorpus(profile: string, paths: readonly string[]): WitnessCorpus;
export function evaluateCorpus(profile: string, corpus: WitnessCorpus, paths: readonly string[], recorder?: WitnessRecorder): Set<string>;
export function evaluateWitnesses(profile: string, paths: readonly string[], recorder?: WitnessRecorder): Set<string>;
export function assertedObservations(profile: string, trace: WitnessHistory): unknown[];
export function historySequences(profile: string, trace: WitnessHistory): HistorySequences;
export function requiredActions(profile: string): string[];
export function readWitnessRegistry(path?: string | URL): Record<string, string[]>;
export function requiredWitnesses(profile: string, registry?: Record<string, string[]>): string[];
export function checkWitnesses(profile: string, paths: readonly string[], registry?: Record<string, string[]>): WitnessCheck;

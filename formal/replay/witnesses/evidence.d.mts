import type { HistorySequences, WitnessCheck } from "./index.mjs";
import type { WitnessProvenance } from "./recorder.mjs";
export type TraceKind = "sampled" | "regression";
export type TraceKinds = ReadonlyMap<string, TraceKind>;
export interface WitnessDigest { path?: string; name?: string; sha256: string }
export interface WitnessLabel {
  sampled: number;
  regression: number;
  traces: Array<{ name: string; kind: TraceKind; checkpoints: number[] }>;
}
export interface WitnessDiversity {
  sampledHistories: number;
  distinctActionSequences: number;
  distinctObservationSequences: number;
}
export interface WitnessEvidence {
  schemaVersion: 2;
  profile: string;
  traces: number;
  required: string[];
  seen: string[];
  labels: Record<string, WitnessLabel>;
  diversity: WitnessDiversity;
  inputs: Array<{ path: string; sha256: string }>;
  corpus: Array<{ name: string; sha256: string }>;
}
export interface WitnessCorpusFiles { paths: readonly string[]; kinds: TraceKinds }
export const traceKinds: readonly TraceKind[];
export function witnessInputs(profile: string, directory?: string): string[];
export function labelProvenance(provenance: WitnessProvenance, kinds: TraceKinds): Record<string, WitnessLabel>;
export function corpusDiversity(histories: readonly HistorySequences[], kinds: TraceKinds): WitnessDiversity;
export function witnessEvidence(profile: string, check: Pick<WitnessCheck, "seen" | "required" | "provenance" | "histories">, corpus: WitnessCorpusFiles, directory?: string): WitnessEvidence;
export function writeWitnessEvidence(outputDirectory: string, evidence: WitnessEvidence): string;

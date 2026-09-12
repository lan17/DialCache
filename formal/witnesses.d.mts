import type { TraceKind, TraceKinds, WitnessDiversity, WitnessEvidence } from "./replay/witnesses/evidence.mjs";
export interface WitnessOptions {
  command: "evaluate" | "report" | "baseline";
  profile: string;
  traces: string;
  out: string;
  baseline: string;
  write: boolean;
}
export interface WitnessBaselineProfile { sampledHistories: number; corpusSha256: string; labels: Record<string, number> }
export interface WitnessBaseline {
  schemaVersion: number;
  seed: string;
  tolerance: number;
  gatedMinimum: number;
  freshSeedSigma: number;
  profiles: Record<string, WitnessBaselineProfile>;
}
export interface LabelRow { label: string; sampled: number; regression: number }
export interface BaselineFindings {
  recorded: boolean;
  gated: string[];
  failed: Array<{ label: string; baseline: number; sampled: number; minimum: number; rule: 'tolerance' | 'collapse' }>;
  rule: 'tolerance' | 'collapse';
  ungated: string[];
  unrecorded: string[];
}
export interface ProfileReport {
  profile: string;
  histories: number;
  diversity: WitnessDiversity;
  missing: string[];
  fragile: LabelRow[];
  rare: LabelRow[];
  sameCorpusAsBaseline: boolean | null;
  seed: string | null;
  sameSeedAsBaseline: boolean | null;
  seedContradiction: boolean;
  baseline: BaselineFindings;
}
export interface WitnessReport {
  schemaVersion: number;
  command: string;
  traces: string;
  seed: string;
  sameSeedAsBaseline: boolean | null;
  baseline: { path: string; seed: string; tolerance: number; gatedMinimum: number; freshSeedSigma: number } | null;
  profiles: Record<string, ProfileReport>;
  incomplete: string[];
  failed: string[];
}
export interface CorpusDirectories { sampled: string; regressions: string }
export interface WitnessCorpusSelection { paths: string[]; kinds: Map<string, TraceKind>; directories: CorpusDirectories }
export const defaultBaselinePath: string;
export const reportFileName: string;
export const rareMaximum: number;
export const baselineDefaults: { tolerance: number; gatedMinimum: number; freshSeedSigma: number };
export function parseArguments(args: readonly string[]): WitnessOptions;
export function traceKind(path: string, directories: CorpusDirectories): TraceKind;
export function witnessCorpus(profile: string, tracesRoot: string, execution?: unknown, directory?: string): WitnessCorpusSelection;
export function witnessCorpusPaths(profile: string, tracesRoot: string, execution?: unknown, directory?: string): string[];
export function selectedProfiles(selection: string, execution?: unknown): string[];
export function readBaseline(path: string): WitnessBaseline | undefined;
export function sampledCorpusFingerprint(corpus: { paths: readonly string[]; kinds: TraceKinds }): string;
export function recordBaseline(existing: WitnessBaseline | undefined, entries: ReadonlyArray<{ profile: string; evidence: WitnessEvidence; fingerprint: string }>, seed: string, defaults?: { tolerance: number; gatedMinimum: number; freshSeedSigma: number }): WitnessBaseline;
export function baselineFindings(profile: string, rows: readonly LabelRow[], baseline: WitnessBaseline | undefined, options?: { freshCorpus?: boolean }): BaselineFindings;
export function canonicalSeed(value: string): string;
export function resolveCorpusSeed(environment?: Record<string, string | undefined>, execution?: unknown): string;
export function gateRule(seed: string | null | undefined, baseline: WitnessBaseline | undefined, sameCorpus: boolean | null): { rule: 'tolerance' | 'collapse'; sameSeed: boolean | null; contradiction: boolean };
export function profileReport(profile: string, evidence: WitnessEvidence, missing: readonly string[], fingerprint: string, baseline: WitnessBaseline | undefined, options?: { seed?: string }): ProfileReport;
export function formatReport(report: WitnessReport): string;
export function evaluateProfiles(options: WitnessOptions, context?: { directory?: string; log?: (message: string) => void; environment?: Record<string, string | undefined> }): WitnessReport;

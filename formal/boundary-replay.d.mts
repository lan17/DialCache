import type { ReplayRecording } from './replay/coordinator.mjs';

export interface BoundaryRecording extends ReplayRecording { history: string; via: 'coordinator' }
export interface EvidenceHistory { history?: string }
export function boundaryTrace(history: string, traces?: string): { profile: string; path: string };
export function goBoundarySelection(profile: string, path: string): { test: string; env: Record<string, string> };
export function readBoundaryRecording(file: string, history: string, path: string,
  result: { status: number | null; signal?: string | null; error?: Error; stdout?: string }): BoundaryRecording;
export function runBoundaryReplay(options: {
  port: 'typescript' | 'go'; history: string; label: string; output: string; root: string;
  workspace: string; env: NodeJS.ProcessEnv; go?: string;
}): BoundaryRecording;
export function boundaryBaselines(evidence: EvidenceHistory[], replay: (history: string) => BoundaryRecording): Record<string, BoundaryRecording>;
export function mutationBoundaries<T extends EvidenceHistory, R>(evidence: T[], replay: (history: string) => BoundaryRecording,
  assess: (entry: T, recording?: BoundaryRecording) => R): R[];

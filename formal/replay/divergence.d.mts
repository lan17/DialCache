export interface Divergence { step: number; action: string; paths: string[] }
export function assertObservation(actual: unknown, expected: unknown): void;
export function isObservationComparison(error: unknown): error is import("node:assert").AssertionError;
export function diffPaths(expected: unknown, actual: unknown, prefix?: string): string[];
export function countingPaths(fields: readonly string[], at: readonly string[], before?: readonly string[]): string[];

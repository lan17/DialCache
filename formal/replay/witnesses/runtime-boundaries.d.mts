import type { WitnessRecorder } from "./recorder.mjs";

export function runtimeBoundaryTraceWitnesses(raw: unknown, recorder?: WitnessRecorder): Set<string>;
export function runtimeBoundaryWitnesses(profile: string, paths: readonly string[], recorder?: WitnessRecorder): Set<string>;

import type { WitnessRecorder } from "./recorder.mjs";
import type { RawHistory } from "./trace.mjs";

export function runtimeBoundaryTraceWitnesses(history: Pick<RawHistory, "states">, recorder?: WitnessRecorder): Set<string>;
export function runtimeBoundaryWitnesses(profile: string, histories: readonly RawHistory[], recorder?: WitnessRecorder): Set<string>;

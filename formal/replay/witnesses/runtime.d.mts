import type { WitnessRecorder } from "./recorder.mjs";
import type { PrivateHistory } from "./trace.mjs";

export function runtimeWitnesses(profile: string, histories: readonly PrivateHistory[], recorder?: WitnessRecorder): Set<string>;

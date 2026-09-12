import type { WitnessRecorder } from "./recorder.mjs";

export function runtimeWitnesses(profile: string, paths: readonly string[], recorder?: WitnessRecorder): Set<string>;

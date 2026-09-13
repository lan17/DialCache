import type { WitnessRecorder } from "./recorder.mjs";

export function recoveryShadowWitnesses(profile: string, paths: readonly string[], recorder?: WitnessRecorder): Set<string>;

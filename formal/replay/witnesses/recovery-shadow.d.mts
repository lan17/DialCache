import type { WitnessRecorder } from "./recorder.mjs";
import type { PrivateHistory } from "./trace.mjs";

export function recoveryShadowWitnesses(profile: string, histories: readonly PrivateHistory[], recorder?: WitnessRecorder): Set<string>;

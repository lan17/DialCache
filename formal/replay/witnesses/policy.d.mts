import type { Trace as FeatureTrace } from "../features.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export function policyWitnesses(histories: readonly (FeatureTrace & { predictions?: Array<Record<string, unknown>> })[], recorder?: WitnessRecorder): Set<string>;

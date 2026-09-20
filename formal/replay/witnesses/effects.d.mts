import type { Trace } from "../effects.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
import type { PrivateHistory } from "./trace.mjs";
// A parsed effects history; one that still carries the model's private predictions is also bound by the fidelity check.
export type EffectsWitnessHistory = Trace & Partial<Pick<PrivateHistory, "predictions">>;
export function effectsWitnesses(traces: readonly EffectsWitnessHistory[], recorder?: WitnessRecorder): Set<string>;

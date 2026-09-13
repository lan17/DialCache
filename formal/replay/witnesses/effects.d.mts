import type { Trace } from "../effects.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export function effectsWitnesses(traces: readonly Trace[], recorder?: WitnessRecorder): Set<string>;

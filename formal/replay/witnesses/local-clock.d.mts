import type { LocalClockTrace } from "../local-clock.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export function localClockWitnesses(traces: readonly LocalClockTrace[], recorder?: WitnessRecorder): Set<string>;

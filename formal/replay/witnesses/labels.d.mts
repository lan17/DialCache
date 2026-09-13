import type { FeatureHistory } from "./index.mjs";
import type { WitnessRecorder } from "./recorder.mjs";
export function actionLabels(histories: readonly FeatureHistory[], recorder?: WitnessRecorder): Set<string>;
export function flowLabels(histories: readonly FeatureHistory[], fixtures?: boolean, recorder?: WitnessRecorder): Set<string>;

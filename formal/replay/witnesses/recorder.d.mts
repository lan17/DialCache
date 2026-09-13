export type WitnessProvenance = Record<string, Array<{ name: string; checkpoints: number[] }>>;
export interface WitnessRecorder {
  enter(path: string): void;
  step(index: number): void;
  credit(label: string, ...steps: number[]): void;
  labels(): Set<string>;
  provenance(): WitnessProvenance;
}
export function createWitnessRecorder(): WitnessRecorder;
export function standaloneRecorder(name?: string): WitnessRecorder;

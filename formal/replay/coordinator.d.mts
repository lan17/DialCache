import type { Divergence } from "./divergence.mjs";

export const protocolVersion: 1;
export const settlement: "causally-ready-v1";
export interface ReplayRecording {
  path: string;
  divergences: Divergence[];
  completed: boolean;
  /** Last observation that passed shape and settlement checks; -1 before any. */
  lastStep: number;
  error?: string;
}
export class ReplayCoordinator {
  constructor(options?: { record?: boolean; onRecord?: (recording: ReplayRecording) => void });
  dispatch(request: unknown): Record<string, unknown>;
  recording(session: string): ReplayRecording | undefined;
  abort(session: string, error: unknown): void;
}

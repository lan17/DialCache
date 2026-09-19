export interface VectorSample {
  row: string;
  request: { operation: string; input: Record<string, unknown> };
  expected: Record<string, unknown>;
  inputSha256: string;
}
export interface VectorEvidence {
  artifact: string;
  group: string;
  rows: Record<'typescript' | 'go', string>;
  fields: string[];
  relation: string;
  artifactSha256: string;
  samples: Record<'typescript' | 'go', VectorSample>;
}
export function validVectorResult(operation: string, value: unknown): boolean;
export function resolveVectorEvidence(written: unknown, model: { vectorExport?: { artifact: string } }, readSource: (path: string) => string): VectorEvidence;
export function assessVectorBoundary(evidence: { vector: VectorEvidence; history: string; fields: string[] }, recording?: unknown): {
  state: string; completed: boolean; lastStep: number; reason?: string; divergences: Array<{ step: number; action: string; paths: string[] }>;
};

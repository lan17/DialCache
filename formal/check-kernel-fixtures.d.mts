export const fixtureDirectory: string;
export function kernelFixtures(directory?: string): string[];
export function checkKernelFixtures(options?: { directory?: string; manifest?: unknown; seed?: string; timeoutMs?: number }): Promise<{ fixtures: number; runs: number }>;

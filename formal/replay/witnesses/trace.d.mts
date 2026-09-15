export function readTrace(path: string): unknown;
export function traceStates(raw: unknown, context: string): unknown[];
export function explicitInput(state: unknown, context: string): { name: string; choice: number };
export function witnessCommand(name: string, choice?: number): string;
export function decodeIntegers(value: unknown, context: string): unknown;
export function integer(value: unknown, context: string): number;
export interface RawHistory { path: string; states: unknown[] }
export interface PrivateHistory extends RawHistory { predictions: Array<Record<string, unknown>> }
export function witnessStates(raw: unknown, context: string): Omit<PrivateHistory, "path">;

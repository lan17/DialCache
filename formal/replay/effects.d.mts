import type { Fixture, Input, Observation } from "../../typescript/test/formal/behavior-driver.js";
export const actions: readonly string[];
export const observedFields: readonly string[];
export interface Event { event: string; location: string; detail: string; amount: number }
export interface ReadContext { index: number; timeoutMs: number; aborted: boolean }
// The observation versions 2 and 3 assert at a step, parsed from the composed layout (s.o, s.io, s.events) or the retired one.
export type Expected = Record<"loaders"|"reads"|"writes"|"invalidations"|"loads"|"dumps"|"policyCalls", number> & { calls: number[]; events: Event[]; writeTtls: number[]; readAborts: number[]; readContexts: ReadContext[] };
export interface Step { action: string; choice: number; expected: Expected }
export interface Trace { path: string; steps: Step[] }
export function parseTrace(raw: unknown, path: string): Trace;
export interface EffectsDescriptor { explicitInputs: true; parseTrace: typeof parseTrace; actions: Record<string, { choices?: number[] | "index" }> }
export const effectsDescriptor: EffectsDescriptor;
export function fixtureFor(mode: number): Fixture;
// The choice is read only for the actions that record one (init, wall advance, the reply, the budget policy, the observer fault, the loader and read settlements).
export function inputsFor(step: { action: string; choice?: number }, observed: Observation, environment: { wallMs: number }): Input[];
export function project(observed: Observation): Record<string, unknown>;
export function expectedObservations(trace: Trace): Expected[];

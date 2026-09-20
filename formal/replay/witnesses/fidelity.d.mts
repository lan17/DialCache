export type PrivateState = Record<string, unknown>;
export type FidelityView<Shadow, State extends PrivateState> = (shadow: Shadow, state: State, context: string) => [Record<string, unknown>, Record<string, unknown>];
export function carriesPrivateState(predictions: readonly PrivateState[] | undefined, publicChannels: readonly string[]): boolean;
export function requireLayout<State extends PrivateState>(state: State, layoutFields: readonly string[], context: string): State;
export function compareViews(ours: Record<string, unknown>, theirs: Record<string, unknown>, context: string): void;
export function checkFidelity<Shadow, State extends PrivateState>(shadows: readonly Shadow[], predictions: readonly State[], path: string, view: FidelityView<Shadow, State>): void;
export function shadowSequence<Shadow>(initial: Shadow, frames: ReadonlyArray<{ after: Shadow }>): Shadow[];
export function fidelityBinding<Shadow, State extends PrivateState>(options: { publicChannels: readonly string[]; layoutFields?: readonly string[]; view: FidelityView<Shadow, State> }): {
  carriesPrivateState(predictions: readonly PrivateState[] | undefined): boolean;
  checkFidelity(shadows: readonly Shadow[], predictions: readonly State[], path: string): void;
};

/** protocol.schema.json definition every behavior driver's receipt must satisfy. */
export const receiptDefinition: "settlementReceipt";
/** Matches the rule texts `SettlementLedger.assert` produces; the mutation runners classify violations by it. */
export const settlementViolationPattern: RegExp;
/** 2026-09-08T12:00:00.000Z: where every controlled driver starts its wall clock. */
export const wallEpochMs: 1788868800000;

export interface HeldGates {
  loaders: number;
  reads: number;
  writes: number;
  dumps: number;
  loads: number;
  policies: number;
  scopes: number;
}

/** What a behavior driver attests about the instant its observation was taken. */
export interface SettlementReceipt {
  /** The driver's controlled monotonic clock, in whole milliseconds. */
  elapsedMs: number;
  /** What one zero-time verification drain after the snapshot found; 0 means settled. */
  runnable: number;
  /** Controlled external gates still unsettled at the snapshot. */
  held: HeldGates;
}

export class SettlementLedger {
  /** Only the two elapsed-time sentinels of the fixture are read. */
  constructor(fixture: { sourceWorkMs?: number; comparisonMs?: number } | Record<string, unknown>,
    setup?: ReadonlyArray<Record<string, unknown>>);
  /** Record the commands issued since the previous observation. */
  issue(commands: ReadonlyArray<Record<string, unknown>>): void;
  /** The receipt the schedule requires for this observation (runnable is always 0). */
  expected(observed: unknown): SettlementReceipt;
  /** The wall clock the schedule requires for this observation. */
  wallMs(observed: unknown): number;
  /** Throws `Settlement violation: ...` for the first rule (R2 to R5) the receipt breaks. */
  assert(receipt: SettlementReceipt, observed: unknown, environment: { wallMs: number }): void;
  /** R4 alone: throws `Settlement violation: wall clock ...` when the reported wall clock leaves the schedule. */
  assertWallClock(observed: unknown, environment: { wallMs: number }): void;
}

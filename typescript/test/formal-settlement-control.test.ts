import { describe, expect, it, vi } from "vitest";

import { profileActions } from "../../formal/replay/bindings.mjs";
import { ReplayCoordinator } from "../../formal/replay/coordinator.mjs";
import { profiles } from "../../formal/replay/features.mjs";
import { wallEpochMs } from "../../formal/replay/settlement.mjs";
import { FallbackTimeoutError } from "../src/errors.js";
import { BehaviorDriver, type Fixture, type Input } from "./formal/behavior-driver.js";
import { replayThroughCoordinator, smokeTracePath } from "./formal/coordinated-replay.js";

// Harness control for the causally-ready-v1 settlement contract (PORTING.md).
// Every BehaviorDriver-backed profile replays its committed smoke history
// through the shared coordinator twice: with the settling driver, which must
// pass, and with a driver that skips its end-of-apply drain, which the
// coordinator must reject through the settlement receipt (runnable work found
// by the verification drain), never through an observation mismatch. If the
// skipped drain could pass, the contract would be unenforced and a port could
// pass without ever settling; if it failed only by mismatch, an unsettled
// driver could earn mutation credit. The core and local-clock profiles use
// other drivers and carry no receipt.
const behaviorProfiles = Object.keys(profileActions()).filter(name => name !== "core" && name !== "local-clock");

// Measured 2026-09-18 at commit 76ba3ef: the unsettled driver first reports
// runnable work at step 2 of source-budgets, 3 of runtime-boundaries, 2 of
// shadow-layers, 1 of local-failure, 5 of recovery-read, 4 of independent, 1
// of layers, 1 of admission, 4 of scope, 1 of recovery, 2 of policy, 1 of
// shadow and 5 of effects, at or before the step where its observation would
// first mismatch. Every profile must detect; exempt one only with a written
// reason (for example a regenerated smoke history that observes nothing
// asynchronous), and never all of them.
describe("harness control: causally-ready-v1 settlement", () => {
  it("covers every behavior-driver profile the coordinator serves", () => {
    expect(behaviorProfiles.length).toBeGreaterThan(0);
  });
  // The verification drain compares one encoding of the observation with
  // itself. A value the library hands back is recorded by reference, and an
  // Error instance is exactly what a fault can put there (mutant M37 publishes
  // a rejected source's error into local storage); nothing ran after the
  // snapshot, so the receipt must say so.
  it("reports nothing runnable when a call value is a live object the library hands back", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(wallEpochMs));
    const layers = profiles.layers!;
    const fixture = (layers.fixture as (choice: number) => Fixture)(5);
    const driver = new BehaviorDriver(fixture, {}, {});
    try {
      for (const input of layers.setup) await driver.apply(input as Input);
      await driver.apply({ op: "begin" });
      await driver.apply({ op: "resolve", loader: 0, value: new FallbackTimeoutError("Behavior", 10) } as unknown as Input);
      expect(driver.receipt().runnable).toBe(0);
      expect(driver.settlementDiagnostic()).toBeUndefined();
      expect(driver.snapshot().calls[0]).toMatchObject({ status: "value", value: { name: "FallbackTimeoutError" } });
    } finally {
      await driver.dispose();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  // The timer term of the attestation. With the settle drain skipped, the
  // call's remote read has not started at the snapshot; the verification
  // drain starts it (an observed read-context event) against the held read
  // gate and arms its read deadline, so the receipt counts the armed timer
  // beside the observation change and the diagnostic names both.
  it("counts a timer the verification drain arms as runnable work beside the observation change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(wallEpochMs));
    const independent = profiles.independent!;
    const driver = new BehaviorDriver(independent.fixture as Fixture, {}, { settle: false });
    try {
      for (const input of independent.setup) await driver.apply(input as Input);
      await driver.apply({ op: "begin" });
      expect(driver.receipt().runnable).toBeGreaterThan(1);
      expect(driver.settlementDiagnostic()).toMatch(/^verification drain: observation member events changed, pending timers 0 -> [1-9]\d*$/);
    } finally {
      await driver.dispose();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
  for (const name of behaviorProfiles) {
    it(`${name} smoke history passes with the settling driver`, async () => {
      await replayThroughCoordinator(name, smokeTracePath(name));
    });
    it(`${name} smoke history fails a driver that skips settlement by settlement violation, never by mismatch`, async () => {
      const outcome = await replayThroughCoordinator(name, smokeTracePath(name), new ReplayCoordinator(), { settle: false })
        .then(() => "passed", (cause: unknown) => String(cause));
      expect(outcome).toMatch(/Settlement violation: /);
      expect(outcome).not.toMatch(/Observation mismatch/);
      expect(outcome).not.toMatch(/expected:[\s\S]*actual:/);
    });
  }
});

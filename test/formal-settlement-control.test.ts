import { describe, expect, it } from "vitest";

import { profileActions } from "../formal/replay/bindings.mjs";
import { ReplayCoordinator } from "../formal/replay/coordinator.mjs";
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
const profiles = Object.keys(profileActions()).filter(name => name !== "core" && name !== "local-clock");

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
    expect(profiles.length).toBeGreaterThan(0);
  });
  for (const name of profiles) {
    it(`${name} smoke history passes with the settling driver`, async () => {
      await replayThroughCoordinator(name, smokeTracePath(name));
    });
    it(`${name} smoke history fails a driver that skips settlement by settlement violation, never by mismatch`, async () => {
      const outcome = await replayThroughCoordinator(name, smokeTracePath(name), new ReplayCoordinator(), { settle: false })
        .then(() => "passed", (cause: unknown) => String(cause));
      expect(outcome).toMatch(/Settlement violation: \d+ runnable task\(s\) at observation/);
      expect(outcome).not.toMatch(/Observation mismatch/);
      expect(outcome).not.toMatch(/expected:[\s\S]*actual:/);
    });
  }
});

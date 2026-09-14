import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Trace = { states: Array<Record<string, any>>; [key: string]: unknown };
type Schedule = Array<[string, number]>;
const { projectPilotTrace, comparePilotHistory, witnessCheckpoints, validatePilot, validatePilotChallenges, validatePilotChallengeResult, validateWitnessControlResult, explorationComparison } = await import(
  new URL("../formal/kernel-pilot.mjs", import.meta.url).href,
) as {
  projectPilotTrace(raw: unknown, path?: string): Trace;
  comparePilotHistory(profile: string, baseline: Trace, pilot: Trace, actions: Schedule, path?: string): { steps: number; status: string };
  witnessCheckpoints(raw: Trace, required: string[], path?: string): Record<string, number[]>;
  validatePilot(raw: unknown): unknown;
  validatePilotChallenges(raw: unknown, pilot: unknown): unknown;
  validatePilotChallengeResult(result: unknown, exitCode: number, raw: unknown, history: unknown, check: unknown, expectation: string): { status: string };
  validateWitnessControlResult(output: string, exitCode: number, required: string[]): { status: string; tests: string[] };
  explorationComparison(baseline: unknown, kernel: unknown, settings: { backend: string; seed: string }, bounds: { maxSamples: number; maxSteps: number }): Record<string, unknown>;
};
const read = (path: string) => JSON.parse(readFileSync(resolve(path), "utf8"));
const schedule = (trace: Trace): Schedule => trace.states.map(state => [state.input.name, Number(state.input.choice["#bigint"])]);
const exported = (trace: Trace, prefix = "K") => ({ states: trace.states.map(state => ({
  [`${prefix}::input`]: structuredClone(state.input), [`${prefix}::view`]: structuredClone(state.s),
  [`${prefix}::witnesses`]: { "#set": ["coalesced-success"] },
})) });

describe("supplemental kernel pilot evidence", () => {
  it("projects only explicitly exported input/view fields without mutating the Quint trace", () => {
    const baseline: Trace = read("formal/effects-smoke.itf.json");
    const raw = exported(baseline, "effects_pilot::K"), original = structuredClone(raw);
    const projected = projectPilotTrace(raw, "effects/pilot");
    expect(raw).toEqual(original);
    expect(comparePilotHistory("effects", baseline, projected, schedule(baseline))).toEqual({ steps: baseline.states.length, status: "passed" });
    projected.states[0]!.input.choice["#bigint"] = "5";
    expect(raw).toEqual(original);
    expect(projected.states[1]!["mbt::actionTaken"]).toBe(baseline.states[1]!.input.name);
  });

  it.each(["input", "view", "witnesses"])("rejects missing or ambiguous exported %s instead of reconstructing it", field => {
    const raw = exported(read("formal/effects-smoke.itf.json"));
    delete (raw.states[1] as Record<string, unknown>)[`K::${field}`];
    expect(() => projectPilotTrace(raw, "effects/missing")).toThrow(new RegExp(`effects/missing step 1: expected one declared K::${field}, found 0`));
    const ambiguous = exported(read("formal/effects-smoke.itf.json"));
    (ambiguous.states[1] as Record<string, unknown>)[`other::K::${field}`] = {};
    expect(() => projectPilotTrace(ambiguous, "effects/ambiguous")).toThrow(/step 1: expected one declared.*found 2/);
  });

  it.each(["effects", "layers"])("compares public %s outcomes with profile, history, action and step diagnostics", profile => {
    const baseline: Trace = read(`formal/${profile}-smoke.itf.json`);
    const pilot = projectPilotTrace(exported(baseline));
    const s = pilot.states[1]!.s;
    const observation = profile === "layers" ? s.o : s;
    observation.writes = { "#bigint": String(Number(observation.writes["#bigint"]) + 1) };
    expect(() => comparePilotHistory(profile, baseline, pilot, schedule(baseline), `${profile}/changed-write`))
      .toThrow(new RegExp(`${profile}/changed-write step 1 action.*\\nexpected baseline:.*\\nactual kernel:`));
  });

  it("does not mistake internal state layout changes for public behavior changes", () => {
    const baseline: Trace = read("formal/effects-smoke.itf.json");
    const pilot = projectPilotTrace(exported(baseline));
    pilot.states[1]!.s.acceptedAt = { "#bigint": "12345" };
    expect(comparePilotHistory("effects", baseline, pilot, schedule(baseline)).status).toBe("passed");
  });

  it("requires exactly the scheduled external inputs and complete history", () => {
    const baseline: Trace = read("formal/effects-smoke.itf.json");
    const pilot = projectPilotTrace(exported(baseline));
    const wrong = schedule(baseline); wrong[1] = ["tick", -1];
    expect(() => comparePilotHistory("effects", baseline, pilot, wrong, "effects/wrong-input")).toThrow(/effects\/wrong-input step 1: baseline executed a different input/);
    pilot.states.pop();
    expect(() => comparePilotHistory("effects", baseline, pilot, schedule(baseline), "effects/truncated")).toThrow(/effects\/truncated: incomplete schedule/);
  });

  it("requires the declared consequential labels exported by Quint", () => {
    const pilot = projectPilotTrace(exported(read("formal/effects-smoke.itf.json")));
    expect(witnessCheckpoints(pilot, ["coalesced-success"])["coalesced-success"]).toHaveLength(pilot.states.length);
    expect(() => witnessCheckpoints(pilot, ["shared-failure-retry"], "effects/missing-witness")).toThrow(/effects\/missing-witness: Quint never witnessed shared-failure-retry/);
    pilot.states[1]!.pilotWitnesses = { "#set": [1] };
    expect(() => witnessCheckpoints(pilot, [], "effects/invalid-witness")).toThrow(/effects\/invalid-witness step 1: invalid Quint witness set/);
  });

  it("keeps the pilot catalog input-only and rejects accidentally duplicated schedules", () => {
    const catalog = read("formal/kernel/pilot.json");
    expect(validatePilot(catalog)).toBe(catalog);
    const expected = structuredClone(catalog); expected.histories[0].expected = { calls: [1] };
    expect(() => validatePilot(expected)).toThrow(/inputs and evidence references only/);
    const duplicate = structuredClone(catalog); duplicate.histories.push(duplicate.histories[0]);
    expect(() => validatePilot(duplicate)).toThrow(/duplicate pilot history/);
  });

  it("checks fault declarations against the selected profile, invariant and bounded input history", () => {
    const pilot = read("formal/kernel/pilot.json"), challenges = read("formal/kernel/challenges.json");
    expect(validatePilotChallenges(challenges, pilot)).toBe(challenges);
    for (const patch of [{ history: "unknown" }, { profile: "unknown" }, { invariant: "doesNotExist" }, { failureStep: 1000 }]) {
      const invalid = structuredClone(challenges); Object.assign(invalid.challenges[0].checks[0], patch);
      expect(() => validatePilotChallenges(invalid, pilot)).toThrow(/invalid history, invariant or failure checkpoint/);
    }
    for (const before of ["__missing_kernel_anchor__", " "]) {
      const invalid = structuredClone(challenges); invalid.challenges[0].before = before;
      expect(() => validatePilotChallenges(invalid, pilot)).toThrow(/mutation anchor must match exactly once/);
    }
  });

  it("reports sampled exploration separately and requires successful finite timings from both models", () => {
    const settings = { backend: "rust", seed: "0xd1a1ca" }, bounds = { maxSamples: 2000, maxSteps: 40 };
    const baseline = { result: { status: "ok", errors: [], trace: [{}] }, status: 0, durationMs: 100, report: "baseline.json" };
    const kernel = { ...baseline, durationMs: 500, report: "kernel.json" };
    expect(explorationComparison(baseline, kernel, settings, bounds)).toEqual({
      status: "passed", kind: "sampled-exploration", backend: "rust", seed: "0xd1a1ca", threads: 1, bounds,
      invariants: [], includesCliStartup: true, sameInputHistories: false,
      baseline: { durationMs: 100, report: "baseline.json" }, kernel: { durationMs: 500, report: "kernel.json" }, ratio: 5,
    });
    const invalid = [undefined, { ...baseline, status: 1 }, { ...baseline, result: {} },
      { ...baseline, result: { ...baseline.result, errors: ["evaluator failed"] } },
      ...[undefined, 0, -1, NaN, Infinity].map(durationMs => ({ ...baseline, durationMs }))];
    for (const measured of invalid) {
      expect(() => explorationComparison(measured, kernel, settings, bounds)).toThrow();
      expect(() => explorationComparison(baseline, measured, settings, bounds)).toThrow();
    }
  });

  it("credits only an invariant violation at its declared public input checkpoint", () => {
    const baseline: Trace = read("formal/effects-smoke.itf.json");
    const history = { id: "fault", profile: "effects", actions: schedule(baseline) };
    const check = { invariant: "publicationHasTimelySource", failureStep: 1 };
    const raw = exported(baseline); raw.states = raw.states.slice(0, 2);
    const violation = { status: "violation", errors: [], trace: [{}, {}] };
    expect(validatePilotChallengeResult(violation, 1, raw, history, check, "mutant").status).toBe("detected");
    expect(() => validatePilotChallengeResult({ ...violation, errors: ["evaluation failed"] }, 1, raw, history, check, "mutant")).toThrow(/Evaluator errors/);
    expect(() => validatePilotChallengeResult({ ...violation, status: "ok" }, 0, raw, history, check, "mutant")).toThrow(/fault survived/);
    expect(() => validatePilotChallengeResult(violation, 1, raw, history, { ...check, failureStep: 2 }, "mutant")).toThrow(/declared.*checkpoint 2/);
    raw.states[1]!["K::input"].name = "tick";
    expect(() => validatePilotChallengeResult(violation, 1, raw, history, check, "mutant")).toThrow(/step 1: mutant executed a different challenge input/);
  });

  it("requires every named Quint witness control to finish instead of accepting an empty test run", () => {
    const output = "  ok consequenceRequiredTest passed 1 test(s)\n  ok corruptedHistoryRejectedTest passed 1 test(s)\n";
    const tests = ["consequenceRequiredTest", "corruptedHistoryRejectedTest"];
    expect(validateWitnessControlResult(output, 0, tests)).toEqual({ status: "passed", tests });
    for (const invalid of ["0 passing", output.split("\n")[0]!, output + output]) {
      expect(() => validateWitnessControlResult(invalid, 0, tests)).toThrow(/did not all complete/);
    }
    expect(() => validateWitnessControlResult(output, 1, tests)).toThrow(/did not all complete/);
  });
});

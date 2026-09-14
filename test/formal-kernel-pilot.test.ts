import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Trace = { states: Array<Record<string, any>>; [key: string]: unknown };
type Schedule = Array<[string, number]>;
const { projectPilotTrace, comparePilotHistory, witnessCheckpoints, validatePilot, validatePilotChallenges, validatePilotChallengeResult, validateWitnessControlResult, explorationComparison, pilotInvariants, explorationRepetitions } = await import(
  new URL("../formal/kernel-pilot.mjs", import.meta.url).href,
) as {
  projectPilotTrace(raw: unknown, path?: string): Trace;
  comparePilotHistory(profile: string, baseline: Trace, pilot: Trace, actions: Schedule, path?: string): { steps: number; status: string };
  witnessCheckpoints(raw: Trace, required: string[], path?: string): Record<string, number[]>;
  validatePilot(raw: unknown): unknown;
  validatePilotChallenges(raw: unknown, pilot: unknown): unknown;
  validatePilotChallengeResult(result: unknown, exitCode: number, raw: unknown, history: unknown, check: unknown, expectation: string): { status: string };
  validateWitnessControlResult(output: string, exitCode: number, required: string[]): { status: string; tests: string[] };
  explorationComparison(baseline: unknown, kernel: unknown, settings: { backend: string; seed: string }, bounds: { maxSamples: number; maxSteps: number },
    options?: Record<string, unknown>): Record<string, unknown>;
  pilotInvariants: string[];
  explorationRepetitions: number;
};
const read = (path: string) => JSON.parse(readFileSync(resolve(path), "utf8"));
const schedule = (trace: Trace): Schedule => trace.states.map(state => [state.input.name, Number(state.input.choice["#bigint"])]);
const exported = (trace: Trace, prefix = "K") => ({ states: trace.states.map(state => ({
  [`${prefix}::input`]: structuredClone(state.input), [`${prefix}::view`]: structuredClone(state.s),
  [`${prefix}::monitor`]: { initialized: true, cursors: [{ "#bigint": "-1" }], labels: { "#set": ["coalesced-success"] } },
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

  it.each(["input", "view", "monitor"])("rejects missing or ambiguous exported %s instead of reconstructing it", field => {
    const raw = exported(read("formal/effects-smoke.itf.json"));
    delete (raw.states[1] as Record<string, unknown>)[`K::${field}`];
    expect(() => projectPilotTrace(raw, "effects/missing")).toThrow(new RegExp(`effects/missing step 1: expected one declared K::${field}, found 0`));
    const ambiguous = exported(read("formal/effects-smoke.itf.json"));
    (ambiguous.states[1] as Record<string, unknown>)[`other::K::${field}`] = {};
    expect(() => projectPilotTrace(ambiguous, "effects/ambiguous")).toThrow(/step 1: expected one declared.*found 2/);
  });

  it("takes credited labels only from the monitor's recorded label set", () => {
    const raw = exported(read("formal/effects-smoke.itf.json"));
    for (const monitor of [undefined, null, [], { labels: [] }, { labels: { "#set": "coalesced-success" } }, { cursors: [] }]) {
      const invalid = structuredClone(raw);
      (invalid.states[1] as Record<string, unknown>)["K::monitor"] = monitor;
      expect(() => projectPilotTrace(invalid, "effects/monitor")).toThrow(/effects\/monitor step 1: (witness monitor does not record a label set|expected one declared K::monitor)/);
    }
    const projected = projectPilotTrace(raw);
    expect(projected.states[1]!.pilotWitnesses).toEqual({ "#set": ["coalesced-success"] });
    expect(Object.keys(projected.states[1]!).sort()).toEqual(["input", "mbt::actionTaken", "mbt::nondetPicks", "pilotWitnesses", "s"]);
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

  it("pins the pilot inventory: twelve histories, eleven labels, five faults with seven checks, five properties, fifteen controls", () => {
    const catalog = read("formal/kernel/pilot.json"), challenges = read("formal/kernel/challenges.json");
    const byProfile = (profile: string) => catalog.histories.filter((history: { profile: string }) => history.profile === profile);
    expect(catalog.histories).toHaveLength(12);
    expect(byProfile("layers")).toHaveLength(5);
    expect(byProfile("effects")).toHaveLength(7);
    const labels = new Set<string>(catalog.histories.flatMap((history: { witnesses: string[] }) => history.witnesses));
    expect([...labels].sort()).toEqual([
      "abandoned-source-replacement", "accepted-publication-after-deadline", "acquired-fence-suppresses-publication", "coalesced-success",
      "future-frame-refills-after-source", "inflight-publication-remains-fenced", "late-reject-rejected", "late-resolve-rejected",
      "published-value-reused", "shared-failure-retry", "tracked-redis-warms-local",
    ]);
    expect(challenges.challenges).toHaveLength(5);
    expect(challenges.challenges.flatMap((challenge: { checks: unknown[] }) => challenge.checks)).toHaveLength(7);
    expect(pilotInvariants).toHaveLength(5);
    expect(explorationRepetitions).toBe(2);
    const controls = readFileSync(resolve("formal/kernel/lifecycle-witnesses-test.qnt"), "utf8").match(/^\s*run \w+Test\b/gm) ?? [];
    expect(controls).toHaveLength(15);
    const monitor = readFileSync(resolve("formal/kernel/lifecycle-witnesses.qnt"), "utf8");
    expect(monitor.match(/^\s*pure val \w+: Script = \{/gm)).toHaveLength(4);
    expect([...monitor.matchAll(/label: "([a-z-]+)"/g)].map(match => match[1]).sort()).toEqual([
      "acquired-fence-suppresses-publication", "future-frame-refills-after-source", "inflight-publication-remains-fenced", "tracked-redis-warms-local",
    ]);
  });

  it("keeps the pilot catalog input-only and rejects accidentally duplicated schedules", () => {
    const catalog = read("formal/kernel/pilot.json");
    expect(validatePilot(catalog)).toBe(catalog);
    for (const exploration of [undefined, {}, { maxRatio: "2" }, { maxRatio: 0.5 }, { maxRatio: NaN }, { maxRatio: Infinity }, { maxRatio: null },
      { maxRatio: { withInvariants: 2, withoutInvariants: 3 } }, { maxRatio: 2, other: 1 }]) {
      const invalid = structuredClone(catalog); invalid.exploration = exploration;
      expect(() => validatePilot(invalid)).toThrow(/Invalid kernel pilot exploration bound/);
    }
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

  it("bounds the kernel view's wall time against the original profile and records the evaluation-only ratio", () => {
    const settings = { backend: "rust", seed: "0xd1a1ca" }, bounds = { maxSamples: 2048, maxSteps: 80 };
    const invariants = { baseline: ["sourceEffectsMatch"], kernel: ["publicationHasTimelySource"] };
    const fixedCost = { baseline: 40, kernel: 50 };
    const options = { label: "layers exploration with invariants", invariants, fixedCost, maxRatio: 2 };
    const run = (durationMs: number, report: string, patch: Record<string, unknown> = {}) =>
      ({ result: { status: "ok", errors: [], trace: [{}] }, status: 0, durationMs, report, ...patch });
    const baseline = { runs: [run(120, "baseline-1.json"), run(100, "baseline-2.json")] };
    const kernel = { runs: [run(150, "kernel-1.json"), run(180, "kernel-2.json")] };
    expect(explorationComparison(baseline, kernel, settings, bounds, options)).toEqual({
      status: "passed", kind: "sampled-exploration", backend: "rust", seed: "0xd1a1ca", threads: 1, bounds,
      invariants, includesCliStartup: true, sameInputHistories: false,
      baseline: { durationMs: 100, durations: [120, 100], reports: ["baseline-1.json", "baseline-2.json"], fixedCostMs: 40, evaluationMs: 60 },
      kernel: { durationMs: 150, durations: [150, 180], reports: ["kernel-1.json", "kernel-2.json"], fixedCostMs: 50, evaluationMs: 100 },
      ratio: 1.5, evaluationRatio: 100 / 60, gated: true, maxRatio: 2,
    });
    expect(explorationComparison(baseline, { runs: [run(200, "k.json")] }, settings, bounds, options)).toMatchObject({ status: "passed", ratio: 2 });
    expect(explorationComparison(baseline, { runs: [run(201, "k.json")] }, settings, bounds, options)).toMatchObject({
      status: "failed", ratio: 2.01, gated: true, maxRatio: 2,
      violation: "layers exploration with invariants: the kernel view took 2.01x the original profile's wall time (bound 2x); 201 ms against 100 ms",
    });
    const { maxRatio: _unused, ...ungated } = options;
    expect(explorationComparison(baseline, { runs: [run(900, "k.json")] }, settings, bounds, ungated)).toMatchObject({ status: "passed", ratio: 9, gated: false });
    expect(explorationComparison(baseline, { runs: [run(900, "k.json")] }, settings, bounds, ungated)).not.toHaveProperty("maxRatio");
    const broken: Array<Record<string, unknown>> = [{}, { invariants }, { invariants, fixedCost, maxRatio: 0.5 }, { invariants: { baseline: [] }, fixedCost, maxRatio: 2 },
      { invariants, fixedCost, maxRatio: NaN }, { invariants, fixedCost: { baseline: 40 }, maxRatio: 2 }, { invariants, fixedCost: { baseline: 0, kernel: 50 }, maxRatio: 2 },
      { invariants, fixedCost: { baseline: 100, kernel: 50 }, maxRatio: 2 }];
    for (const options of broken) expect(() => explorationComparison(baseline, kernel, settings, bounds, options)).toThrow();
    const invalid = [undefined, {}, { runs: [] }, { runs: [run(100, "r.json", { status: 1 })] }, { runs: [run(100, "r.json", { result: {} })] },
      { runs: [run(100, "r.json", { result: { status: "ok", errors: ["evaluator failed"], trace: [{}] } })] },
      ...[undefined, 0, -1, NaN, Infinity].map(durationMs => ({ runs: [run(100, "ok.json"), run(durationMs as number, "bad.json")] }))];
    for (const measured of invalid) {
      expect(() => explorationComparison(measured, kernel, settings, bounds, options)).toThrow();
      expect(() => explorationComparison(baseline, measured, settings, bounds, options)).toThrow();
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { corpusDiversity, labelProvenance, witnessEvidence } from "../formal/replay/witnesses/evidence.mjs";
import { checkWitnesses, historySequences } from "../formal/replay/witnesses/index.mjs";
import { publicCheckpoint, publicPrefixRule, publicPrefixWitnesses, witnessCommand } from "../formal/replay/witnesses/public-prefix.mjs";
import { createWitnessRecorder, standaloneRecorder } from "../formal/replay/witnesses/recorder.mjs";
import { baselineFindings, parseArguments, profileReport, readBaseline, recordBaseline, traceKind } from "../formal/witnesses.mjs";
import type { WitnessEvidence } from "../formal/replay/witnesses/evidence.mjs";
import type { WitnessHistory } from "../formal/replay/witnesses/index.mjs";

const directories: string[] = [];
const scratch = () => { const directory = mkdtempSync(join(tmpdir(), "dialcache-witness-provenance-")); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const integer = (value: number) => ({ "#bigint": String(value) });
const baseline = {
  schemaVersion: 1, seed: "0x1", tolerance: 0.5, gatedMinimum: 10,
  profiles: { effects: { sampledHistories: 10, corpusSha256: "0".repeat(64), labels: { gated: 20, exact: 10, rare: 5 } } },
};
type Row = { label: string; sampled: number; regression: number };
const row = (label: string, sampled: number, regression = 0): Row => ({ label, sampled, regression });

describe("witness recorder provenance", () => {
  it("records the history and the checkpoint step of every credit", () => {
    const recorder = createWitnessRecorder();
    recorder.enter("/corpus/features/scope/trace_1.itf.json");
    recorder.credit("fixture:2"); // before the step loop: checkpoint 0
    recorder.step(3); recorder.credit("x");
    recorder.step(7); recorder.credit("x"); recorder.credit("x");
    recorder.credit("y", 4, 2); // declared public checkpoints
    recorder.enter("/corpus/regressions/scope/pinnedTest.itf.json");
    recorder.step(1); recorder.credit("x");
    expect([...recorder.labels()].sort()).toEqual(["fixture:2", "x", "y"]);
    expect(recorder.provenance()).toEqual({
      "fixture:2": [{ name: "trace_1.itf.json", checkpoints: [0] }],
      x: [{ name: "trace_1.itf.json", checkpoints: [3, 7] }, { name: "pinnedTest.itf.json", checkpoints: [1] }],
      y: [{ name: "trace_1.itf.json", checkpoints: [2, 4] }],
    });
  });

  it("rejects credits outside a history and invalid checkpoints", () => {
    expect(() => createWitnessRecorder().credit("x")).toThrow(/outside a history/);
    const recorder = createWitnessRecorder();
    expect(() => recorder.enter("")).toThrow(/path/);
    recorder.enter("trace_1.itf.json");
    expect(() => recorder.step(-1)).toThrow(/checkpoint/);
    expect(() => recorder.credit("x", 1.5)).toThrow(/checkpoint/);
    expect(() => recorder.credit("")).toThrow(/label/);
    const standalone = standaloneRecorder();
    standalone.credit("x");
    expect(standalone.provenance()).toEqual({ x: [{ name: "trace.itf.json", checkpoints: [0] }] });
  });

  it("credits a public-prefix rule at its declared checkpoints", () => {
    const directory = scratch();
    const path = join(directory, "trace_7.itf.json");
    const state = (name: string, choice: number, calls: number[]) => ({ input: { name, choice: integer(choice) }, s: { o: { calls: calls.map(integer) } } });
    writeFileSync(path, JSON.stringify({ states: [state("init", -1, []), state("beginCall", 0, [0]), state("resolveLoader", 1, [1]), state("beginCall", 1, [1, 0])] }));
    const rule = publicPrefixRule("settled-then-probed", "settledThenProbedTest",
      [witnessCommand("init"), witnessCommand("beginCall", 0), witnessCommand("resolveLoader", 1)],
      publicCheckpoint(1, { calls: [0] }), publicCheckpoint(2, { calls: [1] }));
    const recorder = createWitnessRecorder();
    expect(publicPrefixWitnesses([path], [rule], recorder).has(rule.name)).toBe(true);
    expect(recorder.provenance()).toEqual({ "settled-then-probed": [{ name: "trace_7.itf.json", checkpoints: [1, 2] }] });
    const unmet = publicPrefixRule("unmet", "unmetTest", rule.commands, publicCheckpoint(2, { calls: [2] }));
    expect(publicPrefixWitnesses([path], [unmet]).size).toBe(0);
  });
});

describe("witness corpus kinds and diversity", () => {
  it("classifies a history by the corpus directory it came from", () => {
    const directory = scratch();
    const dirs = { sampled: join(directory, "features/scope"), regressions: join(directory, "regressions/scope") };
    expect(traceKind(join(dirs.sampled, "trace_3.itf.json"), dirs)).toBe("sampled");
    expect(traceKind(join(dirs.regressions, "pinnedTest.itf.json"), dirs)).toBe("regression");
    expect(() => traceKind(join(directory, "features/policy/trace_3.itf.json"), dirs)).toThrow(/outside/);
  });

  it("counts distinct action and asserted-observation sequences over sampled histories only", () => {
    const trace = (path: string, calls: number[]) => ({ path, steps: [
      { action: "init", choice: 0, expected: { calls: [], loaders: 0 } },
      { action: "constructInstance", choice: 0, expected: { calls: [], loaders: 0 } },
      { action: "call", choice: 1, expected: { calls, loaders: 1 } },
    ] }) as unknown as WitnessHistory;
    const first = historySequences("local-clock", trace("/corpus/features/local-clock/trace_1.itf.json", [1]));
    const second = historySequences("local-clock", trace("/corpus/features/local-clock/trace_2.itf.json", [2]));
    const pinned = historySequences("local-clock", trace("/corpus/regressions/local-clock/pinnedTest.itf.json", [2]));
    expect(first.actions).toBe(second.actions);
    expect(first.observations).not.toBe(second.observations);
    expect(second.observations).toBe(pinned.observations);
    const kinds = new Map<string, "sampled" | "regression">([["trace_1.itf.json", "sampled"], ["trace_2.itf.json", "sampled"], ["pinnedTest.itf.json", "regression"]]);
    expect(corpusDiversity([first, second, pinned], kinds)).toEqual({ sampledHistories: 2, distinctActionSequences: 1, distinctObservationSequences: 2 });
    expect(corpusDiversity([first, pinned], kinds)).toEqual({ sampledHistories: 1, distinctActionSequences: 1, distinctObservationSequences: 1 });
    expect(() => corpusDiversity([{ name: "unknown.itf.json", actions: "[]", observations: "[]" }], kinds)).toThrow(/corpus kind/);
  });

  it("splits per-label provenance into sampled and regression hits", () => {
    const kinds = new Map<string, "sampled" | "regression">([["trace_1.itf.json", "sampled"], ["pinnedTest.itf.json", "regression"]]);
    expect(labelProvenance({ x: [{ name: "trace_1.itf.json", checkpoints: [3, 7] }, { name: "pinnedTest.itf.json", checkpoints: [2] }], a: [{ name: "trace_1.itf.json", checkpoints: [0] }] }, kinds)).toEqual({
      a: { sampled: 1, regression: 0, traces: [{ name: "trace_1.itf.json", kind: "sampled", checkpoints: [0] }] },
      x: { sampled: 1, regression: 1, traces: [{ name: "pinnedTest.itf.json", kind: "regression", checkpoints: [2] }, { name: "trace_1.itf.json", kind: "sampled", checkpoints: [3, 7] }] },
    });
    expect(() => labelProvenance({ x: [{ name: "other.itf.json", checkpoints: [1] }] }, kinds)).toThrow(/corpus kind/);
  });
});

describe("witness evidence schema 2", () => {
  it("carries provenance and diversity beside the schema 1 fields", () => {
    const root = resolve(".");
    const path = resolve(root, "formal/effects-smoke.itf.json");
    const check = checkWitnesses("effects", [path]);
    const kinds = new Map<string, "sampled" | "regression">([["effects-smoke.itf.json", "sampled"]]);
    const evidence: WitnessEvidence = witnessEvidence("effects", check, { paths: [path], kinds }, root);
    expect(evidence).toMatchObject({ schemaVersion: 2, profile: "effects", traces: 1, required: check.required, seen: [...check.seen].sort(),
      diversity: { sampledHistories: 1, distinctActionSequences: 1, distinctObservationSequences: 1 } });
    expect(Object.keys(evidence.labels)).toEqual(evidence.seen);
    for (const label of Object.values(evidence.labels)) {
      expect(label).toMatchObject({ sampled: 1, regression: 0 });
      expect(label.traces).toHaveLength(1);
      expect(label.traces[0]).toMatchObject({ name: "effects-smoke.itf.json", kind: "sampled" });
      expect(label.traces[0]!.checkpoints.length).toBeGreaterThan(0);
    }
    const fixture = evidence.seen.find(label => label.startsWith("fixture:"));
    expect(fixture).toBeDefined();
    expect(evidence.labels[fixture!]?.traces[0]?.checkpoints).toEqual([0]);
    expect(evidence.corpus).toEqual([{ name: "effects-smoke.itf.json", sha256: expect.stringMatching(/^[a-f\d]{64}$/) }]);
    expect(evidence.inputs.map(input => input.path)).toContain("formal/replay/witnesses/recorder.mjs");
    expect(() => witnessEvidence("effects", check, { paths: [path], kinds: new Map() }, root)).toThrow(/corpus kind/);
  });
});

describe("witness baseline gate", () => {
  it("fails a gated label below the tolerance and only reports the rest", () => {
    const findings = baselineFindings("effects", [row("gated", 10), row("exact", 5), row("rare", 0), row("new", 1)], baseline);
    expect(findings).toEqual({ recorded: true, gated: ["gated", "exact"], failed: [], ungated: ["rare"], unrecorded: ["new"] });
    const tripped = baselineFindings("effects", [row("gated", 9), row("exact", 4), row("rare", 0)], baseline);
    expect(tripped.failed).toEqual([{ label: "gated", baseline: 20, sampled: 9, minimum: 10 }, { label: "exact", baseline: 10, sampled: 4, minimum: 5 }]);
    expect(baselineFindings("scope", [row("gated", 0)], baseline)).toEqual({ recorded: false, gated: [], failed: [], ungated: [], unrecorded: ["gated"] });
    expect(baselineFindings("scope", [row("gated", 0)], undefined).recorded).toBe(false);
  });

  it("reports fragile unpinned and pinned-but-rare labels per profile", () => {
    const evidence = { traces: 12, required: ["fragile", "pinned", "common", "unreached"], diversity: { sampledHistories: 10, distinctActionSequences: 9, distinctObservationSequences: 10 },
      labels: { fragile: { sampled: 2, regression: 0, traces: [] }, pinned: { sampled: 1, regression: 1, traces: [] }, common: { sampled: 50, regression: 0, traces: [] } },
      corpus: [] } as unknown as WitnessEvidence;
    const report = profileReport("effects", evidence, ["unreached"], new Map(), baseline);
    expect(report.fragile).toEqual([row("fragile", 2), row("unreached", 0)]);
    expect(report.rare).toEqual([row("pinned", 1, 1)]);
    expect(report).toMatchObject({ histories: 12, missing: ["unreached"], sameCorpusAsBaseline: false, baseline: { recorded: true, unrecorded: ["fragile", "pinned", "common", "unreached"] } });
  });

  it("reads, records and merges baselines from evidence", () => {
    const directory = scratch();
    expect(readBaseline(join(directory, "missing.json"))).toBeUndefined();
    writeFileSync(join(directory, "bad.json"), JSON.stringify({ schemaVersion: 1, seed: "0x1", tolerance: 1.5, gatedMinimum: 10, profiles: {} }));
    expect(() => readBaseline(join(directory, "bad.json"))).toThrow(/unsupported/);
    const evidence = { required: ["a", "b"], labels: { a: { sampled: 12, regression: 1, traces: [] } }, diversity: { sampledHistories: 3 },
      corpus: [{ name: "trace_1.itf.json", sha256: "1".repeat(64) }, { name: "pinnedTest.itf.json", sha256: "2".repeat(64) }] } as unknown as WitnessEvidence;
    const kinds = new Map<string, "sampled" | "regression">([["trace_1.itf.json", "sampled"], ["pinnedTest.itf.json", "regression"]]);
    const recorded = recordBaseline(undefined, [{ profile: "scope", evidence, kinds }], "0x2a");
    expect(recorded).toMatchObject({ schemaVersion: 1, seed: "0x2a", tolerance: 0.5, gatedMinimum: 10,
      profiles: { scope: { sampledHistories: 3, corpusSha256: expect.stringMatching(/^[a-f\d]{64}$/), labels: { a: 12, b: 0 } } } });
    const merged = recordBaseline(structuredClone(baseline), [{ profile: "scope", evidence, kinds }], "0x1");
    expect(Object.keys(merged.profiles)).toEqual(["effects", "scope"]);
    expect(() => recordBaseline(baseline, [{ profile: "scope", evidence, kinds }], "0x2a")).toThrow(/seed/);
  });

  it("parses the evaluate, report and baseline commands", () => {
    expect(parseArguments(["evaluate"])).toMatchObject({ command: "evaluate", profile: "all", traces: ".formal-traces", out: ".formal-traces/go-parity-witnesses", baseline: "formal/witness-baseline.json", write: false });
    expect(parseArguments(["report", "--profile", "effects", "--baseline", "b.json"])).toMatchObject({ command: "report", profile: "effects", baseline: "b.json" });
    expect(parseArguments(["baseline", "--write", "--traces", "corpus"])).toMatchObject({ command: "baseline", write: true, traces: "corpus" });
    for (const args of [["baseline"], ["report", "--out", "x"], ["check"], ["evaluate", "--profile"], ["evaluate", "--unknown", "x"]]) {
      expect(() => parseArguments(args)).toThrow(/Usage/);
    }
  });
});

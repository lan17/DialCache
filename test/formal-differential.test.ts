import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

type Step = { action: string; choice: number; expected: Record<string, unknown>; io?: unknown };
type History = { path: string; steps: Step[] };
type Verdict = { path: string; agree: boolean; step?: number; action?: string; choice?: number; reason?: string; fields?: string[] };
type Manifests = { execution: { settings: Record<string, unknown>; models: Array<Record<string, unknown>> }; registry: { profiles: Array<{ id: string; version?: number }> } };
type Model = { path: string; generate: { outputDirectory: string; traces: number }; invariants: string[]; replayRegressions?: string[]; settings: { backend: string; seed: string };
  behaviorVersion: number; schemaVersion: number | null; maxBytesPerStateRatio: number };
type Plan = { action: "skip" | "compare"; reason?: string; reference?: Model; candidate: Model; descriptor: unknown };
type Report = { profile: string; skipped?: string; forward: { disagreed: number }; reverse: { disagreed: number };
  generation: { bytesPerStateRatio: number | null; maxBytesPerStateRatio: number; wallRatio: number | null } };
const differential = await import(new URL("../formal/differential.mjs", import.meta.url).href) as {
  compareHistory(reference: History, replayed: History): { agree: boolean; step?: number; action?: string; choice?: number; reason?: string; fields?: string[] };
  chunked<T>(items: T[], size: number): T[][];
  bytesPerState(directory: string): { traces: number; states: number; bytes: number; bytesPerState: number };
  historyOf(raw: unknown, path: string, descriptor: unknown): History;
  recordedStates(raw: { states: unknown[] }): { states: unknown[] };
  runDiagnostic(log: string, run: string): string | null;
  differentialPlan(reference: Manifests, candidate: Manifests, profileId: string): Plan;
  readManifests(directory: string): Manifests;
  replayHistories(tree: string, model: Model, descriptor: unknown, histories: History[], options: { chunk: number; output: string; concurrency: number }): Promise<Verdict[]>;
  composedProfiles(manifest: { models: Array<{ path: string; profile?: string }> }, options?: { cwd?: string }): string[];
  kernelModuleCount(directory?: string): number;
  verdict(report: Report): { failed: boolean; reasons: string[] };
  formatReport(report: Report): string;
  defaultChunk: number;
  cursorVariable: string;
};
const fixtures = await import(new URL("../formal/generated-fixtures.mjs", import.meta.url).href) as {
  scheduleHistories(source: string, declarations: Map<string, unknown>, sourceMap: unknown, histories: Array<Array<[string, number]>>, options: { prefix: string; cursor: string }):
    { declarations: string[]; schedules: Array<{ init: string; step: string; steps: number }>; clones: number };
};
const { readExecution, quintSources } = await import(new URL("../formal/execution.mjs", import.meta.url).href) as {
  readExecution(): { models: Array<{ path: string; profile?: string }> }; quintSources(directory?: string): string[];
};
const root = fileURLToPath(new URL("../", import.meta.url));
const quintAvailable = spawnSync("quint", ["--version"], { encoding: "utf8" }).status === 0;

const step = (action: string, choice: number, calls: number[], extra: Record<string, unknown> = {}): Step => ({ action, choice, expected: { calls, loaders: 0 }, ...extra });
const manifests = (models: Array<Record<string, unknown>>, version = 2): Manifests => ({
  execution: { settings: { backend: "rust", threads: 1, seed: "0xd1a1ca", verbosity: 1 }, models },
  registry: { profiles: [{ id: "layers", version }] },
});
const layersModel = (extra: Record<string, unknown> = {}) => ({ path: "formal/dialcache-layers-conformance.qnt", profile: "layers", invariants: ["a"], regressions: [],
  generate: { maxSamples: 4, maxSteps: 4, traces: 2, outputDirectory: ".formal-traces/features/layers" }, ...extra });

describe("corpus differential comparison", () => {
  it("agrees on identical histories and names the differing channel and field", () => {
    const reference: History = { path: "trace_0", steps: [step("init", 0, []), step("beginCall", 3, [0]), step("resolveLoader", 1, [1])] };
    expect(differential.compareHistory(reference, structuredClone(reference))).toEqual({ agree: true });
    const divergent = structuredClone(reference);
    divergent.steps[2]!.expected = { calls: [2], loaders: 0 };
    const verdict = differential.compareHistory(reference, divergent);
    expect(verdict).toMatchObject({ agree: false, step: 2, action: "resolveLoader", choice: 1, fields: ["expected.calls.0"] });
    expect(verdict.reason).toMatch(/observation differs after resolveLoader\/1 at step 2: expected\.calls\.0 2 \(reference 1\)/);
  });

  it("compares every driver-asserted channel of a step, not only the observation", () => {
    const reference: History = { path: "trace_2", steps: [step("init", 0, []), step("beginCall", 1, [0], { io: [{ budget: 5 }] })] };
    const sideChannel = structuredClone(reference);
    (sideChannel.steps[1] as { io: unknown }).io = [{ budget: 10 }];
    const verdict = differential.compareHistory(reference, sideChannel);
    expect(verdict).toMatchObject({ agree: false, step: 1, fields: ["io.0.budget"] });
    expect(verdict.reason).toContain("io.0.budget 10 (reference 5)");
  });

  it("reports a replaced input and names the input the replay refused", () => {
    const reference: History = { path: "trace_1", steps: [step("init", 0, []), step("beginCall", 3, [0]), step("tick", -1, [0])] };
    const replaced = structuredClone(reference);
    replaced.steps[1] = step("seed", 3, [0]);
    expect(differential.compareHistory(reference, replaced)).toMatchObject({ agree: false, step: 1, reason: "input seed/3 replaces beginCall/3" });
    const truncated: History = { path: "trace_1", steps: reference.steps.slice(0, 2) };
    expect(differential.compareHistory(reference, truncated)).toMatchObject({ agree: false, step: 2, action: "tick", choice: -1,
      reason: "tick/-1 refused at step 2 (replay has 2 states, reference 3)" });
  });

  it("drops the trailing meta-only state a stopped run records and finds a run's diagnostic in a test log", () => {
    const raw = { states: [{ "#meta": { index: 0 }, s: {}, input: {} }, { "#meta": { index: 1 }, s: {}, input: {} }, { "#meta": { index: 2 } }] };
    expect(differential.recordedStates(raw).states).toHaveLength(2);
    const log = "  1) replay0:\n      Error [QNT513]: Reps loop could not continue after iteration #2 evaluated to false\n  2) replay3:\n      Error [QNT513]: Reps loop could not continue after iteration #5 evaluated to false\n";
    expect(differential.runDiagnostic(log, "replay3")).toMatch(/QNT513.*iteration #5/);
    expect(differential.runDiagnostic(log, "replay0")).toMatch(/iteration #2/);
    expect(differential.runDiagnostic(log, "replay1")).toBeNull();
  });

  it("chunks histories in input order and measures bytes per state over a trace directory", () => {
    expect(differential.chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(differential.chunked([], 3)).toEqual([]);
    expect(differential.defaultChunk).toBe(16);
    const directory = mkdtempSync(join(tmpdir(), "differential-bytes-"));
    try {
      const trace = JSON.stringify({ states: [{ s: 1 }, { s: 2 }, { s: 3 }] });
      writeFileSync(join(directory, "a.itf.json"), trace);
      writeFileSync(join(directory, "b.itf.json"), trace);
      writeFileSync(join(directory, "notes.txt"), "ignored");
      expect(differential.bytesPerState(directory)).toEqual({ traces: 2, states: 6, bytes: 2 * Buffer.byteLength(trace), bytesPerState: Buffer.byteLength(trace) / 3 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("plans a comparison only when both revisions generate the profile at the same declared behavior", () => {
    const candidate = manifests([layersModel()]);
    expect(differential.differentialPlan(manifests([layersModel()]), candidate, "layers")).toMatchObject({ action: "compare",
      reference: { behaviorVersion: 0, schemaVersion: 2, maxBytesPerStateRatio: 1.2 }, candidate: { behaviorVersion: 0 } });
    // The reference manifest is read as recorded: extra or missing keys are not validated against the working tree.
    const older = manifests([{ ...layersModel(), unrelatedKey: true }]);
    (older.execution as Record<string, unknown>).kernel = ["formal/kernel/x.qnt"];
    expect(differential.differentialPlan(older, candidate, "layers").action).toBe("compare");
    expect(differential.differentialPlan(manifests([]), candidate, "layers")).toMatchObject({ action: "skip", reason: /new profile/ });
    expect(differential.differentialPlan(manifests([layersModel()]), manifests([layersModel({ differential: { behaviorVersion: 1 } })]), "layers"))
      .toMatchObject({ action: "skip", reason: "intended divergence: behaviorVersion 0 -> 1" });
    expect(differential.differentialPlan(manifests([layersModel()], 2), manifests([layersModel()], 3), "layers"))
      .toMatchObject({ action: "skip", reason: "intended divergence: observation schema version 2 -> 3" });
    expect(differential.differentialPlan(manifests([layersModel()]), manifests([layersModel({ differential: { maxBytesPerStateRatio: 1.5 } })]), "layers"))
      .toMatchObject({ action: "compare", candidate: { maxBytesPerStateRatio: 1.5 } });
    expect(() => differential.differentialPlan(manifests([]), manifests([]), "layers")).toThrow(/No generation profile named layers/);
  });

  it("fails the run on a disagreement in either direction or trace growth beyond the bound; wall time is advisory", () => {
    type Sketch = { forward?: Report["forward"]; reverse?: Report["reverse"]; generation?: Partial<Report["generation"]> };
    const report = (extra: Sketch): Report => ({ profile: "layers",
      forward: extra.forward ?? { disagreed: 0 }, reverse: extra.reverse ?? { disagreed: 0 },
      generation: { bytesPerStateRatio: 1, maxBytesPerStateRatio: 1.2, wallRatio: 1, ...(extra.generation ?? {}) } });
    expect(differential.verdict(report({}))).toEqual({ failed: false, reasons: [] });
    expect(differential.verdict(report({ forward: { disagreed: 2 } }))).toMatchObject({ failed: true, reasons: ["2 forward disagreement(s)"] });
    expect(differential.verdict(report({ reverse: { disagreed: 1 } }))).toMatchObject({ failed: true, reasons: ["1 reverse disagreement(s)"] });
    expect(differential.verdict(report({ generation: { bytesPerStateRatio: 1.25 } }))).toMatchObject({ failed: true, reasons: [expect.stringMatching(/x1\.250, above the bound x1\.2/)] });
    expect(differential.verdict(report({ generation: { bytesPerStateRatio: 1.25, maxBytesPerStateRatio: 1.3 } }))).toEqual({ failed: false, reasons: [] });
    expect(differential.verdict(report({ generation: { wallRatio: 2 } }))).toEqual({ failed: false, reasons: [expect.stringMatching(/^advisory: generation wall time x2\.00/)] });
    expect(differential.verdict({ profile: "layers", skipped: "new profile" } as unknown as Report)).toEqual({ failed: false, reasons: ["skipped: new profile"] });
    expect(differential.formatReport({ profile: "layers", skipped: "intended divergence: behaviorVersion 0 -> 1" } as unknown as Report)).toBe("layers: not compared (intended divergence: behaviorVersion 0 -> 1).");
  });

  it("selects the composed profiles by their kernel imports, following helper libraries, and lists every Quint source", () => {
    expect(differential.composedProfiles(readExecution())).toEqual(["layers"]);
    const tree = mkdtempSync(join(tmpdir(), "differential-composed-"));
    try {
      mkdirSync(join(tree, "formal/kernel"), { recursive: true });
      writeFileSync(join(tree, "formal/kernel/clock.qnt"), "module clock { pure def advance(n: int): int = n + 1 }");
      writeFileSync(join(tree, "formal/helper.qnt"), 'module helper { import clock.* from "./kernel/clock" }');
      writeFileSync(join(tree, "formal/dialcache-a-conformance.qnt"), 'module a { import helper.* from "./helper" }');
      writeFileSync(join(tree, "formal/dialcache-b-conformance.qnt"), 'module b { import cache_rules.* from "./cache-rules" }');
      const manifest = { models: [{ path: "formal/dialcache-a-conformance.qnt", profile: "a" }, { path: "formal/dialcache-b-conformance.qnt", profile: "b" }, { path: "formal/other.qnt" }] };
      expect(differential.composedProfiles(manifest, { cwd: tree })).toEqual(["a"]);
      expect(differential.kernelModuleCount(tree)).toBe(1);
    } finally { rmSync(tree, { recursive: true, force: true }); }
    const sources = quintSources(root);
    expect(sources).toContain("formal/dialcache-layers-conformance.qnt");
    expect(sources).toContain("formal/kernel/serving.qnt");
    expect([...sources].sort()).toEqual(sources);
  });
});

describe.skipIf(!quintAvailable)("corpus differential replay through a tree", () => {
  const output = mkdtempSync(join(tmpdir(), "differential-replay-"));
  afterAll(() => rmSync(output, { recursive: true, force: true }));
  const layers = () => {
    const plan = differential.differentialPlan(differential.readManifests(root), differential.readManifests(root), "layers");
    return { model: plan.candidate, descriptor: plan.descriptor };
  };
  const smokeHistory = (descriptor: unknown) => differential.historyOf(JSON.parse(readFileSync(resolve(root, "formal/layers-smoke.itf.json"), "utf8")), "layers-smoke", descriptor);
  const copyTree = (into: string) => {
    for (const path of quintSources(root)) {
      mkdirSync(join(into, path, ".."), { recursive: true });
      writeFileSync(join(into, path), readFileSync(resolve(root, path)));
    }
    return into;
  };

  it("shares one constrained clone per input pair across the histories of a chunk", async () => {
    const { model } = layers();
    const parse = spawnSync("quint", ["parse", model.path, `--out=${output}/parsed.json`, `--source-map=${output}/map.json`], { cwd: root, encoding: "utf8" });
    expect(parse.status, parse.stderr).toBe(0);
    const parsed = JSON.parse(readFileSync(`${output}/parsed.json`, "utf8")) as { modules: Array<{ name: string; declarations: Array<{ name: string }> }> };
    const declarations = new Map(parsed.modules.at(-1)!.declarations.map(declaration => [declaration.name, declaration]));
    const source = readFileSync(resolve(root, model.path), "utf8");
    const schedule = fixtures.scheduleHistories(source, declarations, JSON.parse(readFileSync(`${output}/map.json`, "utf8")),
      [[["init", 0], ["beginCall", 3], ["tick", -1]], [["init", 0], ["tick", -1], ["beginCall", 3], ["beginCall", 7]]], { prefix: "replay", cursor: "replayCursor" });
    expect(schedule.clones).toBe(4);
    expect(schedule.declarations.filter(line => line.startsWith("var ")).length).toBe(1);
    expect(schedule.declarations.filter(line => line.startsWith("action replayAction")).length).toBe(4);
    expect(schedule.schedules.map(entry => entry.steps)).toEqual([2, 3]);
    expect(schedule.schedules[0]!.init).toBe("all { replayAction0, replayCursor' = 0 }");
    expect(schedule.schedules[1]!.step).toBe("any { all { replayCursor == 0, replayAction2, replayCursor' = 1 }, all { replayCursor == 1, replayAction1, replayCursor' = 2 }, all { replayCursor == 2, replayAction3, replayCursor' = 3 } }");
  });

  it("replays the committed layers smoke history and an exported regression through the current text and agrees with both", async () => {
    const { model, descriptor } = layers();
    const smoke = smokeHistory(descriptor);
    expect(smoke.steps.length).toBeGreaterThan(2);
    const regressions = join(output, "regressions");
    mkdirSync(regressions);
    const exported = spawnSync("quint", ["test", model.path, "--backend=rust", "--max-samples=1", `--seed=${model.settings.seed}`,
      "--match=^untrackedSourcePublicationIsProbedInAllThreeLayersTest$", `--out-itf=${regressions}/{test}.itf.json`], { cwd: root, encoding: "utf8" });
    expect(exported.status, exported.stderr + exported.stdout).toBe(0);
    const regression = differential.historyOf(JSON.parse(readFileSync(join(regressions, "untrackedSourcePublicationIsProbedInAllThreeLayersTest.itf.json"), "utf8")), "regression", descriptor);
    const verdicts = await differential.replayHistories(root, model, descriptor, [smoke, regression], { chunk: 1, output: join(output, "agree"), concurrency: 2 });
    expect(verdicts).toEqual([{ path: "layers-smoke", agree: true }, { path: "regression", agree: true }]);
    const generated = readFileSync(join(output, "agree", "replay-0", model.path), "utf8");
    expect(generated).toContain(`var ${differential.cursorVariable}: int`);
    expect(generated).toMatch(/run replay0 = \(all \{ replayAction0, replayCursor' = 0 \}\)\.then\(\(\d+\)\.reps\(_ => replaySchedule0\)\)/);
  }, 180_000);

  it("detects a candidate whose library changes an observation, naming the channel", async () => {
    const { model, descriptor } = layers();
    const candidate = copyTree(join(output, "mutant"));
    const serving = join(candidate, "formal/kernel/serving.qnt");
    const text = readFileSync(serving, "utf8");
    expect(text).toContain("loaders: state.o.loaders + 1");
    writeFileSync(serving, text.replace("loaders: state.o.loaders + 1", "loaders: state.o.loaders + 2"));
    const [verdict] = await differential.replayHistories(candidate, model, descriptor, [smokeHistory(descriptor)], { chunk: 64, output: join(output, "mutant-out"), concurrency: 1 });
    expect(verdict!.agree).toBe(false);
    expect(verdict!.fields).toEqual(["expected.loaders"]);
  }, 180_000);

  it("names the input a candidate refuses, with the evaluator's diagnostic", async () => {
    const { model, descriptor } = layers();
    const candidate = copyTree(join(output, "refusing"));
    const profile = join(candidate, model.path);
    const text = readFileSync(profile, "utf8");
    expect(text).toContain("s.o.calls.length() < MAX_CALLERS,");
    writeFileSync(profile, text.replace("s.o.calls.length() < MAX_CALLERS,", "s.o.calls.length() < 1,"));
    const smoke = smokeHistory(descriptor);
    const refused = smoke.steps.findIndex((entry, index) => index > 0 && entry.action === "beginCall" && smoke.steps.slice(1, index).some(previous => previous.action === "beginCall"));
    expect(refused).toBeGreaterThan(0);
    const [verdict] = await differential.replayHistories(candidate, model, descriptor, [smoke], { chunk: 16, output: join(output, "refusing-out"), concurrency: 1 });
    expect(verdict).toMatchObject({ agree: false, step: refused, action: "beginCall" });
    expect(verdict!.reason).toMatch(new RegExp(`beginCall/\\d+ refused at step ${refused} .*QNT513`));
  }, 180_000);
});

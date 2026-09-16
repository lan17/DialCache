import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

type Step = { action: string; choice: number; expected: Record<string, unknown> };
type History = { path: string; steps: Step[] };
type Verdict = { path: string; agree: boolean; step?: number; reason?: string; fields?: string[] };
const differential = await import(new URL("../formal/differential.mjs", import.meta.url).href) as {
  compareHistory(reference: History, replayed: History): { agree: boolean; step?: number; reason?: string; fields?: string[] };
  chunked<T>(items: T[], size: number): T[][];
  bytesPerState(directory: string): { traces: number; states: number; bytes: number; bytesPerState: number };
  quintSources(directory: string): string[];
  historyOf(raw: unknown, path: string, profile: unknown): History;
  replayModule(source: string, declarations: Map<string, unknown>, sourceMap: unknown, histories: History[], options: { module: string }): { text: string; clones: number; runs: number };
  replayHistories(candidateTree: string, model: { path: string; manifest: { settings: { backend: string } } }, profile: unknown, histories: History[],
    options: { chunk: number; seed: string; output: string; concurrency: number }): Promise<Verdict[]>;
  differentialModel(manifest: unknown, profileId: string): { path: string; manifest: { settings: { backend: string; seed: string } }; descriptor: unknown; generate: { outputDirectory: string } };
  formatReport(report: unknown): string;
  cursorVariable: string;
};
const { readExecution } = await import(new URL("../formal/execution.mjs", import.meta.url).href) as { readExecution(): { models: unknown[] } };
const root = fileURLToPath(new URL("../", import.meta.url));
const quintAvailable = spawnSync("quint", ["--version"], { encoding: "utf8" }).status === 0;

const step = (action: string, choice: number, calls: number[]): Step => ({ action, choice, expected: { calls, loaders: 0 } });

describe("corpus differential comparison", () => {
  it("agrees on identical histories and reports the first divergent observation field", () => {
    const reference: History = { path: "trace_0", steps: [step("init", 0, []), step("beginCall", 3, [0]), step("resolveLoader", 1, [1])] };
    expect(differential.compareHistory(reference, structuredClone(reference))).toEqual({ agree: true });
    const divergent = structuredClone(reference);
    divergent.steps[2]!.expected = { calls: [2], loaders: 0 };
    const verdict = differential.compareHistory(reference, divergent);
    expect(verdict.agree).toBe(false);
    expect(verdict.step).toBe(2);
    expect(verdict.fields).toEqual(["calls"]);
    expect(verdict.reason).toMatch(/observation differs after resolveLoader\/1 at step 2: calls \[2\] \(reference \[1\]\)/);
  });

  it("reports a replaced input and a truncated replay by step", () => {
    const reference: History = { path: "trace_1", steps: [step("init", 0, []), step("beginCall", 3, [0]), step("tick", -1, [0])] };
    const replaced = structuredClone(reference);
    replaced.steps[1] = step("seed", 3, [0]);
    expect(differential.compareHistory(reference, replaced)).toMatchObject({ agree: false, step: 1, reason: "input seed/3 replaces beginCall/3" });
    const truncated: History = { path: "trace_1", steps: reference.steps.slice(0, 2) };
    expect(differential.compareHistory(reference, truncated)).toMatchObject({ agree: false, step: 2, reason: "replay has 2 states, reference 3" });
  });

  it("chunks histories in input order and measures bytes per state over a trace directory", () => {
    expect(differential.chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(differential.chunked([], 3)).toEqual([]);
    const directory = mkdtempSync(join(tmpdir(), "differential-bytes-"));
    try {
      const trace = JSON.stringify({ states: [{ s: 1 }, { s: 2 }, { s: 3 }] });
      writeFileSync(join(directory, "a.itf.json"), trace);
      writeFileSync(join(directory, "b.itf.json"), trace);
      writeFileSync(join(directory, "notes.txt"), "ignored");
      const size = differential.bytesPerState(directory);
      expect(size).toEqual({ traces: 2, states: 6, bytes: 2 * Buffer.byteLength(trace), bytesPerState: Buffer.byteLength(trace) / 3 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("lists the top-level and kernel Quint sources of a tree", () => {
    const sources = differential.quintSources(root);
    expect(sources).toContain("formal/dialcache-layers-conformance.qnt");
    expect(sources).toContain("formal/kernel/serving.qnt");
    expect(sources.every(path => /^formal\/(kernel\/)?[\w-]+\.qnt$/.test(path))).toBe(true);
    expect([...sources].sort()).toEqual(sources);
  });
});

describe.skipIf(!quintAvailable)("corpus differential replay through the working tree", () => {
  const output = mkdtempSync(join(tmpdir(), "differential-replay-"));
  afterAll(() => rmSync(output, { recursive: true, force: true }));

  it("replays the committed layers smoke history and a regression through the current text and agrees with both", async () => {
    const manifest = readExecution();
    const model = differential.differentialModel(manifest, "layers");
    const smoke = differential.historyOf(JSON.parse(readFileSync(resolve(root, "formal/layers-smoke.itf.json"), "utf8")), "layers-smoke", model.descriptor);
    expect(smoke.steps.length).toBeGreaterThan(2);
    // A regression exported by the lane's own command is the second history.
    const regressions = join(output, "regressions");
    mkdirSync(regressions);
    const exported = spawnSync("quint", ["test", model.path, "--backend=rust", "--max-samples=1", `--seed=${model.manifest.settings.seed}`,
      "--match=^untrackedSourcePublicationIsProbedInAllThreeLayersTest$", `--out-itf=${regressions}/{test}.itf.json`], { cwd: root, encoding: "utf8" });
    expect(exported.status, exported.stderr + exported.stdout).toBe(0);
    const regression = differential.historyOf(JSON.parse(readFileSync(join(regressions, "untrackedSourcePublicationIsProbedInAllThreeLayersTest.itf.json"), "utf8")),
      "regression", model.descriptor);
    const verdicts = await differential.replayHistories(root, model, model.descriptor, [smoke, regression], {
      chunk: 1, seed: model.manifest.settings.seed, output, concurrency: 2 });
    expect(verdicts).toEqual([{ path: "layers-smoke", agree: true }, { path: "regression", agree: true }]);
    // Each chunk left its generated module and traces behind for inspection.
    const generated = readFileSync(join(output, "replay-0", model.path), "utf8");
    expect(generated).toContain(`var ${differential.cursorVariable}: int`);
    expect(generated).toMatch(/run replay0 = all \{ replayAction0, replayCursor' = 0 \}\.then\(\(\d+\)\.reps\(_ => replaySchedule0\)\)/);
  }, 180_000);

  it("detects a candidate whose text changes an observation", async () => {
    const manifest = readExecution();
    const model = differential.differentialModel(manifest, "layers");
    const smoke = differential.historyOf(JSON.parse(readFileSync(resolve(root, "formal/layers-smoke.itf.json"), "utf8")), "layers-smoke", model.descriptor);
    // A candidate tree whose serving module counts two loaders per source start.
    const candidate = join(output, "candidate");
    for (const path of differential.quintSources(root)) {
      mkdirSync(join(candidate, path, ".."), { recursive: true });
      writeFileSync(join(candidate, path), readFileSync(resolve(root, path)));
    }
    const serving = join(candidate, "formal/kernel/serving.qnt");
    const text = readFileSync(serving, "utf8");
    expect(text).toContain("loaders: state.o.loaders + 1");
    writeFileSync(serving, text.replace("loaders: state.o.loaders + 1", "loaders: state.o.loaders + 2"));
    const [verdict] = await differential.replayHistories(candidate, model, model.descriptor, [smoke], {
      chunk: 64, seed: model.manifest.settings.seed, output: join(output, "mutant"), concurrency: 1 });
    expect(verdict!.agree).toBe(false);
    expect(verdict!.fields).toEqual(["loaders"]);
  }, 180_000);
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

type Evidence = { challenge: string; mutant: string; history: string; step: number; fields: string[] };
type Recording = { path: string; completed: boolean; lastStep: number; divergences: Array<{ step: number; paths: string[] }>; error?: string };
type Verdict = { state: string; matched?: string[]; reason?: string; divergences?: unknown[] };
const { assessBoundary, boundaryReview, validateBoundaryReportFreshness, fingerprintFiles, sha256, languages } = await import(new URL("../../formal/mutation-reports.mjs", import.meta.url).href) as {
  assessBoundary(evidence: Evidence | { challenge: string; mutant: string; state: string }, recording?: Recording): Verdict;
  boundaryReview(report: unknown, evidence: unknown[], options?: { requireEntries?: boolean }): Verdict[];
  validateBoundaryReportFreshness(report: unknown, options?: { directory?: string }): void;
  fingerprintFiles(directory: string, paths: string[]): { files: number; sha256: string };
  sha256(bytes: Buffer): string;
  languages: Record<"ts" | "go", { inputs: string[] }>;
};
const evidence: Evidence = { challenge: "captured-retention", mutant: "M29", history: "shadow-layers/capturedTest", step: 7, fields: ["o.writeTtls", "o.shadow"] };
const record = (changes: Partial<Recording> = {}): Recording => ({
  path: "/tmp/corpus/regressions/shadow-layers/capturedTest.itf.json", completed: true, lastStep: 11,
  divergences: [{ step: 4, paths: ["o.policyCalls"] }, { step: 6, paths: ["o.policyCalls", "o.writeTtls.0"] }, { step: 7, paths: ["o.policyCalls", "o.writeTtls.0"] }],
  ...changes,
});

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function measuredSnapshot(port: "ts" | "go") {
  const directory = mkdtempSync(join(tmpdir(), "dialcache-boundary-freshness-"));
  temporaryDirectories.push(directory);
  const corpusPaths = [".formal-traces/conformance", ".formal-traces/effects", ".formal-traces/features", ".formal-traces/regressions"];
  for (const path of ["typescript/src", "typescript/test", "formal", "go", ...corpusPaths]) mkdirSync(join(directory, path), { recursive: true });
  const files: Record<string, string> = {
    "typescript/src/cache.ts": "export const value = 1;", "typescript/test/replay.ts": "compare(actual, expected);",
    "formal/model.qnt": "pure val accepted = true", "formal/mutations.json": '{"mutations":[]}',
    "go/cache.go": "package cache", "go/go.mod": "module cache", "go/go.sum": "dependency checksum",
    "package.json": '{"type":"module"}', "typescript/package.json": '{"name":"dialcache"}', "pnpm-workspace.yaml": "packages: [typescript]", "pnpm-lock.yaml": "lockfileVersion: 9.0", "typescript/tsconfig.json": "{}", "typescript/vitest.config.ts": "export default {};",
    ".formal-traces/regressions/shadow-layers/capturedTest.itf.json": '{"states":[{"input":{"name":"init"}}]}',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  const configuration = ["package.json", "typescript/package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "typescript/tsconfig.json", "typescript/vitest.config.ts"];
  const report: Record<string, unknown> = {
    complete: true, catalogSha256: sha256(readFileSync(join(directory, "formal/mutations.json"))),
    inputs: fingerprintFiles(directory, languages[port].inputs), corpus: fingerprintFiles(directory, corpusPaths),
    ...(port === "go" ? { go: "go version go1.27.1" } : {
      configurationSha256: Object.fromEntries(configuration.map(path => [path, sha256(readFileSync(join(directory, path)))])),
    }),
    mutations: [{ id: "M29", cohorts: {}, boundary: [assessBoundary(evidence, record())] }],
    boundaryBaselines: { [evidence.history]: { ...record({ divergences: [] }), history: evidence.history } },
  };
  return { directory, report };
}

describe("gated boundary report freshness", () => {
  it("fails the actual gated command on stale inputs while historical inspection succeeds", async () => {
    const { boundaryEvidence } = await import(new URL("../../formal/execution.mjs", import.meta.url).href) as {
      boundaryEvidence(): Array<Evidence | { challenge: string; mutant: string; state: string }>;
    };
    const mutations = new Map<string, { id: string; cohorts: object; boundary: unknown[] }>();
    const baselines: Record<string, { history: string; completed: boolean; lastStep: number; divergences: unknown[] }> = {};
    for (const entry of boundaryEvidence()) {
      if (!mutations.has(entry.mutant)) mutations.set(entry.mutant, { id: entry.mutant, cohorts: {}, boundary: [] });
      if ("state" in entry) mutations.get(entry.mutant)!.boundary.push(entry);
      else {
        mutations.get(entry.mutant)!.boundary.push(assessBoundary(entry, record({
          path: `regressions/${entry.history}.itf.json`, lastStep: entry.step, divergences: [{ step: entry.step, paths: [entry.fields[0]!] }],
        })));
        baselines[entry.history] = { history: entry.history, completed: true, lastStep: Math.max(baselines[entry.history]?.lastStep ?? 0, entry.step), divergences: [] };
      }
    }
    const { directory, report } = measuredSnapshot("go");
    Object.assign(report, {
      catalogSha256: sha256(readFileSync(new URL("../../formal/mutations.json", import.meta.url))),
      inputs: { files: 0, sha256: "stale" }, mutations: [...mutations.values()], boundaryBaselines: baselines,
    });
    const path = join(directory, "historical-report.json");
    writeFileSync(path, JSON.stringify(report));
    const args = [fileURLToPath(new URL("../../formal/mutation-reports.mjs", import.meta.url)), "boundary", "--report", path];
    const historical = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(historical.status, historical.stderr).toBe(0);
    const gated = spawnSync(process.execPath, [...args, "--gate"], { encoding: "utf8" });
    expect(gated.status).toBe(1);
    expect(gated.stderr).toContain("source inputs differ from the measured report");
  });

  it.each(["ts", "go"] as const)("accepts the original %s snapshot but rejects changed sources with unchanged boundary declarations", port => {
    const { directory, report } = measuredSnapshot(port);
    expect(() => validateBoundaryReportFreshness(report, { directory })).not.toThrow();
    for (const path of [port === "ts" ? "typescript/src/cache.ts" : "go/cache.go", "formal/model.qnt"]) {
      const original = readFileSync(join(directory, path));
      writeFileSync(join(directory, path), "changed behavior at the same named checkpoint");
      // Historical inspection can still interpret the old recording, but its
      // unchanged mapping cannot make it evidence for the modified checkout.
      expect(boundaryReview(report, [evidence], { requireEntries: true })[0]?.state).toBe("confirmed");
      expect(() => validateBoundaryReportFreshness(report, { directory })).toThrow(/source inputs differ/);
      writeFileSync(join(directory, path), original);
    }
  });

  it.each(["ts", "go"] as const)("rejects a changed catalog or corpus for %s", port => {
    const { directory, report } = measuredSnapshot(port);
    const catalog = join(directory, "formal/mutations.json"), original = readFileSync(catalog);
    writeFileSync(catalog, '{"mutations":[{"id":"M29","after":"different fault"}]}');
    expect(() => validateBoundaryReportFreshness(report, { directory })).toThrow(/mutation catalog differs/);
    writeFileSync(catalog, original);
    writeFileSync(join(directory, ".formal-traces/regressions/shadow-layers/capturedTest.itf.json"), '{"states":[]}');
    expect(() => validateBoundaryReportFreshness(report, { directory })).toThrow(/corpus differs/);
  });

  it("checks separately recorded TypeScript configuration and Go module configuration", () => {
    const ts = measuredSnapshot("ts"), go = measuredSnapshot("go");
    writeFileSync(join(ts.directory, "pnpm-lock.yaml"), "changed dependency resolution");
    expect(() => validateBoundaryReportFreshness(ts.report, ts)).toThrow(/TypeScript configuration differs/);
    writeFileSync(join(go.directory, "go/go.mod"), "module changed");
    expect(() => validateBoundaryReportFreshness(go.report, go)).toThrow(/source inputs differ/);
  });

  it("refuses missing fingerprints or ambiguous language metadata without blocking historical inspection", () => {
    const { directory, report } = measuredSnapshot("ts");
    for (const field of ["catalogSha256", "inputs", "corpus", "configurationSha256"]) {
      const incomplete = { ...report };
      delete incomplete[field];
      expect(() => validateBoundaryReportFreshness(incomplete, { directory })).toThrow();
      expect(boundaryReview(incomplete, [evidence])[0]?.state).toBe("confirmed");
    }
    expect(() => validateBoundaryReportFreshness({ ...report, go: "go version go1.27.1" }, { directory })).toThrow(/unambiguous/);
  });
});

describe("native boundary evidence", () => {
  it("credits the captured TTL at its checkpoint after an earlier unrelated provider call", () => {
    expect(assessBoundary(evidence, record())).toMatchObject({ state: "confirmed", matched: ["o.writeTtls.0"] });
    expect(assessBoundary({ ...evidence, fields: ["o.policyCalls"] }, record()).state).toBe("side-effect-only");
    expect(assessBoundary({ ...evidence, step: 4, fields: ["o.policyCalls"] }, record()).state).toBe("confirmed");
  });

  it("credits newly divergent decode counters but not a carried counter", () => {
    const target = { ...evidence, fields: ["o.calls", "o.dumps", "o.loads"] };
    expect(assessBoundary(target, record({ divergences: [{ step: 7, paths: ["o.dumps", "o.loads"] }] })).state).toBe("confirmed");
    expect(assessBoundary(target, record({ divergences: [{ step: 6, paths: ["o.dumps"] }, { step: 7, paths: ["o.dumps"] }] })).state).toBe("side-effect-only");
  });

  it("requires a core caller result instead of carrying an earlier missing-publication count", () => {
    const history = "core/invalidationRefillsFromCurrentSourceTest";
    const target = { challenge: "conformance-remote-miss-skips-publication", mutant: "M38", history, step: 3, fields: ["lastResult"] };
    const recording = {
      path: `/tmp/regressions/${history}.itf.json`, completed: true, lastStep: 5,
      divergences: [{ step: 1, paths: ["redisWrites"] }, { step: 2, paths: ["redisWrites"] },
        { step: 3, paths: ["lastResult", "remoteLoaderCalls", "redisWrites"] }],
    };
    expect(assessBoundary(target, recording)).toMatchObject({ state: "confirmed", matched: ["lastResult"] });
    expect(assessBoundary({ ...target, fields: ["redisWrites"] }, recording).state).toBe("side-effect-only");
    expect(assessBoundary(target, { ...recording, divergences: recording.divergences.map(entry => ({
      ...entry, paths: entry.paths.filter(path => path !== "lastResult"),
    })) }).state).toBe("side-effect-only");
    expect(assessBoundary(target, { ...recording, completed: false, error: "driver failed after result" }).state).toBe("unreached");
  });

  it("keeps failed or incomplete replays outside detection even after a matching divergence", () => {
    expect(assessBoundary(evidence, record({ completed: false, lastStep: 7, error: "step 8 releaseDump: No pending dump 0" }))).toMatchObject({ state: "unreached", reason: expect.stringContaining("step 8 releaseDump") });
    expect(assessBoundary(evidence, record({ completed: false, error: "step 8: Settlement violation: read gates" }))).toMatchObject({ state: "unreached", reason: expect.stringContaining("Settlement violation") });
    expect(assessBoundary(evidence, record({ lastStep: 6 })).state).toBe("unreached");
    expect(assessBoundary(evidence, record({ path: "/tmp/regressions/shadow-layers/otherTest.itf.json" })).state).toBe("unreached");
    expect(assessBoundary(evidence).state).toBe("unreached");
    expect(assessBoundary(evidence, record({ divergences: [{ step: 7, paths: ["o.writeTtls.0"] }, { step: 7, paths: ["o.shadow"] }] })).state).toBe("unreached");
  });

  it("reports clean mutants and unmapped execution boundaries explicitly", () => {
    expect(assessBoundary(evidence, record({ divergences: [] })).state).toBe("not-divergent");
    for (const state of ["vector", "unreproduced"]) expect(assessBoundary({ challenge: "gap", mutant: "M06", state }).state).toBe(state);
  });

  it("requires a completed recording even when legacy assertions claim the target mismatch", () => {
    const message = `/tmp/regressions/${evidence.history}.itf.json step 7 action releaseWrite\n` +
      'expected: {"o":{"writeTtls":[120000]}}\nactual: {"o":{"writeTtls":[180000]}}';
    for (const generated of [
      { assertionEvidence: { failure: message } },
      { divergences: [{ history: evidence.history, step: 7, paths: ["o.writeTtls.0"] }] },
    ]) {
      const report = { mutations: [{ id: "M29", cohorts: { generated } }] };
      const original = structuredClone(report);
      for (const requireEntries of [false, true]) {
        expect(boundaryReview(report, [evidence], { requireEntries }))
          .toEqual([expect.objectContaining({ state: "unreached", divergences: [] })]);
      }
      expect(report).toEqual(original);
    }
  });

  it("requires an explicit entry for coverage limitations when gating a report", () => {
    const limitation = { challenge: "not-yet-reproduced", mutant: "M29", state: "unreproduced" };
    const report = { mutations: [{ id: "M29", cohorts: {} }] };
    expect(boundaryReview(report, [limitation])[0]?.state).toBe("unreproduced");
    expect(boundaryReview(report, [limitation], { requireEntries: true })[0]).toMatchObject({ state: "unreached", reason: expect.stringContaining("per-challenge") });
    expect(boundaryReview({ mutations: [{ ...report.mutations[0], boundary: [limitation] }] }, [limitation], { requireEntries: true })[0]?.state).toBe("unreproduced");
  });

  it("refuses missing mutants, stale pins and missing clean baselines when reading reports", () => {
    expect(boundaryReview({ mutations: [] }, [evidence])[0]).toMatchObject({ state: "unreached", reason: expect.stringContaining("absent") });
    const confirmed = assessBoundary(evidence, record());
    const report = { mutations: [{ id: "M29", cohorts: {}, boundary: [confirmed] }],
      boundaryBaselines: { [evidence.history]: { ...record({ divergences: [] }), history: evidence.history } } };
    expect(boundaryReview(report, [evidence])[0]?.state).toBe("confirmed");
    expect(boundaryReview(report, [{ ...evidence, step: 8 }])[0]).toMatchObject({ state: "unreached", reason: expect.stringContaining("current evidence") });
    expect(boundaryReview({ ...report, boundaryBaselines: {} }, [evidence])[0]).toMatchObject({ state: "unreached", reason: expect.stringContaining("baseline") });
    expect(boundaryReview({ ...report, mutations: [{ id: "M29", cohorts: {}, boundary: [{ ...confirmed, divergences: [] }] }] }, [evidence])[0]?.state).toBe("not-divergent");
  });
});

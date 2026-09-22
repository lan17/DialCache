import type { VectorEvidence } from "../../formal/vector-evidence.mjs";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Shard = { index: number; count: number };
type Selection = { shard: Shard; only?: string[] | undefined };
type Cohort = { state: "detected" | "survived" | "crashed"; passed: number; failed: number; failingTests: string[]; [key: string]: unknown };
type Boundary = { vector?: VectorEvidence; challenge: string; mutant: string; history?: string; step?: number; fields?: string[]; state?: string; [key: string]: unknown };
type Mutation = { id: string; case: string; description: string; cohorts: Record<string, Cohort>; boundary?: Boundary[] };
type Report = Record<string, unknown> & { shard?: Shard & { mutationIds: string[] }; baselines: Record<string, Cohort>; mutations: Mutation[] };
type CatalogEntry = { id: string; case: string; description: string; requiredDetections: string[] };
type Catalog = { mutations: CatalogEntry[] };
type Language = { name: string; output: string; catalog: string; inputs: string[]; recordsRegressions: boolean; markdown(report: Report, directory?: string): string };
type Fingerprint = { files: number; sha256: string };
type Context = { catalog: Catalog; catalogSha256: string; inputs?: Fingerprint | undefined };

const shared = await import(new URL("../../formal/mutation-reports.mjs", import.meta.url).href) as {
  parseShard(value?: string): Shard;
  parseOnly(value?: string): string[] | undefined;
  selectionFromArguments(argv: string[]): Selection;
  partitionMutations<T>(mutations: T[], shard: Shard): T[];
  selectMutations<T extends { id: string }>(mutations: T[], selection: Selection): T[];
  selectionDirectory(output: string, selection: Selection): string;
  fingerprintFiles(directory: string, paths: string[], options?: { exclude?: string[] }): { files: number; sha256: string };
  requiredDetectionRegressions(entries: CatalogEntry[], results: Mutation[]): string[];
  goDetection(mutations: Mutation[]): Record<string, unknown>;
  typescriptDetection(mutations: Mutation[], cases: { id: string; vectors: unknown[] }[]): Record<string, unknown>;
  classifyCohort<T>(selection: { baseline: boolean; cohort: string }, evaluate: () => T): T | Cohort;
  crashedCohort(reason: string): Cohort;
  portableCohort(generated: Cohort, fixed: Cohort): Cohort;
  noncompilingResult(mutation: CatalogEntry, cohorts: string[], reason: string): Mutation;
  gateDetections(language: Language, report: Report, entries: CatalogEntry[], options?: { directory?: string; summarize?: boolean }): void;
  languages: { ts: Language; go: Language; rust: Language & { exclude: string[] } };
};
const merge = await import(new URL("../../formal/merge-mutation-reports.mjs", import.meta.url).href) as {
  canonical(value: unknown): string;
  mergeShardReports(language: Language, shards: Report[], context: Context): Report;
  readShardReports(directory: string): Report[];
  mergeMutationReports(name: string, options?: { directory?: string; shardsDirectory?: string; outputDirectory?: string }): Report;
};
const { boundaryEvidence, challengesByMutant } = await import(new URL("../../formal/execution.mjs", import.meta.url).href) as {
  boundaryEvidence(): Boundary[];
  challengesByMutant(manifest: { challenges: Array<{ id: string; nativeMutants?: { mutant?: string } }> }): Map<string, string[]>;
};
const { parseShard, parseOnly, selectionFromArguments, partitionMutations, selectMutations, selectionDirectory, fingerprintFiles, requiredDetectionRegressions, goDetection, typescriptDetection, gateDetections, languages, classifyCohort, crashedCohort, noncompilingResult, portableCohort } = shared;
const { canonical, mergeShardReports, readShardReports, mergeMutationReports } = merge;

const repo = new URL("../../", import.meta.url);
const readRepo = (path: string) => readFileSync(new URL(path, repo));
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type UnifiedEntry = { id: string; case: string; description: string; typescript: { requiredDetections: string[] }; go: { requiredDetections: string[] } };
const unified = JSON.parse(readRepo("formal/mutations.json").toString()) as { mutations: UnifiedEntry[] };
// One catalog, two port views: each measurer applies and gates its own section.
const portView = (port: "typescript" | "go"): Catalog => ({ mutations: unified.mutations.map(mutation => ({ id: mutation.id, case: mutation.case, description: mutation.description, requiredDetections: mutation[port].requiredDetections })) });
const goCatalog = portView("go");
const tsCatalog = portView("typescript");
const ids = goCatalog.mutations.map(mutation => mutation.id);
// The fixtures below derive every count and slice from the catalogs, so they
// hold as the catalogs grow. A TypeScript mutant counts as a protocol mutant
// when its case carries vectors, whatever cohort detects it: W03.cohort-assignment
// (the serving ramp) is a vector case although its mutant is detected behaviorally.
const semanticCases = (JSON.parse(readRepo("formal/semantic-cases.json").toString()) as { cases: Array<{ id: string; vectors: unknown[] }> }).cases;
const protocolIds = tsCatalog.mutations.filter(mutation => semanticCases.find(entry => entry.id === mutation.case)!.vectors.length > 0).map(mutation => mutation.id);
const whole = { index: 1, count: 1 };
const slices = (count: number) => Array.from({ length: count }, (_, position) => partitionMutations(ids, { index: position + 1, count }));
// The Challenges column names the model challenges each mutant is the native twin of.
const challengesOf = (id: string) => (challengesByMutant(JSON.parse(readRepo("formal/execution.json").toString())).get(id) ?? []).join(", ") || "none";
const evidence = boundaryEvidence();
// Synthetic observations exercise the report merger; these are harness fixtures,
// never native measurement evidence. Every vector fixture has typed actual output.
function vectorRecording(entry: Boundary, port: "typescript" | "go", changed = false) {
  const vector = entry.vector!, sample = vector.samples[port];
  let actual = structuredClone(sample.expected);
  if (changed) switch (sample.request.operation) {
    case "key": actual = {kind: "key_error"}; break;
    case "trackedDecode": actual.reason = actual.reason === "expired" ? "watermark_fenced" : "expired"; break;
    case "envelope": actual.decodedHex = `${actual.decodedHex}ff`; break;
    case "compression": actual.outcome = actual.outcome === "compressed" ? "not_smaller" : "compressed"; break;
    case "invalidation":
      if (entry.fields!.includes("content")) actual.content = `${actual.content}0`;
      else actual.outcome = actual.outcome === "success" ? "rejected" : "success";
      break;
    default: throw new Error("Unknown vector fixture operation");
  }
  return { history: entry.history!, completed: true, lastStep: 0, divergences: [], vectorResult: {
    history: entry.history!, port, row: sample.row, artifactSha256: vector.artifactSha256, inputSha256: sample.inputSha256, actual,
  } };
}
const boundaries = (id: string, port: "typescript" | "go"): Boundary[] => evidence.filter(entry => entry.mutant === id).map(entry =>
  entry.vector ? { ...entry, ...vectorRecording(entry, port, true), state: "confirmed" } : entry.state ? { ...entry } : {
    ...entry, state: "confirmed", completed: true, lastStep: entry.step! + 1,
    divergences: [{ step: entry.step!, paths: [entry.fields![0]!] }],
  });
const boundaryBaselines = (port: "typescript" | "go") => Object.fromEntries(evidence.filter(entry => entry.history).map(entry => [entry.history!,
  entry.vector ? vectorRecording(entry, port) : {
    history: entry.history, completed: true, lastStep: Math.max(...evidence.filter(other => other.history === entry.history).map(other => other.step!)) + 1, divergences: [],
  }]));

// Shapes follow the hosted Go report (run 34669546872) and the TypeScript
// runner's report object: the same keys, small values.
function goCohort(executed: string[], failing: string[] = []): Cohort {
  return { state: failing.length ? "detected" : "survived", passed: executed.length - failing.length, failed: failing.length, failingTests: failing,
    assertionKinds: Object.fromEntries(failing.map(name => [name, "observation-mismatch"])),
    assertionEvidence: Object.fromEntries(failing.map(name => [name, `    replay_test.go:84: expected: {"loaders":1}\n    actual: {"loaders":2}\n`])),
    executedTests: executed };
}
function union(generated: Cohort, fixed: Cohort): Cohort {
  return { state: generated.failed + fixed.failed ? "detected" : "survived", passed: generated.passed + fixed.passed, failed: generated.failed + fixed.failed,
    failingTests: [...generated.failingTests, ...fixed.failingTests], components: ["generated", "fixed"] };
}
const goTests = {
  ordinary: ["TestPolicyDefaults", "TestInvalidOperation/read", "TestInvalidOperation/write"],
  generated: ["TestCoreConformance/trace_0.itf.json", "TestCoreConformance/trace_1.itf.json", "TestEffectsConformance/trace_0.itf.json", "TestProtocolKeys/row_0"],
  fixed: ["TestBehaviorConformance/first-read-fills", "TestBehaviorConformance/second-fence", "TestProtocolKeys/row_1"],
};
// The hosted run's detection pattern: generated caught everything, ordinary
// caught five, the fixed supplement missed M09.
const ordinarySurvivors = new Set(["M01", "M02", "M04", "M07", "M09", "M10", "M12", "M13"]);
const fixedSurvivors = new Set(["M09"]);
function goMutation(entry: CatalogEntry): Mutation {
  const generated = goCohort(goTests.generated, [goTests.generated[0]!, goTests.generated[2]!]);
  const fixed = goCohort(goTests.fixed, fixedSurvivors.has(entry.id) ? [] : [goTests.fixed[1]!]);
  return { id: entry.id, case: entry.case, description: entry.description, boundary: boundaries(entry.id, "go"),
    cohorts: { ordinary: goCohort(goTests.ordinary, ordinarySurvivors.has(entry.id) ? [] : [goTests.ordinary[0]!]), generated, fixed, portable: union(generated, fixed) } };
}
function goBaselines(): Record<string, Cohort> {
  const generated = goCohort(goTests.generated), fixed = goCohort(goTests.fixed);
  return { ordinary: goCohort(goTests.ordinary), generated, fixed, portable: union(generated, fixed) };
}
function goIdentity(catalogSha256: string, inputs: { files: number; sha256: string }) {
  return { revision: "7bfe1c50e65c50c257e60fd35aabba6816700b5f", go: "go version go1.27.1 linux/amd64", node: "v24.20.0", catalogSha256, inputs,
    corpus: { files: 5514, sha256: "ec475faaf33775e159805b604b8dd176850b55fd5a0c31b39aa44f0a55dc304e" },
    witnesses: { files: 14, sha256: "aa135313a09f6b1550adb83d9ce21da8fa8e6dd0fc7e200cc30c6c720a39b24c" },
    sourceSha256: { "go/engine.go": "cde64ae32089281452430d3f49aefaa15e8c2bd0435f17c133356630e49bac9d", "go/cache.go": "5ff9377294d27c8713cc42597d0a4a159fb40607be3334246e7204cacd996cdc" },
    selections: { ordinary: ["TestPolicyDefaults", "TestInvalidOperation"], generated: ["TestCoreConformance", "TestEffectsConformance", "TestProtocolKeys"], fixed: ["TestBehaviorConformance", "TestProtocolKeys"] },
    ordinaryFiles: ["cache_test.go", "policy_test.go"] };
}
// What measure-go-semantics.mjs writes for --shard=1/1.
function goSingleReport(catalogSha256: string, inputs: { files: number; sha256: string }): Report {
  const mutations = goCatalog.mutations.map(goMutation);
  return { schemaVersion: 1, complete: true, startedAt: "2026-09-12T00:27:22.662Z", baselines: goBaselines(), boundaryBaselines: boundaryBaselines("go"), mutations, elapsedSeconds: 1507,
    ...goIdentity(catalogSha256, inputs), detection: goDetection(mutations), requiredDetectionRegressions: [] };
}
// What each measure-go-semantics.mjs --shard=i/n run writes.
function goShardReports(single: Report, count: number): Report[] {
  single = structuredClone(single);
  return Array.from({ length: count }, (_, position) => {
    const shard = { index: position + 1, count };
    const mutations = partitionMutations(single.mutations, shard);
    const { detection: _detection, complete: _complete, shard: _shard, ...rest } = single;
    return { ...rest, complete: false, shard: { ...shard, mutationIds: mutations.map(mutation => mutation.id) },
      startedAt: `2026-09-12T00:2${position}:00.000Z`, baselines: goBaselines(), mutations, elapsedSeconds: 500 + position, requiredDetectionRegressions: [] };
  });
}
const tsTests = {
  ordinary: ["dialcache get-or-load > fills on miss", "dialcache get-or-load > serves within ttl"],
  generated: ["formal conformance > replays trace_0", "formal conformance > replays trace_1", "formal protocol conformance vectors > row 0"],
  fixed: ["portable behavioral scenarios read: first fill", "formal protocol conformance vectors > row 1"],
};
function tsCohort(executed: string[], failing: string[] = []): Cohort {
  return { state: failing.length ? "detected" : "survived", passed: executed.length - failing.length, failed: failing.length, failingTests: failing };
}
function tsMutation(entry: CatalogEntry): Mutation {
  const generated = tsCohort(tsTests.generated, [tsTests.generated[0]!]);
  const fixed = tsCohort(tsTests.fixed, entry.id === "M09" ? [] : [tsTests.fixed[0]!]);
  return { id: entry.id, case: entry.case, description: entry.description, boundary: boundaries(entry.id, "typescript"),
    cohorts: { ordinary: tsCohort(tsTests.ordinary, entry.id === "M12" ? [] : [tsTests.ordinary[0]!]), generated, fixed, portable: union(generated, fixed) } };
}
function tsBaselines(): Record<string, Cohort> {
  const generated = tsCohort(tsTests.generated), fixed = tsCohort(tsTests.fixed);
  return { ordinary: tsCohort(tsTests.ordinary), generated, fixed, portable: union(generated, fixed) };
}
const declaredCoverage = { cases: { total: 262, portable: 262, generated: 226 }, behavioral: { total: 240, portable: 240, generated: 225 }, protocol: { total: 22, portable: 22, generated: 1 } };
function tsShardReports(catalogSha256: string, inputs: { files: number; sha256: string }, count: number): Report[] {
  const mutations = tsCatalog.mutations.map(tsMutation);
  return Array.from({ length: count }, (_, position) => {
    const shard = { index: position + 1, count };
    const slice = partitionMutations(mutations, shard);
    return { schemaVersion: 1, complete: false, shard: { ...shard, mutationIds: slice.map(mutation => mutation.id) }, startedAt: `2026-09-12T01:0${position}:00.000Z`,
      revision: "ed9bd62", node: "v24.20.0", catalogSha256, sourceSha256: { "typescript/src/dialcache.ts": "aa".repeat(32) }, declaredCoverage, baselines: tsBaselines(), boundaryBaselines: boundaryBaselines("typescript"), mutations: slice,
      elapsedSeconds: 300, inputs, configurationSha256: { "package.json": "bb".repeat(32) }, corpus: { files: 5514, sha256: "cc".repeat(32) },
      reachedWitnesses: { effects: { required: 40, reached: 40, traces: 300 } } };
  });
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const without = (report: Report, ...keys: string[]) => Object.fromEntries(Object.entries(report).filter(([key]) => !keys.includes(key)));

describe("mutation shard partition", () => {
  it("parses --shard=<index>/<count> and defaults to the complete run", () => {
    expect(parseShard(undefined)).toEqual({ index: 1, count: 1 });
    expect(parseShard("2/3")).toEqual({ index: 2, count: 3 });
    expect(parseShard("13/13")).toEqual({ index: 13, count: 13 });
    for (const value of ["0/3", "4/3", "1/0", "a/b", "1", "01/3", "1/3/", " 1/3", "1/ 3", "-1/3", ""]) {
      expect(() => parseShard(value), value).toThrow(/index.*count/);
    }
    expect(selectionFromArguments([])).toEqual({ shard: { index: 1, count: 1 }, only: undefined });
    expect(selectionFromArguments(["--shard=2/3"])).toEqual({ shard: { index: 2, count: 3 }, only: undefined });
    expect(() => selectionFromArguments(["--shard=1/3", "--shard=2/3"])).toThrow(/unexpected argument/);
    expect(() => selectionFromArguments(["--other"])).toThrow(/unexpected argument --other/);
    expect(() => selectionFromArguments(["2/3"])).toThrow(/unexpected argument/);
  });

  it("parses --only=<id>,<id> as a partial selection that excludes sharding and names catalog mutants", () => {
    expect(parseOnly(undefined)).toBeUndefined();
    expect(parseOnly("M14")).toEqual(["M14"]);
    expect(parseOnly("M14,M15")).toEqual(["M14", "M15"]);
    for (const value of ["", "M14,", "M14,M14", "m14", "14", "M14 M15", "M14;M15"]) {
      expect(() => parseOnly(value), value).toThrow(/distinct mutant ids/);
    }
    expect(selectionFromArguments(["--only=M02,M01"])).toEqual({ shard: { index: 1, count: 1 }, only: ["M02", "M01"] });
    expect(() => selectionFromArguments(["--only=M01", "--only=M02"])).toThrow(/unexpected argument --only=M02/);
    expect(() => selectionFromArguments(["--shard=1/3", "--only=M01"])).toThrow(/--shard and --only exclude each other/);
    expect(() => selectionFromArguments(["--only=M01", "--shard=1/3"])).toThrow(/--shard and --only exclude each other/);
    // Selection keeps catalog order whatever the argument order, and every named id must exist.
    const catalog = goCatalog.mutations;
    expect(selectMutations(catalog, { shard: whole, only: [ids.at(-1)!, ids[0]!] }).map(mutation => mutation.id)).toEqual([ids[0], ids.at(-1)]);
    expect(selectMutations(catalog, { shard: whole, only: undefined })).toEqual(catalog);
    expect(selectMutations(catalog, { shard: { index: 2, count: 3 } })).toEqual(partitionMutations(catalog, { index: 2, count: 3 }));
    expect(() => selectMutations(catalog, { shard: whole, only: ["M9999", ids[0]!] })).toThrow(/Unknown mutation ids: M9999/);
  });

  it("covers every mutation exactly once, contiguously and in catalog order, for any shard count", () => {
    for (let count = 1; count <= 20; count++) {
      const shards = slices(count);
      expect(shards.flat(), `count ${count}`).toEqual(ids);
      const sizes = shards.map(shard => shard.length);
      expect(Math.max(...sizes) - Math.min(...sizes), `count ${count} balance`).toBeLessThanOrEqual(1);
      for (const shard of shards) {
        if (!shard.length) continue;
        const start = ids.indexOf(shard[0]!);
        expect(ids.slice(start, start + shard.length), `count ${count} contiguous`).toEqual(shard);
      }
    }
    // The first (mutations mod count) shards take one mutation more.
    expect(slices(3).map(shard => shard.length)).toEqual([0, 1, 2].map(position => Math.floor(ids.length / 3) + (position < ids.length % 3 ? 1 : 0)));
    expect(partitionMutations(ids, whole)).toEqual(ids);
    // More shards than mutations: the trailing shards are empty but valid.
    expect(partitionMutations(ids, { index: ids.length, count: ids.length + 1 })).toEqual([ids.at(-1)]);
    expect(partitionMutations(ids, { index: ids.length + 1, count: ids.length + 1 })).toEqual([]);
    expect(partitionMutations([], { index: 1, count: 3 })).toEqual([]);
  });

  it("keeps the single run's directory, separates shards under shards/<index>-of-<count> and partial runs under partial/", () => {
    expect(selectionDirectory("/out/semantic", { shard: whole })).toBe("/out/semantic");
    expect(selectionDirectory("/out/semantic", { shard: { index: 2, count: 3 } })).toBe("/out/semantic/shards/2-of-3");
    expect(selectionDirectory("/out/semantic", { shard: whole, only: ["M14"] })).toBe("/out/semantic/partial");
  });

  it("gates each shard on its own catalog slice with the function the complete run uses", () => {
    const single = goSingleReport("catalog", { files: 1, sha256: "x" });
    const slice = partitionMutations(goCatalog.mutations, { index: 2, count: 3 });
    const report = { ...without(clone(single), "detection", "requiredDetectionRegressions"), complete: false, mutations: partitionMutations(clone(single.mutations), { index: 2, count: 3 }) } as unknown as Report;
    gateDetections(languages.go, report, slice, { summarize: false });
    expect(report.requiredDetectionRegressions).toEqual([]);
    expect(report.detection).toBeUndefined();
    expect(report.complete).toBe(false); // a shard never completes on its own
    report.mutations[0]!.cohorts.generated!.state = "survived";
    expect(() => gateDetections(languages.go, report, slice, { summarize: false })).toThrow(new RegExp(`Lost required detections: ${slice[0]!.id}/generated`));
    expect(report.requiredDetectionRegressions).toEqual([`${slice[0]!.id}/generated`]);
    expect(() => gateDetections(languages.go, report, goCatalog.mutations, { summarize: false })).toThrow(/has no measured result/);
    expect(requiredDetectionRegressions(slice, report.mutations)).toEqual([`${slice[0]!.id}/generated`]);
  });

  it("requires current completed boundary evidence independently of cohort detection", () => {
    const entry = goCatalog.mutations.find(item => item.id === "M29")!;
    const declaration = evidence.find(item => item.mutant === entry.id && item.history)!;
    const expected = `${entry.id}/boundary:${declaration.challenge}`;
    const fresh = (): Report => ({ ...goSingleReport("catalog", { files: 1, sha256: "x" }), complete: false,
      mutations: [goMutation(entry)] });
    for (const change of [
      (report: Report) => { delete report.mutations[0]!.boundary; },
      (report: Report) => { report.mutations[0]!.boundary![0]!.step = declaration.step! + 1; },
      (report: Report) => { report.mutations[0]!.boundary![0]!.divergences = []; },
      (report: Report) => { report.mutations[0]!.boundary![0]!.completed = false; },
      (report: Report) => { report.boundaryBaselines = {}; },
      (report: Report) => { report.mutations[0]!.boundary![0]!.divergences = [{ step: declaration.step, paths: ["o.policyCalls"] }]; },
    ]) {
      const report = fresh(); change(report);
      expect(() => gateDetections(languages.go, report, [entry], { summarize: false })).toThrow(expected);
      expect(report.requiredDetectionRegressions).toEqual([expected]);
      expect(report.complete).toBe(false);
    }
    const report = fresh();
    gateDetections(languages.go, report, [entry], { summarize: false });
    expect(report.requiredDetectionRegressions).toEqual([]);
    report.mutations[0]!.boundary!.push(structuredClone(report.mutations[0]!.boundary![0]!));
    expect(() => gateDetections(languages.go, report, [entry], { summarize: false })).toThrow(/repeats a challenge/);
  });
});

describe("mutation shard merge", () => {
  const catalogSha256 = sha256(readRepo("formal/mutations.json"));
  const inputs = { files: 367, sha256: "56af679ac31469b1f608e8d13fa7771b762d19ccbb648987438a6d8b8f732b2e" };
  const context = { catalog: goCatalog, catalogSha256, inputs };
  const single = goSingleReport(catalogSha256, inputs);
  const shards = () => goShardReports(single, 3);
  const merged = (reports: Report[], overrides: Partial<Context> = {}) => {
    const report = mergeShardReports(languages.go, reports, { ...context, ...overrides });
    gateDetections(languages.go, report, goCatalog.mutations);
    return report;
  };
  const refuse = (reports: Report[], pattern: RegExp, overrides: Partial<Context> = {}) =>
    expect(() => merged(reports, overrides)).toThrow(pattern);

  it("reassembles three Go shards into the report a single run would have written", () => {
    const report = merged(shards());
    expect(report.complete).toBe(true);
    expect(report.mutations.map(mutation => mutation.id)).toEqual(ids);
    expect(report.detection).toEqual(single.detection);
    expect(report.requiredDetectionRegressions).toEqual([]);
    expect(report.startedAt).toBe("2026-09-12T00:20:00.000Z");
    expect(report.elapsedSeconds).toBe(500 + 501 + 502);
    expect(report.shards).toEqual(slices(3).map((slice, position) => (
      { index: position + 1, count: 3, mutationIds: slice, startedAt: `2026-09-12T00:2${position}:00.000Z`, elapsedSeconds: 500 + position }
    )));
    expect("shard" in report).toBe(false);
    // Everything but timing and the shard summary is identical to the single run.
    expect(canonical(without(report, "shards"))).toBe(canonical(single));
    expect(Object.keys(without(report, "shards")).sort()).toEqual(Object.keys(single).sort());
    // Shard order on disk does not matter; the merge sorts by index.
    expect(canonical(merged(shards().reverse()))).toBe(canonical(report));
  });

  it("accepts one shard per mutation and an empty trailing shard", () => {
    expect(canonical(without(merged(goShardReports(single, ids.length)), "shards"))).toBe(canonical(single));
    const oneMore = goShardReports(single, ids.length + 1);
    expect(oneMore.at(-1)!.mutations).toEqual([]);
    expect(oneMore.at(-1)!.shard!.mutationIds).toEqual([]);
    const report = merged(oneMore);
    expect(canonical(without(report, "shards"))).toBe(canonical(single));
    expect((report.shards as unknown[]).length).toBe(ids.length + 1);
  });

  it("unions clean boundary baselines and preserves each mutant's boundary result", () => {
    const reports = shards();
    for (const report of reports) for (const mutation of report.mutations) delete mutation.boundary;
    const history = "shadow-layers/capturedTest";
    const boundary = { challenge: "captured-retention", history, step: 7, fields: ["o.writeTtls"], state: "confirmed" };
    for (const [index, report] of reports.entries()) report.boundaryBaselines = {
      [history]: { history, path: `/runner-${index}/regressions/${history}.itf.json`, completed: true, lastStep: 11, divergences: [] },
    };
    Object.assign(reports[0]!.mutations[0]!, { boundary: [boundary] });
    // This test isolates the merge; the gate separately checks current pins.
    const result = mergeShardReports(languages.go, reports, context);
    expect(result.boundaryBaselines).toEqual({ [history]: { history, completed: true, lastStep: 11, divergences: [] } });
    expect(result.mutations[0]).toMatchObject({ boundary: [boundary] });
    const divergent = structuredClone(reports);
    divergent[1]!.boundaryBaselines = { [history]: { history, completed: true, lastStep: 11, divergences: [{ step: 2, paths: ["o.calls.0"] }] } };
    refuse(divergent, /boundary baseline .*not a clean completed replay/);
    const missing = structuredClone(reports);
    for (const report of missing) report.boundaryBaselines = {};
    refuse(missing, /boundary history .*no clean baseline/);
  });

  it("keeps a crashed Go cohort out of the detection total and lists it apart from survivors", () => {
    const generated = goCohort(goTests.generated, [goTests.generated[0]!]);
    const fixed = goCohort(goTests.fixed);
    const measured: Mutation = { id: "M01", case: "c", description: "d", cohorts: { ordinary: goCohort(goTests.ordinary, [goTests.ordinary[0]!]), generated, fixed, portable: union(generated, fixed) } };
    const skipping: Mutation = { id: "M02", case: "c", description: "d",
      cohorts: { ordinary: { state: "crashed", reason: "crash, timeout, race, or build error is not mutation detection", passed: 0, failed: 0, failingTests: [] }, generated, fixed, portable: union(generated, fixed) } };
    const detection = goDetection([measured, skipping]) as Record<string, { detected: number; total: number; survivors: string[]; crashed?: string[] }>;
    expect(detection.ordinary).toEqual({ detected: 1, total: 1, survivors: [], crashed: ["M02"] });
    expect(detection.generated).toEqual({ detected: 2, total: 2, survivors: [] });
    expect(detection.fixed).toEqual({ detected: 0, total: 2, survivors: ["M01", "M02"] });
    // A crashed cohort can never satisfy a required detection.
    expect(requiredDetectionRegressions([{ id: "M02", case: "c", description: "d", requiredDetections: ["ordinary", "generated"] }], [skipping])).toEqual(["M02/ordinary"]);
    // The TypeScript summary excludes it the same way.
    const tsDetected: Cohort = { state: "detected", passed: 1, failed: 1, failingTests: ["t"] };
    const tsSurvived: Cohort = { state: "survived", passed: 2, failed: 0, failingTests: [] };
    const tsMeasured: Mutation = { id: "M01", case: "C45.maximum-age-exclusive", description: "d", cohorts: { ordinary: tsDetected, generated: tsDetected, fixed: tsSurvived, portable: tsDetected } };
    const tsCrashed: Mutation = { id: "M02", case: "C45.maximum-age-exclusive", description: "d", cohorts: { ordinary: crashedCohort("unhandled rejection with no failed assertion"), generated: tsDetected, fixed: tsSurvived, portable: tsDetected } };
    const ts = typescriptDetection([tsMeasured, tsCrashed], [{ id: "C45.maximum-age-exclusive", vectors: [] }]) as Record<string, Record<string, { detected: number; total: number; survivors: string[]; crashed?: string[] }>>;
    expect(ts.all!.ordinary).toEqual({ detected: 1, total: 1, ordinaryParity: { detected: 1, total: 1 }, survivors: [], crashed: ["M02"] });
    expect(ts.all!.generated).toEqual({ detected: 2, total: 2, ordinaryParity: { detected: 1, total: 1 }, survivors: [] });
  });

  it("records a crashed unit cohort for a mutant and rethrows for baselines and replay cohorts", () => {
    const evaluate = () => { throw new Error("crash, timeout, race, or build error is not mutation detection"); };
    expect(classifyCohort({ baseline: false, cohort: "ordinary" }, evaluate)).toEqual({ state: "crashed", reason: "crash, timeout, race, or build error is not mutation detection", passed: 0, failed: 0, failingTests: [] });
    expect(() => classifyCohort({ baseline: true, cohort: "ordinary" }, evaluate)).toThrow(/crash, timeout, race, or build error/);
    for (const cohort of ["generated", "fixed"]) expect(() => classifyCohort({ baseline: false, cohort }, evaluate), cohort).toThrow(/crash, timeout, race, or build error/);
    const measured = { state: "survived", passed: 3, failed: 0, failingTests: [] };
    expect(classifyCohort({ baseline: false, cohort: "ordinary" }, () => measured)).toBe(measured);
    // A settlement violation under a mutant is recorded against it in any cohort, naming the history and rule; the baseline keeps the strict rule.
    const violation = "trace_11.itf.json step 25 action beginCall choice 0: Settlement violation: 1 runnable task(s) at observation";
    const violated = () => { throw Object.assign(new Error("M37/generated: infrastructure/import error"), { settlementViolation: violation }); };
    for (const cohort of ["ordinary", "generated", "fixed"]) expect(classifyCohort({ baseline: false, cohort }, violated), cohort).toEqual(crashedCohort(`settlement violation: ${violation}`));
    expect(() => classifyCohort({ baseline: true, cohort: "generated" }, violated)).toThrow(/infrastructure\/import error \(settlement violation: trace_11/);
    // Portable is unmeasured whenever one of its components is, in both runners.
    const detected: Cohort = { state: "detected", passed: 2, failed: 1, failingTests: ["t"] };
    expect(portableCohort(crashedCohort(`settlement violation: ${violation}`), detected)).toEqual(crashedCohort(`generated: settlement violation: ${violation}`));
    expect(portableCohort(detected, crashedCohort("panic"))).toEqual(crashedCohort("fixed: panic"));
    expect(portableCohort(measured as Cohort, detected)).toEqual({ state: "detected", passed: 5, failed: 1, failingTests: ["t"], components: ["generated", "fixed"] });
    // A noncompiling mutant is recorded with every cohort crashed, so the gate names it.
    const entry: CatalogEntry = { id: "M03", case: "c", description: "d", requiredDetections: ["generated", "portable"] };
    const result = noncompilingResult(entry, ["ordinary", "generated", "fixed", "portable"], "M03: noncompiling mutant");
    expect(Object.keys(result.cohorts)).toEqual(["ordinary", "generated", "fixed", "portable"]);
    expect(result.cohorts.generated).toEqual(crashedCohort("M03: noncompiling mutant"));
    expect(requiredDetectionRegressions([entry], [result])).toEqual(["M03/generated", "M03/portable"]);
    expect((goDetection([result]) as Record<string, { total: number; crashed?: string[] }>).generated).toEqual({ detected: 0, total: 0, survivors: [], crashed: ["M03"] });
  });

  it("refuses a missing, duplicated or miscounted shard", () => {
    refuse(shards().filter(report => report.shard!.index !== 2), /shard 2 of 3 is missing/);
    refuse([...shards(), shards()[0]!], /shard 1 of 3 appears more than once/);
    const miscounted = shards();
    miscounted[2]!.shard!.count = 4;
    refuse(miscounted, /shard counts disagree: 3, 4/);
    refuse([], /no shard reports were found/);
    const undescribed = shards();
    delete undescribed[1]!.shard;
    refuse(undescribed, /no valid shard descriptor/);
    const outOfRange = shards();
    outOfRange[1]!.shard!.index = 5;
    refuse(outOfRange, /no valid shard descriptor/);
  });

  it("refuses shards that do not cover the catalog exactly once in order", () => {
    const swapped = shards();
    [swapped[1]!.mutations, swapped[2]!.mutations] = [swapped[2]!.mutations, swapped[1]!.mutations];
    [swapped[1]!.shard!.mutationIds, swapped[2]!.shard!.mutationIds] = [swapped[2]!.shard!.mutationIds, swapped[1]!.shard!.mutationIds];
    refuse(swapped, /catalog in order/);
    const duplicated = shards();
    const twice = duplicated[1]!.mutations[0]!;
    duplicated[2]!.mutations.unshift(clone(twice));
    duplicated[2]!.shard!.mutationIds.unshift(twice.id);
    refuse(duplicated, new RegExp(`${twice.id} appears in shards 2 and 3`));
    const undeclared = shards();
    undeclared[0]!.shard!.mutationIds = undeclared[0]!.shard!.mutationIds.slice(1);
    refuse(undeclared, /shard 1\/3 declares \[.*\] but measured \[/);
    const dropped = shards();
    dropped[0]!.mutations.pop();
    dropped[0]!.shard!.mutationIds.pop();
    refuse(dropped, /the shards cover \[.*\] but the catalog in order is \[/);
    const foreign = shards();
    foreign[2]!.mutations.push({ ...clone(foreign[2]!.mutations[0]!), id: "M99" });
    foreign[2]!.shard!.mutationIds.push("M99");
    refuse(foreign, /catalog in order/);
  });

  it("refuses shards whose measured inputs differ from each other or from this checkout", () => {
    for (const field of ["catalogSha256", "inputs", "corpus", "witnesses", "sourceSha256", "revision", "go", "node", "selections", "ordinaryFiles"]) {
      const differing = shards();
      const value = differing[2]![field];
      differing[2]![field] = typeof value === "string" ? `${value}-other` : { ...value as Record<string, unknown>, sha256: "other", extra: true };
      refuse(differing, new RegExp(`${field} differs between shards 1 and 3`));
    }
    const extraField = shards();
    extraField[1]!.unexpected = true;
    refuse(extraField, /unexpected differs between shards 1 and 2/);
    refuse(shards(), /catalogSha256 .* was measured, but this checkout's formal\/mutations.json hashes to/, { catalogSha256: sha256("edited catalog") });
    refuse(shards(), /inputs fingerprint .* was measured, but this checkout's formal\/go\/typescript\/test\/typescript\/src hash to/, { inputs: { files: 367, sha256: "different" } });
    // Without a checkout fingerprint the shards need only agree with each other.
    expect(merged(shards(), { inputs: undefined }).complete).toBe(true);
  });

  it("refuses shards whose baselines differ, ignoring test order", () => {
    const fewer = shards();
    fewer[1]!.baselines.ordinary!.passed -= 1;
    (fewer[1]!.baselines.ordinary!.executedTests as string[]).pop();
    refuse(fewer, /baseline ordinary differs between shards 1 and 2/);
    const extraCohort = shards();
    extraCohort[2]!.baselines.extra = goCohort(["TestExtra"]);
    refuse(extraCohort, /baseline extra differs between shards 1 and 3/);
    const permuted = shards();
    (permuted[2]!.baselines.generated!.executedTests as string[]).reverse();
    expect(merged(permuted).complete).toBe(true);
    // Timing inside a result never decides consistency.
    const timed = shards();
    timed[0]!.baselines.fixed!.durationMs = 12;
    expect(merged(timed).complete).toBe(true);
  });

  it("refuses a shard that claims completion, recorded an error or lacks results", () => {
    const complete = shards();
    complete[0]!.complete = true;
    refuse(complete, /shard 1\/3 claims complete=true; only the merged report is complete evidence/);
    const failed = shards();
    failed[2]!.error = "Error: M12/generated: runner failed: SIGKILL";
    refuse(failed, /shard 3\/3 failed: Error: M12\/generated: runner failed/);
    const stub = shards();
    stub[1] = { schemaVersion: 1, complete: false, shard: { index: 2, count: 3 }, startedAt: "2026-09-12T00:21:00.000Z" } as unknown as Report;
    refuse(stub, /shard 2\/3 lacks its mutation list, baselines or mutation results/);
    const versioned = shards();
    versioned[0]!.schemaVersion = 2;
    refuse(versioned, /schemaVersion 2/);
  });

  it("fails the merged report on a lost required detection exactly as the single run does", () => {
    const lost = shards();
    const survivor = lost[1]!.mutations[0]!;
    survivor.cohorts.generated!.state = "survived";
    const report = mergeShardReports(languages.go, lost, context);
    expect(() => gateDetections(languages.go, report, goCatalog.mutations)).toThrow(new RegExp(`Lost required detections: ${survivor.id}/generated`));
    expect(report.requiredDetectionRegressions).toEqual([`${survivor.id}/generated`]);
    expect(report.complete).toBe(false);
  });
});

describe("mutation shard merge over a shard directory", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dialcache-mutation-shards-"));
    for (const path of ["formal", "typescript/src", "typescript/test", "go", "shards"]) mkdirSync(join(directory, path), { recursive: true });
    for (const path of ["formal/mutations.json", "formal/semantic-cases.json", "formal/execution.json"]) copyFileSync(new URL(path, repo), join(directory, path));
    const manifest = JSON.parse(readRepo("formal/execution.json").toString()) as { models: { path: string; vectorExport?: {artifact: string} }[] };
    for (const model of manifest.models) {
      copyFileSync(new URL(model.path, repo), join(directory, model.path));
      if (model.vectorExport) copyFileSync(new URL(model.vectorExport.artifact, repo), join(directory, model.vectorExport.artifact));
    }
    writeFileSync(join(directory, "typescript/src/index.ts"), "export {};\n");
    writeFileSync(join(directory, "typescript/test/index.test.ts"), "export {};\n");
    writeFileSync(join(directory, "go/cache.go"), "package dialcache\n");
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const writeShards = (reports: Report[], root = join(directory, "shards")) => {
    for (const report of reports) {
      const path = join(root, `${report.shard!.index}-of-${report.shard!.count}`);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "report.json"), JSON.stringify(report, null, 2) + "\n");
    }
  };
  const readReport = (path: string) => JSON.parse(readFileSync(join(directory, path), "utf8")) as Report;

  it("reads <index>-of-<count>/report.json entries and rejects misplaced or unreadable ones", () => {
    const catalogSha256 = sha256(readRepo("formal/mutations.json"));
    const reports = goShardReports(goSingleReport(catalogSha256, fingerprintFiles(directory, languages.go.inputs)), 3);
    writeShards(reports);
    writeFileSync(join(directory, "shards/.DS_Store"), "");
    mkdirSync(join(directory, "shards/notes"));
    writeFileSync(join(directory, "shards/3-of-3/M12-generated.jsonl"), "{}\n");
    expect(readShardReports(join(directory, "shards")).map(report => report.shard!.index).sort()).toEqual([1, 2, 3]);
    mkdirSync(join(directory, "shards/4-of-4"));
    expect(() => readShardReports(join(directory, "shards"))).toThrow(/4-of-4 has no report.json/);
    rmSync(join(directory, "shards/4-of-4"), { recursive: true });
    writeFileSync(join(directory, "shards/2-of-3/report.json"), JSON.stringify(reports[0]));
    expect(() => readShardReports(join(directory, "shards"))).toThrow(/2-of-3\/report.json describes shard 1\/3/);
    writeFileSync(join(directory, "shards/2-of-3/report.json"), "{ not json");
    expect(() => readShardReports(join(directory, "shards"))).toThrow(/2-of-3\/report.json is not valid JSON/);
    expect(() => readShardReports(join(directory, "missing"))).toThrow(/no shard directory/);
  });

  it("writes the complete Go report and markdown where the single run writes them", () => {
    const catalogSha256 = sha256(readRepo("formal/mutations.json"));
    const single = goSingleReport(catalogSha256, fingerprintFiles(directory, languages.go.inputs));
    writeShards(goShardReports(single, 3), join(directory, ".formal-traces/go-semantic/shards"));
    const report = mergeMutationReports("go", { directory });
    expect(canonical(without(readReport(".formal-traces/go-semantic/report.json"), "shards"))).toBe(canonical(single));
    expect(readReport(".formal-traces/go-semantic/report.json")).toEqual(report);
    const markdown = readFileSync(join(directory, ".formal-traces/go-semantic/report.md"), "utf8");
    expect(markdown).toContain("# Go semantic mutation measurement");
    expect(markdown).toContain(`Merged from 3 shards that each reran the baselines: ${slices(3).map((slice, position) => `${position + 1} (${slice.join(", ")}, ${500 + position}s)`).join("; ")}.`);
    // Every mutant names the challenges it is the native twin of, from the checkout's manifest.
    expect(markdown).toContain("| Mutation | Contract case | Challenges | Ordinary | Quint generated | Fixed supplement | Full portable |");
    expect(markdown).toContain(`| M09 | C60.logging-default-off | ${challengesOf("M09")} | survived | detected | survived | detected |`);
    for (const id of ids) expect(markdown, id).toMatch(new RegExp(`^\\| ${id} \\| [^|]+ \\| ${challengesOf(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|`, "m"));
    expect(markdown).toContain(`Completed in ${500 + 501 + 502}s.`);
  });

  it("writes the complete TypeScript report with the behavioral/protocol split the single run computes", () => {
    const catalogSha256 = sha256(readRepo("formal/mutations.json"));
    const inputs = fingerprintFiles(directory, languages.ts.inputs);
    writeShards(tsShardReports(catalogSha256, inputs, 3), join(directory, ".formal-traces/semantic/shards"));
    const report = mergeMutationReports("ts", { directory });
    expect(report.complete).toBe(true);
    expect("requiredDetectionRegressions" in report).toBe(false);
    expect(Object.keys(report.detection as object)).toEqual(["all", "behavioral", "protocol"]);
    const detection = report.detection as Record<string, Record<string, { detected: number; total: number; survivors: string[]; ordinaryParity: { detected: number; total: number } }>>;
    // The fixture's only ordinary survivor is M12, a protocol mutant (W02.sorted-arguments carries vectors).
    expect(protocolIds).toContain("M12");
    expect(detection.all!.ordinary).toEqual({ detected: ids.length - 1, total: ids.length, ordinaryParity: { detected: ids.length - 1, total: ids.length - 1 }, survivors: ["M12"] });
    expect(detection.protocol!.ordinary).toEqual({ detected: protocolIds.length - 1, total: protocolIds.length, ordinaryParity: { detected: protocolIds.length - 1, total: protocolIds.length - 1 }, survivors: ["M12"] });
    expect(detection.behavioral!.portable!.total).toBe(ids.length - protocolIds.length);
    expect(report.reachedWitnesses).toEqual({ effects: { required: 40, reached: 40, traces: 300 } });
    const markdown = readFileSync(join(directory, ".formal-traces/semantic/report.md"), "utf8");
    expect(markdown).toContain("# Semantic coverage measurement");
    expect(markdown).toContain("| cases | 262 | 262 | 226 |");
    expect(markdown).toContain("| Mutation | Case | Challenges | Ordinary | Generated | Full portable |");
    expect(markdown).toContain(`| M12 | W02.sorted-arguments | ${challengesOf("M12")} | survived | detected | detected |`);
    expect(markdown).toContain("Merged from 3 shards");
  });

  it("leaves an incomplete report naming the refusal and exits nonzero from the command line", async () => {
    const catalogSha256 = sha256(readRepo("formal/mutations.json"));
    const single = goSingleReport(catalogSha256, fingerprintFiles(directory, languages.go.inputs));
    writeShards(goShardReports(single, 3).slice(0, 2), join(directory, ".formal-traces/go-semantic/shards"));
    mkdirSync(join(directory, ".formal-traces/go-semantic"), { recursive: true });
    writeFileSync(join(directory, ".formal-traces/go-semantic/report.md"), "stale\n");
    expect(() => mergeMutationReports("go", { directory })).toThrow(/shard 3 of 3 is missing/);
    const report = readReport(".formal-traces/go-semantic/report.json");
    expect(report.complete).toBe(false);
    expect(report.error).toMatch(/shard 3 of 3 is missing/);
    expect(() => readFileSync(join(directory, ".formal-traces/go-semantic/report.md"))).toThrow();
    // A lost detection is written with the regression list, as the single run does.
    const lost = goShardReports(single, 3);
    const survivor = lost[2]!.mutations[1]!;
    survivor.cohorts.generated!.state = "survived";
    writeShards(lost, join(directory, ".formal-traces/go-semantic/shards"));
    expect(() => mergeMutationReports("go", { directory })).toThrow(new RegExp(`Lost required detections: ${survivor.id}/generated`));
    expect(readReport(".formal-traces/go-semantic/report.json")).toMatchObject({ complete: false, requiredDetectionRegressions: [`${survivor.id}/generated`], error: expect.stringContaining(`${survivor.id}/generated`) });
    expect(() => mergeMutationReports("zig", { directory })).toThrow(/Expected language ts, go or rust/);
    expect(() => mergeMutationReports("go", { directory, shardsDirectory: "nowhere" })).toThrow(/no shard directory/);
    expect(readReport(".formal-traces/go-semantic/report.json")).toMatchObject({ complete: false, error: expect.stringContaining("no shard directory") });
    // The command line rejects a bad language before touching any report directory.
    const { spawnSync } = await import("node:child_process");
    const usage = spawnSync(process.execPath, [new URL("../../formal/merge-mutation-reports.mjs", import.meta.url).pathname, "zig"], { encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/Usage: node formal\/merge-mutation-reports.mjs <ts\|go\|rust>/);
  });
});

describe("Rust mutation language", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "dialcache-rust-mutation-language-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const put = (path: string, text: string) => { mkdirSync(join(directory, path, ".."), { recursive: true }); writeFileSync(join(directory, path), text); };

  it("fingerprints the crate sources and files without the build directory", () => {
    for (const path of ["formal/rust-mutations.json", "typescript/test/a.test.ts", "typescript/src/a.ts", "go/redis_adapter.go", "rust/Cargo.toml", "rust/Cargo.lock", "rust/src/lib.rs", "rust/tests/conformance.rs"]) put(path, path);
    const clean = fingerprintFiles(directory, languages.rust.inputs, { exclude: languages.rust.exclude });
    put("rust/target/release/deps/libdialcache.rlib", "build output");
    put("rust/target/semantic/report.json", "{}");
    expect(fingerprintFiles(directory, languages.rust.inputs, { exclude: languages.rust.exclude })).toEqual(clean);
    expect(clean.files).toBe(8);
    // Without the exclusion the build output would count, so the exclusion is what keeps a checkout and its workspace copy equal.
    expect(fingerprintFiles(directory, languages.rust.inputs).files).toBe(10);
    expect(fingerprintFiles(directory, ["rust/Cargo.toml"])).toEqual(fingerprintFiles(directory, ["rust/Cargo.toml"], { exclude: ["rust/target"] }));
    expect(fingerprintFiles(directory, ["rust/Cargo.toml"]).files).toBe(1);
  });

  it("merges the separate Rust catalog without claiming shared model-boundary evidence", () => {
    const catalogBytes = readRepo("formal/rust-mutations.json");
    const catalog = JSON.parse(catalogBytes.toString()) as Catalog;
    for (const path of languages.rust.inputs) mkdirSync(join(directory, path), { recursive: true });
    writeFileSync(join(directory, languages.rust.catalog), catalogBytes);
    const catalogSha256 = sha256(catalogBytes);
    const inputs = fingerprintFiles(directory, languages.rust.inputs, { exclude: languages.rust.exclude });
    const mutations = catalog.mutations.map(entry => {
      const { boundary: _boundary, ...result } = goMutation(entry);
      return result;
    });
    const single = { schemaVersion: 1, complete: true, startedAt: "2026-09-21T00:00:00.000Z", elapsedSeconds: 1,
      cargo: "cargo 1.98.1", catalogSha256, inputs, baselines: goBaselines(), mutations,
      scope: { catalog: "rust-native", modelBoundaryEvidence: false, unmappedSharedMutations: ["M14"] } } as Report;
    const shards = goShardReports(single, 3);
    for (const report of shards) {
      const path = join(directory, languages.rust.output, "shards", `${report.shard!.index}-of-3`);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "report.json"), JSON.stringify(report));
    }
    const merged = mergeMutationReports("rust", { directory });
    expect(merged.complete).toBe(true);
    expect(merged.detection).toEqual(goDetection(mutations));
    expect(merged.requiredDetectionRegressions).toEqual([]);
    expect(merged.scope).toEqual(single.scope);
    const markdown = readFileSync(join(directory, languages.rust.output, "report.md"), "utf8");
    expect(markdown).toContain("# Rust semantic mutation measurement");
    expect(markdown).toContain("| M01 | C45.maximum-age-exclusive | survived | detected | detected | detected |");
    expect(markdown).toContain("model-challenge boundary coverage is not measured");
    expect(markdown).toContain("Merged from 3 shards");
    shards[0]!.mutations[0]!.cohorts.generated!.state = "survived";
    writeFileSync(join(directory, languages.rust.output, "shards/1-of-3/report.json"), JSON.stringify(shards[0]));
    expect(() => mergeMutationReports("rust", { directory })).toThrow(/M01\/generated/);
  });
});


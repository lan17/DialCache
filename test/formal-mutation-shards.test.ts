import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Shard = { index: number; count: number };
type Cohort = { state: "detected" | "survived"; passed: number; failed: number; failingTests: string[]; [key: string]: unknown };
type Mutation = { id: string; case: string; description: string; cohorts: Record<string, Cohort> };
type Report = Record<string, unknown> & { shard?: Shard & { mutationIds: string[] }; baselines: Record<string, Cohort>; mutations: Mutation[] };
type CatalogEntry = { id: string; case: string; description: string; requiredDetections: string[] };
type Catalog = { mutations: CatalogEntry[] };
type Language = { name: string; output: string; catalog: string; inputs: string[]; recordsRegressions: boolean; markdown(report: Report): string };
type Fingerprint = { files: number; sha256: string };
type Context = { catalog: Catalog; catalogSha256: string; inputs?: Fingerprint | undefined };

const shared = await import(new URL("../formal/mutation-reports.mjs", import.meta.url).href) as {
  parseShard(value?: string): Shard;
  shardFromArguments(argv: string[]): Shard;
  partitionMutations<T>(mutations: T[], shard: Shard): T[];
  shardDirectory(output: string, shard: Shard): string;
  fingerprintFiles(directory: string, paths: string[]): { files: number; sha256: string };
  requiredDetectionRegressions(entries: CatalogEntry[], results: Mutation[]): string[];
  goDetection(mutations: Mutation[]): Record<string, unknown>;
  typescriptDetection(mutations: Mutation[], cases: { id: string; vectors: unknown[] }[]): Record<string, unknown>;
  gateDetections(language: Language, report: Report, entries: CatalogEntry[], options?: { directory?: string; summarize?: boolean }): void;
  languages: { ts: Language; go: Language };
};
const merge = await import(new URL("../formal/merge-mutation-reports.mjs", import.meta.url).href) as {
  canonical(value: unknown): string;
  mergeShardReports(language: Language, shards: Report[], context: Context): Report;
  readShardReports(directory: string): Report[];
  mergeMutationReports(name: string, options?: { directory?: string; shardsDirectory?: string; outputDirectory?: string }): Report;
};
const { parseShard, shardFromArguments, partitionMutations, shardDirectory, fingerprintFiles, requiredDetectionRegressions, goDetection, gateDetections, languages } = shared;
const { canonical, mergeShardReports, readShardReports, mergeMutationReports } = merge;

const repo = new URL("../", import.meta.url);
const readRepo = (path: string) => readFileSync(new URL(path, repo));
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const goCatalog = JSON.parse(readRepo("formal/go-mutations.json").toString()) as Catalog;
const tsCatalog = JSON.parse(readRepo("formal/semantic-mutations.json").toString()) as Catalog;
const ids = goCatalog.mutations.map(mutation => mutation.id);

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
  return { id: entry.id, case: entry.case, description: entry.description,
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
  return { schemaVersion: 1, complete: true, startedAt: "2026-09-12T00:27:22.662Z", baselines: goBaselines(), mutations, elapsedSeconds: 1507,
    ...goIdentity(catalogSha256, inputs), detection: goDetection(mutations), requiredDetectionRegressions: [] };
}
// What each measure-go-semantics.mjs --shard=i/n run writes.
function goShardReports(single: Report, count: number): Report[] {
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
  return { id: entry.id, case: entry.case, description: entry.description,
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
      revision: "ed9bd62", node: "v24.20.0", catalogSha256, sourceSha256: { "src/dialcache.ts": "aa".repeat(32) }, declaredCoverage, baselines: tsBaselines(), mutations: slice,
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
    expect(shardFromArguments([])).toEqual({ index: 1, count: 1 });
    expect(shardFromArguments(["--shard=2/3"])).toEqual({ index: 2, count: 3 });
    expect(() => shardFromArguments(["--shard=1/3", "--shard=2/3"])).toThrow(/unexpected argument/);
    expect(() => shardFromArguments(["--other"])).toThrow(/unexpected argument --other/);
    expect(() => shardFromArguments(["2/3"])).toThrow(/unexpected argument/);
  });

  it("covers every mutation exactly once, contiguously and in catalog order, for any shard count", () => {
    for (let count = 1; count <= 20; count++) {
      const shards = Array.from({ length: count }, (_, position) => partitionMutations(ids, { index: position + 1, count }));
      expect(shards.flat(), `count ${count}`).toEqual(ids);
      const sizes = shards.map(shard => shard.length);
      expect(Math.max(...sizes) - Math.min(...sizes), `count ${count} balance`).toBeLessThanOrEqual(1);
      for (const shard of shards) {
        if (!shard.length) continue;
        const start = ids.indexOf(shard[0]!);
        expect(ids.slice(start, start + shard.length), `count ${count} contiguous`).toEqual(shard);
      }
    }
    expect(Array.from({ length: 3 }, (_, position) => partitionMutations(ids, { index: position + 1, count: 3 }).length)).toEqual([5, 4, 4]);
    expect(partitionMutations(ids, { index: 1, count: 1 })).toEqual(ids);
    // More shards than mutations: the trailing shards are empty but valid.
    expect(partitionMutations(ids, { index: 13, count: 14 })).toEqual(["M13"]);
    expect(partitionMutations(ids, { index: 14, count: 14 })).toEqual([]);
    expect(partitionMutations([], { index: 1, count: 3 })).toEqual([]);
  });

  it("keeps the single run's directory and separates shards under shards/<index>-of-<count>", () => {
    expect(shardDirectory("/out/semantic", { index: 1, count: 1 })).toBe("/out/semantic");
    expect(shardDirectory("/out/semantic", { index: 2, count: 3 })).toBe("/out/semantic/shards/2-of-3");
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
});

describe("mutation shard merge", () => {
  const catalogSha256 = sha256(readRepo("formal/go-mutations.json"));
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
    expect(report.shards).toEqual([
      { index: 1, count: 3, mutationIds: ids.slice(0, 5), startedAt: "2026-09-12T00:20:00.000Z", elapsedSeconds: 500 },
      { index: 2, count: 3, mutationIds: ids.slice(5, 9), startedAt: "2026-09-12T00:21:00.000Z", elapsedSeconds: 501 },
      { index: 3, count: 3, mutationIds: ids.slice(9), startedAt: "2026-09-12T00:22:00.000Z", elapsedSeconds: 502 },
    ]);
    expect("shard" in report).toBe(false);
    // Everything but timing and the shard summary is identical to the single run.
    expect(canonical(without(report, "shards"))).toBe(canonical(single));
    expect(Object.keys(without(report, "shards")).sort()).toEqual(Object.keys(single).sort());
    // Shard order on disk does not matter; the merge sorts by index.
    expect(canonical(merged(shards().reverse()))).toBe(canonical(report));
  });

  it("accepts thirteen single-mutation shards and an empty trailing shard", () => {
    expect(canonical(without(merged(goShardReports(single, 13)), "shards"))).toBe(canonical(single));
    const fourteen = goShardReports(single, 14);
    expect(fourteen[13]!.mutations).toEqual([]);
    expect(fourteen[13]!.shard!.mutationIds).toEqual([]);
    const report = merged(fourteen);
    expect(canonical(without(report, "shards"))).toBe(canonical(single));
    expect((report.shards as unknown[]).length).toBe(14);
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
    duplicated[2]!.mutations.unshift(clone(duplicated[1]!.mutations[0]!));
    duplicated[2]!.shard!.mutationIds.unshift(duplicated[1]!.mutations[0]!.id);
    refuse(duplicated, /M06 appears in shards 2 and 3/);
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
    refuse(shards(), /catalogSha256 .* was measured, but this checkout's formal\/go-mutations.json hashes to/, { catalogSha256: sha256("edited catalog") });
    refuse(shards(), /inputs fingerprint .* was measured, but this checkout's formal\/go\/test\/src hash to/, { inputs: { files: 367, sha256: "different" } });
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
    lost[1]!.mutations[0]!.cohorts.generated!.state = "survived";
    const report = mergeShardReports(languages.go, lost, context);
    expect(() => gateDetections(languages.go, report, goCatalog.mutations)).toThrow(/Lost required detections: M06\/generated/);
    expect(report.requiredDetectionRegressions).toEqual(["M06/generated"]);
    expect(report.complete).toBe(false);
  });
});

describe("mutation shard merge over a shard directory", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dialcache-mutation-shards-"));
    for (const path of ["formal", "src", "test", "go", "shards"]) mkdirSync(join(directory, path), { recursive: true });
    for (const path of ["formal/go-mutations.json", "formal/semantic-mutations.json", "formal/semantic-cases.json"]) copyFileSync(new URL(path, repo), join(directory, path));
    writeFileSync(join(directory, "src/index.ts"), "export {};\n");
    writeFileSync(join(directory, "test/index.test.ts"), "export {};\n");
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
    const catalogSha256 = sha256(readRepo("formal/go-mutations.json"));
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
    const catalogSha256 = sha256(readRepo("formal/go-mutations.json"));
    const single = goSingleReport(catalogSha256, fingerprintFiles(directory, languages.go.inputs));
    writeShards(goShardReports(single, 3), join(directory, ".formal-traces/go-semantic/shards"));
    const report = mergeMutationReports("go", { directory });
    expect(canonical(without(readReport(".formal-traces/go-semantic/report.json"), "shards"))).toBe(canonical(single));
    expect(readReport(".formal-traces/go-semantic/report.json")).toEqual(report);
    const markdown = readFileSync(join(directory, ".formal-traces/go-semantic/report.md"), "utf8");
    expect(markdown).toContain("# Go semantic mutation measurement");
    expect(markdown).toContain("Merged from 3 shards that each reran the baselines: 1 (M01, M02, M03, M04, M05, 500s); 2 (M06, M07, M08, M09, 501s); 3 (M10, M11, M12, M13, 502s).");
    expect(markdown).toContain("| M09 | C60.logging-default-off | survived | detected | survived | detected |");
    expect(markdown).toContain(`Completed in ${500 + 501 + 502}s.`);
  });

  it("writes the complete TypeScript report with the behavioral/protocol split the single run computes", () => {
    const catalogSha256 = sha256(readRepo("formal/semantic-mutations.json"));
    const inputs = fingerprintFiles(directory, languages.ts.inputs);
    writeShards(tsShardReports(catalogSha256, inputs, 3), join(directory, ".formal-traces/semantic/shards"));
    const report = mergeMutationReports("ts", { directory });
    expect(report.complete).toBe(true);
    expect("requiredDetectionRegressions" in report).toBe(false);
    expect(Object.keys(report.detection as object)).toEqual(["all", "behavioral", "protocol"]);
    const detection = report.detection as Record<string, Record<string, { detected: number; total: number; survivors: string[]; ordinaryParity: { detected: number; total: number } }>>;
    expect(detection.all!.ordinary).toEqual({ detected: 12, total: 13, ordinaryParity: { detected: 12, total: 12 }, survivors: ["M12"] });
    expect(detection.protocol!.ordinary).toEqual({ detected: 1, total: 2, ordinaryParity: { detected: 1, total: 1 }, survivors: ["M12"] });
    expect(detection.behavioral!.portable!.total).toBe(11);
    expect(report.reachedWitnesses).toEqual({ effects: { required: 40, reached: 40, traces: 300 } });
    const markdown = readFileSync(join(directory, ".formal-traces/semantic/report.md"), "utf8");
    expect(markdown).toContain("# Semantic coverage measurement");
    expect(markdown).toContain("| cases | 262 | 262 | 226 |");
    expect(markdown).toContain("Merged from 3 shards");
  });

  it("leaves an incomplete report naming the refusal and exits nonzero from the command line", async () => {
    const catalogSha256 = sha256(readRepo("formal/go-mutations.json"));
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
    lost[2]!.mutations[1]!.cohorts.generated!.state = "survived";
    writeShards(lost, join(directory, ".formal-traces/go-semantic/shards"));
    expect(() => mergeMutationReports("go", { directory })).toThrow(/Lost required detections: M11\/generated/);
    expect(readReport(".formal-traces/go-semantic/report.json")).toMatchObject({ complete: false, requiredDetectionRegressions: ["M11/generated"], error: expect.stringContaining("M11/generated") });
    expect(() => mergeMutationReports("rust", { directory })).toThrow(/Expected language ts or go/);
    expect(() => mergeMutationReports("go", { directory, shardsDirectory: "nowhere" })).toThrow(/no shard directory/);
    expect(readReport(".formal-traces/go-semantic/report.json")).toMatchObject({ complete: false, error: expect.stringContaining("no shard directory") });
    // The command line rejects a bad language before touching any report directory.
    const { spawnSync } = await import("node:child_process");
    const usage = spawnSync(process.execPath, [new URL("../formal/merge-mutation-reports.mjs", import.meta.url).pathname, "rust"], { encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/Usage: node formal\/merge-mutation-reports.mjs <ts\|go>/);
  });
});

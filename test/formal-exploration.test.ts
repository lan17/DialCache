import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Entry = { id: string; category: string; profile: string; path?: string };
type Result = { language: string; status: string; witnessFailures: string[]; caseFailures: string[] };
type Step = { args?: string[]; env?: Record<string, string>; nativeReport?: string; explorationContext?: string };
const { explorationSeed, explorationPlan, snapshotSources, nativeExplorationResult, runExplorationSteps, explore, replayExploration } = await import(
  new URL("../formal/explore.mjs", import.meta.url).href,
) as {
  explorationSeed(value?: string): string;
  explorationPlan(directory: string, seed: string): Step[];
  snapshotSources(directory: string, destination: string, paths: string[]): Record<string, string>;
  nativeExplorationResult(language: string, text: string, context: unknown, directory: string, packageName: string): Result;
  runExplorationSteps(plan: Step[], options: { directory: string; execute: (steps: Step[]) => Promise<void> }): Promise<Result[]>;
  explore(seed: string, options: { directory: string; run?: () => Promise<unknown[]> }): Promise<string>;
  replayExploration(path: string, options: { directory: string }): Promise<string>;
};
const { nativeBinding } = await import(new URL("../formal/conformance-bindings.mjs", import.meta.url).href) as {
  nativeBinding(entry: Entry, language: string, directory?: string): string | [string, string];
};
const inventory: Entry[] = [
  { id: "sampled/recovery/0", category: "sampled", profile: "recovery", path: ".formal-traces/features/recovery/trace_0.itf.json" },
  { id: "witness/recovery", category: "witness", profile: "recovery" },
];
const packageName = "example.com/exploration";
const context = (language: string) => ({ kind: "exploration", language, createdAt: 1, inventory,
  specification: {}, implementation: {}, corpus: {} });
const { selectedProfiles } = await import(new URL("../formal/witnesses.mjs", import.meta.url).href) as { selectedProfiles(selection: string): string[] };
function tsReport(directory: string, failure?: string) {
  const ancestorTitles = ["generated recovery conformance"];
  const assertionResults = inventory.map(entry => {
    const [, fullName] = nativeBinding(entry, "typescript", directory) as [string, string];
    return { ancestorTitles, title: fullName.slice(ancestorTitles[0]!.length + 1), fullName,
      status: entry.id === failure ? "failed" : "passed", failureMessages: entry.id === failure ? ["AssertionError: expected matching observation"] : [] };
  });
  return { success: !failure, numFailedTests: failure ? 1 : 0, numPassedTests: failure ? 1 : 2, numTotalTests: 2,
    numTotalTestSuites: 2, numFailedTestSuites: failure ? 2 : 0, numPassedTestSuites: failure ? 0 : 2,
    numPendingTests: 0, numTodoTests: 0, numPendingTestSuites: 0, startTime: 2,
    testResults: [{ name: `${directory}/test/formal-features.test.ts`, status: failure ? "failed" : "passed",
      startTime: 2, endTime: 3, message: "", assertionResults }] };
}
function rustReport(failure?: string) {
  const records: Record<string, unknown>[] = [{ schemaVersion: 1, kind: "start", implementation: "rust", startedAt: 10 }];
  for (const [index, entry] of inventory.entries()) {
    const failed = entry.id === failure;
    records.push({ kind: "case", id: nativeBinding(entry, "rust"), status: failed ? "failed" : "passed", startedAt: 11 + index, finishedAt: 12 + index,
      ...(failed ? { message: "Observation mismatch\nexpected: 1\nactual: 2" } : {}) });
  }
  records.push({ kind: "finish", status: failure ? "failed" : "passed", finishedAt: 20, cases: inventory.length, failed: failure ? 1 : 0 });
  return records.map(record => JSON.stringify(record)).join("\n");
}
function goReport(failure?: string) {
  const events: Record<string, unknown>[] = [];
  const event = (Action: string, Test?: string) => events.push({ Action, ...(Test ? { Test } : {}), Package: packageName, Time: new Date(10 + events.length).toISOString() });
  event("start");
  for (const entry of inventory) {
    const name = nativeBinding(entry, "go") as string;
    const parts = name.split("/");
    const parents = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
    for (const parent of parents) event("run", parent);
    event("run", name);
    event(entry.id === failure ? "fail" : "pass", name);
    for (const parent of [...parents].reverse()) event(entry.id === failure ? "fail" : "pass", parent);
  }
  event(failure ? "fail" : "pass");
  return events.map(event => JSON.stringify(event)).join("\n");
}

// A completed evaluator report for a seed: what formal/witnesses.mjs evaluate
// writes when every scheduled witness profile was evaluated and nothing failed.
function completedWitnessReport(seed: string, profiles: readonly string[] = selectedProfiles("all")) {
  return { schemaVersion: 1, command: "evaluate", seed, failed: [] as string[], incomplete: [] as string[],
    profiles: Object.fromEntries(profiles.map(profile => [profile, {}])) };
}

// The witness inventory a snapshot carries: the manifest's scheduled profiles
// and the registry that names which of them have required witnesses.
function writeWitnessInventory(directory: string, profiles: readonly string[]) {
  mkdirSync(join(directory, "formal"), { recursive: true });
  writeFileSync(join(directory, "formal/execution.json"), JSON.stringify({ models: profiles.map(profile => ({ profile })) }));
  writeFileSync(join(directory, "formal/coverage-witnesses.json"), JSON.stringify(Object.fromEntries(profiles.map(profile => [profile, ["required"]]))));
}

function savedFixture(directory: string) {
  const saved = join(directory, "saved"), workspace = join(saved, "workspace");
  mkdirSync(join(workspace, "formal"), { recursive: true });
  mkdirSync(join(directory, "node_modules"));
  const sources: Record<string, string> = {
    "package.json": '{"packageManager":"pnpm@10.33.0"}\n',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    // The saved snapshot schedules one witness profile; the current checkout
    // schedules fourteen. A replay is judged against the saved inventory.
    "formal/execution.json": JSON.stringify({ models: [{ profile: "effects" }] }),
    "formal/coverage-witnesses.json": JSON.stringify({ effects: ["required"] }),
    "formal/explore.mjs": `import { writeFileSync } from 'node:fs';
      export const explorationPlan = (directory, seed) => [{ directory, seed, runner: 'saved' }];
      export async function runExplorationSteps(plan, options) {
        writeFileSync(options.directory + '/.formal-traces/saved-runner.json', JSON.stringify(plan));
        // A saved run's evaluator also has to leave a completed witness report behind.
        writeFileSync(options.directory + '/.formal-traces/witness-report.json', ${JSON.stringify(JSON.stringify(completedWitnessReport("0x2a", ["effects"])))});
        return [{ language: 'typescript', status: 'passed' }, { language: 'go', status: 'passed' }, { language: 'rust', status: 'passed' }];
      }`,
    "formal/validation.mjs": `import { mkdirSync, writeFileSync } from 'node:fs';
      export function checkPrerequisites(target, { directory }) {
        mkdirSync(directory + '/.formal-traces', { recursive: true });
        writeFileSync(directory + '/.formal-traces/saved-prerequisites.txt', target);
      }`,
  };
  for (const [path, content] of Object.entries(sources)) writeFileSync(join(workspace, path), content);
  for (const path of ["package.json", "pnpm-lock.yaml"]) writeFileSync(join(directory, path), sources[path]!);
  mkdirSync(join(workspace, ".formal-traces"));
  writeFileSync(join(workspace, ".formal-traces/original-evidence.txt"), "retain original native evidence");
  const report = { schemaVersion: 1, kind: "exploration", acceptance: false, baseRevision: "a".repeat(40),
    seed: "0x2a", status: "native-failure", finishedAt: new Date().toISOString(),
    sources: Object.fromEntries(Object.entries(sources).map(([path, content]) => [path, createHash("sha256").update(content).digest("hex")])) };
  const path = join(saved, "report.json");
  writeFileSync(path, JSON.stringify(report));
  return { path, report, workspace, sources };
}

describe("isolated exploratory validation", () => {
  it("normalizes reproducible seeds and rejects unsupported seed domains", () => {
    expect(explorationSeed("18446744073709551615")).toBe("0xffffffffffffffff");
    expect(explorationSeed("0xD1A1CA")).toBe("0xd1a1ca");
    for (const seed of ["-1", "18446744073709551616", "1.2", "", "seed", "0x10000000000000000"]) {
      expect(() => explorationSeed(seed)).toThrow(/seed/);
    }
  });

  it("seeds only exploration/generation and keeps native paths separate from acceptance", () => {
    const directory = "/isolated/exploration";
    const plan = explorationPlan(directory, "42");
    const seeded = plan.filter(step => step.env?.QUINT_SEED);
    expect(seeded).toHaveLength(3);
    expect(seeded.map(step => step.args?.slice(0, 2))).toEqual([
      ["formal/run-models.mjs", "check"], ["formal/run-models.mjs", "generate"], ["formal/witnesses.mjs", "evaluate"],
    ]);
    for (const step of seeded) expect(step.env?.QUINT_SEED).toBe("0x2a");
    // Only the identical pinned fault campaign is omitted. Clean model
    // checks/regressions, lint, fixtures, generation and witnesses remain.
    expect(plan.filter(step => step.args?.[0]?.startsWith("formal/")).map(step => step.args)).toEqual([
      ["formal/run-models.mjs", "check"],
      ["formal/lint-profiles.mjs", "baseline", "--check"],
      ["formal/check-kernel-fixtures.mjs"],
      ["formal/run-models.mjs", "generate"],
      ["formal/generated-fixtures.mjs", "--check"],
      ["formal/witnesses.mjs", "evaluate", "--profile", "all"],
      ["formal/check-go-parity.mjs"],
    ]);
    const replays = plan.filter(step => step.nativeReport);
    expect(replays.map(step => step.nativeReport)).toEqual(["typescript", "go", "rust"]);
    for (const step of replays) expect(step.env?.DIALCACHE_FEATURE_TRACE_DIR).toBe(`${directory}/.formal-traces/features`);
    expect(plan.filter(step => step.explorationContext).map(step => step.explorationContext)).toEqual(["typescript", "go", "rust"]);
    expect(plan.some(step => step.args?.includes("formal/check-go-replay.mjs") || step.args?.includes("formal/check-rust-replay.mjs")
      || step.args?.includes("formal/conformance-adapters.mjs"))).toBe(false);
    expect(plan.some(step => step.args?.[0] === "formal/conformance.mjs" && step.args[1] === "check")).toBe(false);
  });

  it("copies dirty/new sources, rejects links and cannot overwrite a snapshot target", () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-test-"));
    try {
      const destination = join(directory, "snapshot");
      mkdirSync(join(directory, "formal"));
      writeFileSync(join(directory, "formal/rule.qnt"), "current rule");
      const hashes = snapshotSources(directory, destination, ["formal/rule.qnt", "removed.qnt"]);
      expect(Object.keys(hashes)).toEqual(["formal/rule.qnt"]);
      expect(hashes["formal/rule.qnt"]).toBe(createHash("sha256").update("current rule").digest("hex"));
      writeFileSync(join(destination, "formal/rule.qnt"), "exploratory edit");
      expect(readFileSync(join(directory, "formal/rule.qnt"), "utf8")).toBe("current rule");
      expect(() => snapshotSources(directory, destination, ["formal/rule.qnt"])).toThrow();
      for (const path of ["../outside", "/outside", "node_modules", "node_modules/pkg", ".formal-traces", ".formal-traces/report.json", ".git/config"]) {
        expect(() => snapshotSources(directory, destination, [path])).toThrow();
      }
      for (const [name, target] of [["external", directory], ["internal", join(directory, "formal/rule.qnt")], ["dangling", join(directory, "missing")]]) {
        symlinkSync(target!, join(directory, name!));
        expect(() => snapshotSources(directory, destination, [name!])).toThrow(/Symbolic link/);
      }
      expect(() => snapshotSources(directory, destination, ["external/formal/rule.qnt"])).toThrow(/Symbolic link/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["typescript", "go", "rust"])("classifies exact %s witness leaves separately from replay failures", language => {
    const native = (failure?: string) => language === "typescript" ? JSON.stringify(tsReport("/snapshot", failure))
      : language === "go" ? goReport(failure) : rustReport(failure);
    expect(nativeExplorationResult(language, native(), context(language), "/snapshot", packageName).status).toBe("passed");
    expect(nativeExplorationResult(language, native("witness/recovery"), context(language), "/snapshot", packageName)).toMatchObject({
      status: "witness-check-failure", witnessFailures: ["witness/recovery"], caseFailures: [],
    });
    expect(nativeExplorationResult(language, native("sampled/recovery/0"), context(language), "/snapshot", packageName)).toMatchObject({
      status: "native-failure", caseFailures: ["sampled/recovery/0"],
    });
  });

  it("does not infer coverage from a witness-like unknown test title or tolerate incomplete reports", () => {
    const report = tsReport("/snapshot", "witness/recovery");
    report.testResults[0]!.assertionResults[1]!.fullName += " almost";
    report.testResults[0]!.assertionResults[1]!.title += " almost";
    expect(() => nativeExplorationResult("typescript", JSON.stringify(report), context("typescript"), "/snapshot", packageName)).toThrow(/Missing/);
    expect(() => nativeExplorationResult("go", goReport().split("\n").slice(0, -1).join("\n"), context("go"), "/snapshot", packageName)).toThrow(/incomplete/);
    const wrong = tsReport("/snapshot"); wrong.numPassedTests++;
    expect(() => nativeExplorationResult("typescript", JSON.stringify(wrong), context("typescript"), "/snapshot", packageName)).toThrow(/totals/);
  });

  it("replays Go after a TypeScript witness shortfall while preserving both failed native reports", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-run-"));
    try {
      mkdirSync(join(directory, ".formal-traces")); mkdirSync(join(directory, "go"));
      writeFileSync(join(directory, "go/go.mod"), `module ${packageName}\n`);
      for (const [language, prefix] of [["typescript", "ts"], ["go", "go"]]) {
        writeFileSync(join(directory, `.formal-traces/${prefix}-context.json`), JSON.stringify(context(language!)));
      }
      const ran: string[] = [];
      const results = await runExplorationSteps([{ nativeReport: "typescript" }, { nativeReport: "go" }], {
        directory, execute: async ([step]) => {
          const language = step!.nativeReport!; ran.push(language);
          const text = language === "typescript" ? JSON.stringify(tsReport(directory, "witness/recovery")) : goReport("witness/recovery");
          writeFileSync(join(directory, language === "typescript" ? ".formal-traces/ts-replay.json" : ".formal-traces/go-replay.jsonl"), text);
          throw new Error("native test command exited 1");
        },
      });
      expect(ran).toEqual(["typescript", "go"]);
      expect(results.map(result => result.status)).toEqual(["witness-check-failure", "witness-check-failure"]);
      expect(JSON.parse(readFileSync(join(directory, ".formal-traces/ts-replay.json"), "utf8")).success).toBe(false);
      expect(existsSync(join(directory, ".formal-traces/ts-completion.json"))).toBe(false);
      await expect(runExplorationSteps([{ nativeReport: "typescript" }, { nativeReport: "go" }], {
        directory, execute: async () => { throw new Error("process crashed without a report"); },
      })).rejects.toThrow();
      expect(ran).toHaveLength(2);
      await expect(runExplorationSteps([{ nativeReport: "typescript" }], {
        directory, execute: async () => {
          writeFileSync(join(directory, ".formal-traces/ts-replay.json"), JSON.stringify(tsReport(directory)));
          writeFileSync(join(directory, ".formal-traces/ts-context.json"), JSON.stringify({ ...context("typescript"), inventory: [] }));
        },
      })).rejects.toThrow(/context changed/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("records initialization failure and finishes the report before any native command", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-init-"));
    try {
      await expect(explore("42", { directory })).rejects.toThrow();
      const output = join(directory, ".formal-traces/exploration", readdirSync(join(directory, ".formal-traces/exploration"))[0]!);
      expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8"))).toMatchObject({
        kind: "exploration", acceptance: false, status: "infrastructure-failure", seed: "0x2a", finishedAt: expect.any(String),
      });
      expect(existsSync(join(output, "workspace/node_modules"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects source changes within the copied run and removes the runtime link", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-integrity-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "test"], { cwd: directory });
      writeFileSync(join(directory, ".gitignore"), ".formal-traces/\n");
      writeWitnessInventory(directory, selectedProfiles("all"));
      writeFileSync(join(directory, "rule.qnt"), "original");
      await expect(explore("42", { directory, run: async () => {
        const output = join(directory, ".formal-traces/exploration", readdirSync(join(directory, ".formal-traces/exploration"))[0]!);
        writeFileSync(join(output, "workspace/rule.qnt"), "changed");
        return [{ language: "typescript", status: "passed" }, { language: "go", status: "passed" }, { language: "rust", status: "passed" }];
      } })).rejects.toThrow(/changed/);
      const output = join(directory, ".formal-traces/exploration", readdirSync(join(directory, ".formal-traces/exploration"))[0]!);
      expect(readFileSync(join(directory, "rule.qnt"), "utf8")).toBe("original");
      expect(existsSync(join(output, "workspace/node_modules"))).toBe(false);
      expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8")).status).toBe("infrastructure-failure");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("returns a nonzero failure after both ports report incomplete witness coverage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-coverage-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "test"], { cwd: directory });
      writeFileSync(join(directory, ".gitignore"), ".formal-traces/\n");
      writeWitnessInventory(directory, selectedProfiles("all"));
      await expect(explore("42", { directory, run: async () => [
        { language: "typescript", status: "witness-check-failure" }, { language: "go", status: "witness-check-failure" }, { language: "rust", status: "witness-check-failure" },
      ] })).rejects.toThrow(/witness-check-failure/);
      const output = join(directory, ".formal-traces/exploration", readdirSync(join(directory, ".formal-traces/exploration"))[0]!);
      expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8"))).toMatchObject({
        kind: "exploration", acceptance: false, status: "witness-check-failure", sourcesUnchanged: true,
        native: [{ language: "typescript" }, { language: "go" }, { language: "rust" }],
      });
      expect(existsSync(join(output, "workspace/node_modules"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("replays saved bytes with their own runner and prerequisites without Git, preserving original evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-reproduce-"));
    try {
      const saved = savedFixture(directory), original = readFileSync(saved.path, "utf8");
      mkdirSync(join(directory, "formal"));
      writeFileSync(join(directory, "formal/explore.mjs"), 'throw new Error("new checkout runner must not execute")');
      writeFileSync(join(directory, "formal/validation.mjs"), 'throw new Error("new checkout prerequisites must not execute")');
      const output = await replayExploration(saved.path, { directory });
      const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
      expect(report).toMatchObject({ status: "passed", acceptance: false, seed: "0x2a", baseRevision: saved.report.baseRevision,
        sources: saved.report.sources, replayOrigin: { path: realpathSync(saved.path),
          reportSha256: createHash("sha256").update(original).digest("hex") } });
      expect(JSON.parse(readFileSync(join(output, "workspace/.formal-traces/saved-runner.json"), "utf8"))).toEqual([
        { directory: join(output, "workspace"), seed: "0x2a", runner: "saved" },
      ]);
      expect(readFileSync(join(output, "workspace/.formal-traces/saved-prerequisites.txt"), "utf8")).toBe("explore");
      // The saved inventory has one profile while this checkout schedules many:
      // the replay was judged against the snapshot's inventory, not the checkout's.
      expect(selectedProfiles("all").length).toBeGreaterThan(1);
      expect(Object.keys(report.witnesses.profiles)).toEqual(["effects"]);
      expect(readFileSync(saved.path, "utf8")).toBe(original);
      expect(readFileSync(join(saved.workspace, ".formal-traces/original-evidence.txt"), "utf8")).toBe("retain original native evidence");
      for (const [path, content] of Object.entries(saved.sources)) expect(readFileSync(join(saved.workspace, path), "utf8")).toBe(content);
      expect(existsSync(join(output, "workspace/node_modules"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["changed", "deleted"])("rejects a %s saved source before rerunning", async change => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-drift-"));
    try {
      const saved = savedFixture(directory), source = join(saved.workspace, "formal/explore.mjs");
      const original = readFileSync(saved.path, "utf8");
      if (change === "changed") writeFileSync(source, "changed saved runner"); else rmSync(source);
      await expect(replayExploration(saved.path, { directory })).rejects.toThrow();
      expect(readFileSync(saved.path, "utf8")).toBe(original);
      expect(existsSync(join(directory, ".formal-traces/exploration"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("requires matching dependency definitions and valid saved seed/revision metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-origin-"));
    try {
      const saved = savedFixture(directory);
      for (const patch of [{ seed: "invalid" }, { baseRevision: "not-a-revision" }, { status: "running" }]) {
        writeFileSync(saved.path, JSON.stringify({ ...saved.report, ...patch }));
        await expect(replayExploration(saved.path, { directory })).rejects.toThrow();
      }
      writeFileSync(saved.path, JSON.stringify(saved.report));
      writeFileSync(join(directory, "pnpm-lock.yaml"), "different installed dependency definitions");
      await expect(replayExploration(saved.path, { directory })).rejects.toThrow(/dependency runtime/);
      const outputs = join(directory, ".formal-traces/exploration");
      const output = join(outputs, readdirSync(outputs)[0]!);
      expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8")).status).toBe("infrastructure-failure");
      expect(existsSync(join(output, "workspace/node_modules"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("fails exploration after both ports replay when the witness baseline gate tripped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-witness-report-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "test"], { cwd: directory });
      writeFileSync(join(directory, ".gitignore"), ".formal-traces/\n");
      writeWitnessInventory(directory, selectedProfiles("all"));
      const witnesses = { ...completedWitnessReport("0x2a"), failed: ["witness/effects: reply:13 reached by 1 sampled histories, minimum 2 (baseline 4)"] };
      let replays = 0;
      await expect(explore("42", { directory, run: async () => {
        const workspace = join(directory, ".formal-traces/exploration", readdirSync(join(directory, ".formal-traces/exploration"))[0]!, "workspace");
        mkdirSync(join(workspace, ".formal-traces"), { recursive: true });
        writeFileSync(join(workspace, ".formal-traces/witness-report.json"), JSON.stringify(witnesses));
        replays = 2;
        return [{ language: "typescript", status: "passed" }, { language: "go", status: "passed" }, { language: "rust", status: "passed" }];
      } })).rejects.toThrow(/coverage-gate-failure[\s\S]*reply:13 reached by 1 sampled histories/);
      expect(replays).toBe(2);
      const output = join(directory, ".formal-traces/exploration", readdirSync(join(directory, ".formal-traces/exploration"))[0]!);
      expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8"))).toMatchObject({ status: "coverage-gate-failure", witnesses, sourcesUnchanged: true });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([
    ["missing", undefined, /wrote no report/],
    ["an empty object", "{}", /not a completed evaluation/],
    ["a failure string instead of a list", JSON.stringify({ ...completedWitnessReport("0x2a"), failed: "evaluation failed" }), /not a completed evaluation/],
    ["malformed JSON", "{ not json", /unreadable/],
    ["written by the report command", JSON.stringify({ ...completedWitnessReport("0x2a"), command: "report" }), /not a completed evaluation/],
    ["judged under the pinned seed", JSON.stringify(completedWitnessReport("0xd1a1ca")), /judged under seed 0xd1a1ca, not this exploration's 0x2a/],
    ["missing a scheduled profile", JSON.stringify({ ...completedWitnessReport("0x2a"), profiles: { effects: {} } }), /covers no evaluation of/],
  ])("fails as infrastructure when the witness report is %s although both ports passed", async (_name, contents, message) => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-witness-missing-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "test"], { cwd: directory });
      writeFileSync(join(directory, ".gitignore"), ".formal-traces/\n");
      writeWitnessInventory(directory, selectedProfiles("all"));
      await expect(explore("42", { directory, run: async () => {
        const workspace = join(directory, ".formal-traces/exploration", readdirSync(join(directory, ".formal-traces/exploration"))[0]!, "workspace");
        mkdirSync(join(workspace, ".formal-traces"), { recursive: true });
        if (contents !== undefined) writeFileSync(join(workspace, ".formal-traces/witness-report.json"), contents);
        return [{ language: "typescript", status: "passed" }, { language: "go", status: "passed" }, { language: "rust", status: "passed" }];
      } })).rejects.toThrow(message);
      const output = join(directory, ".formal-traces/exploration", readdirSync(join(directory, ".formal-traces/exploration"))[0]!);
      expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8")).status).toBe("infrastructure-failure");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("reports a tolerated evaluator failure to the caller instead of swallowing it", async () => {
    const tolerated: string[] = [];
    const results = await runExplorationSteps([{ label: "Evaluate shared witness evidence", args: ["formal/witnesses.mjs", "evaluate"], tolerateFailure: true } as unknown as Step], {
      directory: "/isolated", execute: async () => { throw new Error("evaluator crashed after writing evidence"); },
      onToleratedFailure: (step: unknown, error: unknown) => { tolerated.push(`${(step as { label?: string }).label}: ${String(error)}`); },
    } as never);
    expect(results).toEqual([]);
    expect(tolerated).toEqual(["Evaluate shared witness evidence: Error: evaluator crashed after writing evidence"]);
  });
  it("keeps a clean witness report and passes when the baseline gate holds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dialcache-exploration-witness-clean-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "test"], { cwd: directory });
      writeFileSync(join(directory, ".gitignore"), ".formal-traces/\n");
      writeWitnessInventory(directory, selectedProfiles("all"));
      const witnesses = completedWitnessReport("42");
      const output = await explore("42", { directory, run: async () => {
        const workspace = join(directory, ".formal-traces/exploration", readdirSync(join(directory, ".formal-traces/exploration"))[0]!, "workspace");
        mkdirSync(join(workspace, ".formal-traces"), { recursive: true });
        writeFileSync(join(workspace, ".formal-traces/witness-report.json"), JSON.stringify(witnesses));
        return [{ language: "typescript", status: "passed" }, { language: "go", status: "passed" }, { language: "rust", status: "passed" }];
      } });
      expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8"))).toMatchObject({ status: "passed", witnesses });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

});

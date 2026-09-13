import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

type Finding = { kind: string; detail?: string; root: { kind: string; definition: string }; chain: string[]; variable: string };
type ThinViolation = { definition: string; variable: string; chain: string[] };
type Report = {
  main: string;
  modules: string[];
  tableSize: number;
  thinProfile: { kernelModules: string[]; actions: string[]; publicActions: string[]; reachableDefinitions: number; stateAssigningDefinitions: string[]; count: number; violations: ThinViolation[] };
  witnessIsolation: {
    witnessVariables: string[];
    roots: { init: string | null; step: string | null; transitions: string[]; choiceDomains: Array<{ definition: string; choice: string }>; projections: string[]; operatorConstants: Array<{ instance: string; constant: string; definitions: string[] }> };
    count: number;
    violations: Finding[];
  };
};
type Profile = { id: string; model: string };
type Baseline = { schemaVersion: number; quintVersion: string; kernelModules: string[]; profiles: Array<{ id: string; model: string; module: string; tableSize: number; actions: number; reachableDefinitions: number; stateAssigningDefinitions: number; stateAssigningDefinitionNames: string[] }> };
type LintOptions = { main?: string; kernelModules?: string[]; witnessPattern?: string; observationField?: string };
const { lintModel, computeBaseline, checkBaseline, diffBaseline, formatBaseline, baselinePath } =
  await import(new URL("../formal/lint-profiles.mjs", import.meta.url).href) as {
    lintModel(model: string, options?: LintOptions): Promise<Report>;
    computeBaseline(options?: { profiles?: Profile[]; concurrency?: number }): Promise<Baseline>;
    checkBaseline(options?: { cwd?: string; path?: string; profiles?: Profile[]; concurrency?: number }): Promise<{ expected: Baseline; actual: Baseline; differences: string[] }>;
    diffBaseline(expected: unknown, actual: unknown): string[];
    formatBaseline(baseline: Baseline): string;
    baselinePath: string;
  };

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = "test/fixtures/profile-lint";
const fixture = (name: string) => `${fixtures}/${name}.qnt`;
const fixtureNames = [
  "kernel", "kernel-leaky", "profile-clean", "profile-thick", "profile-nested-let", "profile-lambda-assign", "profile-shadow",
  "profile-witness-choice", "profile-witness-projection", "profile-witness-guard", "profile-witness-deep", "profile-witness-domain",
  "profile-witness-input", "profile-witness-match",
];
// Quint's effect checker rejects an operator constant that reads a variable
// (QNT201), so this route can only be shown on the parsed IR; the lint must
// still report it because it is defined over that IR, not over the checker.
const parseOnlyFixtures = ["profile-witness-constant"];
const witness = { witnessPattern: "^witnessed$" };
// The lint parses through the pinned Quint CLI. The TypeScript check lane runs
// without Quint, so the parsing cases skip there and run in the formal lanes.
const quintAvailable = spawnSync("quint", ["--version"], { encoding: "utf8" }).status === 0;
const quintTimeout = 60_000;
const cli = (...args: string[]) => spawnSync(process.execPath, ["formal/lint-profiles.mjs", ...args], { cwd: root, encoding: "utf8" });

describe("profile lint baseline diff", () => {
  const baseline: Baseline = { schemaVersion: 1, quintVersion: "0.32.0", kernelModules: [], profiles: [
    { id: "a", model: "formal/a.qnt", module: "a", tableSize: 10, actions: 2, reachableDefinitions: 3, stateAssigningDefinitions: 1, stateAssigningDefinitionNames: ["init"] },
  ] };
  const clone = () => JSON.parse(JSON.stringify(baseline)) as Baseline;

  it("reports nothing for an identical recomputation", () => {
    expect(diffBaseline(baseline, clone())).toEqual([]);
  });

  it("names the path of every changed leaf", () => {
    const actual = clone();
    actual.profiles[0]!.actions = 3;
    actual.profiles[0]!.stateAssigningDefinitionNames = ["init", "call"];
    expect(diffBaseline(baseline, actual)).toEqual([
      "baseline.profiles[0].actions: expected 2, got 3",
      'baseline.profiles[0].stateAssigningDefinitionNames[1]: unexpected "call"',
    ]);
  });

  it("reports missing and unexpected profiles and keys", () => {
    const actual = clone();
    actual.profiles.push({ ...actual.profiles[0]!, id: "b" });
    delete (actual as Partial<Baseline>).kernelModules;
    (actual as Baseline & { extra?: number }).extra = 1;
    const differences = diffBaseline(baseline, actual);
    expect(differences).toContain("baseline.kernelModules: missing []");
    expect(differences).toContain("baseline.extra: unexpected 1");
    expect(differences.some(line => line.startsWith("baseline.profiles[1]: unexpected "))).toBe(true);
    expect(diffBaseline(baseline, { ...clone(), profiles: [] })).toEqual([`baseline.profiles[0]: missing ${JSON.stringify(baseline.profiles[0])}`]);
  });
});

describe.skipIf(!quintAvailable)("profile lint over synthetic kernel instances", () => {
  it("typechecks every fixture with quint and runs every profile fixture", () => {
    for (const name of fixtureNames) {
      const result = spawnSync("quint", ["typecheck", fixture(name)], { cwd: root, encoding: "utf8" });
      expect(result.status, `${name}: ${result.stderr}${result.stdout}`).toBe(0);
      if (!name.startsWith("profile-")) continue;
      const run = spawnSync("quint", ["run", "--max-samples=3", "--max-steps=4", fixture(name)], { cwd: root, encoding: "utf8" });
      expect(run.status, `${name}: ${run.stderr}${run.stdout}`).toBe(0);
    }
    for (const name of parseOnlyFixtures) {
      expect(spawnSync("quint", ["parse", fixture(name)], { cwd: root, encoding: "utf8" }).status, name).toBe(0);
      const result = spawnSync("quint", ["typecheck", fixture(name)], { cwd: root, encoding: "utf8" });
      expect(result.status, name).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`, name).toMatch(/QNT201/);
    }
  }, quintTimeout * 3);

  it("accepts the clean instance under both rules and lists the roots it examined", async () => {
    const report = await lintModel(fixture("profile-clean"), { kernelModules: ["kernel"], ...witness });
    expect(report.main).toBe("profile_clean");
    expect(report.thinProfile.publicActions).toEqual(["init", "bumpWrapper", "resetWrapper", "step"]);
    expect(report.thinProfile.stateAssigningDefinitions).toEqual(["kernel::bump", "kernel::init", "kernel::reset"]);
    expect(report.thinProfile.violations).toEqual([]);
    expect(report.witnessIsolation.witnessVariables).toEqual(["kernel::witnessed"]);
    expect(report.witnessIsolation.violations).toEqual([]);
    expect(report.witnessIsolation.roots).toEqual({
      init: "init", step: "step",
      transitions: ["kernel::bump", "kernel::init", "kernel::reset"],
      choiceDomains: [{ definition: "bumpWrapper", choice: "choice" }],
      projections: ["kernel::bump", "kernel::init", "kernel::reset"],
      operatorConstants: [{ instance: "K", constant: "CAPACITY", definitions: [] }, { instance: "K", constant: "PROJECT", definitions: ["project"] }],
    });
  }, quintTimeout);

  it("treats every kernel assignment as private when no kernel module is named", async () => {
    const report = await lintModel(fixture("profile-clean"), witness);
    expect(report.thinProfile.kernelModules).toEqual([]);
    expect(report.thinProfile.count).toBe(12);
    expect(report.thinProfile.violations).toContainEqual({ definition: "kernel::bump", variable: "kernel::count", chain: ["bumpWrapper", "kernel::bump"] });
    expect(report.thinProfile.violations).toContainEqual({ definition: "kernel::init", variable: "kernel::o", chain: ["init", "kernel::init"] });
    expect(report.witnessIsolation.violations).toEqual([]);
  }, quintTimeout);

  it("reports private transition logic with the chain wrapper -> helper -> assignment", async () => {
    const report = await lintModel(fixture("profile-thick"), { kernelModules: ["kernel"], ...witness });
    expect(report.thinProfile.publicActions).toEqual(["init", "bumpWrapper", "step"]);
    expect(report.thinProfile.actions).toEqual(["bumpWrapper", "decide", "init", "step"]);
    expect(report.thinProfile.violations).toEqual([
      { definition: "decide", variable: "decided", chain: ["bumpWrapper", "decide"] },
      { definition: "decide", variable: "kernel::count", chain: ["bumpWrapper", "decide"] },
      { definition: "decide", variable: "kernel::input", chain: ["bumpWrapper", "decide"] },
      { definition: "decide", variable: "kernel::o", chain: ["bumpWrapper", "decide"] },
      { definition: "decide", variable: "kernel::witnessed", chain: ["bumpWrapper", "decide"] },
      { definition: "init", variable: "decided", chain: ["init"] },
    ]);
    // Reassigning witness state from prior witness state is the monitor's own
    // accumulation, not feedback.
    expect(report.witnessIsolation.violations).toEqual([]);
  }, quintTimeout);

  it("names the choice domain when a nondet filters on witness state behind a helper in a lambda", async () => {
    const report = await lintModel(fixture("profile-witness-choice"), { kernelModules: ["kernel"], ...witness });
    expect(report.thinProfile.violations).toEqual([]);
    expect(report.witnessIsolation.violations).toEqual([
      { kind: "choice domain", detail: "choice", root: { kind: "step", definition: "step" }, chain: ["step", "bumpWrapper", "allowed"], variable: "kernel::witnessed" },
    ]);
  }, quintTimeout);

  it("names the projection when the observation field is computed from witness state", async () => {
    const report = await lintModel(fixture("profile-witness-projection"), { kernelModules: ["kernel_leaky"], ...witness });
    expect(report.thinProfile.violations).toEqual([]);
    expect(report.witnessIsolation.roots.projections).toEqual(["kernel_leaky::bump", "kernel_leaky::init", "kernel_leaky::reset"]);
    expect(report.witnessIsolation.violations).toEqual([
      { kind: "projection", detail: "o", root: { kind: "step", definition: "step" }, chain: ["step", "bumpWrapper", "kernel_leaky::bump"], variable: "kernel_leaky::witnessed" },
      { kind: "projection", detail: "o", root: { kind: "step", definition: "step" }, chain: ["step", "resetWrapper", "kernel_leaky::reset"], variable: "kernel_leaky::witnessed" },
    ]);
  }, quintTimeout);

  it("names the guard when a transition is enabled by witness state through a helper", async () => {
    const report = await lintModel(fixture("profile-witness-guard"), { kernelModules: ["kernel"], ...witness });
    expect(report.thinProfile.violations).toEqual([]);
    expect(report.witnessIsolation.violations).toEqual([
      { kind: "guard", root: { kind: "step", definition: "step" }, chain: ["step", "bumpWrapper", "unlabeled"], variable: "kernel::witnessed" },
    ]);
  }, quintTimeout);

  it("attributes an assignment made by a nested definition to the helper that binds it", async () => {
    const report = await lintModel(fixture("profile-nested-let"), { kernelModules: ["kernel"], ...witness });
    expect(report.thinProfile.stateAssigningDefinitions).toEqual(["kernel::init", "settle"]);
    expect(report.thinProfile.violations).toEqual(["kernel::count", "kernel::input", "kernel::o", "kernel::witnessed"].map(variable =>
      ({ definition: "settle", variable, chain: ["bumpWrapper", "settle"] })));
    expect(report.witnessIsolation.violations).toEqual([]);
  }, quintTimeout);

  it("attributes an assignment inside a lambda argument to the wrapper that writes the lambda", async () => {
    const report = await lintModel(fixture("profile-lambda-assign"), { kernelModules: ["kernel"], ...witness });
    expect(report.thinProfile.stateAssigningDefinitions).toEqual(["bumpWrapper", "kernel::init"]);
    expect(report.thinProfile.violations).toEqual(["kernel::count", "kernel::input", "kernel::o", "kernel::witnessed"].map(variable =>
      ({ definition: "bumpWrapper", variable, chain: ["bumpWrapper"] })));
    expect(report.witnessIsolation.violations).toEqual([]);
  }, quintTimeout);

  it("resolves by declaration, not by name, when the profile shadows kernel definitions", async () => {
    const report = await lintModel(fixture("profile-shadow"), { kernelModules: ["kernel"], ...witness });
    expect(report.thinProfile.publicActions).toEqual(["init", "viaKernel", "viaLocal", "step"]);
    expect(report.thinProfile.stateAssigningDefinitions).toEqual(["bump", "kernel::bump", "kernel::init"]);
    // Only the profile's own `bump` is private; `K::bump` through the instance is kernel logic.
    expect(report.thinProfile.violations).toEqual(["kernel::count", "kernel::input", "kernel::o", "kernel::witnessed"].map(variable =>
      ({ definition: "bump", variable, chain: ["viaLocal", "bump"] })));
    // Only the profile's own `room` reads witness state; `K::room` is the kernel's pure guard.
    expect(report.witnessIsolation.violations).toEqual([
      { kind: "guard", root: { kind: "step", definition: "step" }, chain: ["step", "viaLocal", "room"], variable: "kernel::witnessed" },
    ]);
  }, quintTimeout);

  it("follows a guard two pure calls deep and through an operator argument", async () => {
    const report = await lintModel(fixture("profile-witness-deep"), { kernelModules: ["kernel"], ...witness });
    expect(report.thinProfile.violations).toEqual([]);
    expect(report.witnessIsolation.violations).toEqual([
      { kind: "guard", root: { kind: "step", definition: "step" }, chain: ["step", "bumpWrapper", "screen", "blocked"], variable: "kernel::witnessed" },
    ]);
  }, quintTimeout);

  it("names the choice domain when a helper computes the set the nondet draws from", async () => {
    const report = await lintModel(fixture("profile-witness-domain"), { kernelModules: ["kernel"], ...witness });
    expect(report.thinProfile.violations).toEqual([]);
    expect(report.witnessIsolation.violations).toEqual([
      { kind: "choice domain", detail: "choice", root: { kind: "step", definition: "step" }, chain: ["step", "bumpWrapper", "domain"], variable: "kernel::witnessed" },
    ]);
  }, quintTimeout);

  it("reports witness state flowing into a kernel action's input under the step root itself", async () => {
    const report = await lintModel(fixture("profile-witness-input"), { kernelModules: ["kernel"], ...witness });
    expect(report.thinProfile.violations).toEqual([]);
    expect(report.witnessIsolation.violations).toEqual([
      { kind: "step", root: { kind: "step", definition: "step" }, chain: ["step", "bumpWrapper"], variable: "kernel::witnessed" },
    ]);
  }, quintTimeout);

  it("treats the scrutinee of a match over kernel actions as a guard", async () => {
    const report = await lintModel(fixture("profile-witness-match"), { kernelModules: ["kernel"], ...witness });
    expect(report.thinProfile.violations).toEqual([]);
    expect(report.witnessIsolation.violations).toEqual([
      { kind: "guard", root: { kind: "step", definition: "step" }, chain: ["step", "bumpWrapper", "mode"], variable: "kernel::witnessed" },
    ]);
  }, quintTimeout);

  it("names the operator constant when the projection bound at instantiation reads witness state", async () => {
    const report = await lintModel(fixture("profile-witness-constant"), { kernelModules: ["kernel"], witnessPattern: "^seen$" });
    expect(report.witnessIsolation.witnessVariables).toEqual(["seen"]);
    expect(report.witnessIsolation.roots.operatorConstants).toEqual([
      { instance: "K", constant: "CAPACITY", definitions: [] }, { instance: "K", constant: "PROJECT", definitions: ["project"] },
    ]);
    expect(report.witnessIsolation.violations).toEqual([
      { kind: "operator constant", root: { kind: "operator constant", definition: "K.PROJECT" }, chain: ["K.PROJECT", "project", "label"], variable: "seen" },
      { kind: "projection", detail: "kernel::o", root: { kind: "init", definition: "init" }, chain: ["init", "kernel::init", "K.PROJECT", "project", "label"], variable: "seen" },
    ]);
    // The profile-local witness variable is also state the profile assigns itself.
    expect(report.thinProfile.violations).toEqual([
      { definition: "bumpWrapper", variable: "seen", chain: ["bumpWrapper"] },
      { definition: "init", variable: "seen", chain: ["init"] },
    ]);
  }, quintTimeout);

  it("checks witness isolation only for the variables the pattern selects", async () => {
    for (const name of ["profile-witness-choice", "profile-witness-projection", "profile-witness-guard"]) {
      const report = await lintModel(fixture(name), { kernelModules: ["kernel", "kernel_leaky"] });
      expect(report.witnessIsolation.witnessVariables, name).toEqual([]);
      expect(report.witnessIsolation.violations, name).toEqual([]);
    }
    const scoped = await lintModel(fixture("profile-witness-guard"), { kernelModules: ["kernel"], witnessPattern: "^kernel::witnessed$" });
    expect(scoped.witnessIsolation.witnessVariables).toEqual(["kernel::witnessed"]);
    expect(scoped.witnessIsolation.count).toBe(1);
  }, quintTimeout * 2);

  it("exits non-zero from the CLI exactly when a rule is violated", () => {
    const clean = cli(fixture("profile-clean"), "--kernel=kernel", "--witness=^witnessed$");
    expect(clean.status, clean.stderr).toBe(0);
    expect((JSON.parse(clean.stdout) as Report).thinProfile.count).toBe(0);
    const thick = cli(fixture("profile-thick"), "--kernel=kernel");
    expect(thick.status).toBe(1);
    expect((JSON.parse(thick.stdout) as Report).thinProfile.count).toBe(6);
    const guard = cli(fixture("profile-witness-guard"), "--kernel=kernel", "--witness=^witnessed$");
    expect(guard.status).toBe(1);
    expect((JSON.parse(guard.stdout) as Report).witnessIsolation.violations.map(finding => finding.kind)).toEqual(["guard"]);
  }, quintTimeout * 2);

  it("fails clearly when quint cannot parse the model", async () => {
    await expect(lintModel(`${fixtures}/missing.qnt`)).rejects.toThrow(/quint parse .*missing\.qnt failed/);
  }, quintTimeout);
});

describe.skipIf(!quintAvailable)("profile lint baseline", () => {
  const temporary = mkdtempSync(join(tmpdir(), "profile-lint-baseline-"));
  afterAll(() => rmSync(temporary, { recursive: true, force: true }));

  it("matches the committed baseline for every conformance profile", async () => {
    const { expected, actual, differences } = await checkBaseline();
    expect(differences).toEqual([]);
    expect(actual.profiles.length).toBe(15);
    expect(expected.kernelModules).toEqual([]);
    // With no kernel every reachable assignment is private, so the named
    // definitions are exactly the migration work list.
    for (const profile of actual.profiles) {
      expect(profile.stateAssigningDefinitionNames.length, profile.id).toBe(profile.stateAssigningDefinitions);
      expect(profile.stateAssigningDefinitions, profile.id).toBeGreaterThan(0);
      expect(profile.reachableDefinitions, profile.id).toBeGreaterThanOrEqual(profile.actions);
    }
  }, 180_000);

  it("reports drift against a stale baseline with the changed paths", async () => {
    const profiles = [{ id: "clean", model: fixture("profile-clean") }, { id: "thick", model: fixture("profile-thick") }];
    const fresh = await computeBaseline({ profiles, concurrency: 1 });
    expect(fresh.profiles.map(profile => [profile.id, profile.module, profile.actions, profile.stateAssigningDefinitionNames])).toEqual([
      ["clean", "profile_clean", 4, ["kernel::bump", "kernel::init", "kernel::reset"]],
      ["thick", "profile_thick", 4, ["decide", "init", "kernel::init"]],
    ]);
    const stale = JSON.parse(JSON.stringify(fresh)) as Baseline;
    stale.profiles[1]!.stateAssigningDefinitionNames = ["init", "kernel::init"];
    stale.profiles[1]!.stateAssigningDefinitions = 2;
    stale.profiles[0]!.tableSize += 1;
    const path = join(temporary, "baseline.json");
    writeFileSync(path, formatBaseline(stale));
    const { differences } = await checkBaseline({ path, profiles, concurrency: 1 });
    expect(differences).toEqual([
      `baseline.profiles[0].tableSize: expected ${stale.profiles[0]!.tableSize}, got ${fresh.profiles[0]!.tableSize}`,
      "baseline.profiles[1].stateAssigningDefinitions: expected 2, got 3",
      'baseline.profiles[1].stateAssigningDefinitionNames[0]: expected "init", got "decide"',
      'baseline.profiles[1].stateAssigningDefinitionNames[1]: expected "kernel::init", got "init"',
      'baseline.profiles[1].stateAssigningDefinitionNames[2]: unexpected "kernel::init"',
    ]);
    writeFileSync(path, formatBaseline(fresh));
    expect((await checkBaseline({ path, profiles, concurrency: 1 })).differences).toEqual([]);
  }, 120_000);

  it("passes baseline --check from the CLI on the committed file", () => {
    const result = cli("baseline", "--check");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${baselinePath} matches 15 profiles`);
  }, 180_000);
});

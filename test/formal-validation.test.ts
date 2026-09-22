import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Step = {
  label: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdoutFile?: string;
  requireEmptyStdout?: boolean;
  remove?: string[];
  requireFile?: string;
  failureHint?: string;
};
type Options = { directory?: string; environment?: NodeJS.ProcessEnv; runnerNode?: string; nodeVersion?: string };
const { validationPlan, executeSteps, checkPrerequisites, cleanEnvironment, targetDescriptions } = await import(
  new URL("../formal/validation.mjs", import.meta.url).href,
) as {
  validationPlan(target: string, options?: Options): Step[];
  executeSteps(steps: Step[], options?: Options & { log?: (message: string) => void }): Promise<void>;
  checkPrerequisites(target: string, options?: Options): void;
  cleanEnvironment(environment: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  targetDescriptions: Record<string, string>;
};

describe("shared validation runner", () => {
  let directory: string;
  let child: string;
  let environment: NodeJS.ProcessEnv;
  const put = (path: string, text: string) => writeFileSync(join(directory, path), text);
  const events = () => readFileSync(join(directory, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as {
    label: string; cwd: string; selected: Record<string, string>; path: string; retained: string;
  });
  const fakeTool = (name: string, body: string) => {
    const path = join(directory, "bin", name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const run = (steps: Step[]) => executeSteps(steps, { directory, environment, log: () => undefined });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dialcache-validation-"));
    for (const path of ["bin", "formal", "dist", "node_modules/typescript", "rust"]) mkdirSync(join(directory, path), { recursive: true });
    child = join(directory, "child.mjs");
    put("child.mjs", `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.RUNNER_EVENTS, JSON.stringify({ label: process.argv[2], cwd: process.cwd(),
  selected: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('DIALCACHE_') || key === 'QUINT_SEED')),
  path: process.env.PATH, retained: process.env.RUNNER_RETAINED }) + '\\n');
if (process.argv[4]) process.stdout.write(process.argv[4]);
process.exit(Number(process.argv[3] ?? 0));\n`);
    environment = { ...process.env, RUNNER_EVENTS: join(directory, "events.jsonl"), RUNNER_RETAINED: "caller-owned",
      DIALCACHE_MBT_TRACE_FILE: "/unrelated/one-file.json", DIALCACHE_FEATURE_TRACE_DIR: "/unrelated/corpus",
      DIALCACHE_PROTOCOL_CORPUS: "fixed", DIALCACHE_WITNESS_EVIDENCE_DIR: "/unrelated/witnesses", QUINT_SEED: "0xbad" };
    delete environment.NODE22_BIN;
    put("package.json", '{"packageManager":"pnpm@10.33.0"}');
    put("node_modules/typescript/package.json", "{}");
    put("formal/generated-fixtures.lock.json", '{"quintVersion":"0.32.0"}');
    fakeTool("corepack", 'console.log("10.33.0")');
    fakeTool("go", 'console.log("go version go1.27.1 test/test")');
    fakeTool("cargo", 'console.log("cargo 1.98.1 (test 2026-08-05)")');
    environment.PYTHON = fakeTool("python", 'if (process.argv.includes("--version")) console.log("Python 3.11.14")');
    fakeTool("quint", 'console.log("0.32.0")');
    fakeTool("java", 'console.log("openjdk 21.0.11")');
    fakeTool("tar", 'console.log("bsdtar 3.5.3")');
    fakeTool("docker", 'console.log("running")');
    environment.PATH = `${join(directory, "bin")}${delimiter}${process.env.PATH ?? ""}`;
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("removes inherited replay selectors but passes the planned full-corpus environment to real children", async () => {
    const complete = validationPlan("formal", { directory, environment }).find(step => step.label === "Replay complete Go corpus with race detection")!;
    await run([
      { label: "default", command: process.execPath, args: [child, "default"] },
      { label: "full", command: process.execPath, args: [child, "full"], env: complete.env! },
    ]);
    const [ordinary, full] = events();
    expect(ordinary).toMatchObject({ cwd: realpathSync(directory), selected: {}, retained: "caller-owned" });
    expect(full!.selected).toEqual({
      DIALCACHE_MBT_TRACE_DIR: join(directory, ".formal-traces/conformance"),
      DIALCACHE_EFFECTS_TRACE_DIR: join(directory, ".formal-traces/effects"),
      DIALCACHE_FEATURE_TRACE_DIR: join(directory, ".formal-traces/features"),
      DIALCACHE_WITNESS_EVIDENCE_DIR: join(directory, ".formal-traces/go-parity-witnesses"),
    });
  });

  it("runs a step inside its declared directory and every other step at the checkout root", async () => {
    await run([
      { label: "root", command: process.execPath, args: [child, "root"] },
      { label: "crate", command: process.execPath, args: [child, "crate"], cwd: "rust" },
    ]);
    const [root, crate] = events();
    expect(root!.cwd).toBe(realpathSync(directory));
    expect(crate!.cwd).toBe(realpathSync(join(directory, "rust")));
  });

  it("excludes only opt-in Go workers from complete replay and exploration", async () => {
    const { loadGoReplayInventory } = await import(new URL("../formal/check-go-replay.mjs", import.meta.url).href) as {
      loadGoReplayInventory(): { required: Array<{ name: string }> };
    };
    const { explorationPlan } = await import(new URL("../formal/explore.mjs", import.meta.url).href) as {
      explorationPlan(directory: string, seed: string): Step[];
    };
    const goTest = (step: Step) => step.command === "go" && step.args?.includes("test");
    const replay = validationPlan("formal-go", { directory }).find(goTest)!;
    expect(replay.args).toContain("-skip");
    const skipped = new RegExp(replay.args![replay.args!.indexOf("-skip") + 1]!);
    for (const worker of ["TestGeneratedInvalidationVectors", "TestVectorBoundaryDriver", "TestDocsTrackedInvalidation"]) {
      expect(skipped.test(worker), worker).toBe(true);
      expect(skipped.test(`${worker}Required`), worker).toBe(false);
      expect(skipped.test(`Other${worker}`), worker).toBe(false);
    }
    // Check the real inventory so adding a required corpus root cannot
    // silently inherit a worker exclusion.
    const requiredRoots = [...new Set(loadGoReplayInventory().required.map(entry => entry.name.split("/")[0]!))];
    expect(requiredRoots.filter(name => skipped.test(name))).toEqual([]);
    expect(explorationPlan(directory, "0x1").find(goTest)!.args)
      .toEqual(replay.args);
    for (const target of ["check-go", "smoke"]) {
      expect(validationPlan(target, { directory }).find(goTest)!.args, target)
        .not.toContain("-skip");
    }
  });

  it("stops at a failing child and preserves its partial native report without running later steps", async () => {
    const steps: Step[] = [
      { label: "first", command: process.execPath, args: [child, "first"] },
      { label: "failed native replay", command: process.execPath, args: [child, "failure", "7", "partial report\n"], stdoutFile: ".formal-traces/report.jsonl", failureHint: "Run the prerequisite first." },
      { label: "must not run", command: process.execPath, args: [child, "after"] },
    ];
    await expect(run(steps)).rejects.toThrow(/failed native replay failed \(exit 7\).*Run the prerequisite first/);
    expect(events().map(event => event.label)).toEqual(["first", "failure"]);
    expect(readFileSync(join(directory, ".formal-traces/report.jsonl"), "utf8")).toBe("partial report\n");
  });

  it("rejects formatting output even when the formatting command exits successfully", async () => {
    await expect(run([{ label: "formatting", command: process.execPath, args: [child, "format", "0", "go/cache.go\n"], requireEmptyStdout: true }]))
      .rejects.toThrow(/files requiring formatting:\ngo\/cache.go/);
  });

  it("orders generation and shared witness evaluation before every port replay without duplicate wire generation", () => {
    const plan = validationPlan("formal", { directory });
    const position = (script: string, argument: string) => plan.findIndex(step => step.args?.[0] === script && step.args.includes(argument));
    const tsPrepare = position("formal/conformance.mjs", "typescript");
    const goPrepare = position("formal/conformance.mjs", "go");
    const rustPrepare = position("formal/conformance.mjs", "rust");
    const goCompletion = position("formal/conformance.mjs", ".formal-traces/go-completion.json");
    const rustCompletion = position("formal/conformance.mjs", ".formal-traces/rust-completion.json");
    const tsCompletion = position("formal/conformance.mjs", ".formal-traces/ts-completion.json");
    const witnesses = position("formal/witnesses.mjs", "evaluate");
    expect(position("formal/run-models.mjs", "check")).toBeLessThan(position("formal/run-models.mjs", "generate"));
    expect(position("formal/run-models.mjs", "generate")).toBeLessThan(witnesses);
    expect(witnesses).toBeLessThan(tsPrepare);
    expect(tsPrepare).toBeLessThan(tsCompletion);
    expect(tsCompletion).toBeLessThan(goPrepare);
    expect(goPrepare).toBeLessThan(goCompletion);
    expect(goCompletion).toBeLessThan(rustPrepare);
    expect(rustPrepare).toBeLessThan(rustCompletion);
    expect(plan.filter(step => step.args?.[0] === "formal/run-models.mjs" && step.args[1] === "generate")).toHaveLength(1);
    expect(plan.filter(step => step.args?.[0] === "formal/witnesses.mjs")).toHaveLength(1);
    expect(plan.some(step => step.args?.[0] === "formal/generate-artifacts.mjs")).toBe(false);
    expect(plan[0]!.args).toEqual(["formal/run-models.mjs", "check"]);
    expect(plan.find(step => step.remove)!.remove).toEqual([".formal-traces/ts-completion.json", ".formal-traces/go-completion.json", ".formal-traces/rust-completion.json", ".formal-traces/python-completion.json"]);
    // The aggregate is exactly these lanes in order, so a CI job running
    // one lane executes the same steps as the local sequential run.
    expect(plan).toEqual(["formal-check", "formal-generate", "formal-ts", "formal-go", "formal-rust", "formal-python"].flatMap(target => validationPlan(target, { directory })));
  });

  it("keeps the model check as its own lane that produces nothing the port lanes consume", () => {
    // The check (typechecks, bounded runs, regressions and challenges) is
    // evidence about Quint; generation is the only producer downstream reads.
    expect(validationPlan("formal-check", { directory })).toEqual([
      { label: "Check every scheduled Quint model", command: process.execPath, args: ["formal/run-models.mjs", "check"] },
      { label: "Measure every pinned model fault", command: process.execPath, args: ["formal/check-model-properties.mjs"] },
      { label: "Check the profile lint baseline", command: process.execPath, args: ["formal/lint-profiles.mjs", "baseline", "--check"] },
      { label: "Check the kernel library fixtures", command: process.execPath, args: ["formal/check-kernel-fixtures.mjs"] },
    ]);
    const generate = validationPlan("formal-generate", { directory });
    expect(generate.some(step => step.args?.[0] === "formal/run-models.mjs" && step.args[1] === "check")).toBe(false);
    expect(generate.some(step => step.args?.[0] === "formal/check-model-properties.mjs")).toBe(false);
    for (const target of ["formal-ts", "formal-go", "formal-rust", "formal-python", "mutations"]) {
      expect(validationPlan(target, { directory }).some(step => step.args?.[0] === "formal/run-models.mjs")).toBe(false);
    }
    // Every acceptance entry point keeps one complete campaign, after all
    // unmodified model checks. No filtered --only run can replace that gate.
    for (const target of ["formal-check", "formal", "ci"]) {
      const plan = validationPlan(target, { directory });
      const checks = plan.filter(step => step.args?.[0] === "formal/run-models.mjs" && step.args[1] === "check");
      const campaigns = plan.filter(step => step.args?.[0] === "formal/check-model-properties.mjs");
      expect(checks, target).toHaveLength(1);
      expect(campaigns.map(step => step.args), target).toEqual([["formal/check-model-properties.mjs"]]);
      expect(plan.indexOf(checks[0]!), target).toBeLessThan(plan.indexOf(campaigns[0]!));
    }
  });


  it("gates composition in the differential lane: the lint baseline, then both-direction replay against the configured reference", () => {
    expect(validationPlan("differential", { directory, environment: { ...environment, DIFFERENTIAL_REFERENCE: "origin/release" } })).toEqual([
      { label: "Check the profile lint baseline", command: process.execPath, args: ["formal/lint-profiles.mjs", "baseline", "--check"] },
      { label: "Check the kernel library fixtures", command: process.execPath, args: ["formal/check-kernel-fixtures.mjs"] },
      { label: "Replay composed profiles against their reference corpus", command: process.execPath, args: ["formal/differential.mjs", "--composed", "--reference=origin/release"] },
    ]);
    expect(validationPlan("differential", { directory, environment }).at(-1)!.args).toEqual(["formal/differential.mjs", "--composed", "--reference=origin/main"]);
    // DIFFERENTIAL_SHARD narrows the replay to one shard, keeps the two cheap checks in every shard, and is validated as the script parses it.
    const sharded = validationPlan("differential", { directory, environment: { ...environment, DIFFERENTIAL_SHARD: "2/4" } });
    expect(sharded.map(step => step.args)).toEqual([["formal/lint-profiles.mjs", "baseline", "--check"], ["formal/check-kernel-fixtures.mjs"],
      ["formal/differential.mjs", "--composed", "--reference=origin/main", "--shard=2/4"]]);
    expect(validationPlan("differential", { directory, environment }).flatMap(step => step.args ?? []).some(argument => argument.startsWith("--shard"))).toBe(false);
    for (const value of ["0/4", "5/4", "2", "a/b", ""]) {
      expect(() => validationPlan("differential", { directory, environment: { ...environment, DIFFERENTIAL_SHARD: value } }), value).toThrow(/DIFFERENTIAL_SHARD must be <index>\/<count>/);
    }
    // Other targets ignore the variable, even a malformed one: no aggregate includes the differential.
    for (const target of ["check-ts", "formal-check", "ci"]) {
      expect(validationPlan(target, { directory, environment: { ...environment, DIFFERENTIAL_SHARD: "9/1" } }), target).toEqual(validationPlan(target, { directory, environment }));
    }
    expect(targetDescriptions.differential).toMatch(/DIFFERENTIAL_SHARD=<index>\/<count>/);
  });
  it("ends generation with the shared witness evaluation and starts each replay lane from a prepared context", () => {
    const generate = validationPlan("formal-generate", { directory });
    expect(generate.at(-1)!.args).toEqual(["formal/witnesses.mjs", "evaluate", "--profile", "all"]);
    expect(generate.map(step => step.args?.slice(0, 2))).toEqual([undefined, ["formal/run-models.mjs", "generate"],
      ["formal/generated-fixtures.mjs", "--check"], ["formal/witnesses.mjs", "evaluate"]]);
    expect(generate.some(step => step.args?.[0] === "formal/conformance.mjs")).toBe(false);
    expect(generate.some(step => step.command === "corepack" || step.command === "go")).toBe(false);
    const ts = validationPlan("formal-ts", { directory });
    expect(ts[0]!.remove).toEqual([".formal-traces/ts-completion.json"]);
    expect(ts[1]!.args).toEqual(["formal/conformance.mjs", "prepare", "typescript", ".formal-traces/ts-context.json"]);
    expect(ts.at(-1)!.args).toEqual(["formal/conformance.mjs", "check", ".formal-traces/ts-completion.json", ".formal-traces/ts-context.json"]);
    expect(ts.some(step => step.args?.[0] === "formal/witnesses.mjs" || step.args?.[0] === "formal/run-models.mjs")).toBe(false);
  });

  it("replays Rust from its crate with full corpus selectors and a dedicated report before the completion gate", () => {
    const plan = validationPlan("formal-rust", { directory, environment });
    expect(plan[0]!.remove).toEqual([".formal-traces/rust-completion.json"]);
    expect(plan[1]!.args).toEqual(["formal/conformance.mjs", "prepare", "rust", ".formal-traces/rust-context.json"]);
    const replay = plan.find(step => step.command === "cargo")!;
    expect(replay).toMatchObject({ cwd: "rust", args: ["test", "--release", "--all-features", "--test", "conformance"] });
    expect(replay.env).toEqual({
      DIALCACHE_MBT_TRACE_DIR: join(directory, ".formal-traces/conformance"),
      DIALCACHE_EFFECTS_TRACE_DIR: join(directory, ".formal-traces/effects"),
      DIALCACHE_FEATURE_TRACE_DIR: join(directory, ".formal-traces/features"),
      DIALCACHE_WITNESS_EVIDENCE_DIR: join(directory, ".formal-traces/go-parity-witnesses"),
      DIALCACHE_RUST_REPORT: join(directory, ".formal-traces/rust-replay.jsonl"),
    });
    expect(plan.slice(plan.indexOf(replay) + 1).map(step => step.args)).toEqual([
      ["formal/check-rust-replay.mjs"],
      ["formal/conformance-adapters.mjs", "rust", ".formal-traces/rust-replay.jsonl", ".formal-traces/rust-context.json"],
      ["formal/conformance.mjs", "check", ".formal-traces/rust-completion.json", ".formal-traces/rust-context.json"],
    ]);
    const smoke = validationPlan("smoke", { directory }).find(step => step.command === "cargo")!;
    expect(smoke.args).toEqual(["test", "--all-features", "--test", "conformance"]);
    expect(smoke.env).toBeUndefined();
  });

  it("runs Python from its prepared interpreter and checks complete evidence after replay", () => {
    const native = validationPlan("check-python", { directory, environment });
    expect(native).toEqual([{
      label: "Run Python native, wire, scenario and smoke tests", command: environment.PYTHON,
      args: ["-m", "pytest", "python/tests", "-m", "not integration"], env: { NODE: process.execPath },
    }]);
    const plan = validationPlan("formal-python", { directory, environment });
    expect(plan[0]!.remove).toEqual([".formal-traces/python-completion.json"]);
    expect(plan[1]!.args).toEqual(["formal/conformance.mjs", "prepare", "python", ".formal-traces/python-context.json"]);
    expect(plan[2]!.args).toEqual(["formal/run-python-replay.mjs", "--generated", "--scenarios", "--complete", "--report", ".formal-traces/python-replay.jsonl"]);
    expect(plan[2]!.env).toEqual({ PYTHON: environment.PYTHON });
    expect(plan.at(-1)!.args).toEqual(["formal/conformance.mjs", "check", ".formal-traces/python-completion.json", ".formal-traces/python-context.json"]);
    expect(validationPlan("smoke", { directory, environment }).at(-1)!.args).toEqual(["-m", "pytest", "python/tests/test_conformance.py"]);
    expect(validationPlan("integration-python", { directory, environment })[0]!.args).toEqual(["formal/run-python-integration.mjs"]);
  });

  it("requires the Python floor and dependencies only for the Python lanes", () => {
    environment.PYTHON = fakeTool("python", 'console.log("Python 3.10.16")');
    for (const target of ["check-python", "formal-python", "integration-python", "smoke", "check"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" }), target).toThrow(/Python 3.11 or later/);
    }
    expect(() => checkPrerequisites("formal-rust", { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
    environment.PYTHON = fakeTool("python", 'if (process.argv.includes("--version")) console.log("Python 3.14.7"); else { console.error("missing pytest"); process.exit(1); }');
    expect(() => checkPrerequisites("check-python", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/missing pytest/);
  });

  it("lets Go parity and every mutation measurement run off the generated corpus without completion checks", () => {
    const isCompletionCheck = (step: Step) => step.args?.[0] === "formal/conformance.mjs" && step.args[1] === "check";
    const go = validationPlan("formal-go", { directory });
    expect(go[0]!.remove).toEqual([".formal-traces/go-completion.json"]);
    expect(go.some(step => step.args?.some(argument => argument.startsWith(".formal-traces/ts-")))).toBe(false);
    expect(go.filter(isCompletionCheck).map(step => step.args)).toEqual([["formal/conformance.mjs", "check", ".formal-traces/go-completion.json", ".formal-traces/go-context.json"]]);
    expect(go.some(step => step.args?.[0] === "formal/witnesses.mjs" || step.args?.[0] === "formal/run-models.mjs")).toBe(false);
    for (const [target, script] of [["mutations-ts", "formal/measure-semantics.mjs"], ["mutations-go", "formal/measure-go-semantics.mjs"], ["mutations-rust", "formal/measure-rust-semantics.mjs"]] as const) {
      expect(validationPlan(target, { directory }).map(step => step.args)).toEqual([[script]]);
    }
    const all = validationPlan("mutations", { directory });
    expect(all.map(step => step.args?.[0])).toEqual(["formal/measure-semantics.mjs", "formal/measure-go-semantics.mjs", "formal/measure-rust-semantics.mjs"]);
    expect(all.some(isCompletionCheck)).toBe(false);
    expect(all.some(step => step.remove || step.args?.[0] === "formal/run-models.mjs")).toBe(false);
  });

  it("shards a mutation lane only through MUTATION_SHARD on its own target and validates the value", () => {
    const sharded = { ...environment, MUTATION_SHARD: "2/3" };
    expect(validationPlan("mutations-ts", { directory, environment: sharded })).toEqual([
      { label: "Measure TypeScript semantic mutations", command: process.execPath, args: ["formal/measure-semantics.mjs", "--shard=2/3"] },
    ]);
    expect(validationPlan("mutations-go", { directory, environment: sharded }).map(step => step.args)).toEqual([["formal/measure-go-semantics.mjs", "--shard=2/3"]]);
    expect(validationPlan("mutations-rust", { directory, environment: sharded }).map(step => step.args)).toEqual([["formal/measure-rust-semantics.mjs", "--shard=2/3"]]);
    // Unset, the plan is exactly today's complete measurement.
    expect(validationPlan("mutations-ts", { directory, environment }).map(step => step.args)).toEqual([["formal/measure-semantics.mjs"]]);
    for (const value of ["0/3", "4/3", "1/0", "a/b", "1", "01/3", "1/3/", " 1/3", ""]) {
      expect(() => validationPlan("mutations-ts", { directory, environment: { ...environment, MUTATION_SHARD: value } }), value).toThrow(/MUTATION_SHARD must be <index>\/<count>/);
    }
    // The aggregates stay unsharded and refuse to ignore the variable silently; unrelated targets ignore it.
    for (const target of ["mutations", "ci"]) {
      expect(() => validationPlan(target, { directory, environment: sharded }), target).toThrow(/MUTATION_SHARD=2\/3 applies only to make mutations-ts, make mutations-go and make mutations-rust/);
    }
    for (const target of ["check", "formal", "formal-ts", "mutations-merge-ts", "mutations-merge-go", "mutations-merge-rust"]) {
      expect(validationPlan(target, { directory, environment: sharded }), target).toEqual(validationPlan(target, { directory, environment }));
    }
    // The runner's environment cleaning removes replay selectors, not the shard.
    expect(cleanEnvironment({ MUTATION_SHARD: "2/3", DIALCACHE_PROTOCOL_CORPUS: "fixed", QUINT_SEED: "1" })).toEqual({ MUTATION_SHARD: "2/3" });
  });

  it("measures named mutants only through MUTATION_ONLY on its own target, never together with a shard", () => {
    const partial = { ...environment, MUTATION_ONLY: "M14,M15" };
    expect(validationPlan("mutations-ts", { directory, environment: partial })).toEqual([
      { label: "Measure TypeScript semantic mutations", command: process.execPath, args: ["formal/measure-semantics.mjs", "--only=M14,M15"] },
    ]);
    expect(validationPlan("mutations-go", { directory, environment: partial }).map(step => step.args)).toEqual([["formal/measure-go-semantics.mjs", "--only=M14,M15"]]);
    expect(validationPlan("mutations-rust", { directory, environment: { ...environment, MUTATION_ONLY: "M01,M02" } }).map(step => step.args)).toEqual([["formal/measure-rust-semantics.mjs", "--only=M01,M02"]]);
    for (const value of ["", "M14,", "M14,M14", "m14", "14", "M14 M15"]) {
      expect(() => validationPlan("mutations-ts", { directory, environment: { ...environment, MUTATION_ONLY: value } }), value).toThrow(/MUTATION_ONLY must be <id>,<id> naming distinct mutant ids/);
    }
    // A partial run is never merged, so it cannot also be a shard.
    expect(() => validationPlan("mutations-ts", { directory, environment: { ...partial, MUTATION_SHARD: "2/3" } })).toThrow(/MUTATION_SHARD and MUTATION_ONLY exclude each other/);
    // The aggregates refuse to ignore it silently; unrelated targets ignore it.
    for (const target of ["mutations", "ci"]) {
      expect(() => validationPlan(target, { directory, environment: partial }), target).toThrow(/MUTATION_ONLY=M14,M15 applies only to make mutations-ts, make mutations-go and make mutations-rust/);
    }
    for (const target of ["check", "formal", "formal-ts", "mutations-merge-ts", "mutations-merge-go", "mutations-merge-rust"]) {
      expect(validationPlan(target, { directory, environment: partial }), target).toEqual(validationPlan(target, { directory, environment }));
    }
    expect(cleanEnvironment({ MUTATION_ONLY: "M14", DIALCACHE_PROTOCOL_CORPUS: "fixed" })).toEqual({ MUTATION_ONLY: "M14" });
    for (const target of ["mutations-ts", "mutations-go", "mutations-rust"]) expect(targetDescriptions[target]).toMatch(/MUTATION_ONLY=<id>,<id>/);
  });

  it("merges each language's shards with a plain Node step that needs no native toolchains or Quint", () => {
    expect(validationPlan("mutations-merge-ts", { directory })).toEqual([
      { label: "Merge TypeScript mutation shards", command: process.execPath, args: ["formal/merge-mutation-reports.mjs", "ts"] },
    ]);
    expect(validationPlan("mutations-merge-go", { directory }).map(step => step.args)).toEqual([["formal/merge-mutation-reports.mjs", "go"]]);
    expect(validationPlan("mutations-merge-rust", { directory }).map(step => step.args)).toEqual([["formal/merge-mutation-reports.mjs", "rust"]]);
    fakeTool("quint", 'console.error("quint: not installed"); process.exit(1)');
    fakeTool("go", 'console.error("go: not installed"); process.exit(1)');
    fakeTool("cargo", 'console.error("cargo: not installed"); process.exit(1)');
    for (const target of ["mutations-merge-ts", "mutations-merge-go", "mutations-merge-rust"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
      expect(targetDescriptions[target]).toMatch(/Merge .* mutation shards/);
    }
    // The merge is not part of the local aggregates: they measure unsharded.
    for (const target of ["mutations", "ci"]) {
      expect(validationPlan(target, { directory }).some(step => step.args?.[0] === "formal/merge-mutation-reports.mjs"), target).toBe(false);
    }
  });

  it("requires Quint only for generation and recomputation, not for replay or mutation lanes", () => {
    fakeTool("quint", 'console.error("quint: not installed"); process.exit(1)');
    for (const target of ["formal-check", "formal-generate", "formal", "fixtures-check", "explore", "differential", "ci"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/Cannot run quint/);
    }
    for (const target of ["formal-ts", "formal-go", "mutations-ts", "mutations-go", "mutations", "mutations-merge-ts", "mutations-merge-go"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
    }
    fakeTool("go", 'console.error("go: not installed"); process.exit(1)');
    for (const target of ["formal-ts", "mutations-ts", "mutations-merge-ts", "mutations-merge-go"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
    }
    for (const target of ["formal-go", "mutations-go"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/Cannot run go/);
    }
  });

  it("fails full-CI prerequisites before execution when the exact floor runtime is missing or wrong", () => {
    expect(() => checkPrerequisites("ci", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/Set NODE22_BIN=/);
    environment.NODE22_BIN = fakeTool("node22", 'console.log("v22.16.0")');
    expect(() => checkPrerequisites("ci", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/exact Node 22.15.0/);
    environment.NODE22_BIN = fakeTool("node22", 'console.log("v22.15.0")');
    expect(() => checkPrerequisites("ci", { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
  });

  it("isolates Java and symbolic checks from corpus generation and exploration", () => {
    fakeTool("java", 'console.log("openjdk 17.0.12")');
    for (const target of ["model-check", "ci"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/requires Java 21/);
    }
    for (const target of ["check-ts", "formal", "formal-check", "formal-generate", "formal-ts", "explore"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
      expect(validationPlan(target, { directory }).some(step => step.args?.[0] === "formal/check-symbolic-models.mjs")).toBe(false);
    }
    expect(validationPlan("ci", { directory }).filter(step => step.args?.[0] === "formal/check-symbolic-models.mjs")).toHaveLength(1);
    fakeTool("java", 'console.log("openjdk 21.0.11 2026-04-21 LTS")');
    expect(() => checkPrerequisites("model-check", { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
    // The pinned Apalache archive is unpacked with tar; only the symbolic lane needs it.
    fakeTool("tar", 'console.error("tar: not available"); process.exit(1)');
    for (const target of ["model-check", "ci"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/requires tar to unpack the pinned Apalache archive/);
    }
    for (const target of ["check-ts", "formal", "formal-check", "formal-generate", "formal-ts", "explore"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
    }
  }, 15_000);

  it("requires Docker for mutation measurements but not report merging", () => {
    fakeTool("docker", 'console.error("Docker not running"); process.exit(1)');
    for (const target of ["mutations-ts", "mutations-go"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/docker/);
    }
    for (const target of ["mutations-merge-ts", "mutations-merge-go", "mutations-merge-rust"]) {
      expect(() => checkPrerequisites(target, { directory, environment, nodeVersion: "v24.20.0" })).not.toThrow();
    }
  });

  it("allows the standalone floor target on Node 22.15 and propagates its PATH without reintroducing selectors", async () => {
    const floor = fakeTool("node22", `if (process.argv[2] === '--version') console.log('v22.15.0');
else {
  process.argv[2] = process.argv[2] === '--eval' ? 'floor-zstd' : 'floor-package';
  process.argv.length = 3;
  await import(${JSON.stringify(child)});
}`);
    expect(() => checkPrerequisites("package-floor", { directory, environment, runnerNode: floor, nodeVersion: "v22.15.0" })).not.toThrow();
    put("dist/index.js", "export {};\n");
    await run(validationPlan("package-floor", { directory, environment, runnerNode: floor, nodeVersion: "v22.15.0" }));
    expect(events().map(event => event.label)).toEqual(["floor-zstd", "floor-package"]);
    for (const event of events()) {
      expect(event.path.split(delimiter)[0]).toBe(dirname(floor));
      expect(event.selected).toEqual({});
    }
  });

  it("rejects unsupported runtime and tool versions with setup instructions", () => {
    expect(() => checkPrerequisites("check", { directory, environment, nodeVersion: "v22.15.0" })).toThrow(/requires Node 24/);
    fakeTool("corepack", 'console.log("9.0.0")');
    expect(() => checkPrerequisites("check-ts", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/pinned pnpm 10.33.0/);
    fakeTool("corepack", 'console.log("10.33.0")');
    fakeTool("go", 'console.log("go version go1.26.0 test/test")');
    expect(() => checkPrerequisites("check-go", { directory, environment, nodeVersion: "v24.20.0" })).toThrow(/Go 1.27.1/);
  });
});

describe("full formal workflow shape", () => {
  type Step = { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string>; with?: Record<string, string | boolean> };
  type Job = { needs?: string | string[]; if?: string; env?: Record<string, string>; strategy?: { "fail-fast"?: boolean; matrix?: Record<string, unknown[]> }; "timeout-minutes"?: number; steps: Step[] };
  const lanes = ["typescript-parity", "go-parity", "rust-parity", "python-parity", "typescript-mutations", "go-mutations", "rust-mutations"];
  const needsOf = (job: Job) => (job.needs === undefined ? [] : [job.needs].flat());
  let jobs: Record<string, Job>;

  beforeEach(async () => {
    // yaml is not a project dependency and vitest does not declare it: it is in
    // the lockfile only transitively (testcontainers via docker-compose, and
    // vite's optional peer), and pnpm hoists every transitive package into
    // node_modules/.pnpm/node_modules, which a require rooted at vitest's real
    // store path walks up into while a bare import from this file cannot.
    // Name the remedy if a dependency bump ever drops it from the tree.
    let yamlPath: string;
    try {
      yamlPath = createRequire(createRequire(import.meta.url).resolve("vitest/package.json")).resolve("yaml");
    } catch {
      throw new Error("The workflow shape tests parse YAML; add yaml as a devDependency now that no other package brings it in.");
    }
    const { parse } = await import(pathToFileURL(yamlPath).href) as { parse(text: string): { jobs: Record<string, Job> } };
    jobs = parse(readFileSync(new URL("../.github/workflows/formal-full.yaml", import.meta.url), "utf8")).jobs;
  });

  it("runs the model check beside generation so the port and mutation lanes wait only for the corpus", () => {
    expect(needsOf(jobs["check-models"]!)).toEqual([]);
    expect(needsOf(jobs.generate!)).toEqual([]);
    expect(jobs["check-models"]!.steps.map(step => step.run).filter(Boolean)).toEqual(["make formal-check"]);
    expect(jobs.generate!.steps.map(step => step.run).filter(Boolean)).toEqual(["make formal-generate"]);
    for (const lane of lanes) expect(needsOf(jobs[lane]!), lane).toEqual(["generate"]);
  });

  it("shards both mutation lanes so every shard fits its timeout on the slow runner class, and gates the aggregate on their merges", () => {
    const uploadOf = (job: Job) => job.steps.find(step => step.uses?.startsWith("actions/upload-artifact"))!;
    const downloadsOf = (job: Job) => job.steps.filter(step => step.uses?.startsWith("actions/download-artifact")).map(step => step.with);
    const matrixShard = "$" + "{{ matrix.shard }}";
    // A shard runs the baselines, then its slice of the catalog strictly in sequence; on the slow
    // runner class a TypeScript mutant costs about 2 minutes and a Go mutant about 3.5 (run
    // 35335831285 measured 200-208 s per Go mutant on that class), and one hung
    // cohort adds its own bound (the 540 s vitest spawn timeout, the 480 s go test timeout) before
    // the shard fails. The matrix must keep every shard inside the job timeout, so growing the
    // catalog fails here until the matrix grows. The shard count in the matrix and in MUTATION_SHARD
    // must agree or the merge refuses the shards.
    const catalogSize = (JSON.parse(readFileSync(new URL("../formal/mutations.json", import.meta.url), "utf8")) as { mutations: unknown[] }).mutations.length;
    const baselineMinutes = 4;
    const table = [
      { lane: "typescript-mutations", language: "ts", output: ".formal-traces/semantic", artifact: "typescript-semantic", timeout: 40, shards: 6, slowMinutesPerMutant: 2, hungCohortMinutes: 9, go: undefined },
      { lane: "go-mutations", language: "go", output: ".formal-traces/go-semantic", artifact: "go-semantic", timeout: 40, shards: 10, slowMinutesPerMutant: 3.5, hungCohortMinutes: 8, go: { go: "true" } },
    ];
    for (const { lane, language, output, artifact, timeout, shards, slowMinutesPerMutant, hungCohortMinutes, go } of table) {
      const job = jobs[lane]!;
      const perShard = Math.ceil(catalogSize / shards);
      expect(baselineMinutes + perShard * slowMinutesPerMutant + hungCohortMinutes, `${lane}: ${perShard} mutants per shard`).toBeLessThanOrEqual(timeout);
      expect(job.strategy, lane).toEqual({ "fail-fast": false, matrix: { shard: Array.from({ length: shards }, (_, position) => position + 1) } });
      expect(job.env, lane).toEqual({ MUTATION_SHARD: matrixShard + "/" + shards });
      expect(job["timeout-minutes"], lane).toBe(timeout);
      expect(job.steps.map(step => step.run).filter(Boolean), lane).toEqual(["make mutations-" + language]);
      expect(job.steps.find(step => step.uses === "./.github/actions/setup-validation")!.with, lane).toEqual(go);
      expect(downloadsOf(job), lane).toEqual([{ name: "formal-traces", path: ".formal-traces" }]);
      const upload = uploadOf(job);
      expect(upload.if, lane).toBe("always()");
      expect(upload.with, lane).toMatchObject({ name: artifact + "-shard-" + matrixShard, path: output + "/shards/" });
      const merge = jobs[lane + "-merge"]!;
      expect(needsOf(merge), lane).toEqual([lane]);
      expect(merge.if, lane).toBe(`always() && needs.${lane}.result != 'skipped'`);
      expect(merge["timeout-minutes"], lane).toBe(10);
      expect(merge.steps.map(step => step.run).filter(Boolean), lane).toEqual(["make mutations-merge-" + language]);
      // The merge installs only the shared Node/pnpm environment: no Go, no Quint.
      expect(merge.steps.find(step => step.uses === "./.github/actions/setup-validation")!.with, lane).toBeUndefined();
      expect(downloadsOf(merge), lane).toEqual([{ pattern: artifact + "-shard-*", path: output + "/shards", "merge-multiple": true }]);
      const evidence = uploadOf(merge);
      expect(evidence.if, lane).toBe("always()");
      expect(evidence.with, lane).toMatchObject({ name: artifact + "-evidence", path: output + "/" });
    }
    const aggregate = jobs["formal-full"]!;
    expect(needsOf(aggregate)).toEqual(expect.arrayContaining(["typescript-mutations-merge", "go-mutations-merge"]));
    expect(needsOf(aggregate)).not.toContain("typescript-mutations");
    expect(needsOf(aggregate)).not.toContain("go-mutations");
    const gate = aggregate.steps.find(step => step.run?.includes("_RESULT"))!;
    expect(gate.env).toMatchObject({
      TYPESCRIPT_MUTATIONS_MERGE_RESULT: "$" + "{{ needs.typescript-mutations-merge.result }}",
      GO_MUTATIONS_MERGE_RESULT: "$" + "{{ needs.go-mutations-merge.result }}",
    });
    expect(gate.env).not.toHaveProperty("TYPESCRIPT_MUTATIONS_RESULT");
    expect(gate.env).not.toHaveProperty("GO_MUTATIONS_RESULT");
    expect(gate.run).toMatch(/test "\$TYPESCRIPT_MUTATIONS_MERGE_RESULT" = success/);
    expect(gate.run).toMatch(/test "\$GO_MUTATIONS_MERGE_RESULT" = success/);
  });

  it("requires Rust replay and merged mutations and retains Rust completion in the summary", () => {
    const parity = jobs["rust-parity"]!;
    expect(parity.steps.find(step => step.uses === "./.github/actions/setup-validation")!.with).toEqual({ rust: "true" });
    expect(parity.steps.map(step => step.run).filter(Boolean)).toEqual(["make formal-rust"]);
    const mutations = jobs["rust-mutations"]!;
    const shards = mutations.strategy!.matrix!.shard as number[];
    expect(mutations.env).toEqual({ MUTATION_SHARD: "$" + "{{ matrix.shard }}/" + shards.length });
    expect(mutations.steps.map(step => step.run).filter(Boolean)).toEqual(["make mutations-rust"]);
    const merge = jobs["rust-mutations-merge"]!;
    expect(needsOf(merge)).toEqual(["rust-mutations"]);
    expect(merge.if).toBe("always() && needs.rust-mutations.result != 'skipped'");
    expect(merge.steps.map(step => step.run).filter(Boolean)).toEqual(["make mutations-merge-rust"]);
    const aggregate = jobs["formal-full"]!;
    expect(needsOf(aggregate)).toEqual(expect.arrayContaining(["rust-parity", "rust-mutations-merge"]));
    expect(needsOf(aggregate)).not.toContain("rust-mutations");
    const gate = aggregate.steps.find(step => step.run?.includes("_RESULT"))!;
    expect(gate.env).toMatchObject({ RUST_RESULT: "$" + "{{ needs.rust-parity.result }}",
      RUST_MUTATIONS_MERGE_RESULT: "$" + "{{ needs.rust-mutations-merge.result }}" });
    expect(gate.run).toMatch(/test "\$RUST_RESULT" = success/);
    expect(gate.run).toMatch(/test "\$RUST_MUTATIONS_MERGE_RESULT" = success/);
    const summary = aggregate.steps.find(step => step.uses?.startsWith("actions/upload-artifact"))!.with!;
    expect(summary.path).toContain("formal-summary/rust/rust-completion.json");
    expect(summary.path).toContain("formal-summary/rust/rust-context.json");
    expect(summary.path).toContain("formal-summary/rust/rust-replay-summary.json");
  });

  it("requires Python complete replay and retains its actual completion evidence", () => {
    const parity = jobs["python-parity"]!;
    expect(parity.steps.find(step => step.uses === "./.github/actions/setup-validation")!.with).toEqual({ python: "true" });
    expect(parity.steps.map(step => step.run).filter(Boolean)).toEqual(["make formal-python"]);
    const aggregate = jobs["formal-full"]!;
    expect(needsOf(aggregate)).toContain("python-parity");
    const gate = aggregate.steps.find(step => step.run?.includes("_RESULT"))!;
    expect(gate.env).toMatchObject({ PYTHON_RESULT: "$" + "{{ needs.python-parity.result }}" });
    expect(gate.run).toMatch(/test "\$PYTHON_RESULT" = success/);
    const summary = aggregate.steps.find(step => step.uses?.startsWith("actions/upload-artifact"))!.with!;
    expect(summary.path).toContain("formal-summary/python/python-completion.json");
    expect(summary.path).toContain("formal-summary/python/python-context.json");
    expect(summary.path).toContain("formal-summary/python/python-replay-summary.json");
  });

  it("requires the model check in the aggregate and retains its report in the long-lived summary", () => {
    const aggregate = jobs["formal-full"]!;
    expect(needsOf(aggregate)).toEqual(expect.arrayContaining(["check-models", "generate", "typescript-parity", "go-parity"]));
    const gate = aggregate.steps.find(step => step.run?.includes("_RESULT"))!;
    expect(gate.env).toMatchObject({ CHECK_MODELS_RESULT: "${{ needs.check-models.result }}" });
    expect(gate.run).toMatch(/test "\$CHECK_MODELS_RESULT" = success/);
    const evidence = jobs["check-models"]!.steps.find(step => step.uses?.startsWith("actions/upload-artifact"))!.with!;
    expect(evidence.name).toBe("model-check-evidence");
    expect(String(evidence.path).trim().split("\n").map(line => line.trim())).toEqual([".formal-traces/verification/", ".formal-traces/model-properties/"]);
    expect(aggregate.steps.some(step => step.uses?.startsWith("actions/download-artifact") && step.with?.name === "model-check-evidence")).toBe(true);
    const summary = aggregate.steps.find(step => step.uses?.startsWith("actions/upload-artifact"))!.with!;
    expect(summary.path).toContain("formal-summary/model-check/model-properties/report.json");
  });

  it("runs the differential on pull requests only, against the base branch, with the replay logs preserved", async () => {
    const yamlPath = createRequire(createRequire(import.meta.url).resolve("vitest/package.json")).resolve("yaml");
    const { parse } = await import(pathToFileURL(yamlPath).href) as { parse(text: string): { jobs: Record<string, Job> } };
    const jobs = parse(readFileSync(new URL("../.github/workflows/formal.yaml", import.meta.url), "utf8")).jobs;
    const job = jobs.differential!;
    expect(job.if).toBe("github.event_name == 'pull_request'");
    // Every composed profile replaying both ways after a kernel change overran one 60-minute job
    // (57 minutes, then a cancellation at the timeout); retain the four required shard statuses.
    expect(job["timeout-minutes"]).toBe(60);
    expect(job.strategy).toEqual({ "fail-fast": false, matrix: { shard: [1, 2, 3, 4] } });
    const shards = job.strategy!.matrix!.shard as number[];
    expect(job.steps.find(step => step.uses?.startsWith("actions/checkout"))!.with).toEqual({ "fetch-depth": 0 });
    expect(job.steps.some(step => step.uses === "./.github/actions/setup-quint")).toBe(true);
    const run = job.steps.find(step => step.run === "make differential")!;
    // The count in DIFFERENTIAL_SHARD must agree with the matrix, or a profile is replayed twice or never.
    expect(run.env).toEqual({ DIFFERENTIAL_REFERENCE: "origin/$" + "{{ github.base_ref }}", DIFFERENTIAL_SHARD: "$" + "{{ matrix.shard }}/" + shards.length });
    expect(run.if).toBe("steps.fixture-scope.outputs.recompute == 'true'");
    const upload = job.steps.find(step => step.uses?.startsWith("actions/upload-artifact"))!;
    expect(upload.with!.name).toBe("formal-differential-$" + "{{ matrix.shard }}");
    expect(String(upload.with!.path)).toContain("**/replay-*/quint-test.log");
  });
});

describe("kernel fixture checker", () => {
  it("lists a fixture's declared runs and rejects a name quint test would not select", async () => {
    const { declaredRuns } = await import(new URL("../formal/check-kernel-fixtures.mjs", import.meta.url).href) as { declaredRuns(source: string): string[] };
    expect(declaredRuns("module m {\n  run firstTest = init\n  run secondTest = init.then(step)\n}\n")).toEqual(["firstTest", "secondTest"]);
    expect(() => declaredRuns("module m {\n  run firstTest = init\n  run probe = init\n}\n")).toThrow(/Kernel fixture runs must end in Test: probe/);
  });
});

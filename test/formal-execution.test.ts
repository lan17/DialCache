import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Manifest = {
  check: { maxSamples: number; maxSteps: number; outputDirectory: string };
  libraries: string[];
  models: Array<{
    path: string;
    invariants: string[];
    regressions: string[];
    profile?: string;
    generate?: { maxSamples: number; maxSteps: number; traces: number; outputDirectory: string };
  }>;
};
type Command = { command: string; args: string[]; outputDirectory?: string; expectedTraces?: number };
const manifest = () => JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as Manifest;
const moduleUrl = new URL("../formal/execution.mjs", import.meta.url).href;
const runner = fileURLToPath(new URL("../formal/run-models.mjs", import.meta.url));
const semantic = fileURLToPath(new URL("../formal/check-semantic-coverage.mjs", import.meta.url));
const invoke = (expression: string, input: unknown): unknown => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
  import { readFileSync } from 'node:fs';
  import { root, scanDeclarations, validateExecution } from ${JSON.stringify(moduleUrl)};
  const input = JSON.parse(readFileSync(0, 'utf8'));
  console.log(JSON.stringify(${expression}));
`], { input: JSON.stringify(input), stdio: ["pipe", "pipe", "pipe"] }).toString());
const validate = (value: unknown) => invoke("validateExecution(input)", value);

describe("formal execution schedule", () => {
  it("accounts for all models, selected invariants, regressions, and generated traces without Quint", () => {
    expect(validate(manifest())).toEqual({ models: 16, libraries: 1, profiles: 9, invariants: 101, regressions: 114, generatedTraces: 4000 });
  });

  it("rejects omitted models and dropped or renamed regressions", () => {
    const missingModel = manifest();
    missingModel.models.shift();
    expect(() => validate(missingModel)).toThrow(/file inventory changed/);
    const hiddenModel = manifest();
    hiddenModel.libraries.push(hiddenModel.models.shift()!.path);
    expect(() => validate(hiddenModel)).toThrow(/stateful model/);
    const missingTest = manifest();
    missingTest.models[0]!.regressions.pop();
    expect(() => validate(missingTest)).toThrow(/regression schedule/);
    const renamedTest = manifest();
    renamedTest.models[0]!.regressions[0] = "renamedWithoutSuffix";
    expect(() => validate(renamedTest)).toThrow(/Test suffix/);
  });

  it("rejects invalid exploration bounds and unsafe generation output paths", () => {
    for (const bound of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = manifest();
      invalid.check.maxSteps = bound;
      expect(() => validate(invalid)).toThrow(/positive bound/);
    }
    const tooManyTraces = manifest();
    const generation = tooManyTraces.models.find(model => model.generate)!.generate!;
    generation.traces = generation.maxSamples + 1;
    expect(() => validate(tooManyTraces)).toThrow(/trace count exceeds/);
    const unsafe = manifest();
    unsafe.models.find(model => model.generate)!.generate!.outputDirectory = ".formal-traces/features/../../formal";
    expect(() => validate(unsafe)).toThrow(/unsafe or duplicate/);
  });

  it("scans declarations across whitespace while ignoring comments, strings, and nested values", () => {
    const source = `module example {
      // val falseEvidence = true
      /* run falseTest = init.expect(true) */
      pure val text = "run forgedTest = { val forged = true }"
      val\n        invariant = true
      action init = { val nested = true nested }
      run /* intervening comment */\n        witnessTest = init.expect(invariant)
    }`;
    expect(invoke("[...scanDeclarations(input)]", source)).toEqual([
      ["text", "val"], ["invariant", "val"], ["init", "action"], ["witnessTest", "run"],
    ]);
    expect(() => invoke("[...scanDeclarations(input)]", "module broken { /* unfinished")).toThrow(/Unterminated/);
    expect(() => invoke("[...scanDeclarations(input)]", 'module broken { val text = "unfinished')).toThrow(/Unterminated/);
    expect(() => invoke("[...scanDeclarations(input)]", "module broken {} { val forged = true }")).toThrow(/outside the Quint module/);
  });

  it("accepts formatted real declarations and rejects a scheduled invariant hidden in a comment", () => {
    const real = manifest();
    expect(invoke(`validateExecution(input, { readSource: path =>
      readFileSync(root + path, 'utf8').replace(/\\b(val|run)\\s+/g, '$1\\n    ')
    })`, real)).toEqual(validate(real));
    expect(() => invoke(`validateExecution(input, { readSource: path => {
      const source = readFileSync(root + path, 'utf8');
      return path === input.models[0].path
        ? source.replace('val ' + input.models[0].invariants[0], '// val ' + input.models[0].invariants[0])
        : source;
    } })`, real)).toThrow(/scheduled invariant is not a declared val/);
  });

  it("rejects semantic evidence that names an existing but unscheduled helper", () => {
    const catalog = JSON.parse(readFileSync(new URL("../formal/semantic-cases.json", import.meta.url), "utf8"));
    catalog.cases[0].models = ["formal/dialcache-core.qnt:callScopeLive"];
    expect(() => execFileSync(process.execPath, [semantic, "--stdin"], {
      input: JSON.stringify(catalog), stdio: ["pipe", "pipe", "pipe"],
    })).toThrow(/not scheduled for execution/);
  });

  it("preserves ordered execution, per-profile budgets, seed override, and the model challenge", () => {
    const dryRun = (mode: string) => JSON.parse(execFileSync(process.execPath, [runner, mode, "--dry-run"], {
      env: { ...process.env, QUINT_SEED: "0x1234" }, stdio: ["pipe", "pipe", "pipe"],
    }).toString()) as Command[];
    const check = dryRun("check");
    expect(check.filter(job => job.args[0] === "typecheck").map(job => job.args[1])).toEqual(manifest().models.map(model => model.path));
    expect(check.filter(job => job.args[0] === "test")).toHaveLength(14);
    const challenge = check.findIndex(job => job.command === "node");
    expect(check[challenge - 1]!.args.slice(0, 2)).toEqual(["test", "formal/dialcache-coalescing-liveness.qnt"]);
    expect(check[challenge]!.args).toEqual(["formal/check-model-properties.mjs"]);
    for (const job of check.filter(job => job.args[0] === "run")) {
      expect(job.args).toEqual(expect.arrayContaining(["--backend=rust", "--n-threads=1", "--seed=0x1234", "--max-samples=2000", "--max-steps=40"]));
    }
    const generated = dryRun("generate");
    expect(generated.map(job => [job.outputDirectory, job.expectedTraces])).toEqual([
      [".formal-traces/conformance", 32], [".formal-traces/effects", 512],
      [".formal-traces/features/recovery", 512], [".formal-traces/features/policy", 512],
      [".formal-traces/features/shadow", 1024], [".formal-traces/features/scope", 256],
      [".formal-traces/features/admission", 128], [".formal-traces/features/layers", 512],
      [".formal-traces/features/independent", 512],
    ]);
    expect(generated[0]!.args).toEqual(expect.arrayContaining(["--max-samples=256", "--max-steps=30", "--seed=0x1234"]));
    expect(generated[7]!.args).toEqual(expect.arrayContaining(["--max-samples=2048", "--max-steps=80"]));
  });
});

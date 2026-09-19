import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../formal/measure-rust-semantics.mjs", import.meta.url).href;
type Cohort = { state: string; passed: number; failed: number; failingTests: string[]; executedTests: string[] };
const { evaluateCargoTestOutput, evaluateRustReport, infrastructureTestFile } = await import(moduleUrl) as {
  evaluateCargoTestOutput(output: string, exitCode: number, expectedBinaries?: number): Cohort;
  evaluateRustReport(text: string, exitCode: number): Cohort;
  infrastructureTestFile: RegExp;
};

// libtest output as `cargo test --release --no-fail-fast --lib --test tokio_runtime` prints it.
function cargoOutput(libOutcome: string, integrationOutcome: string): string {
  const failed = (outcome: string) => (outcome === "FAILED" ? 1 : 0);
  return [
    "     Running unittests src/lib.rs (/tmp/target/release/deps/dialcache-0123)",
    "",
    "running 2 tests",
    `test policy::tests::defaults ... ${libOutcome}`,
    "test codec::tests::round_trip ... ok",
    "",
    `test result: ${failed(libOutcome) ? "FAILED" : "ok"}. ${2 - failed(libOutcome)} passed; ${failed(libOutcome)} failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`,
    "",
    "     Running tests/tokio_runtime.rs (/tmp/target/release/deps/tokio_runtime-4567)",
    "",
    "running 2 tests",
    `test concurrent_callers_coalesce ... ${integrationOutcome}`,
    "test policy::tests::defaults ... ignored",
    "",
    `test result: ${failed(integrationOutcome) ? "FAILED" : "ok"}. ${1 - failed(integrationOutcome)} passed; ${failed(integrationOutcome)} failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.30s`,
    "",
  ].join("\n");
}

describe("Rust ordinary cohort evaluation", () => {
  it("qualifies test names by binary, drops ignored tests and survives a clean run", () => {
    const cohort = evaluateCargoTestOutput(cargoOutput("ok", "ok"), 0, 2);
    expect(cohort).toMatchObject({ state: "survived", passed: 3, failed: 0, failingTests: [] });
    expect(cohort.executedTests).toEqual(["src/lib.rs::policy::tests::defaults", "src/lib.rs::codec::tests::round_trip", "tests/tokio_runtime.rs::concurrent_callers_coalesce"]);
  });

  it("detects a failing test in either binary and names it", () => {
    expect(evaluateCargoTestOutput(cargoOutput("FAILED", "ok"), 101, 2)).toMatchObject({ state: "detected", passed: 2, failed: 1, failingTests: ["src/lib.rs::policy::tests::defaults"] });
    expect(evaluateCargoTestOutput(cargoOutput("ok", "FAILED"), 101, 2)).toMatchObject({ state: "detected", failingTests: ["tests/tokio_runtime.rs::concurrent_callers_coalesce"] });
  });

  it("treats a missing binary, a missing result line or an exit code that disagrees with the outcomes as infrastructure failure", () => {
    expect(() => evaluateCargoTestOutput(cargoOutput("ok", "ok"), 0, 3)).toThrow(/expected 3 test binaries/);
    expect(() => evaluateCargoTestOutput("running 1 test\ntest a ... ok\n", 0)).toThrow(/no libtest result line/);
    expect(() => evaluateCargoTestOutput(cargoOutput("ok", "ok"), 101, 2)).toThrow(/without a failing test/);
    expect(() => evaluateCargoTestOutput(cargoOutput("FAILED", "ok"), 0, 2)).toThrow(/exited 0 with failing tests/);
  });

  it("excludes the harness, its controls, infrastructure, protocol vector suites and real servers from ordinary tests", () => {
    for (const file of ["conformance.rs", "settlement_control.rs", "harness_infra.rs", "redis_integration.rs", "protocol_keys.rs", "protocol_frames.rs"]) expect(infrastructureTestFile.test(file), file).toBe(true);
    for (const file of ["metrics_exporters.rs", "tokio_runtime.rs", "policy_helpers.rs"]) expect(infrastructureTestFile.test(file), file).toBe(false);
  });
});

function report(cases: [string, string][], finish = true, extra: Record<string, unknown> = {}): string {
  const failed = cases.filter(([, status]) => status === "failed").length;
  const lines = [
    JSON.stringify({ schemaVersion: 1, kind: "start", implementation: "rust", startedAt: 1 }),
    ...cases.map(([id, status]) => JSON.stringify({ kind: "case", id, status, startedAt: 2, finishedAt: 3, ...(status === "failed" ? { message: "expected 1 got 2" } : {}) })),
  ];
  if (finish) lines.push(JSON.stringify({ kind: "finish", status: failed ? "failed" : "passed", finishedAt: 4, cases: cases.length, failed, ...extra }));
  return lines.join("\n") + "\n";
}

describe("Rust harness report evaluation", () => {
  it("survives a complete passing report and lists every executed case", () => {
    const cohort = evaluateRustReport(report([["sampled/core/0", "passed"], ["scenario/read/first-fill", "passed"]]), 0);
    expect(cohort).toMatchObject({ state: "survived", passed: 2, failed: 0, failingTests: [], executedTests: ["sampled/core/0", "scenario/read/first-fill"] });
  });

  it("detects a failed case only when the harness also exited nonzero", () => {
    const text = report([["sampled/core/0", "failed"], ["scenario/read/first-fill", "passed"]]);
    expect(evaluateRustReport(text, 101)).toMatchObject({ state: "detected", passed: 1, failed: 1, failingTests: ["sampled/core/0"] });
    expect(() => evaluateRustReport(text, 0)).toThrow(/exited 0 with failed cases/);
    expect(() => evaluateRustReport(report([["sampled/core/0", "passed"]]), 101)).toThrow(/without a failed case/);
  });

  it("rejects crashed, empty, duplicated or inconsistent reports instead of crediting them", () => {
    expect(() => evaluateRustReport("", 0)).toThrow(/empty Rust harness report/);
    expect(() => evaluateRustReport(report([["sampled/core/0", "passed"]], false), 0)).toThrow(/no finish record/);
    expect(() => evaluateRustReport(report([["sampled/core/0", "passed"], ["sampled/core/0", "passed"]]), 0)).toThrow(/duplicate case/);
    expect(() => evaluateRustReport(report([], true), 0)).toThrow(/no cases/);
    expect(() => evaluateRustReport(report([["sampled/core/0", "passed"]], true, { cases: 2 }), 0)).toThrow(/finish totals disagree/);
    expect(() => evaluateRustReport(report([["sampled/core/0", "passed"]], true, { status: "failed" }), 0)).toThrow(/finish status disagrees/);
  });
});

describe("Rust fault catalog", () => {
  const readRepo = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  type Entry = { id: string; case: string; description: string; typescriptMutation: string; edits: { path: string; before: string; after: string }[]; requiredDetections: string[]; typescriptRequiredDetections: string[] };
  const catalog = JSON.parse(readRepo("formal/rust-mutations.json")) as { schemaVersion: number; mutations: Entry[] };
  const typescript = JSON.parse(readRepo("formal/semantic-mutations.json")) as { mutations: { id: string; case: string; description: string; requiredDetections: string[] }[] };

  it("names every TypeScript fault once with the same case and description", () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.mutations.map(m => m.id)).toEqual(typescript.mutations.map(m => m.id));
    for (const entry of catalog.mutations) {
      const counterpart = typescript.mutations.find(m => m.id === entry.typescriptMutation)!;
      expect(counterpart, entry.id).toBeDefined();
      expect(entry.case, entry.id).toBe(counterpart.case);
      expect(entry.description, entry.id).toBe(counterpart.description);
      expect(entry.typescriptRequiredDetections, entry.id).toEqual(counterpart.requiredDetections);
      expect(entry.requiredDetections, entry.id).toEqual(expect.arrayContaining(["generated", "portable"]));
      expect(entry.requiredDetections.every(cohort => ["generated", "fixed", "portable"].includes(cohort)), entry.id).toBe(true);
    }
  });

  it("anchors every edit exactly once in the crate's production sources", () => {
    for (const entry of catalog.mutations) {
      expect(entry.edits.length, entry.id).toBeGreaterThan(0);
      for (const edit of entry.edits) {
        expect(edit.path, entry.id).toMatch(/^rust\/src\/[\w/-]+\.rs$/);
        expect(edit.before, entry.id).not.toBe(edit.after);
        expect(readRepo(edit.path).split(edit.before).length, `${entry.id} ${edit.path}`).toBe(2);
      }
    }
  });
});

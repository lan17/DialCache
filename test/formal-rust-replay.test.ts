import { describe, expect, it } from "vitest";

type Entry = { id: string; category: string; profile?: string; path?: string; name?: string; feature?: string; group?: string };
type Summary = {
  schemaVersion: number; implementation: string; status: string; generated: Record<string, number>; generatedTraces: number;
  quintRegressions: Record<string, number>; quintRegressionTraces: number; fixedScenarios: number; protocolVectors: number;
  witnessProfiles: string[]; executedCases: number;
};
type Step = { label: string; command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; stdoutFile?: string; remove?: string[] };
type Record_ = Record<string, unknown>;

const { checkRustReplay } = await import(new URL("../formal/check-rust-replay.mjs", import.meta.url).href) as {
  checkRustReplay(report: string, inventory?: Entry[]): Summary;
};
const { parseRustReport, adaptReport, nativeBinding } = await import(new URL("../formal/conformance-adapters.mjs", import.meta.url).href) as {
  parseRustReport(text: string, inventory: Entry[]): { startedAt: number; finishedAt: number; results: Array<{ id: string; status: string }> };
  adaptReport(language: string, text: string, context: unknown): unknown;
  nativeBinding(entry: Entry, language: string): unknown;
};
const { conformanceInventory, defaultSources } = await import(new URL("../formal/conformance.mjs", import.meta.url).href) as {
  conformanceInventory(): Entry[];
  defaultSources(language: string): string[];
};
const { validationPlan, checkPrerequisites } = await import(new URL("../formal/validation.mjs", import.meta.url).href) as {
  validationPlan(target: string, options?: { directory?: string; environment?: NodeJS.ProcessEnv }): Step[];
  checkPrerequisites(target: string, options?: { directory?: string; environment?: NodeJS.ProcessEnv; nodeVersion?: string }): void;
};

const inventory = conformanceInventory();
const startedAt = 1_800_000_000_000;
const start = (): Record_ => ({ schemaVersion: 1, kind: "start", implementation: "rust", startedAt });
const caseRecord = (id: string, status = "passed", extra: Record_ = {}): Record_ => ({ kind: "case", id, status, startedAt: startedAt + 1, finishedAt: startedAt + 2, ...extra });
const finish = (cases: number, failed = 0, status = failed ? "failed" : "passed"): Record_ => ({ kind: "finish", status, finishedAt: startedAt + 3, cases, failed });
const encode = (records: unknown[]): string => records.map(record => JSON.stringify(record)).join("\n") + "\n";
const completed = (): Record_[] => [start(), ...inventory.map(entry => caseRecord(entry.id)), finish(inventory.length)];
const withCases = (mutate: (records: Record_[]) => void): string => {
  const records = completed();
  mutate(records);
  return encode(records);
};

describe("Rust replay report gate", () => {
  it("binds every inventory entry to its own id", () => {
    for (const entry of inventory) expect(nativeBinding(entry, "rust")).toBe(entry.id);
    expect(nativeBinding(inventory[0]!, "go")).not.toBe(inventory[0]!.id);
    expect(() => nativeBinding(inventory[0]!, "zig")).toThrow(/TypeScript, Go and Rust/);
  });

  it("accepts a complete report and summarizes it by category and profile", () => {
    const summary = checkRustReplay(encode(completed()), inventory);
    const count = (category: string) => inventory.filter(entry => entry.category === category).length;
    expect(summary).toMatchObject({ schemaVersion: 1, implementation: "rust", status: "pass", executedCases: inventory.length,
      generatedTraces: count("sampled"), quintRegressionTraces: count("regression"), fixedScenarios: count("scenario"), protocolVectors: count("protocol") });
    expect(summary.witnessProfiles).toEqual(inventory.filter(entry => entry.category === "witness").map(entry => entry.profile).sort());
    expect(Object.values(summary.generated).reduce((sum, n) => sum + n, 0)).toBe(summary.generatedTraces);
    expect(summary.generated.core).toBeGreaterThan(0);
    expect(summary.quintRegressions.core).toBe(inventory.filter(entry => entry.category === "regression" && entry.profile === "core").length);
    for (const profile of Object.keys(summary.generated)) expect(summary.quintRegressions, profile).toHaveProperty(profile);
  });

  it("requires new profiles and source-derived exported regressions through the default inventory", () => {
    for (const profile of ["dark-layers", "shadow-read-deadlines"]) {
      for (const category of ["sampled", "regression", "witness"]) {
        expect(inventory.some(entry => entry.profile === profile && entry.category === category), `${profile}/${category}`).toBe(true);
      }
      const oldCases = inventory.filter(entry => entry.profile !== profile);
      const oldReport = encode([start(), ...oldCases.map(entry => caseRecord(entry.id)), finish(oldCases.length)]);
      expect(() => checkRustReplay(oldReport)).toThrow(`Missing passed Rust replay case: sampled/${profile}/0`);
    }
    const historiesOnly = inventory.filter(entry => entry.category !== "regression");
    const missingRegressions = encode([start(), ...historiesOnly.map(entry => caseRecord(entry.id)), finish(historiesOnly.length)]);
    expect(() => checkRustReplay(missingRegressions)).toThrow(/Missing passed Rust replay case: regression\//);
  });

  it("rejects a missing, duplicate or failed case", () => {
    const missing = inventory.at(-1)!.id;
    expect(() => checkRustReplay(withCases(records => { records.splice(records.length - 2, 1); (records.at(-1) as { cases: number }).cases--; }), inventory))
      .toThrow(`Missing passed Rust replay case: ${missing}`);
    expect(() => checkRustReplay(withCases(records => { records.splice(1, 0, caseRecord(inventory[0]!.id)); (records.at(-1) as { cases: number }).cases++; }), inventory))
      .toThrow(`Duplicate Rust replay case: ${inventory[0]!.id}`);
    expect(() => checkRustReplay(withCases(records => { records[1] = caseRecord(inventory[0]!.id, "failed", { message: "observation mismatch at step 3" }); }), inventory))
      .toThrow(`Rust replay failed: ${inventory[0]!.id} (observation mismatch at step 3)`);
    expect(() => checkRustReplay(withCases(records => { records[1] = caseRecord(inventory[0]!.id, "skipped"); }), inventory)).toThrow(/Invalid Rust case status/);
  });

  it("rejects inventory drift, smoke histories in a full replay and unknown ids", () => {
    const add = (id: string) => withCases(records => { records.splice(1, 0, caseRecord(id)); (records.at(-1) as { cases: number }).cases++; });
    expect(() => checkRustReplay(add("sampled/core/999999"), inventory)).toThrow("Unexpected Rust replay case (inventory drift): sampled/core/999999");
    expect(() => checkRustReplay(add("witness/nonexistent"), inventory)).toThrow(/inventory drift/);
    expect(() => checkRustReplay(add("smoke/core/conformance-smoke.itf.json"), inventory)).toThrow("Smoke history in a full Rust replay: smoke/core/conformance-smoke.itf.json");
    expect(() => checkRustReplay(add("bench/unrelated"), inventory)).toThrow("Unknown Rust replay case: bench/unrelated");
  });

  it("rejects an incomplete report, a non-passed finish, inconsistent totals and malformed lines", () => {
    expect(() => checkRustReplay(withCases(records => { records.pop(); }), inventory)).toThrow("Rust replay is incomplete: missing finish record");
    expect(() => checkRustReplay(withCases(records => { records[records.length - 1] = finish(inventory.length, 0, "failed"); }), inventory)).toThrow("Rust replay finished with status failed");
    expect(() => checkRustReplay(withCases(records => { records[records.length - 1] = finish(inventory.length, 1, "passed"); }), inventory)).toThrow(/finish totals disagree/);
    expect(() => checkRustReplay(withCases(records => { records[records.length - 1] = finish(inventory.length - 1); }), inventory)).toThrow(/finish totals disagree/);
    expect(() => checkRustReplay(withCases(records => { records.push(caseRecord(inventory[0]!.id)); }), inventory)).toThrow(/continues after the finish record/);
    expect(() => checkRustReplay(withCases(records => { records.shift(); }), inventory)).toThrow(/precedes the start record/);
    expect(() => checkRustReplay(withCases(records => { records.splice(1, 0, start()); }), inventory)).toThrow(/Duplicate or misplaced Rust start record/);
    expect(() => checkRustReplay(withCases(records => { records[0] = { ...start(), implementation: "go" }; }), inventory)).toThrow(/Unsupported Rust start record/);
    const [firstLine, ...rest] = encode(completed()).split("\n");
    expect(() => checkRustReplay([firstLine, "{not json", ...rest].join("\n"), inventory)).toThrow("Invalid Rust JSON record at line 2");
    expect(() => checkRustReplay(withCases(records => { records[1] = { kind: "note", id: "x" }; }), inventory)).toThrow(/Unsupported Rust replay record kind: note/);
    expect(() => checkRustReplay("", inventory)).toThrow(/Empty Rust replay report/);
  });

  it("adapts the execution window and results only from a report that passed the gate", () => {
    const parsed = parseRustReport(encode(completed()), inventory);
    expect(parsed).toMatchObject({ startedAt, finishedAt: startedAt + 3 });
    expect(parsed.results).toEqual(inventory.map(entry => ({ id: entry.id, status: "passed" })));
    expect(() => parseRustReport(withCases(records => { records.pop(); }), inventory)).toThrow(/missing finish/);
    expect(() => adaptReport("rust", encode(completed()), { schemaVersion: 1, language: "go" })).toThrow(/context/);
  });

  it("binds the crate sources, manifests and lockfile with the shared fixtures and witness evidence, never the build directory", () => {
    const sources = defaultSources("rust");
    expect(new Set(sources).size).toBe(sources.length);
    expect(sources).toContain("rust/Cargo.toml");
    expect(sources).toContain("rust/Cargo.lock");
    expect(sources).toContain("rust/rust-toolchain.toml");
    expect(sources).toContain("rust/src/lib.rs");
    expect(sources).toContain("rust/tests/conformance.rs");
    expect(sources.some(path => path.startsWith("rust/target/"))).toBe(false);
    expect(sources.filter(path => path.startsWith("rust/")).every(path => /\.(rs|toml|lock)$/.test(path))).toBe(true);
    const go = defaultSources("go");
    for (const path of go.filter(path => path.startsWith(".formal-traces/go-parity-witnesses/") || path.startsWith("src/") || path.startsWith("test/"))) {
      expect(sources, path).toContain(path);
    }
  });
});

describe("Rust validation lanes", () => {
  const directory = "/checkout";
  it("checks formatting, clippy and default tests from inside the crate so rustup honors its toolchain pin", () => {
    expect(validationPlan("check-rust", { directory }).map(step => [step.command, ...step.args!])).toEqual([
      ["cargo", "fmt", "--check"],
      ["cargo", "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"],
      ["cargo", "test", "--all-features"],
    ]);
    for (const step of validationPlan("check-rust", { directory })) {
      expect(step.env, step.label).toBeUndefined();
      expect(step.cwd, step.label).toBe("rust");
    }
    expect(validationPlan("check", { directory })).toEqual(["check-ts", "check-go", "check-rust", "docs", "audit"].flatMap(target => validationPlan(target, { directory })));
  });

  it("replays the complete corpus against the shared evidence and adapts the harness report into a completion", () => {
    const plan = validationPlan("formal-rust", { directory });
    expect(plan[0]).toEqual({ label: "Invalidate prior rust completion", remove: [".formal-traces/rust-completion.json"] });
    expect(plan[1]!.args).toEqual(["formal/conformance.mjs", "prepare", "rust", ".formal-traces/rust-context.json"]);
    const replay = plan[2]!;
    expect([replay.command, ...replay.args!]).toEqual(["cargo", "test", "--release", "--all-features", "--test", "conformance"]);
    expect(replay.cwd).toBe("rust");
    expect(replay.env).toEqual({
      DIALCACHE_MBT_TRACE_DIR: "/checkout/.formal-traces/conformance",
      DIALCACHE_EFFECTS_TRACE_DIR: "/checkout/.formal-traces/effects",
      DIALCACHE_FEATURE_TRACE_DIR: "/checkout/.formal-traces/features",
      DIALCACHE_WITNESS_EVIDENCE_DIR: "/checkout/.formal-traces/go-parity-witnesses",
      DIALCACHE_RUST_REPORT: "/checkout/.formal-traces/rust-replay.jsonl",
    });
    expect(replay.stdoutFile).toBeUndefined();
    expect(plan[3]).toMatchObject({ args: ["formal/check-rust-replay.mjs"], stdoutFile: ".formal-traces/rust-replay-summary.json" });
    expect(plan[4]).toMatchObject({ args: ["formal/conformance-adapters.mjs", "rust", ".formal-traces/rust-replay.jsonl", ".formal-traces/rust-context.json"], stdoutFile: ".formal-traces/rust-completion.json" });
    expect(plan.at(-1)!.args).toEqual(["formal/conformance.mjs", "check", ".formal-traces/rust-completion.json", ".formal-traces/rust-context.json"]);
    expect(plan).toHaveLength(6);
    // Go's parity ledger is Go-only; Rust neither checks it nor touches the other ports' reports.
    expect(plan.some(step => step.args?.[0] === "formal/check-go-parity.mjs")).toBe(false);
    expect(plan.some(step => step.args?.some(argument => /\.formal-traces\/(ts|go)-/.test(argument)))).toBe(false);
    const go = validationPlan("formal-go", { directory }).find(step => step.command === "go" && step.env)!;
    for (const key of Object.keys(go.env!)) expect(replay.env![key], key).toBe(go.env![key]);
    expect(validationPlan("formal", { directory }).slice(-plan.length)).toEqual(plan);
  });

  it("adds the smoke conformance run in default mode with no corpus selectors", () => {
    const smoke = validationPlan("smoke", { directory });
    expect(smoke.at(-1)).toEqual({ label: "Replay committed Rust fixtures", command: "cargo", args: ["test", "--all-features", "--test", "conformance"], cwd: "rust" });
    expect(smoke.filter(step => step.command === "cargo")).toHaveLength(1);
  });

  it("runs the real-server integration binary only through the integration lane, which selects its ignored tests", () => {
    const lane = validationPlan("integration-rust", { directory });
    expect(lane).toEqual([{ label: "Run Rust Redis/Valkey/Cluster integrations", command: "cargo", args: ["test", "--all-features", "--test", "redis_integration", "--", "--ignored"], cwd: "rust" }]);
    expect(validationPlan("integration", { directory })).toEqual(["integration-ts", "integration-go", "integration-rust"].flatMap(target => validationPlan(target, { directory })));
    for (const target of ["check-rust", "smoke", "formal-rust"]) expect(validationPlan(target, { directory }).some(step => step.args?.includes("--ignored")), target).toBe(false);
  });

  it("probes the pinned cargo exactly for the Rust lanes", async () => {
    const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { delimiter, join } = await import("node:path");
    const temporary = mkdtempSync(join(tmpdir(), "dialcache-rust-prereq-"));
    try {
      for (const path of ["bin", "formal", "node_modules/typescript", "rust"]) mkdirSync(join(temporary, path), { recursive: true });
      writeFileSync(join(temporary, "package.json"), '{"packageManager":"pnpm@10.33.0"}');
      writeFileSync(join(temporary, "node_modules/typescript/package.json"), "{}");
      writeFileSync(join(temporary, "formal/generated-fixtures.lock.json"), '{"quintVersion":"0.32.0"}');
      const tool = (name: string, body: string) => { const path = join(temporary, "bin", name); writeFileSync(path, `#!${process.execPath}\n${body}\n`); chmodSync(path, 0o755); };
      tool("corepack", 'console.log("10.33.0")');
      tool("go", 'console.log("go version go1.27.1 test/test")');
      tool("quint", 'console.log("0.32.0")');
      const environment = { ...process.env, PATH: `${join(temporary, "bin")}${delimiter}${process.env.PATH ?? ""}` };
      const options = { directory: temporary, environment, nodeVersion: "v24.20.0" };
      tool("cargo", 'console.error("cargo: command not found"); process.exit(127)');
      for (const target of ["check-rust", "formal-rust", "smoke", "check", "integration-rust", "mutations-rust", "mutations", "explore"]) expect(() => checkPrerequisites(target, options), target).toThrow(/Cannot run cargo/);
      for (const target of ["check-ts", "check-go", "formal-ts", "formal-go", "mutations-ts", "mutations-go", "mutations-merge-rust", "audit"]) expect(() => checkPrerequisites(target, options), target).not.toThrow();
      tool("cargo", 'console.log("cargo 1.97.0 (abcdef 2026-06-01)")');
      expect(() => checkPrerequisites("check-rust", options)).toThrow(/requires cargo 1\.98\.1; found cargo 1\.97\.0/);
      tool("cargo", 'console.log("cargo 1.98.10 (abcdef 2026-06-01)")');
      expect(() => checkPrerequisites("formal-rust", options)).toThrow(/requires cargo 1\.98\.1/);
      tool("cargo", 'console.log("cargo 1.98.1 (797e8a9bc 2026-08-05)")');
      for (const target of ["check-rust", "formal-rust", "smoke"]) expect(() => checkPrerequisites(target, options), target).not.toThrow();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

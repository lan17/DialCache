import { parseTrace, fixtureFor, inputsFor, project, expectedObservations, type Trace } from "../formal/replay/effects.mjs";
import { SettlementLedger } from "../formal/replay/settlement.mjs";
import { checkCorpus, loadCorpus } from "../formal/replay/witnesses/index.mjs";

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BehaviorDriver, type Input } from "./formal/behavior-driver.js";
import { assertEffectsHistory } from "./formal/effects-contract.js";

// The exported effects regressions are the model's public-only runs, read from its Quint text.
const { scheduleExecution } = await import(new URL("../formal/execution.mjs", import.meta.url).href) as {
  scheduleExecution(): { models: Array<{ profile?: string; replayRegressions?: string[] }> };
};
const singleFile = process.env.DIALCACHE_EFFECTS_TRACE_FILE;
const directory = process.env.DIALCACHE_EFFECTS_TRACE_DIR;
function loadTraces(): { traces: Trace[]; missing: string[] | undefined } {
  let paths: string[];
  if (singleFile !== undefined) paths = [resolve(singleFile)];
  else if (directory === undefined) paths = [resolve("formal/effects-smoke.itf.json")];
  else {
    paths = readdirSync(directory).filter((name) => name.endsWith(".itf.json")).sort().map((name) => resolve(directory, name));
    for (const name of scheduleExecution().models.find(model => model.profile === "effects")?.replayRegressions ?? []) {
      paths.push(resolve(directory, "..", "regressions", "effects", `${name}.itf.json`));
    }
  }
  if (paths.length === 0) throw new Error("No effects conformance traces found");
  // Each history is read and parsed once. The shared language-neutral evaluator
  // gates that corpus here, so only the steps the replays need stay in memory;
  // the CLI `node formal/witnesses.mjs evaluate` writes the reusable evidence.
  const corpus = loadCorpus("effects", paths);
  const missing = directory !== undefined && singleFile === undefined ? checkCorpus("effects", corpus).missing : undefined;
  return { traces: corpus.map(({ path, steps }) => ({ path, steps })), missing };
}
const { traces, missing } = loadTraces();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// `settle: false` is the harness control of the negative below only;
// conformance replays never pass it.
async function replay(trace: Trace, harness: { settle?: boolean } = {}) {
  // Configuration is an explicit initial input, independent of expected state.
  const fixture = fixtureFor(trace.steps[0]!.choice!);
  const driver = new BehaviorDriver(fixture, {}, harness);
  const setup: Input[] = [{ op: "faults", value: { holdReads: true, holdLoads: true, holdDumps: true, holdWrites: true } }];
  // The ledger the coordinator keeps for a session: every command issued here,
  // checked against the driver's receipt before each observation is compared.
  const ledger = new SettlementLedger(fixture, setup);
  try {
    for (const input of setup) await driver.apply(input);
    const expectations = expectedObservations(trace);
    // One snapshot per step: the inputs of the next step are derived from the
    // observation the previous step was asserted against.
    let observed = driver.snapshot();
    for (const [index, step] of trace.steps.entries()) {
      const context = `${trace.path} step ${index} action ${step.action}`;
      const expected = expectations[index];
      const mismatch = (cause: unknown) => new Error(`${context}\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(driver.snapshot())}\nreceipt: ${JSON.stringify(driver.receipt())}\nreplay: DIALCACHE_EFFECTS_TRACE_FILE=${JSON.stringify(trace.path)} corepack pnpm exec vitest run test/formal-effects.test.ts`, { cause });
      let inputs: Input[] = [];
      try {
        // Only the action/choice and independently observed effect index enter execution.
        inputs = inputsFor({ action: step.action, choice: step.choice }, observed, { wallMs: Date.now() });
        for (const input of inputs) await driver.apply(input);
      } catch (cause) { throw mismatch(cause); }
      ledger.issue(inputs);
      observed = driver.snapshot();
      // Settlement is checked first and outside the comparison wrapper: a
      // violation is the driver's own infrastructure failure and must never
      // carry the expected/actual markers the mutation lanes credit.
      try { ledger.assert(driver.receipt(), observed, { wallMs: Date.now() }); }
      catch (cause) { throw new Error([`${context}: ${(cause as Error).message}`, driver.settlementDiagnostic()].filter(Boolean).join("\n"), { cause }); }
      try {
        // Check C23/C25/C26 directly on observed history, independently of
        // expected Quint phases, timestamps, and outcome predictions.
        assertEffectsHistory(driver.contractHistory());
        const actual = project(observed);
        try { expect(actual, context).toEqual(expected); }
        catch (cause) { throw new Error(`${context}\ncomparison: projected-v1\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`, { cause }); }
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes('\ncomparison: projected-v1\n')) throw cause;
        throw mismatch(cause);
      }
    }
  } finally { await driver.dispose(); }
}

describe("generated pending-effect conformance", () => {
  for (const trace of traces) it(`replays ${trace.path}`, async () => { await replay(trace); });

  if (missing !== undefined) {
    it("covers every action and the required race witnesses", () => {
      expect(missing, "Missing effects witnesses").toEqual([]);
    });
  }

  it("rejects missing diagnostics and detects a corrupted event without changing execution", async () => {
    const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
    delete raw.states[0].s.events;
    expect(() => parseTrace(raw, "missing-events")).toThrow();
    const trace = structuredClone(traces[0]!);
    trace.steps[1]!.expected.events.push({ event: "miss", location: "remote", detail: "value_absent", amount: 0 });
    await expect(replay(trace)).rejects.toThrow(/step 1 action.*\nexpected:.*\nactual:/s);
  });

  it("fails a driver that skips settlement by settlement violation, never by mismatch", async () => {
    const path = resolve("formal/effects-smoke.itf.json");
    const error = await replay(parseTrace(JSON.parse(readFileSync(path, "utf8")), path), { settle: false }).then(() => "passed", (cause: unknown) => String(cause));
    expect(error).toMatch(/Settlement violation: \d+ runnable task\(s\) at observation/);
    expect(error).not.toMatch(/expected:[\s\S]*actual:/);
  });

  it("rejects missing choices and precision loss", () => {
    const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
    raw.states[1].input = { name: "resolveLoader", choice: { "#bigint": "-1" } };
    expect(() => parseTrace(raw, "missing-choice")).toThrow(/missing effect choice/);
    raw.states[1].input.choice = { "#bigint": "9007199254740993" };
    expect(() => parseTrace(raw, "unsafe-choice")).toThrow(/safe ITF integer/);
  });
});

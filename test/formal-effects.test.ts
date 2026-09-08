import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BehaviorDriver, type Input } from "./formal/behavior-driver.js";
import { itfInteger, record } from "./formal/itf.js";

const actions = ["init", "beginCall", "resolveLoader", "rejectLoader", "releaseWrite", "tick", "jumpClock", "invalidate", "futureFence"] as const;
type Action = typeof actions[number];
const fields = ["now", "phase", "activeLoader", "deadline", "observedFence", "writeTimestamp", "storedTimestamp", "watermark",
  "loaders", "reads", "writes", "invalidations", "loads", "dumps", "policyCalls"] as const;
const observedFields = ["loaders", "reads", "writes", "invalidations", "loads", "dumps", "policyCalls"] as const;
type State = Record<typeof fields[number], number> & { calls: number[]; sources: number[] };
interface Step { action: Action; loader?: number; state: State }
interface Trace { path: string; steps: Step[] }

function parseTrace(value: unknown, path: string): Trace {
  const states = record(value, path).states;
  if (!Array.isArray(states) || states.length < 2) throw new Error(`${path}: expected a nonempty trace`);
  const steps = states.map((raw, index): Step => {
    const context = `${path} step ${index}`;
    const step = record(raw, context);
    const action = step["mbt::actionTaken"];
    if (!actions.some((name) => name === action) || ((index === 0) !== (action === "init"))) {
      throw new Error(`${context}: unknown or misplaced action ${JSON.stringify(action)}`);
    }
    const picks = record(step["mbt::nondetPicks"], context);
    if (Object.keys(picks).join() !== "loader") throw new Error(`${context}: unsupported choices`);
    const choice = record(picks.loader, context);
    const settles = action === "resolveLoader" || action === "rejectLoader";
    let loader: number | undefined;
    if (settles) {
      if (choice.tag !== "Some") throw new Error(`${context}: missing loader choice`);
      loader = itfInteger(choice.value, context);
    } else if (choice.tag !== "None" || JSON.stringify(choice.value) !== '{"#tup":[]}') {
      throw new Error(`${context}: unexpected loader choice`);
    }
    const rawState = record(step.s, context);
    if (Object.keys(rawState).length !== fields.length + 2) throw new Error(`${context}: unexpected model fields`);
    const integers = Object.fromEntries(fields.map((field) => [field, itfInteger(rawState[field], `${context} ${field}`)])) as Record<typeof fields[number], number>;
    const state: State = { ...integers, calls: [], sources: [] };
    for (const field of ["calls", "sources"] as const) {
      const values = rawState[field];
      if (!Array.isArray(values)) throw new Error(`${context}: missing ${field} list`);
      state[field] = values.map((value) => itfInteger(value, `${context} ${field}`));
      if (state[field].some((value) => value > (field === "calls" ? 3 : 2))) {
        throw new Error(`${context}: unsupported ${field} code`);
      }
    }
    return { action: action as Action, ...(loader === undefined ? {} : { loader }), state };
  });
  return { path, steps };
}

const singleFile = process.env.DIALCACHE_EFFECTS_TRACE_FILE;
const directory = process.env.DIALCACHE_EFFECTS_TRACE_DIR;
function loadTraces(): Trace[] {
  let paths: string[];
  if (singleFile !== undefined) paths = [resolve(singleFile)];
  else if (directory === undefined) paths = [resolve("formal/effects-smoke.itf.json")];
  else paths = readdirSync(directory).filter((name) => name.endsWith(".itf.json")).sort().map((name) => resolve(directory, name));
  if (paths.length === 0) throw new Error("No effects conformance traces found");
  return paths.map((path) => parseTrace(JSON.parse(readFileSync(path, "utf8")), path));
}
const traces = loadTraces();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  const origin = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function inputFor(step: Pick<Step, "action" | "loader">, driver: BehaviorDriver): Input | null {
  switch (step.action) {
    case "init": return null;
    case "beginCall": return { op: "begin" };
    case "resolveLoader": return { op: "resolve", loader: step.loader!, value: 1 };
    case "rejectLoader": return { op: "reject", loader: step.loader! };
    case "releaseWrite": return { op: "release", effect: "write", index: driver.snapshot().writes - 1 };
    case "tick": return { op: "advance", ms: 10 };
    case "jumpClock": return { op: "advance", ms: 10, deliverTimers: false };
    case "invalidate": return { op: "invalidate" };
    case "futureFence": return { op: "invalidate", futureBufferMs: 20 };
  }
}

function project(driver: BehaviorDriver) {
  const observed = driver.snapshot();
  return {
    ...Object.fromEntries(observedFields.map((field) => [field, observed[field]])),
    calls: observed.calls.map((call) => call.status === "pending" ? 0
      : call.status === "value" ? (call.value === 1 ? 1 : 4)
      : call.error.startsWith("source:") ? 2 : call.error.startsWith("timeout:") ? 3 : 4),
    writeTtls: observed.writeTtls,
  };
}

async function replay(trace: Trace, driver = new BehaviorDriver({ policy: { ttlSec: { remote: 60 } }, tracked: true })) {
  try {
    await driver.apply({ op: "faults", value: { holdWrites: true } });
    for (const [index, step] of trace.steps.entries()) {
      const context = `${trace.path} step ${index} action ${step.action}`;
      const expected = { ...Object.fromEntries(observedFields.map((field) => [field, step.state[field]])),
        calls: step.state.calls, writeTtls: Array<number>(step.state.writes).fill(60_000) };
      try {
        // Only the action/choice and independently observed effect index enter execution.
        const input = inputFor({ action: step.action, ...(step.loader === undefined ? {} : { loader: step.loader }) }, driver);
        if (input !== null) await driver.apply(input);
        expect(project(driver), context).toEqual(expected);
      } catch (cause) {
        throw new Error(`${context}\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(project(driver))}\nreplay: DIALCACHE_EFFECTS_TRACE_FILE=${JSON.stringify(trace.path)} corepack pnpm exec vitest run test/formal-effects.test.ts`, { cause });
      }
    }
  } finally { await driver.dispose(); }
}

describe("generated pending-effect conformance", () => {
  for (const trace of traces) it(`replays ${trace.path}`, async () => { await replay(trace); });

  if (directory !== undefined && singleFile === undefined) {
    it("covers every action and the required race witnesses", () => {
      const seen = new Set<Action>();
      const witnesses = new Set<string>();
      for (const trace of traces) {
        let delayedWriteWasFenced = false;
        for (const [index, step] of trace.steps.entries()) {
          seen.add(step.action);
          const s = step.state;
          const previous = trace.steps[index - 1]?.state;
          if (s.sources.includes(0) && s.sources.includes(1)) witnesses.add("abandoned-overlap");
          if (step.action === "releaseWrite") {
            delayedWriteWasFenced = s.storedTimestamp <= s.watermark;
            if (previous !== undefined && previous.now >= previous.deadline) witnesses.add("publication-after-deadline");
          }
          // Require a later public read/refill to expose the stored stale write.
          if (delayedWriteWasFenced && step.action === "beginCall" && previous?.phase === 0
            && s.loaders === previous.loaders + 1) witnesses.add("delayed-fenced-write");
          if (previous?.phase === 1 && previous.now >= previous.deadline
            && (step.action === "resolveLoader" || step.action === "rejectLoader")) witnesses.add("late-settlement");
        }
      }
      expect([...seen].sort()).toEqual([...actions].sort());
      expect([...witnesses].sort()).toEqual(["abandoned-overlap", "publication-after-deadline", "delayed-fenced-write", "late-settlement"].sort());
    });
  }

  it("rejects missing choices and precision loss", () => {
    const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
    raw.states[1]["mbt::actionTaken"] = "resolveLoader";
    raw.states[1]["mbt::nondetPicks"].loader = { tag: "None", value: { "#tup": [] } };
    expect(() => parseTrace(raw, "missing-choice")).toThrow(/missing loader choice/);
    raw.states[1]["mbt::nondetPicks"].loader = { tag: "Some", value: { "#bigint": "9007199254740993" } };
    expect(() => parseTrace(raw, "unsafe-choice")).toThrow(/safe ITF integer/);
  });
});

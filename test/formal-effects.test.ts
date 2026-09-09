import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BehaviorDriver, type Input } from "./formal/behavior-driver.js";
import { itfInteger, record } from "./formal/itf.js";

const actions = ["init", "beginCall", "resolveLoader", "rejectLoader", "releaseRead", "failRead", "releaseLoad", "failLoad", "releaseDump", "failDump", "releaseWrite", "failWrite", "seedRemote", "tick", "jumpClock", "rollbackWall", "observerFault", "invalidate", "futureFence"] as const;
type Action = typeof actions[number];
const fields = ["now", "wall", "phase", "activeLoader", "activeRead", "deadline", "refill", "acceptedAt", "acceptedWall", "observerFailed", "readAborts", "observedFence", "writeTimestamp", "storedTimestamp", "watermark",
  "loaders", "reads", "writes", "invalidations", "loads", "dumps", "policyCalls"] as const;
const observedFields = ["loaders", "reads", "writes", "invalidations", "loads", "dumps", "policyCalls"] as const;
type State = Record<typeof fields[number], number> & { calls: number[]; sources: number[]; readStates: number[] };
interface Step { action: Action; choice?: number; state: State }
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
    if (Object.keys(picks).join() !== "choice") throw new Error(`${context}: unsupported choices`);
    const pick = record(picks.choice, context);
    const settles = action === "observerFault" || action === "resolveLoader" || action === "rejectLoader" || action === "releaseRead" || action === "failRead";
    let choice: number | undefined;
    if (settles) {
      if (pick.tag !== "Some") throw new Error(`${context}: missing effect choice`);
      choice = itfInteger(pick.value, context);
      if (action === "observerFault" && choice > 1) throw new Error(`${context}: unsupported observer choice`);
    } else if (pick.tag !== "None" || JSON.stringify(pick.value) !== '{"#tup":[]}') {
      throw new Error(`${context}: unexpected effect choice`);
    }
    const rawState = record(step.s, context);
    if (Object.keys(rawState).length !== fields.length + 3) throw new Error(`${context}: unexpected model fields`);
    const integers = Object.fromEntries(fields.map((field) => [field, itfInteger(rawState[field], `${context} ${field}`)])) as Record<typeof fields[number], number>;
    const state: State = { ...integers, calls: [], sources: [], readStates: [] };
    for (const field of ["calls", "sources", "readStates"] as const) {
      const values = rawState[field];
      if (!Array.isArray(values)) throw new Error(`${context}: missing ${field} list`);
      state[field] = values.map((value) => itfInteger(value, `${context} ${field}`));
      if (state[field].some((value) => value > (field === "calls" ? 3 : 2))) {
        throw new Error(`${context}: unsupported ${field} code`);
      }
    }
    return { action: action as Action, ...(choice === undefined ? {} : { choice }), state };
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
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function inputsFor(step: Pick<Step, "action" | "choice">, driver: BehaviorDriver): Input[] {
  const observed = driver.snapshot();
  const release = (effect: "read" | "load" | "dump" | "write", index: number, failed = false): Input[] => [
    { op: "faults", value: { [effect]: failed } }, { op: "release", effect, index },
    { op: "faults", value: { [effect]: false } },
  ];
  switch (step.action) {
    case "init": return [];
    case "beginCall": return [{ op: "begin" }];
    case "resolveLoader": return [{ op: "resolve", loader: step.choice!, value: 1 }];
    case "rejectLoader": return [{ op: "reject", loader: step.choice! }];
    case "releaseRead": return release("read", step.choice!);
    case "failRead": return release("read", step.choice!, true);
    case "releaseLoad": return release("load", observed.loads - 1);
    case "failLoad": return release("load", observed.loads - 1, true);
    case "releaseDump": return release("dump", observed.dumps - 1);
    case "failDump": return release("dump", observed.dumps - 1, true);
    case "releaseWrite": return release("write", observed.writes - 1);
    case "failWrite": return release("write", observed.writes - 1, true);
    case "seedRemote": return [{ op: "seed", value: 1 }];
    case "tick": return [{ op: "advance", ms: 10 }];
    case "jumpClock": return [{ op: "advance", ms: 10, deliverTimers: false }];
    case "observerFault": return [{ op: "faults", value: { observer: step.choice === 1 } }];
    case "rollbackWall": return [{ op: "shiftWall", ms: -1000 }];
    case "invalidate": return [{ op: "invalidate" }];
    case "futureFence": return [{ op: "invalidate", futureBufferMs: 20 }];
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
    readAborts: observed.events!.filter(event => event.event === "readAbort").map(event => event.index),
  };
}

async function replay(trace: Trace, driver = new BehaviorDriver({ policy: { ttlSec: { remote: 60 } }, tracked: true, readTimeoutMs: 10, observe: ["readAbort"] })) {
  try {
    await driver.apply({ op: "faults", value: { holdReads: true, holdLoads: true, holdDumps: true, holdWrites: true } });
    const abortedReads: number[] = [];
    for (const [index, step] of trace.steps.entries()) {
      const previous = trace.steps[index - 1]?.state;
      if (previous !== undefined && step.state.readAborts > previous.readAborts) abortedReads.push(previous.activeRead);
      const context = `${trace.path} step ${index} action ${step.action}`;
      const expected = { ...Object.fromEntries(observedFields.map((field) => [field, step.state[field]])),
        calls: step.state.calls, writeTtls: Array<number>(step.state.writes).fill(60_000), readAborts: abortedReads };
      try {
        // Only the action/choice and independently observed effect index enter execution.
        const inputs = inputsFor({ action: step.action, ...(step.choice === undefined ? {} : { choice: step.choice }) }, driver);
        for (const input of inputs) await driver.apply(input);
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
        let failedRead = false;
        let failedDecode = false;
        let acquiredAt: number | undefined;
        let decodeStarted = 0;
        for (const [index, step] of trace.steps.entries()) {
          seen.add(step.action);
          const s = step.state;
          const previous = trace.steps[index - 1]?.state;
          if (s.sources.includes(0) && s.sources.includes(1)) witnesses.add("abandoned-overlap");
          if (previous?.observerFailed === 1) {
            if (step.action === "releaseLoad") witnesses.add("observer-failure-hit");
            if (step.action === "releaseWrite") witnesses.add("observer-failure-publication");
            if (step.action === "rejectLoader" && previous.sources[step.choice!] === 0 && s.calls.includes(2)) witnesses.add("observer-failure-source-error");
          }
          if (step.action === "seedRemote") delayedWriteWasFenced = false;
          if (previous?.phase === 3 && s.phase === 1) {
            failedRead = step.action === "failRead" || s.readAborts > previous.readAborts;
            failedDecode = false;
            if (s.readAborts > previous.readAborts) {
              witnesses.add("read-timeout-starts-source");
              if (step.action !== "tick") witnesses.add("read-late-settlement");
            }
          }
          if ((step.action === "releaseRead" || step.action === "failRead") && previous?.readStates[step.choice!] === 1) {
            witnesses.add("abandoned-read-settles");
          }
          if (step.action === "releaseRead" && s.phase === 4) { acquiredAt = s.wall; decodeStarted = s.now; }
          if (step.action === "releaseLoad" && acquiredAt !== undefined) {
            if (s.now - decodeStarted >= 10) witnesses.add("decode-outlives-deadline");
            if (s.watermark >= acquiredAt) witnesses.add("acquired-hit-survives-invalidation");
          }
          if (step.action === "failLoad") failedDecode = true;
          if (step.action === "resolveLoader" && previous?.sources[step.choice!] === 0 && previous.now < previous.deadline) {
            if (failedRead && s.phase === 0 && s.dumps === previous.dumps) witnesses.add("failed-read-no-refill");
            if (failedDecode && s.dumps > previous.dumps) witnesses.add("failed-decode-refills");
          }
          if (step.action === "releaseDump" && s.phase === 0) witnesses.add("dump-rechecks-fence-after-rollback");
          if (step.action === "failDump") witnesses.add("dump-failure-preserves-value");
          if (step.action === "failWrite") witnesses.add("write-failure-preserves-value");
          if (step.action === "releaseDump" && previous !== undefined && previous.now >= previous.deadline) witnesses.add("serialize-outlives-deadline");
          if (step.action === "releaseWrite") {
            delayedWriteWasFenced = s.storedTimestamp <= s.watermark;
            if (previous !== undefined && previous.now >= previous.deadline) witnesses.add("publication-after-deadline");
          }
          // Require a later public read/refill to expose the stored stale write.
          if (delayedWriteWasFenced && step.action === "releaseRead" && previous?.phase === 3
            && s.loaders === previous.loaders + 1) witnesses.add("delayed-fenced-write");
          if (previous?.phase === 1 && previous.sources[step.choice!] === 0 && previous.now >= previous.deadline
            && (step.action === "resolveLoader" || step.action === "rejectLoader")) witnesses.add("late-settlement");
        }
      }
      expect([...seen].sort()).toEqual([...actions].sort());
      expect([...witnesses].sort()).toEqual(["abandoned-overlap", "publication-after-deadline", "delayed-fenced-write", "late-settlement",
        "read-timeout-starts-source", "read-late-settlement", "abandoned-read-settles", "decode-outlives-deadline",
        "acquired-hit-survives-invalidation", "failed-read-no-refill", "failed-decode-refills",
        "dump-failure-preserves-value", "write-failure-preserves-value", "serialize-outlives-deadline", "dump-rechecks-fence-after-rollback", "observer-failure-hit", "observer-failure-publication", "observer-failure-source-error"].sort());
    });
  }

  it("rejects missing choices and precision loss", () => {
    const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
    raw.states[1]["mbt::actionTaken"] = "resolveLoader";
    raw.states[1]["mbt::nondetPicks"].choice = { tag: "None", value: { "#tup": [] } };
    expect(() => parseTrace(raw, "missing-choice")).toThrow(/missing effect choice/);
    raw.states[1]["mbt::nondetPicks"].choice = { tag: "Some", value: { "#bigint": "9007199254740993" } };
    expect(() => parseTrace(raw, "unsafe-choice")).toThrow(/safe ITF integer/);
  });
});

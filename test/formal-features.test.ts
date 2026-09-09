import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BehaviorDriver, emptyObservation, type Fixture, type Input, type Observation, type Policy } from "./formal/behavior-driver.js";
import { itfInteger, record } from "./formal/itf.js";

type Projected = Omit<Observation, "calls"> & { calls: number[] };
type Action = { choices?: readonly number[]; input: (choice: number, observed: Observation) => Input };
interface Profile { fixture: Fixture; setup: Input[]; actions: Record<string, Action> }
const settle = (op: "resolve" | "reject"): Action => ({
  ...(op === "resolve" ? { choices: [1, 2] } : {}),
  input: (choice, o) => op === "resolve" ? { op, loader: o.loaders - 1, value: choice } : { op, loader: o.loaders - 1 },
});
const effectCounts = { read: "reads", load: "loads", dump: "dumps", write: "writes", policy: "policyCalls" } as const;
const release = (effect: "read" | "load" | "dump" | "write" | "policy"): Action => ({
  input: (_, o) => ({ op: "release", effect, index: o[effectCounts[effect]] - 1 }),
});
const fault = (field: "read" | "load" | "dump" | "write" | "policy"): Action => ({
  choices: [0, 1], input: (choice) => ({ op: "faults", value: { [field]: choice === 1 } }),
});
const advance = (choices: number[]): Action => ({ choices, input: (choice) => ({ op: "advance", ms: choice }) });
const overlays: Policy[] = [
  {}, { ttlSec: { local: 2 } }, { ttlSec: { remote: 2 } }, { ramp: { local: 0 } },
  { ramp: { remote: 0 } }, { ttlSec: { local: -1 } }, { ttlSec: { remote: -1 } },
  { staleOnErrorMaxAgeSec: 2 }, { ramp: { local: 0, remote: 0 } },
  { ttlSec: { remote: 4 }, staleOnErrorMaxAgeSec: 0 },
];
const profiles: Record<string, Profile> = {
  recovery: {
    fixture: { policy: { ttlSec: { remote: 1 }, staleOnErrorMaxAgeSec: 5 }, tracked: true, fallbackTimeoutMs: null },
    setup: [{ op: "seed", value: 1, ageMs: 1000 }, { op: "faults", value: { holdLoads: true } }],
    actions: {
      beginCall: { choices: [0, 1, 2], input: (choice) => ({ op: "begin", recovery: (["allow", "deny", "error"] as const)[choice]! }) },
      joinCall: { input: () => ({ op: "begin" }) },
      resolveLoader: { input: (_, o) => ({ op: "resolve", loader: o.loaders - 1, value: 2 }) },
      rejectLoader: settle("reject"), releaseLoad: release("load"),
      seed: { choices: [0, 1, 2, 3, 4, 5, 6], input: (choice) => ({ op: "seed", value: choice === 6 ? 2 : 1,
        ageMs: [0, 999, 1000, 4999, 5000, -1, 1000][choice]! }) },
      advance: advance([1, 1000, 4000]), invalidate: { input: () => ({ op: "invalidate" }) },
      policy: { choices: [2000, 5000], input: (choice) => ({ op: "policy", value: { staleOnErrorMaxAgeSec: choice / 1000 } }) },
      readFault: fault("read"), loadFault: fault("load"),
    },
  },
  policy: {
    fixture: { policy: { ttlSec: { local: 1, remote: 1 }, staleOnErrorMaxAgeSec: 5 }, localMaxSize: 1, fallbackTimeoutMs: null },
    setup: [{ op: "faults", value: { holdPolicies: true } }],
    actions: {
      beginCall: { choices: [0, 1], input: (choice) => ({ op: "begin", key: String(choice) }) },
      releasePolicy: release("policy"), resolveLoader: settle("resolve"), rejectLoader: settle("reject"),
      policy: { choices: overlays.map((_, i) => i), input: (choice) => ({ op: "policy", value: overlays[choice]! }) },
      advance: advance([1, 1000, 2000, 5000]), providerFault: fault("policy"),
      readFault: fault("read"), dumpFault: fault("dump"), writeFault: fault("write"),
    },
  },
  shadow: {
    fixture: { policy: { ttlSec: { remote: 60 }, ramp: { remote: 0 }, shadow: { ramp: 100 } }, tracked: true },
    setup: [{ op: "faults", value: { holdReads: true, holdLoads: true, holdDumps: true, holdWrites: true } }],
    actions: {
      beginCall: { input: () => ({ op: "begin" }) }, resolveLoader: settle("resolve"), rejectLoader: settle("reject"),
      releaseRead: release("read"), releaseLoad: release("load"), releaseDump: release("dump"), releaseWrite: release("write"),
      advance: advance([1, 10]), seed: { choices: [1, 2], input: (choice) => ({ op: "seed", value: choice }) },
      invalidate: { choices: [0, 20], input: (choice) => ({ op: "invalidate", futureBufferMs: choice }) },
      readFault: fault("read"), loadFault: fault("load"), dumpFault: fault("dump"), writeFault: fault("write"),
    },
  },
};

interface Step { action: string; choice: number; expected: Projected }
interface Trace { path: string; steps: Step[] }
function observation(raw: unknown, context: string): Projected {
  const value = record(raw, context);
  const shape = { ...emptyObservation(), calls: [] as number[] };
  if (Object.keys(value).sort().join() !== Object.keys(shape).sort().join()) throw new Error(`${context}: unexpected observation fields`);
  const result = Object.fromEntries(Object.entries(shape).map(([key, initial]) => {
    const item = value[key];
    if (typeof initial === "number") return [key, itfInteger(item, context)];
    if (!Array.isArray(item)) throw new Error(`${context}: expected ${key} list`);
    return [key, item.map((entry) => {
      if (key === "calls" || key === "writeTtls") {
        const integer = itfInteger(entry, context);
        if (key === "calls" && integer > 4) throw new Error(`${context}: unsupported caller outcome`);
        return integer;
      }
      if (typeof entry !== (key === "sourceScopes" ? "boolean" : "string")) throw new Error(`${context}: invalid ${key} entry`);
      return entry;
    })];
  }));
  return result as Projected;
}
function parseTrace(raw: unknown, path: string, profile: Profile): Trace {
  const states = record(raw, path).states;
  if (!Array.isArray(states) || states.length < 2) throw new Error(`${path}: expected a nonempty trace`);
  return { path, steps: states.map((rawState, i) => {
    const context = `${path} step ${i}`;
    const state = record(rawState, context);
    const action = state["mbt::actionTaken"];
    if (typeof action !== "string" || (i === 0 ? action !== "init" : !Object.hasOwn(profile.actions, action))) {
      throw new Error(`${context}: unknown or misplaced action`);
    }
    const picks = record(state["mbt::nondetPicks"], context);
    if (Object.keys(picks).join() !== "choice") throw new Error(`${context}: unsupported choices`);
    const pick = record(picks.choice, context);
    const choices = profile.actions[action]?.choices;
    let choice = 0;
    if (choices !== undefined) {
      if (pick.tag !== "Some") throw new Error(`${context}: missing choice`);
      choice = itfInteger(pick.value, context);
      if (!choices.includes(choice)) throw new Error(`${context}: unsupported choice`);
    } else if (pick.tag !== "None" || JSON.stringify(pick.value) !== '{"#tup":[]}') {
      throw new Error(`${context}: unexpected choice`);
    }
    return { action, choice, expected: observation(record(state.s, context).o, context) };
  }) };
}
function project(o: Observation): Projected {
  return { ...o, calls: o.calls.map((c) => c.status === "pending" ? 0
    : c.status === "value" ? (c.value === 1 || c.value === 2 ? c.value : 5)
    : c.error.startsWith("source:") ? 3 : c.error.startsWith("timeout:") ? 4 : 5) };
}
async function replay(profile: Profile, trace: Trace) {
  const driver = new BehaviorDriver(profile.fixture);
  try {
    for (const input of profile.setup) await driver.apply(input);
    for (const [i, step] of trace.steps.entries()) {
      const { action, choice } = step;
      try {
        // Only named actions/choices and actual effect IDs enter the driver.
        // The model observation and its private state cannot control execution.
        if (action !== "init") await driver.apply(profile.actions[action]!.input(choice, driver.snapshot()));
        expect(project(driver.snapshot())).toEqual(step.expected);
      } catch (cause) {
        throw new Error(`${trace.path} step ${i} action ${action} choice ${choice}\nexpected: ${JSON.stringify(step.expected)}\nactual: ${JSON.stringify(project(driver.snapshot()))}\nreplay: DIALCACHE_FEATURE_TRACE_FILE=${JSON.stringify(trace.path)} corepack pnpm exec vitest run test/formal-features.test.ts --coverage.enabled=false`, { cause });
      }
    }
  } finally { await driver.dispose(); }
}

// These are reachability checks over replayed observations, not additional
// implementation state. A large corpus must not pass by missing its hard paths.
function witnesses(name: string, traces: Trace[]): Set<string> {
  const seen = new Set<string>();
  for (const trace of traces) {
    let invalidatedDuringFlight = false;
    let advancedDuringDecode = false;
    let decoding = false;
    let c0Released = false;
    let changedPendingPolicy = false;
    let sourcePending = false;
    let shadowTimedOut = false;
    for (const [i, step] of trace.steps.entries()) {
      seen.add(`action:${step.action}`);
      const o = step.expected;
      const previous = trace.steps[i - 1]?.expected;
      if (previous === undefined) continue;
      for (const outcome of o.recovery.concat(o.shadow)) seen.add(`outcome:${outcome}`);
      if (step.action === "beginCall") {
        invalidatedDuringFlight = false; advancedDuringDecode = false; decoding = false;
        c0Released = false; changedPendingPolicy = false; sourcePending = false; shadowTimedOut = false;
      }
      if (name === "recovery") {
        if (step.action === "invalidate" && o.calls.includes(0)) invalidatedDuringFlight = true;
        if (step.action === "rejectLoader" && o.loads > previous.loads) decoding = true;
        if (step.action === "advance" && decoding) advancedDuringDecode = true;
        if (o.recovery.length > previous.recovery.length) {
          const outcome = o.recovery.at(-1);
          if (outcome === "served" && invalidatedDuringFlight) seen.add("retained-across-invalidation");
          if (outcome === "served" && previous.calls.filter((c) => c === 0).length > 1) seen.add("coalesced-recovery");
          if (outcome === "miss" && step.action === "releaseLoad" && advancedDuringDecode) seen.add("expired-during-decode");
        }
      }
      if (name === "policy") {
        if (step.action === "releasePolicy") {
          sourcePending = o.loaders > previous.loaders;
          if (o.loads > previous.loads) seen.add("remote-hit");
          if (o.reads === previous.reads && o.loaders === previous.loaders) seen.add("local-hit");
        }
        if (step.action === "policy" && sourcePending) changedPendingPolicy = true;
        if (step.action === "resolveLoader" && changedPendingPolicy && o.writes > previous.writes) seen.add("publication-after-policy-change");
        for (const ttl of o.writeTtls) seen.add(`ttl:${ttl}`);
      }
      if (name === "shadow") {
        if (step.action === "releaseRead") {
          c0Released = true;
          if (o.calls.includes(0) && o.shadow.length === previous.shadow.length) seen.add("c0-before-source");
        }
        if (step.action === "resolveLoader" && !c0Released && o.calls.at(-1) !== 4) seen.add("source-before-c0");
        if (o.shadow.length > previous.shadow.length && o.shadow.at(-1) === "timeout") shadowTimedOut = true;
        if (step.action === "releaseWrite" && shadowTimedOut) seen.add("write-completes-after-timeout");
      }
    }
  }
  return seen;
}
const required: Record<string, string[]> = {
  recovery: ["outcome:served", "outcome:miss", "outcome:deserialization_error", "retained-across-invalidation", "coalesced-recovery", "expired-during-decode"],
  policy: ["local-hit", "remote-hit", "publication-after-policy-change", "ttl:2000", "ttl:4000", "ttl:5000"],
  shadow: ["match", "mismatch", "superseded", "confirmation_error", "redis_error", "source_error", "timeout", "deserialization_error", "filled", "fill_error", "fill_fenced"]
    .map((outcome) => `outcome:${outcome}`).concat(["c0-before-source", "source-before-c0", "write-completes-after-timeout"]),
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const single = process.env.DIALCACHE_FEATURE_TRACE_FILE;
const directory = process.env.DIALCACHE_FEATURE_TRACE_DIR;
for (const [name, profile] of Object.entries(profiles)) {
  const paths = single !== undefined ? (single.includes(`/${name}/`) || single.endsWith(`${name}-smoke.itf.json`) ? [resolve(single)] : [])
    : directory === undefined ? [resolve(`formal/${name}-smoke.itf.json`)]
    : readdirSync(resolve(directory, name)).filter((file) => file.endsWith(".itf.json")).sort().map((file) => resolve(directory, name, file));
  if (single === undefined && paths.length === 0) throw new Error(`No ${name} traces found`);
  const traces = paths.map((path) => parseTrace(JSON.parse(readFileSync(path, "utf8")), path, profile));
  describe(`generated ${name} conformance`, () => {
    for (const trace of traces) it(`replays ${trace.path}`, async () => { await replay(profile, trace); });
    if (directory !== undefined && single === undefined) it("reaches every action and required outcome or race", () => {
      const seen = witnesses(name, traces);
      const wanted = Object.keys(profile.actions).map((action) => `action:${action}`).concat(required[name]!);
      expect(wanted.filter((witness) => !seen.has(witness)), `Missing ${name} coverage witnesses`).toEqual([]);
    });
    if (traces.length > 0) {
      it("rejects missing observations, unknown actions and invalid choices", () => {
        const raw = JSON.parse(readFileSync(traces[0]!.path, "utf8"));
        delete raw.states[0].s.o.reads;
        expect(() => parseTrace(raw, "missing-observation", profile)).toThrow(/observation fields/);
        raw.states[0].s.o.reads = { "#bigint": "0" };
        raw.states[1]["mbt::actionTaken"] = "unknown";
        expect(() => parseTrace(raw, "unknown-action", profile)).toThrow(/unknown/);
        raw.states[1]["mbt::actionTaken"] = "advance";
        raw.states[1]["mbt::nondetPicks"].choice = { tag: "Some", value: { "#bigint": "9007199254740993" } };
        expect(() => parseTrace(raw, "unsafe-choice", profile)).toThrow(/safe ITF integer/);
      });
      it("detects a corrupted model observation without changing execution", async () => {
        const trace = structuredClone(traces[0]!);
        trace.steps[1]!.expected.writes += 1;
        await expect(replay(profile, trace)).rejects.toThrow(/step 1 action.*\nexpected:.*\nactual:/s);
      });
    }
  });
}
if (single !== undefined && !Object.keys(profiles).some((name) => single.includes(`/${name}/`) || single.endsWith(`${name}-smoke.itf.json`))) {
  throw new Error("Single feature trace must be inside its recovery/policy/shadow profile directory");
}

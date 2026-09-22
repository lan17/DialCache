import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const url = new URL("../../formal/replay-inputs.mjs", import.meta.url).href;
const { normalizeReplayInputs, normalizeTraceFiles } = await import(url) as {
  normalizeReplayInputs(trace: unknown): Record<string, unknown>;
  normalizeTraceFiles(directory: string): number;
};
const integer = (text: string) => ({ "#bigint": text });
const fixture = () => ({
  vars: ["input", "s"],
  states: [
    { input: { name: "init", choice: integer("-1") }, s: { privateValue: 42, calls: [] } },
    { input: { name: "beginCall", choice: integer("0") }, s: { privateValue: 99, calls: [1] } },
  ],
});

describe("explicit Quint replay inputs", () => {
  it("uses declared commands independently of expected state and stale MBT metadata", () => {
    const trace = fixture();
    Object.assign(trace.states[1]!, { "mbt::actionTaken": "resolveLoader", "mbt::nondetPicks": { choice: integer("77") } });
    const observations = structuredClone(trace.states.map(state => state.s));
    const result = normalizeReplayInputs(trace) as unknown as {
      vars: string[]; states: Array<Record<string, unknown>>;
    };
    expect(result.states[1]!["mbt::actionTaken"]).toBe("beginCall");
    expect(result.states[1]!["mbt::nondetPicks"]).toEqual({ choice: { tag: "Some", value: integer("0") } });
    expect(result.states[0]!["mbt::nondetPicks"]).toEqual({ choice: { tag: "None", value: { "#tup": [] } } });
    expect(result.states.map(state => state.s)).toEqual(observations);
    expect(normalizeReplayInputs(result)).toEqual(result);
    expect(new Set(result.vars).size).toBe(result.vars.length);
  });

  it("rejects absent commands rather than inferring them from a changed observation", () => {
    const trace = fixture();
    delete (trace.states[1] as Partial<typeof trace.states[number]>).input;
    expect(() => normalizeReplayInputs(trace)).toThrow(/Invalid explicit input/);
  });

  it.each(["-2", "9007199254740992", "01", "-0", "1.5", "1e3", ""])("rejects noncanonical or unsafe choice %s", choice => {
    const trace = fixture();
    trace.states[1]!.input.choice = integer(choice);
    expect(() => normalizeReplayInputs(trace)).toThrow(/explicit choice/);
  });

  it.each([null, [], 0, "0", { "#bigint": 0 }, { "#bigint": "0", extra: true }])("rejects malformed choice %#", choice => {
    const trace = fixture();
    Object.assign(trace.states[1]!.input, { choice });
    expect(() => normalizeReplayInputs(trace)).toThrow(/explicit choice/);
  });

  it("rejects missing initialization, reinitialization, malformed states and extra input fields", () => {
    for (const index of [0, 1]) {
      const trace = fixture();
      trace.states[index]!.input.name = index === 0 ? "beginCall" : "init";
      expect(() => normalizeReplayInputs(trace)).toThrow(/Invalid explicit input/);
    }
    const trace = fixture();
    Object.assign(trace.states[1]!.input, { expectedResult: 1 });
    expect(() => normalizeReplayInputs(trace)).toThrow(/Invalid explicit input/);
    for (const states of [[], fixture().states.slice(0, 1), [null, fixture().states[1]], [fixture().states[0], []]]) {
      expect(() => normalizeReplayInputs({ states })).toThrow(/Replay requires|Invalid replay state/);
    }
    expect(() => normalizeReplayInputs(null)).toThrow(/Replay requires/);
  });
});

describe("trace directory normalization", () => {
  it("rewrites the simulator's action and choice annotations of every history in place from the explicit input record", () => {
    const folder = mkdtempSync(join(tmpdir(), "replay-inputs-normalize-"));
    const step = (name: string, choice: number, taken: string) => ({ input: { name, choice: integer(String(choice)) }, "mbt::actionTaken": taken, s: {} });
    const stale = { vars: ["input", "s", "mbt::actionTaken", "mbt::actionTaken"], states: [step("init", 2, "step"), step("beginCall", 0, "beginCall"), step("advance", -1, "advance")] };
    writeFileSync(join(folder, "trace_0.itf.json"), JSON.stringify(stale));
    writeFileSync(join(folder, "trace_1.itf.json"), JSON.stringify(stale));
    writeFileSync(join(folder, "notes.txt"), "ignored");
    expect(normalizeTraceFiles(folder)).toBe(2);
    for (const name of ["trace_0.itf.json", "trace_1.itf.json"]) {
      const text = readFileSync(join(folder, name), "utf8");
      expect(text.endsWith("\n")).toBe(true);
      const trace = JSON.parse(text) as { vars: string[]; states: Array<Record<string, unknown>> };
      expect(trace.states.map(state => state["mbt::actionTaken"])).toEqual(["init", "beginCall", "advance"]);
      expect(trace.states[2]!["mbt::nondetPicks"]).toEqual({ choice: { tag: "None", value: { "#tup": [] } } });
      expect(trace.vars).toEqual(["input", "s", "mbt::actionTaken", "mbt::nondetPicks"]);
    }
    expect(normalizeTraceFiles(folder)).toBe(2);
  });
});

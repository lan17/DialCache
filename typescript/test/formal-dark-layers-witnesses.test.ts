import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { darkLayersWitnesses, darkLayersWitnessRules } from "../../formal/replay/witnesses/dark-layers.mjs";
import { darkLayersProfile } from "../../formal/replay/profiles/dark-layers.mjs";
import { projectObservation } from "../../formal/replay/features.mjs";
import type { ObservedEvent } from "./formal/behavior-driver.js";
import { emptyObservation } from "../../formal/replay/observation.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/dark-layers-witnesses.json", import.meta.url), "utf8")) as Array<{
  regression: string;
  trace: { states: Array<{ s: { o: Record<string, unknown>; d: Record<string, unknown> } }> };
}>;
const integer = (value: number) => ({ "#bigint": String(value) });
function classify(trace: { states: unknown[] }): Set<string> {
  return darkLayersWitnesses([{ path: "trace.itf.json", states: trace.states }]);
}
function traceFor(name: string) {
  const rule = darkLayersWitnessRules.find(rule => rule.name === name)!;
  return structuredClone(fixtures.find(fixture => fixture.regression === rule.regression)!.trace);
}

describe("held dark-layer public witnesses", () => {
  for (const rule of darkLayersWitnessRules) {
    it(`requires each public checkpoint for ${rule.name}`, () => {
      const original = traceFor(rule.name);
      expect(classify(original).has(rule.name)).toBe(true);
      for (const checkpoint of rule.checkpoints) {
        const corrupted = structuredClone(original);
        const fields = Object.keys(checkpoint.observation).length ? checkpoint.observation : checkpoint.diagnostics!;
        const target = Object.keys(checkpoint.observation).length ? corrupted.states[checkpoint.step]!.s.o : corrupted.states[checkpoint.step]!.s.d;
        const key = Object.keys(fields)[0]!, value = target[key];
        target[key] = Array.isArray(value) ? (value.length ? [] : [integer(999)]) : integer(999);
        expect(classify(corrupted).has(rule.name)).toBe(false);
      }
    });
  }
  it("requires each snapshot field, including ownership and the replacement oldest age", () => {
    for (const rule of darkLayersWitnessRules.filter(rule => rule.name.startsWith("inspection-"))) {
      for (const checkpoint of rule.checkpoints) {
        const original = traceFor(rule.name);
        const snapshots = original.states[checkpoint.step]!.s.d.inspections as Array<Record<string, unknown>>;
        for (const field of ["instance", "activeLeaders", "activeFollowers", "oldestLeaderAgeMs"]) {
          const corrupted = structuredClone(original);
          const actual = (corrupted.states[checkpoint.step]!.s.d.inspections as Array<Record<string, unknown>>).at(-1)!;
          actual[field] = integer(999);
          expect(classify(corrupted).has(rule.name), `${rule.name} step ${checkpoint.step} ${field}`).toBe(false);
        }
        expect(snapshots.length).toBeGreaterThan(0);
      }
    }
  });
  it("treats snapshot record member order as immaterial", () => {
    const name = "inspection-counts-process-followers-and-oldest", trace = traceFor(name);
    for (const state of trace.states) {
      state.s.d.inspections = (state.s.d.inspections as Array<Record<string, unknown>>).map(snapshot => Object.fromEntries(Object.entries(snapshot).reverse()));
    }
    expect(classify(trace).has(name)).toBe(true);
  });
  it("projects only the actual public snapshot and rejects malformed numeric fields", () => {
    const snapshot: ObservedEvent = { event: "coalescingState", instance: "0", activeLeaders: 1, activeFollowers: 2, oldestLeaderAgeMs: 3 };
    const observed = { ...emptyObservation(), events: [snapshot] };
    expect(projectObservation(darkLayersProfile, observed)).toMatchObject({ d: { inspections: [{ instance: 0, activeLeaders: 1, activeFollowers: 2, oldestLeaderAgeMs: 3 }] } });
    snapshot.activeLeaders = 0;
    snapshot.activeFollowers = 0;
    snapshot.oldestLeaderAgeMs = null;
    expect(projectObservation(darkLayersProfile, observed)).toMatchObject({ d: { inspections: [{ instance: 0, activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null }] } });
    for (const [field, value] of [["activeLeaders", -1], ["activeFollowers", 0.5], ["oldestLeaderAgeMs", Number.NaN], ["instance", "other"]] as const) {
      expect(() => projectObservation(darkLayersProfile, { ...emptyObservation(), events: [{ ...snapshot, [field]: value }] })).toThrow(/Malformed actual coalescing inspection/);
    }
  });
  it("does not credit the strict fill fence when serialization starts", () => {
    const name = "dark-fill-at-watermark-is-fenced", trace = traceFor(name);
    trace.states[5]!.s.o.dumps = integer(1);
    expect(classify(trace).has(name)).toBe(false);
  });
  it("does not credit source-error isolation when dark work decodes or fills", () => {
    const name = "rejected-dark-source-seeds-no-layer";
    for (const field of ["loads", "dumps", "writes"]) {
      const trace = traceFor(name);
      trace.states[4]!.s.o[field] = integer(1);
      expect(classify(trace).has(name)).toBe(false);
    }
  });
  it("requires the later dark read's captured watermark to stop its fill", () => {
    const name = "stale-visible-dark-c0-fills-unfenced", trace = traceFor(name);
    trace.states[11]!.s.o.shadow = ["filled", "filled"];
    expect(classify(trace).has(name)).toBe(false);
  });
  it("requires both denied admission and later released capacity for every held effect", () => {
    for (const rule of darkLayersWitnessRules.filter(rule => rule.name.startsWith("timed-out-dark-"))) {
      const dropped = rule.checkpoints[1]!, readmitted = rule.checkpoints.at(-1)!;
      const early = traceFor(rule.name);
      early.states[dropped.step]!.s.o.reads = integer(Number(dropped.observation.reads) + 1);
      expect(classify(early).has(rule.name)).toBe(false);
      const leaked = traceFor(rule.name);
      leaked.states[readmitted.step]!.s.o.reads = integer(Number(readmitted.observation.reads) - 1);
      expect(classify(leaked).has(rule.name)).toBe(false);
    }
  });
  it("requires the profile's diagnostic identity and keeps the existing default", () => {
    const observed = { ...emptyObservation(), events: [{ event: "coalesced" as const, cacheNamespace: "urn", keyType: "id", useCase: "DarkLayers", scope: "request_local" }] };
    expect(projectObservation(darkLayersProfile, observed)).toMatchObject({ d: { coalesced: ["request_local"] } });
    expect(() => projectObservation({ ...darkLayersProfile, diagnosticUseCase: "Behavior" }, observed)).toThrow();
    observed.events[0]!.useCase = "Behavior";
    const { diagnosticUseCase: _identity, ...defaultIdentity } = darkLayersProfile;
    expect(projectObservation(defaultIdentity, observed)).toMatchObject({ d: { coalesced: ["request_local"] } });
  });
});

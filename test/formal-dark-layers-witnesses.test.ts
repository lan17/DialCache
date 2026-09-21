import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { darkLayersWitnesses, darkLayersWitnessRules } from "../formal/replay/witnesses/dark-layers.mjs";
import { darkLayersProfile } from "../formal/replay/profiles/dark-layers.mjs";
import { projectObservation } from "../formal/replay/features.mjs";
import { emptyObservation } from "../formal/replay/observation.mjs";

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
  it("requires the profile's diagnostic identity and keeps the existing default", () => {
    const observed = { ...emptyObservation(), events: [{ event: "coalesced" as const, cacheNamespace: "urn", keyType: "id", useCase: "DarkLayers", scope: "request_local" }] };
    expect(projectObservation(darkLayersProfile, observed)).toMatchObject({ d: { coalesced: ["request_local"] } });
    expect(() => projectObservation({ ...darkLayersProfile, diagnosticUseCase: "Behavior" }, observed)).toThrow();
    observed.events[0]!.useCase = "Behavior";
    const { diagnosticUseCase: _identity, ...defaultIdentity } = darkLayersProfile;
    expect(projectObservation(defaultIdentity, observed)).toMatchObject({ d: { coalesced: ["request_local"] } });
  });
});

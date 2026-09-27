import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deletionWitnessRules, deletionWitnesses } from "../../formal/replay/witnesses/deletion.mjs";

interface Trace { states: Array<{ input: { name: string; choice: unknown }; s: { o: Record<string, unknown> } }> }
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/deletion-witnesses.json", import.meta.url), "utf8")) as Array<{ regression: string; trace: Trace }>;
function classified(name: string, trace: Trace): boolean {
  return deletionWitnesses([{ path: "trace.itf.json", states: trace.states }]).has(name);
}

describe("exact deletion witness boundaries", () => {
  for (const rule of deletionWitnessRules) {
    it(`requires every public checkpoint and delete identity for ${rule.name}`, () => {
      const original = fixtures.find(fixture => fixture.regression === rule.regression)!.trace;
      expect(classified(rule.name, original)).toBe(true);
      for (const checkpoint of rule.checkpoints) {
        const changed = structuredClone(original);
        changed.states[checkpoint.step]!.s.o = {};
        expect(classified(rule.name, changed)).toBe(false);
      }
      const wrongKey = structuredClone(original);
      wrongKey.states.find(state => state.input.name === "deleteEntry")!.input.choice = { "#bigint": "27" };
      expect(classified(rule.name, wrongKey)).toBe(false);
    });
  }
  it("requires an acquired snapshot to remain pending until after delete", () => {
    const trace = structuredClone(fixtures.find(fixture => fixture.regression === "acquiredReadAfterDeleteStillReturnsTest")!.trace);
    trace.states[3]!.s.o.calls = [{ "#bigint": "1" }];
    expect(classified("acquired-snapshot-completes-after-delete", trace)).toBe(false);
  });
  it("requires the second caller to retain the existing flight after delete", () => {
    const trace = structuredClone(fixtures.find(fixture => fixture.regression === "lateFillAfterDeleteRepopulatesTest")!.trace);
    trace.states[3]!.s.o.loaders = { "#bigint": "2" };
    expect(classified("late-fill-remains-shared-and-repopulates", trace)).toBe(false);
  });
});

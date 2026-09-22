import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recoveryAdmissionWitnessRules, recoveryAdmissionWitnesses } from "../../formal/replay/witnesses/recovery-admission.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/recovery-admission-witnesses.json", import.meta.url), "utf8")) as Array<{
  regression: string;
  trace: { states: Array<{ input: { name: string; choice: unknown }; s: { o: Record<string, unknown> } }> };
}>;
const integer = (value: number) => ({ "#bigint": String(value) });
function traceFor(name: string) {
  const rule = recoveryAdmissionWitnessRules.find(rule => rule.name === name)!;
  return structuredClone(fixtures.find(fixture => fixture.regression === rule.regression)!.trace);
}
function classified(name: string, trace: { states: unknown[] }): boolean {
  return recoveryAdmissionWitnesses([{ path: "trace.itf.json", states: trace.states }]).has(name);
}

// These altered public observations challenge witness attribution; they never
// enter the portable behavioral baseline or count as fault-detection evidence.
describe("recovery shadow witness attribution boundaries", () => {
  for (const rule of recoveryAdmissionWitnessRules) {
    it(`requires recovered results and effects for ${rule.name}`, () => {
      const original = traceFor(rule.name);
      expect(classified(rule.name, original)).toBe(true);
      for (const checkpoint of rule.checkpoints) {
        const changed = structuredClone(original);
        changed.states[checkpoint.step]!.s.o = {};
        expect(classified(rule.name, changed)).toBe(false);
      }
    });
  }
  const absence = "recovered-absence-skips-selected-shadow-and-memoizes";
  it("requires a selected shadow fixture rather than shadow disabled", () => {
    const trace = traceFor(absence);
    trace.states[0]!.input.choice = integer(1);
    expect(classified(absence, trace)).toBe(false);
  });
  it("rejects a detached source even before it emits a shadow outcome", () => {
    const trace = traceFor(absence);
    trace.states[5]!.s.o.loaders = integer(2);
    expect(classified(absence, trace)).toBe(false);
  });
  it("distinguishes recovered absence from null", () => {
    const trace = traceFor(absence);
    trace.states[5]!.s.o.calls = [integer(6)];
    expect(classified(absence, trace)).toBe(false);
  });
  it("requires the separate request to repeat recovery instead of using shared publication", () => {
    const trace = traceFor(absence);
    trace.states[10]!.s.o.loaders = integer(1);
    trace.states[10]!.s.o.reads = integer(1);
    expect(classified(absence, trace)).toBe(false);
  });
});

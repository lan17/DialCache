import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { admissionWitnesses } from "../formal/replay/witnesses/admission.mjs";
import { parseTrace, profiles } from "../formal/replay/features.mjs";
import { witnessStates } from "../formal/replay/witnesses/trace.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/admission-budget-witnesses.json", import.meta.url), "utf8")) as Array<{
  trace: { states: Array<{ input: { name: string; choice: unknown }; s: { o: Record<string, unknown> } }> };
}>;
const label = "later-served-shadow-keeps-own-job-budget";
const integer = (value: number) => ({ "#bigint": String(value) });
function trace() {
  // Classify explicit commands; simulator metadata is not witness evidence.
  const copy = structuredClone(fixtures[0]!.trace);
  return { states: copy.states.map(({ input, s }) => ({ input, s })) };
}
function classified(raw: ReturnType<typeof trace>): boolean {
  return admissionWitnesses([{ ...parseTrace(raw, "trace.itf.json", profiles.admission!),
    ...witnessStates(raw, "trace.itf.json") }]).has(label);
}

describe("later admitted shadow budget witness", () => {
  it("requires the later start, preserved caller and source-error outcome", () => {
    expect(classified(trace())).toBe(true);
    const tooEarly = trace();
    tooEarly.states[1]!.input.choice = integer(1);
    expect(classified(tooEarly)).toBe(false);
    for (const step of [5, 6]) {
      const wrongCaller = trace();
      wrongCaller.states[step]!.s.o.calls = [integer(4)];
      expect(classified(wrongCaller)).toBe(false);
    }
    const earlyTimeout = trace();
    earlyTimeout.states[5]!.s.o.shadow = ["timeout"];
    expect(classified(earlyTimeout)).toBe(false);
    const wrongVerdict = trace();
    wrongVerdict.states[6]!.s.o.shadow = ["timeout"];
    expect(classified(wrongVerdict)).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shadowReadDeadlinesWitnesses, shadowReadDeadlinesWitnessRules } from "../formal/replay/witnesses/shadow-read-deadlines.mjs";

type PublicState = { o: Record<string, unknown>; d: Record<string, unknown>; io: Record<string, unknown> };
type Trace = { states: Array<{ input: { name: string; choice: unknown }; s: PublicState }> };
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/shadow-read-deadlines-witnesses.json", import.meta.url), "utf8")) as Array<{ regression: string; trace: Trace }>;
const integer = (value: number) => ({ "#bigint": String(value) });
function traceFor(name: string) {
  const rule = shadowReadDeadlinesWitnessRules.find(rule => rule.name === name)!;
  return structuredClone(fixtures.find(fixture => fixture.regression === rule.regression)!.trace);
}
function credited(name: string, trace: Trace) {
  return shadowReadDeadlinesWitnesses([{ path: "renamed.itf.json", states: trace.states }]).has(name);
}

describe("separate shadow read deadline witness boundaries", () => {
  for (const rule of shadowReadDeadlinesWitnessRules) {
    it(`requires every public consequence for ${rule.name}`, () => {
      const original = traceFor(rule.name);
      expect(credited(rule.name, original)).toBe(true);
      // Corrupt every required output independently, including empty lists:
      // cancellations and budgets must be evidence, not incidental metadata.
      for (const checkpoint of rule.checkpoints) {
        for (const [channel, fields] of [["o", checkpoint.observation], ["d", checkpoint.diagnostics], ["io", checkpoint.io]] as const) {
          for (const field of Object.keys(fields ?? {})) {
            const changed = structuredClone(original);
            delete changed.states[checkpoint.step]!.s[channel][field];
            expect(credited(rule.name, changed), `${channel}.${field} at ${checkpoint.step}`).toBe(false);
          }
        }
      }
    });
  }
  it("rejects C1 taking a new runtime read budget", () => {
    const name = "confirmation-keeps-captured-read-budget", trace = traceFor(name);
    trace.states[6]!.s.io.budgets = [5, 20].map(integer);
    expect(credited(name, trace)).toBe(false);
  });
  it("rejects cancellation before C1 has spent its own budget", () => {
    const name = "confirmation-read-budget-starts-at-dispatch", trace = traceFor(name);
    trace.states[7]!.s.io.aborted = [integer(1)];
    expect(credited(name, trace)).toBe(false);
  });
  it("rejects a second verdict after the job deadline", () => {
    const name = "job-then-read-timeout-has-one-verdict", trace = traceFor(name);
    trace.states[7]!.s.o.shadow = ["timeout", "dropped", "redis_error"];
    expect(credited(name, trace)).toBe(false);
  });
});

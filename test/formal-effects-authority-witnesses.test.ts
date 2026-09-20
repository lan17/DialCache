import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTrace, type Trace } from "../formal/replay/effects.mjs";
import { effectsAuthorityRules, effectsAuthorityWitnesses } from "../formal/replay/witnesses/effects-authority.mjs";

// Public excerpts of real Quint regressions, used solely as classifier controls.
// These tests do not add behavioral examples or mutation assertion detections.
// The controls parse each excerpt as the classifiers do and edit the asserted
// observation (`expected`), the record every rule reads.
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/effects-authority-witnesses.json", import.meta.url), "utf8")) as Array<{
  regression: string; trace: unknown;
}>;
function traceFor(name: string): Trace {
  const regression = effectsAuthorityRules.find(rule => rule.name === name)!.regression;
  return parseTrace(structuredClone(fixtures.find(fixture => fixture.regression === regression)!.trace), "trace.itf.json");
}
const classify = (trace: Trace) => effectsAuthorityWitnesses([trace]);
describe("effects authority witness controls", () => {
  for (const rule of effectsAuthorityRules) it(`requires the actual consequence for ${rule.name}`, () => {
    const trace = traceFor(rule.name);
    expect(classify(trace).has(rule.name)).toBe(true);
    trace.steps.at(-1)!.expected.calls = [0];
    expect(classify(trace).has(rule.name)).toBe(false);
  });
  it("requires a cache hit after the intervening fence, even when the initial source succeeds", () => {
    const name = "write-stamp-after-serialization", trace = traceFor(name);
    trace.steps.at(-1)!.expected.loaders = 2;
    trace.steps.at(-1)!.expected.loads = 0;
    expect(classify(trace).has(name)).toBe(false);
  });
  it("rejects a wrong observing layer with the same positive offset", () => {
    const name = "future-offset-observing-layer-positive-seconds", trace = traceFor(name);
    trace.steps.at(-1)!.expected.events.find(event => event.event === "futureOffset")!.location = "remote_shadow";
    expect(classify(trace).has(name)).toBe(false);
  });
  it("rejects a zero offset at the right observing layer", () => {
    const name = "future-offset-observing-layer-positive-seconds", trace = traceFor(name);
    trace.steps.at(-1)!.expected.events.find(event => event.event === "futureOffset")!.amount = 0;
    expect(classify(trace).has(name)).toBe(false);
  });
  it("rejects duplicated leader errors despite matching caller errors", () => {
    const name = "shared-failure-preserves-leader-and-follower-trail", trace = traceFor(name);
    const events = trace.steps.at(-1)!.expected.events;
    events.push(structuredClone(events.find(event => event.event === "error")!));
    expect(classify(trace).has(name)).toBe(false);
  });
});

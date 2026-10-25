import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseTrace, profiles, projectObservation } from "../../formal/replay/features.mjs";
import { shadowWitnesses } from "../../formal/replay/witnesses/shadow.mjs";
import { witnessStates } from "../../formal/replay/witnesses/trace.mjs";
import { emptyObservation, type Observation, type ObservedEvent } from "./formal/behavior-driver.js";
import { replayThroughCoordinator } from "./formal/coordinated-replay.js";

// Negative controls for the shadow profile's warning content (record D12):
// the d channel parser, the projection of a driver's mismatchWarning and
// shadowMismatchLogging events, the classifier labels that credit a warning,
// and the TypeScript replay of the Quint regressions that pin them. The
// histories are the committed Quint excerpts of the regressions; the
// corruptions below receive no conformance or mutation credit.
type State = { input: { name: string; choice: unknown }; s: { o: Record<string, unknown>; d: Record<string, unknown> } };
type Fixture = { regression: string; trace: { states: State[] } };
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/shadow-diagnostics-witnesses.json", import.meta.url), "utf8")) as Fixture[];
const integer = (value: number) => ({ "#bigint": String(value) });
const shadow = profiles.shadow!;
// A history's states with the optional simulator annotations dropped, so an
// edited explicit input stays the one authoritative command (PORTING.md).
function statesOf(regression: string): State[] {
  const fixture = fixtures.find(item => item.regression === regression);
  if (fixture === undefined) throw new Error(`Missing fixture ${regression}`);
  return structuredClone(fixture.trace.states).map(state =>
    Object.fromEntries(Object.entries(state).filter(([key]) => !key.startsWith("mbt::"))) as State);
}
function labels(states: State[]): Set<string> {
  const raw = { states }, path = "trace.itf.json";
  return shadowWitnesses([{ ...parseTrace(raw, path, shadow), ...witnessStates(raw, path) }]);
}
// The final step's d channel, edited in place.
function finalDiagnostics(states: State[]): Record<string, unknown> { return states.at(-1)!.s.d; }
type Warning = Record<string, unknown>;
function finalWarning(states: State[]): Warning {
  return (finalDiagnostics(states).mismatchWarnings as Warning[])[0]!;
}

describe("shadow warning witness labels", () => {
  it("credits each failure outcome from the public outcome, not the inputs alone", () => {
    const states = statesOf("hookErrorNullsDiffFieldsTest");
    expect(labels(states)).toContain("logging-outcome:hook_error");
    finalDiagnostics(states).loggingOutcomes = ["logged"];
    const changed = labels(states);
    expect(changed).not.toContain("logging-outcome:hook_error");
    expect(changed).toContain("logging-outcome:logged");
  });

  it("requires every failure input for a precedence witness", () => {
    const states = statesOf("hookErrorOutranksBothFailuresTest");
    const original = labels(states);
    expect(original).toContain("hook-error-over-render-error");
    expect(original).toContain("hook-error-over-logger-error");
    // The same public history with the logger's fault turned off at its input.
    const loggerFault = states.findIndex(state => state.input.name === "loggerFault");
    states[loggerFault]!.input.choice = integer(0);
    const withoutLoggerFault = labels(states);
    expect(withoutLoggerFault).toContain("hook-error-over-render-error");
    expect(withoutLoggerFault).not.toContain("hook-error-over-logger-error");
  });

  it("requires the null source field for an unrenderable source", () => {
    const states = statesOf("renderErrorNullsUnrenderableSourceTest");
    expect(labels(states)).toContain("unrenderable-source-logs-null");
    finalWarning(states).sourceValue = integer(2);
    expect(labels(states)).not.toContain("unrenderable-source-logs-null");
  });

  it("requires the field groups a shorthand row captures", () => {
    const row1 = statesOf("trueShorthandWithValueFalseLogsDiffOnlyTest");
    expect(labels(row1)).toContain("shorthand-row:1");
    finalWarning(row1).cachedValue = integer(1);
    finalWarning(row1).sourceValue = integer(2);
    expect(labels(row1)).not.toContain("shorthand-row:1");
    const row3 = statesOf("runtimeFalseShorthandOverridesDefaultDiffTest");
    expect(labels(row3)).toContain("shorthand-row:3");
    finalDiagnostics(row3).mismatchWarnings = [finalWarning(statesOf("runtimeTrueShorthandOverridesDefaultValueTest"))];
    finalDiagnostics(row3).loggingOutcomes = ["logged"];
    finalDiagnostics(row3).warnings = integer(1);
    expect(labels(row3)).not.toContain("shorthand-row:3");
  });

  it("requires the logged content beside a logger failure", () => {
    const states = statesOf("loggerErrorStillDeliversWarningTest");
    expect(labels(states)).toContain("logger-error-keeps-warning-content");
    finalWarning(states).diffNull = true;
    expect(labels(states)).not.toContain("logger-error-keeps-warning-content");
  });
});

describe("shadow d channel parser", () => {
  it("requires both warning lists for the profile that asserts them", () => {
    const states = statesOf("hookErrorNullsDiffFieldsTest");
    expect(parseTrace({ states }, "trace", shadow).steps.at(-1)!.diagnostics!.loggingOutcomes).toEqual(["hook_error"]);
    delete finalDiagnostics(states).mismatchWarnings;
    expect(() => parseTrace({ states }, "trace", shadow)).toThrow(/invalid diagnostics/);
  });

  it("rejects a warning record outside the shared shape", () => {
    const states = statesOf("hookErrorNullsDiffFieldsTest");
    finalWarning(states).cacheKey = "urn:id:1#Behavior";
    expect(() => parseTrace({ states }, "trace", shadow)).toThrow(/invalid mismatch warning/);
    const unknownOutcome = statesOf("hookErrorNullsDiffFieldsTest");
    finalWarning(unknownOutcome).loggingOutcome = "logger_error";
    expect(() => parseTrace({ states: unknownOutcome }, "trace", shadow)).toThrow(/invalid mismatch warning/);
  });

  it("accepts the lists absent or empty, and only so, for a profile that does not assert them", () => {
    const raw = JSON.parse(readFileSync(new URL("../../formal/generated/dark-layers-smoke.itf.json", import.meta.url), "utf8")) as { states: State[] };
    const darkLayers = profiles["dark-layers"]!;
    expect(raw.states[0]!.s.d).not.toHaveProperty("mismatchWarnings");
    const absent = parseTrace(structuredClone(raw), "absent", darkLayers);
    for (const state of raw.states) Object.assign(state.s.d, { mismatchWarnings: [], loggingOutcomes: [] });
    const empty = parseTrace(structuredClone(raw), "empty", darkLayers);
    expect(empty.steps.map(step => step.diagnostics)).toEqual(absent.steps.map(step => step.diagnostics));
    expect(empty.steps[0]!.diagnostics).not.toHaveProperty("mismatchWarnings");
    raw.states[1]!.s.d.loggingOutcomes = ["logged"];
    expect(() => parseTrace(raw, "carried", darkLayers)).toThrow(/invalid diagnostics/);
  });
});

describe("shadow warning projection", () => {
  const labels = { cacheNamespace: "urn", useCase: "Behavior", keyType: "id" };
  const warning = (fields: Record<string, unknown>): ObservedEvent => ({ event: "mismatchWarning", ...labels, outcome: "mismatch",
    cacheKey: "urn:id:1#Behavior", cachedValueAgeSeconds: 0, ...fields } as ObservedEvent);
  const observed = (event: ObservedEvent, outcome = "logged"): Observation => ({
    ...emptyObservation({ policy: {}, observe: [] }), calls: [{ status: "value", value: 2 }], shadow: ["mismatch"],
    events: [{ event: "shadowAge", ...labels, outcome: "mismatch", seconds: 0 }, event,
      { event: "shadowMismatchLogging", ...labels, outcome } as ObservedEvent],
  });
  const projected = (event: ObservedEvent, outcome?: string) =>
    (projectObservation(shadow, observed(event, outcome)).d as { mismatchWarnings: unknown[]; loggingOutcomes: string[] });
  const everything = { mismatchPathsJson: "[\"\"]", mismatchPathCount: 1, diffJson: "[{\"path\":\"\",\"cached\":1,\"source\":2}]",
    cachedValueJson: "1", sourceValueJson: "2" };

  it("projects the warning's fields as parsed JSON and its one outcome", () => {
    expect(projected(warning(everything))).toEqual({ ...projected(warning(everything)), loggingOutcomes: ["logged"], mismatchWarnings: [{
      ageSeconds: 0, cachedValue: 1, sourceValue: 2, diff: "values", diffNull: false, count: 1, paths: [""],
      entries: [{ path: "", cached: 1, source: 2 }], loggingOutcome: "",
    }] });
    // Rendering text is a native detail: a port's spelling of the same JSON projects alike.
    expect(projected(warning({ ...everything, diffJson: "[ {\"source\": 2, \"path\": \"\", \"cached\": 1} ]" })).mismatchWarnings)
      .toEqual(projected(warning(everything)).mismatchWarnings);
    expect(projected(warning({ mismatchPathsJson: null, mismatchPathCount: null, diffJson: null, loggingOutcome: "hook_error" }), "hook_error"))
      .toMatchObject({ loggingOutcomes: ["hook_error"], mismatchWarnings: [{ diff: "values", diffNull: true, cachedValue: -1, paths: [], entries: [] }] });
  });

  it("refuses diff fields that are not carried together or not null together", () => {
    expect(() => projected(warning({ ...everything, diffJson: null }))).toThrow(/observed value domain/);
    expect(() => projected(warning({ diffJson: "[]" }))).toThrow(/observed value domain/);
    expect(() => projected(warning({ mismatchPathsJson: "[]" }))).toThrow(/observed value domain/);
    expect(() => projected(warning({ ...everything, mismatchPathsJson: "not json" }))).toThrow(/observed value domain/);
  });

  it("refuses a value outside the profile's domain and a warning without its age", () => {
    expect(() => projected(warning({ cachedValueJson: "{\"a\":1}", sourceValueJson: "2" }))).toThrow(/observed value domain/);
    const { cachedValueAgeSeconds: _age, ...withoutAge } = warning(everything);
    expect(() => projected(withoutAge as ObservedEvent)).toThrow(/Missing actual warning age/);
  });

  it("keeps a missing entry side apart from a null one", () => {
    const sides = (diffJson: string) => (projected(warning({ ...everything, diffJson })).mismatchWarnings[0] as { entries: unknown[] }).entries;
    expect(sides("[{\"path\":\"\",\"source\":2}]")).toEqual([{ path: "", cached: -1, source: 2 }]);
    expect(sides("[{\"path\":\"\",\"cached\":null,\"source\":2}]")).toEqual([{ path: "", cached: 6, source: 2 }]);
  });
});

describe("shadow warning regressions replayed in TypeScript", () => {
  const directory = mkdtempSync(join(tmpdir(), "dialcache-shadow-warning-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const write = (name: string, states: State[]) => {
    const path = join(directory, `${name}.itf.json`);
    writeFileSync(path, JSON.stringify({ states }));
    return path;
  };

  for (const fixture of fixtures) it(`replays ${fixture.regression}`, async () => {
    await expect(replayThroughCoordinator("shadow", write(fixture.regression, structuredClone(fixture.trace.states)))).resolves.toMatchObject({});
  });

  it("detects a logger that did not fail where the history says it did", async () => {
    const states = statesOf("loggerErrorStillDeliversWarningTest");
    states.find(state => state.input.name === "loggerFault")!.input.choice = integer(0);
    await expect(replayThroughCoordinator("shadow", write("loggerOff", states))).rejects.toThrow(/expected[\s\S]*actual/);
  });

  it("detects a source that rendered where the history says it had no rendering", async () => {
    // The caller's result follows the changed input, so only the warning and
    // its outcome still claim the unrenderable source.
    const states = statesOf("renderErrorNullsUnrenderableSourceTest");
    const resolved = states.findIndex(state => state.input.name === "resolveLoader");
    states[resolved]!.input.choice = integer(2);
    for (const state of states.slice(resolved)) state.s.o.calls = [integer(2)];
    await expect(replayThroughCoordinator("shadow", write("rendered", states))).rejects.toThrow(/expected[\s\S]*actual/);
  });

  it("detects a diff hook that did not run where the history says it threw", async () => {
    // Fixture 4 is fixture 13 without the hook: the same calls and verdicts.
    const states = statesOf("hookErrorNullsDiffFieldsTest");
    states[0]!.input.choice = integer(4);
    await expect(replayThroughCoordinator("shadow", write("noHook", states))).rejects.toThrow(/expected[\s\S]*actual/);
  });
});

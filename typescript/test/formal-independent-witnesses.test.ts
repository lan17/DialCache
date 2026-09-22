import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseTrace, profiles } from "../../formal/replay/features.mjs";
import { independentSourceDeadlineWitnesses, independentWitnesses } from "../../formal/replay/witnesses/independent.mjs";
import { createWitnessRecorder, standaloneRecorder } from "../../formal/replay/witnesses/recorder.mjs";
import { witnessStates } from "../../formal/replay/witnesses/trace.mjs";

type Integer = { "#bigint": string };
interface Observation { calls: Integer[]; loaders: Integer; loads: Integer; writes: Integer; dumps: Integer; writeTtls: Integer[]; invalidations: Integer; maintenance: string[]; classifications: Integer; recovery: string[]; [field: string]: unknown }
interface ReadIO { budgets: Integer[]; aborted: Integer[]; sourceErrors: Integer[] }
interface State { input: { name: string; choice: Integer }; "mbt::actionTaken"?: string; "mbt::nondetPicks"?: unknown; s: { o: Observation; io: ReadIO } }
interface History { source: { model: string; recipe: string }; states: State[] }
interface PrivateState { input: { name: string; choice: Integer }; s: Record<string, unknown> }
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/independent-witnesses.json", import.meta.url), "utf8")) as Record<string, History>;
// The same model's walk projected with its private layout, for the fidelity check.
const predictedFixtures = JSON.parse(readFileSync(new URL("./fixtures/independent-shadow-witnesses.json", import.meta.url), "utf8")) as Record<string, { source: { model: string }; states: PrivateState[] }>;
const independent = profiles.independent!;
const survives = "later-source-survives-earlier-deadline", ownDeadline = "later-source-expires-at-own-deadline";
const staggeredSettle = "staggeredSourceStartsKeepIndependentBudgetsTest", staggeredExpire = "staggeredSourcesExpireAtTheirOwnDeadlineTest";
const separateDeadlines = "independentReadDeadlinesStartSeparateSourcesTest", timedOutRead = "timedOutReadCannotAffectAnotherCallTest";
const refill = "readFailureCannotBorrowAnotherCallsRefillTest", ageBoundary = "independentRecoveryAtCapturedAgeBoundaryTest";
const distinctSnapshots = "independentRecoveriesServeDistinctAcquiredSnapshotsTest", freshDecode = "acquiredFreshDecodeSurvivesInvalidation";
const lateSource = "lateSourceDoesNotAffectOtherCall", failedRecovery = "failedRecoveryKeepsSourceError";

// The fixtures are public Quint runs of the independent model projected to the
// recorded inputs, the observation and the read IO a driver is asserted
// against. The classifiers have nothing else to read; a probe that changes one
// recorded input or result must lose the label, or be refused as a
// contradiction.
function history(name: string): State[] {
  const fixture = fixtures[name];
  if (fixture === undefined) throw new Error(`Missing independent witness fixture ${name}`);
  return structuredClone(fixture.states);
}
function witnesses(name: string, states: State[]) {
  const recorder = standaloneRecorder(name);
  independentSourceDeadlineWitnesses(name, parseTrace({ states }, name, independent).steps, recorder);
  return { labels: recorder.labels(), provenance: recorder.provenance() };
}
// Every independent witness of one history, loaded as the corpus evaluator
// loads it, keyed by label with the checkpoints that earned it; the action
// labels every history earns are left out.
function evaluate(name: string, states: State[]): Record<string, number[]> {
  const recorder = createWitnessRecorder();
  independentWitnesses([{ ...parseTrace({ states }, name, independent), ...witnessStates({ states }, name) }], recorder);
  const checkpoints: Record<string, number[]> = {};
  for (const [label, histories] of Object.entries(recorder.provenance())) if (!label.startsWith("action:")) checkpoints[label] = histories[0]!.checkpoints;
  return checkpoints;
}
const integer = (value: number): Integer => ({ "#bigint": String(value) });
const integers = (...values: number[]): Integer[] => values.map(integer);
const nth = (states: State[], action: string, index = 0): State => {
  const state = states.filter(candidate => candidate.input.name === action)[index];
  if (state === undefined) throw new Error(`No ${action} input #${index}`);
  return state;
};
// Re-record an input's choice. The simulator annotation must agree with the record.
function rechoose(state: State, choice: number): void {
  state.input.choice = integer(choice);
  state["mbt::nondetPicks"] = { choice: { tag: "Some", value: integer(choice) } };
}
// Re-record a step as another action with its choice.
function rename(state: State, action: string, choice: number): void {
  state.input.name = action;
  state["mbt::actionTaken"] = action;
  rechoose(state, choice);
}
// Re-record one caller's result from a state onward, so the history stays settled.
function resettle(states: State[], from: State, caller: number, result: number): void {
  for (const state of states.slice(states.indexOf(from))) state.s.o.calls[caller] = integer(result);
}
// Re-record public fields from a state onward, so the history stays consistent with an edited input.
function patch(states: State[], from: State, mutate: (s: State["s"]) => void): void {
  for (const state of states.slice(states.indexOf(from))) mutate(state.s);
}
// Drop a recorded step; the caller re-records what it had changed in the later states.
function drop(states: State[], state: State): void {
  states.splice(states.indexOf(state), 1);
}
// Record another step right after a state: its copy, re-recorded as the given action.
function insertAfter(states: State[], after: State, action: string, choice: number, mutate: (s: State["s"]) => void = () => {}): State {
  const inserted = structuredClone(after);
  rename(inserted, action, choice);
  mutate(inserted.s);
  states.splice(states.indexOf(after) + 1, 0, inserted);
  return inserted;
}

describe("independent source-budget witnesses from inputs and public observations", () => {
  it("reads fixtures that carry only the recorded input, the asserted observation and read IO", () => {
    for (const [name, fixture] of Object.entries(fixtures)) {
      expect(fixture.source.model, name).toBe("formal/dialcache-independent-conformance.qnt");
      for (const state of fixture.states) expect(Object.keys(state.s).sort(), name).toEqual(["io", "o"]);
    }
  });

  it("credits the later source that settles after the earlier deadline", () => {
    const { labels, provenance } = witnesses(staggeredSettle, history(staggeredSettle));
    expect([...labels]).toEqual([survives]);
    expect(provenance[survives]).toEqual([{ name: staggeredSettle, checkpoints: [9] }]);
  });

  it("credits the later source that expires at its own deadline", () => {
    const { labels, provenance } = witnesses(staggeredExpire, history(staggeredExpire));
    expect([...labels]).toEqual([ownDeadline]);
    expect(provenance[ownDeadline]).toEqual([{ name: staggeredExpire, checkpoints: [12] }]);
  });

  it("does not credit a later source that has not settled", () => {
    const states = history(staggeredSettle);
    states.pop();
    expect(witnesses("probe", states).labels.size).toBe(0);
  });

  it("does not credit a later source before the advance that delivers its own deadline", () => {
    const states = history(staggeredExpire);
    states.pop();
    expect(witnesses("probe", states).labels.size).toBe(0);
  });

  it("refuses a deadline error recorded ahead of the shadowed clock", () => {
    const states = history(staggeredSettle);
    rechoose(nth(states, "advance"), 1);
    expect(() => witnesses("probe", states)).toThrow(/caller 0 deadline 10 after now 6/);
  });

  it.each([staggeredSettle, staggeredExpire])("does not treat a source error at the expiring advance as an earlier deadline: %s", name => {
    const states = history(name);
    resettle(states, nth(states, "advance", 1), 0, 3);
    expect(witnesses("probe", states).labels.size).toBe(0);
  });

  // The independence clauses: the later source must have started inside the
  // earlier budget, and its own deadline must be delivered by the advance that
  // crosses it. Start the later source at the earlier deadline instead.
  it.each([[staggeredExpire, ownDeadline], [staggeredSettle, survives]])("does not credit a later source that starts at the earlier deadline: %s", (name, label) => {
    const states = history(name);
    const first = nth(states, "advance");
    rechoose(first, 10);
    resettle(states, first, 0, 4);
    expect(witnesses("probe", states).labels.has(label)).toBe(false);
  });

  it("does not credit an own-deadline error that surfaces after the crossing advance", () => {
    const states = history(staggeredExpire);
    const crossing = states.at(-1)!;
    crossing.s.o.calls = [integer(4), integer(0)];
    const late = structuredClone(crossing);
    late.input = { name: "policy", choice: integer(0) };
    late["mbt::actionTaken"] = "policy";
    rechoose(late, 0);
    late.s.o.calls = [integer(4), integer(4)];
    states.push(late);
    expect(witnesses("probe", states).labels.has(ownDeadline)).toBe(false);
  });

  it("credits neither label when both sources start at one instant and expire in one advance", () => {
    const states = history(staggeredExpire);
    // Drop the stagger, so both read replies start their sources at the same
    // instant, then let one advance cross both deadlines.
    states.splice(states.indexOf(nth(states, "advance")), 1);
    const expiry = nth(states, "advance");
    rechoose(expiry, 10);
    expiry.s.o.calls = [integer(4), integer(4)];
    states.length = states.indexOf(expiry) + 1;
    expect(witnesses("probe", states).labels.size).toBe(0);
  });
});

// The call witnesses over the shadowed schedule: each committed history earns
// exactly the labels below, at the steps that establish them.
describe("independent call witnesses from inputs and public observations", () => {
  const positive: Array<[string, Record<string, number[]>]> = [
    [staggeredSettle, { [survives]: [9], "recovery:miss": [7, 8, 9], "source-deadline": [7, 8, 9] }],
    [staggeredExpire, { [ownDeadline]: [12], "recovery:miss": [7, 8, 9, 10, 11, 12], "source-deadline": [7, 8, 9, 10, 11, 12] }],
    [separateDeadlines, { "independent-read-overlap": [3], "one-read-times-out-before-another": [7] }],
    [timedOutRead, { "late-read-does-not-affect-other-call": [5] }],
    [refill, { "independent-read-overlap": [2], "refill-authority-is-per-call": [5] }],
    [ageBoundary, { "recovery:miss": [9, 10], "independent-recovery-age-boundary": [9], "recovery:served": [10] }],
    [distinctSnapshots, { "recovery:served": [9, 10], "acquired-recovery-survives-invalidation": [9, 10], "distinct-retained-recovery-values": [10] }],
    [freshDecode, { "acquired-fresh-decode-survives-invalidation": [5] }],
    [lateSource, { "recovery:miss": [5, 6], "source-deadline": [5, 6], "late-source-does-not-affect-other-call": [6] }],
    [failedRecovery, { "recovery:deserialization_error": [4], "failed-recovery-keeps-source-error": [4] }],
  ];
  it.each(positive)("credits %s at the establishing steps", (name, expected) => {
    expect(evaluate(name, history(name))).toEqual(expected);
  });

  it("a read that already timed out neither overlaps a later call nor leaves a read active at the later deadline", () => {
    const states = history(separateDeadlines);
    // Time out the first read before the second call begins; its later
    // deadline then finds no other read active.
    const first = nth(states, "advance");
    rechoose(first, 5);
    patch(states, first, s => { s.io.aborted = integers(0); s.o.loaders = integer(1); });
    const last = states.at(-1)!;
    last.s.io.aborted = integers(0, 1);
    last.s.o.loaders = integer(2);
    expect(evaluate("probe", states)).toEqual({});
  });

  it("a late read reply once every call has completed shows no other call unaffected", () => {
    const states = history(timedOutRead);
    const late = states.at(-1)!;
    const settledFirst = insertAfter(states, states[states.indexOf(late) - 1]!, "resolveLoader", 1, s => { s.o.calls = integers(1, 0); });
    const settledBoth = (s: State["s"]) => { s.o.calls = integers(1, 1); s.o.writes = integer(1); s.o.dumps = integer(1); s.o.writeTtls = integers(5000); };
    insertAfter(states, settledFirst, "resolveLoader", 3, settledBoth);
    settledBoth(late.s);
    expect(evaluate("probe", states)).toEqual({});
  });

  it("refuses a reply of a read still active that leaves the observation unchanged", () => {
    const states = history(timedOutRead);
    const advance = nth(states, "advance");
    rechoose(advance, 1);
    patch(states, advance, s => { s.io.aborted = []; s.o.loaders = integer(0); });
    patch(states, nth(states, "releaseRead"), s => { s.o.loaders = integer(1); });
    expect(() => evaluate("probe", states)).toThrow(/step 5: active read 0 replied without starting caller 0's source or fresh decode/);
  });

  it("a late settlement once every call has completed shows no other call unaffected", () => {
    const states = history(lateSource);
    const advance = nth(states, "advance");
    rechoose(advance, 1000);
    resettle(states, advance, 1, 4);
    expect(evaluate("probe", states)).toEqual({ "recovery:miss": [5, 6], "source-deadline": [5, 6] });
  });

  it("refuses a settlement of a source still inside its budget that leaves the observation unchanged", () => {
    const states = history(lateSource);
    const advance = nth(states, "advance");
    rechoose(advance, 5);
    patch(states, advance, s => { s.o.calls = integers(0, 0); s.o.recovery = []; s.o.classifications = integer(0); });
    expect(() => evaluate("probe", states)).toThrow(/step 6: 0 decodes started but the shadowed schedule starts 1/);
  });

  it("a write while the other running source may refill too is not per-call refill authority", () => {
    const states = history(refill);
    rename(nth(states, "failRead"), "releaseRead", 0);
    const last = states.at(-1)!;
    last.s.o.writes = integer(2);
    last.s.o.dumps = integer(2);
    last.s.o.writeTtls = integers(5000, 5000);
    expect(evaluate("probe", states)).toEqual({ "independent-read-overlap": [2] });
  });

  it("a settlement that does not write shows no refill authority", () => {
    const states = history(refill);
    const [first, second] = [nth(states, "resolveLoader"), nth(states, "resolveLoader", 1)];
    rechoose(first, 1);
    Object.assign(first.s.o, { calls: integers(1, 0), writes: integer(0), dumps: integer(0), writeTtls: [] });
    rechoose(second, 4);
    second.s.o.calls = integers(1, 2);
    expect(evaluate("probe", states)).toEqual({ "independent-read-overlap": [2] });
  });

  it("two recoveries serving the same acquired value are not distinct", () => {
    const states = history(distinctSnapshots);
    rechoose(nth(states, "seed"), 1);
    resettle(states, nth(states, "releaseLoad"), 1, 1);
    expect(evaluate("probe", states)).toEqual({ "recovery:served": [9, 10], "acquired-recovery-survives-invalidation": [9, 10] });
  });

  it("a served recovery with no invalidation since its read does not survive one", () => {
    const states = history(distinctSnapshots);
    drop(states, nth(states, "invalidate"));
    patch(states, nth(states, "releaseLoad"), s => { s.o.invalidations = integer(0); s.o.maintenance = []; });
    expect(evaluate("probe", states)).toEqual({ "recovery:served": [8, 9], "distinct-retained-recovery-values": [9] });
  });

  it("a fresh decode with no invalidation since its read does not survive one", () => {
    const states = history(freshDecode);
    drop(states, nth(states, "invalidate"));
    patch(states, nth(states, "releaseLoad"), s => { s.o.invalidations = integer(0); s.o.maintenance = []; });
    expect(evaluate("probe", states)).toEqual({});
  });

  it("refuses a recovery outcome recorded for a fresh decode", () => {
    const states = history(freshDecode);
    nth(states, "releaseLoad").s.o.recovery = ["served"];
    expect(() => evaluate("probe", states)).toThrow(/step 5: recovery outcomes \["served"\] but the shadowed schedule records \[\]/);
  });

  it("a miss while the other pending caller captured the same recovery age is not the captured-age boundary", () => {
    const states = history(ageBoundary);
    // Capture the shorter age for both callers: the second decode then misses too.
    insertAfter(states, states[0]!, "policy", 2);
    const second = nth(states, "releaseLoad", 1);
    Object.assign(second.s.o, { calls: integers(3, 3), recovery: ["miss", "miss"] });
    second.s.io.sourceErrors = integers(1, 2);
    expect(evaluate("probe", states)).toEqual({ "recovery:miss": [10, 11], "independent-source-error-identities": [11] });
  });

  it("a miss once the other caller has completed is not the captured-age boundary", () => {
    const states = history(ageBoundary);
    const [first, second] = [nth(states, "releaseLoad"), nth(states, "releaseLoad", 1)];
    rechoose(first, 0);
    Object.assign(first.s.o, { calls: integers(1, 0), recovery: ["served"] });
    first.s.io.sourceErrors = integers(0, 0);
    rechoose(second, 1);
    second.s.o.recovery = ["served", "miss"];
    expect(evaluate("probe", states)).toEqual({ "recovery:served": [9, 10], "recovery:miss": [10] });
  });

  it("a failed recovery whose recorded error identity is not the caller's own source keeps nothing", () => {
    const states = history(failedRecovery);
    states.at(-1)!.s.io.sourceErrors = integers(2);
    expect(evaluate("probe", states)).toEqual({ "recovery:deserialization_error": [4] });
  });

  it("a failed recovery after a source deadline keeps the deadline error, not a source error", () => {
    const states = history(failedRecovery);
    rename(nth(states, "rejectLoader"), "advance", 10);
    const last = states.at(-1)!;
    last.s.o.calls = integers(4);
    last.s.io.sourceErrors = integers(0);
    expect(evaluate("probe", states)).toEqual({ "recovery:deserialization_error": [4], "source-deadline": [4] });
  });
});

describe("shadow fidelity against the model's private predictions", () => {
  const walk = (mutate: (states: PrivateState[]) => void = () => {}) => {
    const states = structuredClone(predictedFixtures.shadowWalk!.states);
    mutate(states);
    return { ...parseTrace({ states }, "shadowWalk", independent), ...witnessStates({ states }, "shadowWalk") };
  };

  it("matches the model at every step of the shadow walk, which takes every action", () => {
    expect(predictedFixtures.shadowWalk!.source.model).toBe("formal/dialcache-independent-conformance.qnt");
    expect(() => independentWitnesses([walk()])).not.toThrow();
    expect(new Set(predictedFixtures.shadowWalk!.states.map(state => state.input.name))).toEqual(new Set(["init", ...Object.keys(independent.actions)]));
  });

  // The layout is the composed profile's: a read's activity is its flight (a
  // delivered deadline disowns it), a caller's refill authority is its flight's
  // captured retention, a loader's start is its pending deadline minus the budget.
  it.each([
    ["reads", 2, (s: Record<string, unknown>) => { (s.reads as Array<Record<string, unknown>>)[0]!.flight = integer(-1); },
      /step 2: shadow reads \[\{"caller":0,"pending":true,"active":true\}\] differs from the model's \[\{"caller":0,"pending":true,"active":false\}\]/],
    ["now", 8, (s: Record<string, unknown>) => { s.now = integer(4); }, /step 8: shadow now 5 differs from the model's 4/],
    ["calls", 7, (s: Record<string, unknown>) => { (s.sources as Array<Record<string, unknown>>)[1]!.retentionMs = integer(5000); },
      /step 7: shadow calls .*"canWrite":false.* differs from the model's .*"canWrite":true/],
    ["sources", 8, (s: Record<string, unknown>) => {
      const due = (s.deadlines as Array<Record<string, unknown>>).find(deadline => (deadline.index as Integer)["#bigint"] === "2")!;
      due.at = integer(14);
    }, /step 8: shadow sources .*"startedAt":5.* differs from the model's .*"startedAt":4/],
  ])("names the first field the model predicts differently: %s", (_field, step, mutate, message) => {
    expect(() => independentWitnesses([walk(states => mutate(states[step]!.s))])).toThrow(message);
  });

  it("requires every field of the private layout the shadow reads", () => {
    expect(() => independentWitnesses([walk(states => { for (const state of states) delete state.s.deadlines; })]))
      .toThrow(/step 0: private layout is missing deadlines/);
  });
});

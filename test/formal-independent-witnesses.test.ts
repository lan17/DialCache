import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseTrace, profiles } from "../formal/replay/features.mjs";
import { sourceBudgetWitnesses } from "../formal/replay/witnesses/independent.mjs";
import { standaloneRecorder } from "../formal/replay/witnesses/recorder.mjs";

type Integer = { "#bigint": string };
interface State { input: { name: string; choice: Integer }; "mbt::actionTaken"?: string; "mbt::nondetPicks"?: unknown; s: { o: { calls: Integer[] }; io: Record<string, unknown> } }
interface History { source: { model: string; recipe: string }; states: State[] }
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/independent-witnesses.json", import.meta.url), "utf8")) as Record<string, History>;
const independent = profiles.independent!;
const survives = "later-source-survives-earlier-deadline", ownDeadline = "later-source-expires-at-own-deadline";
const staggeredSettle = "staggeredSourceStartsKeepIndependentBudgetsTest", staggeredExpire = "staggeredSourcesExpireAtTheirOwnDeadlineTest";

// The fixtures are public Quint runs of the independent model projected to the
// recorded inputs, the observation and the read IO a driver is asserted
// against. The source-budget rule has nothing else to read; a probe that
// changes one recorded input or result must lose the label, or be refused as
// a contradiction.
function history(name: string): State[] {
  const fixture = fixtures[name];
  if (fixture === undefined) throw new Error(`Missing independent witness fixture ${name}`);
  return structuredClone(fixture.states);
}
function witnesses(name: string, states: State[]) {
  const recorder = standaloneRecorder(name);
  sourceBudgetWitnesses(name, parseTrace({ states }, name, independent).steps, recorder);
  return { labels: recorder.labels(), provenance: recorder.provenance() };
}
const integer = (value: number): Integer => ({ "#bigint": String(value) });
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
// Re-record one caller's result from a state onward, so the history stays settled.
function resettle(states: State[], from: State, caller: number, result: number): void {
  for (const state of states.slice(states.indexOf(from))) state.s.o.calls[caller] = integer(result);
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

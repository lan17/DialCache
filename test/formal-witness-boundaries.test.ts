import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTrace, profiles as featureProfiles } from "../formal/replay/features.mjs";
import { recoveryWitnesses } from "../formal/replay/witnesses/recovery.mjs";
import { runtimeWitnesses } from "../formal/replay/witnesses/runtime.mjs";
import { shadowWitnesses } from "../formal/replay/witnesses/shadow.mjs";
import { witnessStates } from "../formal/replay/witnesses/trace.mjs";

type RecordValue = Record<string, unknown>;
type Choice = { tag: string; value: unknown };
type Fixture = {
  witness: string;
  profile: string;
  provenance: { recipe: string };
  initialState: RecordValue;
  steps: Array<{ action: string; choice?: Choice; statePatch: RecordValue }>;
};
type State = { input: { name: string; choice: unknown }; s: RecordValue };
type Recipe = { id: string; actions: Array<[string, number]> };
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/formal-witness-boundaries.json", import.meta.url), "utf8")) as Fixture[];
const recipes = JSON.parse(readFileSync(new URL("../formal/fixture-recipes.json", import.meta.url), "utf8")) as { artifacts: Array<{ path: string; recipes: Recipe[] }> };

// The fixture file contains histories selected from real Quint runs. Store
// only changed fields to keep the examples readable without duplicating state.
function merge(before: RecordValue, patch: RecordValue): RecordValue {
  const result = structuredClone(before);
  for (const [key, value] of Object.entries(patch)) {
    const previous = result[key];
    result[key] = value !== null && previous !== null
      && typeof value === "object" && typeof previous === "object"
      && !Array.isArray(value) && !Array.isArray(previous)
      ? merge(previous as RecordValue, value as RecordValue)
      : structuredClone(value);
  }
  return result;
}
function integer(value: number): RecordValue { return { "#bigint": String(value) }; }
// Steps declare the explicit input record that every shared classifier keys
// on; a recorded choice is the simulator's Some/None pick. A layers excerpt
// starts mid-history under a placeholder input; a recovery or shadow history
// starts at its init, whose fixture choice is the recipe's first external action.
const explicitInput = (name: string, choice?: Choice) => ({ name, choice: choice === undefined || choice.tag === "None" ? integer(-1) : choice.value });
function initialInput(fixture: Fixture): { name: string; choice: unknown } {
  if (fixture.profile === "layers") return explicitInput("excerpt");
  const reference = fixture.provenance.recipe.replace(/^formal\/fixture-recipes\.json#/, "");
  const separator = reference.lastIndexOf("/");
  const recipe = recipes.artifacts.find(artifact => artifact.path === reference.slice(0, separator))?.recipes.find(item => item.id === reference.slice(separator + 1));
  if (recipe === undefined) throw new Error(`Missing recipe for ${fixture.witness}`);
  return { name: "init", choice: integer(recipe.actions[0]![1]) };
}
function statesFor(fixture: Fixture): State[] {
  const states: State[] = [{ input: initialInput(fixture), s: structuredClone(fixture.initialState) }];
  for (const step of fixture.steps) {
    states.push({ input: explicitInput(step.action, step.choice), s: merge(states.at(-1)!.s, step.statePatch) });
  }
  return states;
}
// A recovery or shadow history is parsed exactly as the corpus is (the
// drivers' explicit inputs and public channels); the layers excerpts keep their private state.
function collect(fixture: Fixture, states: State[]): Set<string> {
  const raw = { states }, path = "trace.itf.json";
  if (fixture.profile === "layers") return runtimeWitnesses(fixture.profile, [{ path, ...witnessStates(raw, path) }]);
  const history = { ...parseTrace(raw, path, featureProfiles[fixture.profile as keyof typeof featureProfiles]!), ...witnessStates(raw, path) };
  return fixture.profile === "recovery" ? recoveryWitnesses([history]) : shadowWitnesses([history]);
}
function fixtureFor(witness: string): Fixture {
  const fixture = fixtures.find(item => item.witness === witness);
  if (fixture === undefined) throw new Error(`Missing fixture for ${witness}`);
  return fixture;
}
// An input-level negative control on a public-only history: an environment
// command inserted before a step, carrying the same public channels (the
// command itself observes nothing), so the classifier must re-decide from the
// changed inputs while the recorded outcome stays.
function insertBefore(states: State[], index: number, name: string, choice: number): State[] {
  const inserted = { input: { name, choice: integer(choice) }, s: structuredClone(states[index - 1]!.s) };
  return [...states.slice(0, index), inserted, ...states.slice(index)];
}
// The recorded verdict of a history's final step replaced by another: the
// public outcome a changed input would have produced.
function withFinalVerdict(states: State[], verdict: string): State[] {
  const edited = structuredClone(states);
  const observations = edited.at(-1)!.s.o as RecordValue;
  const shadow = observations.shadow as string[];
  observations.shadow = [...shadow.slice(0, -1), verdict];
  return edited;
}

describe("Quint recovery and shadow witness consequences", () => {
  it.each(fixtures)("recognizes the replayed consequence: $witness", fixture => {
    expect(collect(fixture, statesFor(fixture)).has(fixture.witness)).toBe(true);
  });

  it.each(fixtures)("does not credit inputs without the consequence: $witness", fixture => {
    const states = statesFor(fixture);
    const final = states.at(-1)!.s;
    if (fixture.witness === "late-shadow-dump-cannot-dispatch-write") {
      // Merely reaching a timed-out serialization is insufficient: a late
      // dispatch violates the very consequence the witness must establish.
      const observations = final.o as RecordValue;
      const writes = Number((observations.writes as RecordValue)["#bigint"]);
      observations.writes = integer(writes + 1);
    } else {
      // Preserve phase, clocks, candidate, and external input. Remove only the
      // final public result/effect transition from the real trace.
      final.o = structuredClone(states.at(-2)!.s.o);
    }
    if (fixture.profile === "shadow") {
      // The shadow classifier predicts each step's public effects from the
      // inputs: an observation the inputs do not produce is refused outright,
      // and one they do produce without the consequence earns nothing.
      let credited: boolean;
      try { credited = collect(fixture, states).has(fixture.witness); }
      catch (error) { expect((error as Error).message).toMatch(/shadow predicts/); return; }
      expect(credited).toBe(false);
      return;
    }
    expect(collect(fixture, states).has(fixture.witness)).toBe(false);
  });

  it("confirms equal bytes across text/binary encodings but excludes different JSON bytes", () => {
    // The job's C0 is the binary spelling of the Unicode text (seed 8). A frame
    // reseeded before the confirmation read with the text spelling (seed 7)
    // carries the same bytes and confirms the mismatch; the padded spelling of
    // `1` (seed 5) is other bytes, and the recorded mismatch becomes the
    // supersession that input produces.
    const fixture = fixtureFor("same-c1-bytes-confirm-mismatch");
    const states = statesFor(fixture), confirmation = states.length - 1;
    expect(collect(fixture, insertBefore(states, confirmation, "seed", 7)).has(fixture.witness)).toBe(true);
    expect(collect(fixture, withFinalVerdict(insertBefore(states, confirmation, "seed", 5), "superseded")).has(fixture.witness)).toBe(false);
  });

  it("requires different bytes for a replacement witness even when a verdict says superseded", () => {
    // The job's C0 is text `2` (seed 2). A frame reseeded before the
    // confirmation read with the padded spelling of `1` (seed 5) is other
    // bytes and supersedes; the binary spelling of `2` (seed 4) carries the C0
    // bytes, so the recorded supersession becomes the mismatch that input
    // produces and no replacement is credited.
    const fixture = fixtureFor("different-c1-bytes-supersede");
    const states = statesFor(fixture), confirmation = states.length - 1;
    expect(collect(fixture, insertBefore(states, confirmation, "seed", 5)).has(fixture.witness)).toBe(true);
    expect(collect(fixture, withFinalVerdict(insertBefore(states, confirmation, "seed", 4), "mismatch")).has(fixture.witness)).toBe(false);
  });

  it("does not claim capacity retention from late-effect suppression alone", () => {
    const fixture = fixtureFor("late-shadow-dump-cannot-dispatch-write");
    const witnesses = collect(fixture, statesFor(fixture));
    expect(witnesses.has(fixture.witness)).toBe(true);
    expect([...witnesses].filter(name => /capacity|keeps-slot|ownership/.test(name))).toEqual([]);
  });

  it("requires the exact F boundary, not merely a served stale value", () => {
    // A seed at 999 ms inserted before the acquiring call makes the frame one
    // millisecond short of F at the read; the recorded recovery outcome stays.
    const fixture = fixtureFor("first-stale-age-recovers-without-publication");
    const states = statesFor(fixture);
    const acquisition = states.findIndex(state => state.input.name === "beginCall");
    expect(collect(fixture, insertBefore(states, acquisition, "seed", 1)).has(fixture.witness)).toBe(false);
  });

  it("requires exact M after decode, not merely a generic recovery miss", () => {
    // One more millisecond of elapsed time before the decode settles puts the
    // candidate past M rather than at it; the recorded miss stays.
    const fixture = fixtureFor("exact-maximum-after-decode-rejects");
    const states = statesFor(fixture);
    expect(collect(fixture, insertBefore(states, states.length - 1, "advance", 1)).has(fixture.witness)).toBe(false);
  });

  it("names the first field of the composed layout a private history lacks", () => {
    // A history carrying private state is bound to the composed layout field
    // by field; one in another layout is refused at its first missing field.
    const fixture = fixtureFor("exact-maximum-after-decode-rejects");
    const states = statesFor(fixture);
    for (const state of states) state.s.phase = integer(0);
    expect(() => collect(fixture, states)).toThrow(/step 0: private layout is missing now/);
  });
});


describe("Quint invalidation memo witness provenance", () => {
  const examples = JSON.parse(readFileSync(new URL("./fixtures/formal-runtime-witness-boundaries.json", import.meta.url), "utf8")) as Array<Fixture & { title: string }>;
  it.each(examples)("distinguishes retained memo from later publication: $title", fixture => {
    expect(collect(fixture, statesFor(fixture)).has(fixture.witness))
      .toBe(fixture.title === "preexisting-memo-survives");
  });

  it("does not credit a same-value replacement after invalidation as the original memo", () => {
    const fixture = examples.find(item => item.title === "preexisting-memo-survives")!;
    const states = statesFor(fixture);
    const invalidation = states.findIndex(state => state.input.name === "invalidate");
    const replacement = structuredClone(states[invalidation]!);
    const beforeProbe = states.at(-2)!.s;
    const memo = beforeProbe.memo as RecordValue[];
    const owners = beforeProbe.owners as RecordValue[];
    const slots = beforeProbe.memoSlots as RecordValue[];
    const retainedSlot = memo.findIndex(value => Number(value["#bigint"]) > 0);
    const call = slots.findIndex(value => Number(value["#bigint"]) === retainedSlot);
    const loader = Number(owners[call]!["#bigint"]);
    const value = Number(memo[retainedSlot]!["#bigint"]);
    // Challenge provenance with an observed publication of the same bytes.
    // Public replay remains a separate gate; this test isolates classification.
    replacement.input = { name: "resolveLoader", choice: integer(loader * 2 + value) };
    states.splice(invalidation + 1, 0, replacement);
    expect(collect(fixture, states).has(fixture.witness)).toBe(false);
  });
});

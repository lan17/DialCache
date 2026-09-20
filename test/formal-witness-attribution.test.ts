import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTrace, profiles as featureProfiles } from "../formal/replay/features.mjs";
import { recoveryWitnesses } from "../formal/replay/witnesses/recovery.mjs";
import { recoveryShadowWitnesses } from "../formal/replay/witnesses/recovery-shadow.mjs";
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
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/formal-witness-attribution.json", import.meta.url), "utf8")) as Fixture[];
const recipes = JSON.parse(readFileSync(new URL("../formal/fixture-recipes.json", import.meta.url), "utf8")) as { artifacts: Array<{ path: string; recipes: Recipe[] }> };

// Real Quint histories preserve their final public outcome. The negative
// controls add another sufficient cause, or remove the distinguishing input,
// so reaching that outcome alone must no longer earn the witness. A recovery
// history is a full public history from its init and its controls are input
// edits; the shadow excerpt keeps its private state and edits it directly.
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
function fixtureFor(witness: string): Fixture {
  const fixture = fixtures.find(item => item.witness === witness);
  if (fixture === undefined) throw new Error(`Missing attribution fixture for ${witness}`);
  return fixture;
}
const integer = (value: number): RecordValue => ({ "#bigint": String(value) });
const explicitInput = (name: string, choice?: Choice) => ({ name, choice: choice === undefined || choice.tag === "None" ? integer(-1) : choice.value });
function initialInput(fixture: Fixture): { name: string; choice: unknown } {
  if (fixture.profile !== "recovery") return explicitInput("excerpt");
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
function witnessed(fixture: Fixture, states: State[]): boolean {
  const raw = { states }, path = "trace.itf.json";
  if (fixture.profile === "recovery") return recoveryWitnesses([{ ...parseTrace(raw, path, featureProfiles.recovery!), ...witnessStates(raw, path) }]).has(fixture.witness);
  return recoveryShadowWitnesses(fixture.profile, [{ path, ...witnessStates(raw, path) }]).has(fixture.witness);
}
// An environment command inserted before a step carries the same public
// channels (it observes nothing); removing a step drops its input with them.
function insertBefore(states: State[], index: number, name: string, choice: number): State[] {
  return [...states.slice(0, index), { input: { name, choice: integer(choice) }, s: structuredClone(states[index - 1]!.s) }, ...states.slice(index)];
}
const acquisitionOf = (states: State[]) => states.findIndex((state, index) => index > 0 && state.input.name === "beginCall"
  && Number(((state.s.o as RecordValue).reads as RecordValue)["#bigint"]) > Number(((states[index - 1]!.s.o as RecordValue).reads as RecordValue)["#bigint"]));

describe("Quint witnesses distinguish the rule responsible for an outcome", () => {
  it.each(fixtures)("recognizes an isolated real schedule: $witness", fixture => {
    expect(witnessed(fixture, statesFor(fixture))).toBe(true);
  });

  it("does not credit maximum-age-read-preserves-source-error when the watermark already prevents recovery", () => {
    // An invalidation before the acquiring call raises the watermark to the
    // wall clock, above the frame's stamp: the fence, not the age, refuses it.
    const fixture = fixtureFor("maximum-age-read-preserves-source-error"), states = statesFor(fixture);
    expect(witnessed(fixture, insertBefore(states, acquisitionOf(states), "invalidate", -1))).toBe(false);
  });

  it.each(["maximum-age-read-preserves-source-error", "future-read-preserves-source-error"])(
    "does not credit %s when the read itself fails", witness => {
      // A read fault armed before the acquiring call observes nothing, so no
      // age judgment can be the reason recovery was refused.
      const fixture = fixtureFor(witness), states = statesFor(fixture);
      expect(witnessed(fixture, insertBefore(states, acquisitionOf(states), "readFault", 1))).toBe(false);
    },
  );

  it("does not credit future-read-preserves-source-error without the future stamp", () => {
    // Without the seed one millisecond in the future the acquiring read sees
    // the initial frame at age 1000: an ordinary stale candidate.
    const fixture = fixtureFor("future-read-preserves-source-error"), states = statesFor(fixture);
    const seed = states.findIndex(state => state.input.name === "seed");
    expect(seed).toBeGreaterThan(0);
    expect(witnessed(fixture, [...states.slice(0, seed), ...states.slice(seed + 1)])).toBe(false);
  });

  it("does not credit a watermark when age already prevents recovery", () => {
    // A seed at exactly M before the acquiring call is both fenced and too old.
    const fixture = fixtureFor("fenced-read-does-not-retain"), states = statesFor(fixture);
    expect(witnessed(fixture, insertBefore(states, acquisitionOf(states), "seed", 4))).toBe(false);
  });

  it.each([["fenced", "invalidate", -1], ["at the maximum age", "seed", 4]] as const)(
    "requires a usable candidate to challenge classifier failure: %s", (_reason, name, choice) => {
      const fixture = fixtureFor("classifier-error-keeps-error-without-decode"), states = statesFor(fixture);
      expect(witnessed(fixture, insertBefore(states, acquisitionOf(states), name, choice))).toBe(false);
    },
  );

  it("requires elapsed age to change while asynchronous decoding is pending", () => {
    // This real history starts decoding at age 1,001 ms and rolls the wall
    // clock back before completion. Without the rollback the sampled age is
    // the age decoding started at, whatever the recorded telemetry says.
    const fixture = fixtureFor("recovery-age-sampled-at-successful-decode"), states = statesFor(fixture);
    const rollback = states.findIndex(state => state.input.name === "rollbackWall");
    expect(rollback).toBeGreaterThan(0);
    expect(witnessed(fixture, [...states.slice(0, rollback), ...states.slice(rollback + 1)])).toBe(false);
  });

  it("requires equal C1 bytes to isolate a watermark supersession", () => {
    const fixture = fixtureFor("fenced-c1-supersedes-without-repair"), states = statesFor(fixture);
    const confirmation = states.at(-2)!.s;
    confirmation.c0 = 1; // text '1'
    confirmation.frame = 3; // binary '1': identical payload bytes
    expect(witnessed(fixture, states)).toBe(true);
    confirmation.frame = 5; // binary ' 1': a replacement already supersedes C0
    expect(witnessed(fixture, states)).toBe(false);
  });
});

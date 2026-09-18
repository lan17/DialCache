import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseTrace, profiles } from "../formal/replay/features.mjs";
import { createWitnessRecorder } from "../formal/replay/witnesses/recorder.mjs";
import { runtimeWitnesses } from "../formal/replay/witnesses/runtime.mjs";
import { witnessStates } from "../formal/replay/witnesses/trace.mjs";

type Integer = { "#bigint": string };
interface State { input: { name: string; choice: Integer }; "mbt::actionTaken"?: string; "mbt::nondetPicks"?: unknown; s: { o: Record<string, unknown> } }
interface History { source: { model: string; recipe: string }; states: State[] }
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/layers-witnesses.json", import.meta.url), "utf8")) as Record<string, History>;
const layers = profiles.layers!;
const label = "tracked-local-only-hit";
const reuse = "trackedWithoutRemotePublishesReusableLocalTest";

// The fixture is a public Quint run of the layers model projected to the
// recorded inputs and the observation a driver is asserted against. Without
// private predictions the runtime classifier skips its private rules, so a
// label here comes from the public rule alone.
function history(name: string): State[] {
  const fixture = fixtures[name];
  if (fixture === undefined) throw new Error(`Missing layers witness fixture ${name}`);
  return structuredClone(fixture.states);
}
function witnesses(name: string, states: State[]) {
  const raw = { states }, recorder = createWitnessRecorder();
  const labels = runtimeWitnesses("layers", [{ ...parseTrace(raw, name, layers), ...witnessStates(raw, name) }], recorder);
  return { labels, provenance: recorder.provenance() };
}
// Re-record an input's choice. The simulator annotation must agree with the record.
function rechoose(state: State, choice: number): void {
  state.input.choice = { "#bigint": String(choice) };
  state["mbt::nondetPicks"] = { choice: { tag: "Some", value: { "#bigint": String(choice) } } };
}

describe("layers witnesses from inputs and public observations", () => {
  it("reads a fixture that carries only the recorded input and the asserted observation", () => {
    for (const [name, fixture] of Object.entries(fixtures)) {
      expect(fixture.source.model, name).toBe("formal/dialcache-layers-conformance.qnt");
      for (const state of fixture.states) expect(Object.keys(state.s), name).toEqual(["o"]);
    }
  });

  it("credits the tracked local-only publication at the fresh-context reuse", () => {
    const { labels, provenance } = witnesses(reuse, history(reuse));
    expect(labels.has(label)).toBe(true);
    expect(provenance[label]).toEqual([{ name: reuse, checkpoints: [3] }]);
  });

  it("does not credit a publication before a later caller reuses it", () => {
    const states = history(reuse);
    states.pop();
    expect(witnesses("probe", states).labels.has(label)).toBe(false);
  });

  it("does not credit the same schedule in the untracked fixture without a remote adapter", () => {
    const states = history(reuse);
    rechoose(states[0]!, 4);
    expect(witnesses("probe", states).labels.has(label)).toBe(false);
  });

  it("refuses adapter effects in the fixture without a remote adapter", () => {
    const states = history(reuse);
    states.at(-1)!.s.o.reads = { "#bigint": "1" };
    expect(() => witnesses("probe", states)).toThrow(/adapter effects/);
  });
});

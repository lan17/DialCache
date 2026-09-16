import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseTrace, profiles } from "../formal/replay/features.mjs";
import { loadCorpus } from "../formal/replay/witnesses/index.mjs";
import { policyWitnesses } from "../formal/replay/witnesses/policy.mjs";
import { witnessStates } from "../formal/replay/witnesses/trace.mjs";

type Integer = { "#bigint": string };
interface State { input: { name: string; choice: Integer }; "mbt::actionTaken"?: string; "mbt::nondetPicks"?: unknown; s: Record<string, unknown> }
interface History { source: { model: string; recipe: string }; states: State[] }
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/policy-witnesses.json", import.meta.url), "utf8")) as Record<string, History>;
// The same model's runs projected with their private layout, for the fidelity check.
const predictedFixtures = JSON.parse(readFileSync(new URL("./fixtures/policy-shadow-witnesses.json", import.meta.url), "utf8")) as Record<string, History>;
const policy = profiles.policy!;
const smoke = resolve("formal/policy-smoke.itf.json");

// The fixtures are public Quint runs of the policy model projected to the
// recorded inputs and the observation a driver is asserted against. The
// classifier has nothing else to read; a probe that changes one recorded
// input must lose the label, or be refused as a contradiction, even though the
// recorded outcome stays.
function history(name: string): State[] {
  const fixture = fixtures[name];
  if (fixture === undefined) throw new Error(`Missing policy witness fixture ${name}`);
  return structuredClone(fixture.states);
}
function witnesses(name: string, states: State[]): Set<string> {
  return policyWitnesses([parseTrace({ states }, name, policy)]);
}
const nth = (states: State[], action: string, index = 0): State => {
  const state = states.filter(candidate => candidate.input.name === action)[index];
  if (state === undefined) throw new Error(`No ${action} input #${index}`);
  return state;
};
// Re-record an input's choice. The simulator annotation must agree with the record.
function rechoose(state: State, choice: number): void {
  state.input.choice = { "#bigint": String(choice) };
  state["mbt::nondetPicks"] = { choice: { tag: "Some", value: { "#bigint": String(choice) } } };
}

const positive: Array<[string, string]> = [
  ["localHitDoesNotRenewInsertionTtlTest", "local-hit-preserves-insertion-expiry"],
  ["wallRollbackDoesNotExtendLocalTtlTest", "rollback-preserves-live-local"],
  ["wallRollbackDoesNotExtendLocalTtlTest", "rollback-does-not-extend-local-ttl"],
  ["expiredLocalEntryMissesAfterRollback", "rollback-does-not-extend-local-ttl"],
  ["wallRollbackRejectsFutureRemoteFrameTest", "rollback-rejects-future-remote"],
  ["exactRemoteFreshBoundaryStartsSourceTest", "remote-exact-fresh-boundary-miss"],
  ["increasedFreshTtlCanReusePhysicallyRetainedValueTest", "increased-fresh-ttl-reuses-retained-frame"],
  ["increasedFreshTtlCannotResurrectExpiredStorageTest", "increased-fresh-ttl-cannot-resurrect-expired-storage"],
  ["remoteHitStartsFullLocalInsertionTtlTest", "remote-hit-local-ttl-outlives-remote-freshness"],
  ["providerFailureBypassesAndPreservesExistingLocalTest", "provider-failure-preserves-existing-local"],
  ["disablingServingKeepsExistingLocalForReenablementTest", "serving-disabled-preserves-existing-local"],
  ["untrackedReadFailureStillWarmsActiveLocalTest", "failed-untracked-read-still-warms-local"],
  ["independentLocalPublicationUsesLastCompletionTest", "independent-local-last-completion-probed"],
  ["independentRemotePublicationUsesLastCompletionTest", "independent-remote-last-completion-probed"],
  ["inactiveLayersStartIndependentSources", "inactive-layers-independent-sources"],
];

describe("policy witnesses from inputs and public observations", () => {
  it("reads fixtures that carry only the recorded input and the asserted observation", () => {
    for (const [name, fixture] of Object.entries(fixtures)) {
      expect(fixture.source.model, name).toBe("formal/dialcache-policy-conformance.qnt");
      for (const state of fixture.states) expect(Object.keys(state.s).sort(), name).toEqual(["o", "policyErrors"]);
    }
  });

  it.each(positive)("%s earns %s", (name, witness) => {
    expect(witnesses(name, history(name)).has(witness)).toBe(true);
  });

  it("a miss before the shadowed insertion expiry is not a preserved-expiry probe", () => {
    const states = history("localHitDoesNotRenewInsertionTtlTest");
    rechoose(nth(states, "advance", 1), 1);
    expect(witnesses("probe", states).has("local-hit-preserves-insertion-expiry")).toBe(false);
  });

  it("a rollback that only cancels elapsed time leaves an expired entry expired", () => {
    expect(witnesses("probe", history("expiredLocalEntryMissesAfterRollback")).has("rollback-preserves-live-local")).toBe(false);
  });

  it("a miss while the rolled-back entry is still live does not show its TTL unextended", () => {
    const states = history("wallRollbackDoesNotExtendLocalTtlTest");
    rechoose(nth(states, "advance"), 500);
    expect(witnesses("probe", states).has("rollback-does-not-extend-local-ttl")).toBe(false);
  });

  it("a frame created at the rolled-back wall is not in the future and serves", () => {
    const labels = witnesses("probe", history("rollbackWithinElapsedTimeServesFrame"));
    expect(labels.has("rollback-rejects-future-remote")).toBe(false);
    expect(labels.has("remote-hit")).toBe(true);
  });

  it.each([[500, "inside the fresh window"], [2000, "past the fresh TTL while still retained"]])("a remote miss %i ms after the write, %s, is not the exact boundary", (elapsed) => {
    const states = history("exactRemoteFreshBoundaryStartsSourceTest");
    rechoose(nth(states, "advance"), elapsed);
    expect(witnesses("probe", states).has("remote-exact-fresh-boundary-miss")).toBe(false);
  });

  it("a retained frame that misses for staleness after a rollback is not a rejected future frame", () => {
    const labels = witnesses("probe", history("staleFrameMissesAfterRollback"));
    expect(labels.has("rollback-rejects-future-remote")).toBe(false);
    expect(labels.has("remote-hit")).toBe(false);
  });

  it("a remote hit under the unchanged fresh TTL does not reuse a retained frame", () => {
    const states = history("increasedFreshTtlCanReusePhysicallyRetainedValueTest");
    rechoose(nth(states, "policy", 1), 0);
    expect(witnesses("probe", states).has("increased-fresh-ttl-reuses-retained-frame")).toBe(false);
  });

  it("a remote miss while Redis still retains the frame is not resurrection", () => {
    const states = history("increasedFreshTtlCannotResurrectExpiredStorageTest");
    rechoose(nth(states, "advance"), 1000);
    expect(witnesses("probe", states).has("increased-fresh-ttl-cannot-resurrect-expired-storage")).toBe(false);
  });

  it("a warmed local hit while the remote frame is still fresh does not outlive its freshness", () => {
    const states = history("remoteHitStartsFullLocalInsertionTtlTest");
    rechoose(nth(states, "advance", 1), 1);
    expect(witnesses("probe", states).has("remote-hit-local-ttl-outlives-remote-freshness")).toBe(false);
  });

  it("a recorded local hit without a local layer is a contradiction, not a warmed entry", () => {
    const states = history("remoteHitStartsFullLocalInsertionTtlTest");
    rechoose(nth(states, "policy", 1), 3);
    expect(() => witnesses("probe", states)).toThrow(/step 11: local hit of 1 on key 0 but the shadowed slot holds 0/);
  });

  it("a bypassed result equal to the retained value cannot show the entry was preserved", () => {
    const states = history("providerFailureBypassesAndPreservesExistingLocalTest");
    rechoose(nth(states, "resolveLoader", 1), 8); // the bypassing source also resolves to 1
    expect(witnesses("probe", states).has("provider-failure-preserves-existing-local")).toBe(false);
  });

  it("a recorded hit of the retained value after a healthy reply contradicts the shadowed publication", () => {
    const states = history("providerFailureBypassesAndPreservesExistingLocalTest");
    rechoose(nth(states, "providerFault"), 0);
    expect(() => witnesses("probe", states)).toThrow(/step 10: local hit of 1 on key 0 but the shadowed slot holds 2/);
  });

  it("disabling only the local layer is not the serving kill switch", () => {
    const states = history("disablingServingKeepsExistingLocalForReenablementTest");
    rechoose(nth(states, "policy"), 3);
    expect(witnesses("probe", states).has("serving-disabled-preserves-existing-local")).toBe(false);
  });

  it("a healthy untracked read cannot credit the failed-read warming", () => {
    const states = history("untrackedReadFailureStillWarmsActiveLocalTest");
    rechoose(nth(states, "readFault"), 0);
    expect(witnesses("probe", states).has("failed-untracked-read-still-warms-local")).toBe(false);
  });

  it.each([["independentLocalPublicationUsesLastCompletionTest", "local"], ["independentRemotePublicationUsesLastCompletionTest", "remote"]])(
    "%s needs the overlapping sources to publish different values", (name, layer) => {
      const states = history(name);
      rechoose(nth(states, "resolveLoader"), 8); // source 1 also resolves to 1
      expect(witnesses("probe", states).has(`independent-${layer}-last-completion-probed`)).toBe(false);
    });

  it("an overlapping source with an active remote layer is not an inactive-layers overlap", () => {
    const states = history("inactiveLayersStartIndependentSources");
    rechoose(nth(states, "policy"), 3);
    expect(witnesses("probe", states).has("inactive-layers-independent-sources")).toBe(false);
  });

  it("rejects a settlement of a source the observation never started", () => {
    const states = history("untrackedReadFailureStillWarmsActiveLocalTest");
    rechoose(nth(states, "resolveLoader"), 8); // loader 1, value 1
    expect(() => witnesses("probe", states)).toThrow(/step 4: settles no pending source 1/);
  });

  it("rejects a stored write whose TTL is not the source's captured retention", () => {
    const states = history("increasedFreshTtlCannotResurrectExpiredStorageTest");
    rechoose(nth(states, "policy"), 0); // recorded TTL 2000 from the two-second recovery overlay
    expect(() => witnesses("probe", states)).toThrow(/step 4: write with TTL 2000 but source 0 captured retention 5000/);
  });

  it("rejects a recorded remote hit once the shadowed frame's retention has ended", () => {
    const states = history("increasedFreshTtlCanReusePhysicallyRetainedValueTest");
    rechoose(nth(states, "advance"), 5000);
    expect(() => witnesses("probe", states)).toThrow(/step 8: remote hit of 1 on key 0 but the shadowed frame holds 1 until 5000 at 5000/);
  });
});

describe("shadow fidelity against the model's private predictions", () => {
  const predicted = (mutate: (states: Array<{ s: Record<string, unknown> }>) => void) => {
    const raw = JSON.parse(readFileSync(smoke, "utf8")) as { states: Array<{ s: Record<string, unknown> }> };
    mutate(raw.states);
    return { ...parseTrace(raw, smoke, policy), ...witnessStates(raw, smoke) };
  };

  const walk = (mutate: (states: State[]) => void = () => {}) => {
    const states = structuredClone(predictedFixtures.shadowWalk!.states);
    mutate(states);
    return { ...parseTrace({ states }, "shadowWalk", policy), ...witnessStates({ states }, "shadowWalk") };
  };

  it("matches the model at every step of the committed smoke history and the shadow walk", () => {
    expect(() => policyWitnesses(loadCorpus("policy", [smoke]))).not.toThrow();
    expect(() => policyWitnesses([walk()])).not.toThrow();
    expect(predictedFixtures.shadowWalk!.states.map(state => state.input.name)).toEqual(expect.arrayContaining(["seed", "advance", "policy", "rollbackWall", "readFault", "dumpFault", "writeFault", "rejectLoader"]));
  });

  it("names a seed the model stamped at another wall time", () => {
    expect(() => policyWitnesses([walk(states => { (states[1]!.s.created as Integer[])[0] = { "#bigint": "1" }; })]))
      .toThrow(/step 1: shadow created \[100000,0\] differs from the model's \[1,0\]/);
  });

  it("has nothing to compare in a history projected to its public channels", () => {
    const states = history("localHitDoesNotRenewInsertionTtlTest");
    expect(() => policyWitnesses([parseTrace({ states }, "public", policy)])).not.toThrow();
    expect(() => policyWitnesses([{ ...parseTrace({ states }, "public", policy), ...witnessStates({ states }, "public") }])).not.toThrow();
  });

  it.each([
    ["sources", /step 0: shadow sources \[\] differs from the model's undefined/],
    ["localExpires", /step 0: shadow localExpires \[0,0\] differs from the model's undefined/],
  ])("requires every shadowed field of a private layout: %s", (field, message) => {
    expect(() => policyWitnesses([predicted(states => { for (const state of states) delete state.s[field]; })])).toThrow(message);
  });

  it.each([
    ["localValues", 3, (s: Record<string, unknown>) => { (s.localValues as Integer[])[0] = { "#bigint": "2" }; }, /step 3: shadow localValues \[1,0\] differs from the model's \[2,0\]/],
    ["skew", 0, (s: Record<string, unknown>) => { s.skew = { "#bigint": "1" }; }, /step 0: shadow skew 100000 differs from the model's 1/],
    ["sources", 3, (s: Record<string, unknown>) => { (s.sources as Array<Record<string, unknown>>)[0]!.retentionMs = { "#bigint": "1000" }; }, /step 3: shadow sources .* differs from the model's/],
    ["dumpFailed", 4, (s: Record<string, unknown>) => { s.dumpFailed = true; }, /step 4: shadow dumpFailed false differs from the model's true/],
  ])("names the first field the model predicts differently: %s", (_field, step, mutate, message) => {
    expect(() => policyWitnesses([predicted(states => mutate(states[step]!.s))])).toThrow(message);
  });
});

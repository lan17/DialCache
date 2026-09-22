import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { runtimeBoundaryTraceWitnesses } from "../../formal/replay/witnesses/runtime-boundaries.mjs";

type Integer = { "#bigint": string };
interface State { input: { name: string; choice: Integer }; s: { o: { calls: Integer[]; loaders: Integer; reads: Integer; loads: Integer; writes: Integer; writeTtls: Integer[] } } }
interface Fixture { states: State[] }
const fixtures = JSON.parse(readFileSync("test/fixtures/formal-runtime-boundary-witnesses.json", "utf8")) as Record<string, Fixture>;
const fixture = (name: string): Fixture => structuredClone(fixtures[name]!);
const integer = (value: number): Integer => ({ "#bigint": String(value) });
const choose = (state: State, choice: number): void => { state.input.choice = integer(choice); };
const indexOfNth = (trace: Fixture, action: string, occurrence: number): number => {
  let seen = 0;
  const index = trace.states.findIndex(s => s.input.name === action && seen++ === occurrence);
  if (index < 0) throw new Error(`No ${action} input #${occurrence}`);
  return index;
};
// A step whose observation continues the previous state's counters; the classifier reads inputs and o only.
const step = (trace: Fixture, action: string, choice: number, calls: number[], loaders: number): State =>
  ({ input: { name: action, choice: integer(choice) }, s: { o: { ...structuredClone(trace.states[0]!.s.o), calls: calls.map(integer), loaders: integer(loaders) } } });
const policyStep = (trace: Fixture, choice: number): State => ({ input: { name: "policy", choice: integer(choice) }, s: { o: structuredClone(trace.states[0]!.s.o) } });
// Grow a counter from a step onward, so the history stays monotone.
const bump = (trace: Fixture, from: number, counter: "reads" | "writes"): void => {
  for (const state of trace.states.slice(from)) state.s.o[counter] = integer(Number(state.s.o[counter]["#bigint"]) + 1);
};
const zeroRemoteCounters = (trace: Fixture): void => {
  for (const state of trace.states) { state.s.o.reads = integer(0); state.s.o.loads = integer(0); state.s.o.writes = integer(0); state.s.o.writeTtls = []; }
};
const bypasses: Array<[string, string]> = [
  ["invalidCoalesce", "invalid-coalesce"], ["invalidRequestLocal", "invalid-request-local"],
  ["explicitNullCoalesce", "null-coalesce"], ["explicitNullRequestLocal", "null-request-local"],
];
const positive: Array<[string, string]> = [
  ["runtimeTrueEnablesSharingOverFalseDefaultTest", "runtime-enables-sharing"],
  ["inheritedFalseKeepsIndependentMemoizingSourcesTest", "inherited-false-request-last-writer"],
  ...["request", "local", "remote"].flatMap(layer => [
    [`${layer}AbsenceAndLiteralTextStayDistinctTest`, `absent-distinct-from-text:${layer}`],
    [`${layer}FalsyValuesRemainDistinctAndReusableTest`, `falsy-values:${layer}`],
  ] as Array<[string, string]>),
  ["localCohortEqualityBypassesBeforeAboveSampleCachesTest", "exact-serving-cohort:local"],
  ["remoteCohortEqualityBypassesBeforeAboveSampleCachesTest", "exact-serving-cohort:remote"],
  ["nullProviderInheritsConfiguredServingAndDefaultSharingTest", "null-provider-inherits-serving-and-sharing"],
  ["omittedRampAndSharingUseLibraryDefaultsTest", "default-ramp-and-sharing"],
  ["reenablingSharingUsesTheOmittedTrueDefaultTest", "reenabled-default-sharing"],
  ["falseRequestLeafPreservesMemoForReenablementTest", "bypass-preserves-cache:false-request-leaf"],
  ["invalidCoalesceBypassesWithoutReplacingRemoteTest", "bypass-preserves-cache:invalid-coalesce"],
  ["invalidRequestLocalBypassesWithoutReplacingRemoteTest", "bypass-preserves-cache:invalid-request-local"],
  ["explicitNullCoalesceBypassesWithoutReplacingRemoteTest", "bypass-preserves-cache:null-coalesce"],
  ["explicitNullRequestLocalBypassesWithoutReplacingRemoteTest", "bypass-preserves-cache:null-request-local"],
  ["runtimeLocalTtlWithoutRampActivatesLayerTest", "runtime-ttl-implies-ramp:local"],
  ["runtimeRemoteTtlWithoutRampActivatesLayerTest", "runtime-ttl-implies-ramp:remote"],
  ["disabledBaselineRampedUpKeepsDefaultSharingTest", "disabled-baseline-default-sharing"],
  ["fullFeatureKillSwitchKeepsOmittedSharingAndRetainedMemoTest", "full-feature-kill-switch"],
];
it.each(positive)("attributes the public consequence of %s", (name, witness) => {
  expect(runtimeBoundaryTraceWitnesses(fixture(name)).has(witness)).toBe(true);
});
it.each(["local", "remote"])("%s equality needs a later above-boundary cache probe", layer => {
  const trace = fixture(`${layer}CohortEqualityBypassesBeforeAboveSampleCachesTest`);
  trace.states.pop();
  expect(runtimeBoundaryTraceWitnesses(trace).has(`exact-serving-cohort:${layer}`)).toBe(false);
});
it("a full-ramp overlay cannot masquerade as the adjacent cohort quantum", () => {
  const trace = fixture("remoteCohortEqualityBypassesBeforeAboveSampleCachesTest");
  trace.states.find(s => s.input.name === "policy" && s.input.choice["#bigint"] === "8")!.input.choice["#bigint"] = "11";
  expect(runtimeBoundaryTraceWitnesses(trace).has("exact-serving-cohort:remote")).toBe(false);
});
it("coalesced completion under an inherited false overlay cannot credit runtime enablement", () => {
  const trace = fixture("runtimeTrueEnablesSharingOverFalseDefaultTest");
  trace.states.find(s => s.input.name === "policy")!.input.choice["#bigint"] = "9";
  expect(runtimeBoundaryTraceWitnesses(trace).has("runtime-enables-sharing")).toBe(false);
});
it("numeric input cannot receive literal-string coverage from the expected result alone", () => {
  const trace = fixture("requestAbsenceAndLiteralTextStayDistinctTest");
  trace.states.find(s => s.input.name === "resolveLoader" && Number(s.input.choice["#bigint"]) % 8 === 3)!.input.choice["#bigint"] = "8";
  expect(runtimeBoundaryTraceWitnesses(trace).has("absent-distinct-from-text:request")).toBe(false);
});
it.each(["request", "local", "remote"])("%s falsy evidence requires the final retained empty-string probe", layer => {
  const trace = fixture(`${layer}FalsyValuesRemainDistinctAndReusableTest`);
  trace.states.pop();
  expect(runtimeBoundaryTraceWitnesses(trace).has(`falsy-values:${layer}`)).toBe(false);
});
it("an empty provider response cannot credit a null provider response", () => {
  const trace = fixture("nullProviderInheritsConfiguredServingAndDefaultSharingTest");
  trace.states.find(s => s.input.name === "policy")!.input.choice["#bigint"] = "9";
  expect(runtimeBoundaryTraceWitnesses(trace).has("null-provider-inherits-serving-and-sharing")).toBe(false);
});
it.each(["invalidCoalesce", "invalidRequestLocal", "explicitNullCoalesce", "explicitNullRequestLocal"])("%s needs a retained-cache probe after bypass", prefix => {
  const trace = fixture(`${prefix}BypassesWithoutReplacingRemoteTest`);
  trace.states.pop();
  expect([...runtimeBoundaryTraceWitnesses(trace)].some(w => w.startsWith("bypass-preserves-cache:"))).toBe(false);
});
it("a TTL overlay with an explicit ramp cannot credit omitted-ramp inheritance", () => {
  const trace = fixture("runtimeLocalTtlWithoutRampActivatesLayerTest");
  trace.states.find(s => s.input.name === "policy")!.input.choice["#bigint"] = "20";
  expect(runtimeBoundaryTraceWitnesses(trace).has("runtime-ttl-implies-ramp:local")).toBe(false);
});
it("a disabled baseline needs an observed joined completion before default-sharing credit", () => {
  const trace = fixture("disabledBaselineRampedUpKeepsDefaultSharingTest");
  const resolution = trace.states.find(s => s.input.name === "resolveLoader" && s.input.choice["#bigint"] === "9")!;
  resolution.s.o.calls[2] = { "#bigint": "0" };
  expect(runtimeBoundaryTraceWitnesses(trace).has("disabled-baseline-default-sharing")).toBe(false);
});
it("the full kill switch needs independent killed sources and later memo reuse", () => {
  const trace = fixture("fullFeatureKillSwitchKeepsOmittedSharingAndRetainedMemoTest");
  trace.states.pop();
  expect(runtimeBoundaryTraceWitnesses(trace).has("full-feature-kill-switch")).toBe(false);
});
it("the null provider needs the later remote hit on its shared publication", () => {
  const trace = fixture("nullProviderInheritsConfiguredServingAndDefaultSharingTest");
  trace.states.pop();
  expect(runtimeBoundaryTraceWitnesses(trace).has("null-provider-inherits-serving-and-sharing")).toBe(false);
});
it("an explicit coalesce leaf without a runtime TTL cannot credit omitted-ramp inheritance", () => {
  // Code 11 is {coalesce:true}: no ramp key and no TTL, so fixture 7 configures no remote layer.
  const trace = fixture("runtimeRemoteTtlWithoutRampActivatesLayerTest");
  choose(trace.states[indexOfNth(trace, "policy", 0)]!, 11);
  expect(runtimeBoundaryTraceWitnesses(trace).has("runtime-ttl-implies-ramp:remote")).toBe(false);
});
it.each([["local", "runtimeLocalTtlWithoutRampActivatesLayerTest"], ["remote", "runtimeRemoteTtlWithoutRampActivatesLayerTest"]])("a runtime %s TTL needs the later hit on its publication", (layer, name) => {
  const trace = fixture(name);
  trace.states.pop();
  expect(runtimeBoundaryTraceWitnesses(trace).has(`runtime-ttl-implies-ramp:${layer}`)).toBe(false);
});
it("an explicit coalesce:true leaf cannot credit omitted-leaf defaults", () => {
  // Code 11 is {coalesce:true} with the ramp omitted; no driver code carries an explicit ramp with an omitted coalesce leaf.
  const trace = fixture("omittedRampAndSharingUseLibraryDefaultsTest");
  trace.states.splice(1, 0, policyStep(trace, 11));
  expect(runtimeBoundaryTraceWitnesses(trace).has("default-ramp-and-sharing")).toBe(false);
});
it("library defaults need the later remote hit on the shared publication", () => {
  const trace = fixture("omittedRampAndSharingUseLibraryDefaultsTest");
  trace.states.pop();
  expect(runtimeBoundaryTraceWitnesses(trace).has("default-ramp-and-sharing")).toBe(false);
});
it.each(bypasses)("%s that replaces the retained entry at its settlement did not preserve it", (prefix, leaf) => {
  const trace = fixture(`${prefix}BypassesWithoutReplacingRemoteTest`);
  bump(trace, indexOfNth(trace, "resolveLoader", 1), "writes");
  expect(runtimeBoundaryTraceWitnesses(trace).has(`bypass-preserves-cache:${leaf}`)).toBe(false);
});
it.each(bypasses)("%s that consults the layer at its release did not bypass it", (prefix, leaf) => {
  const trace = fixture(`${prefix}BypassesWithoutReplacingRemoteTest`);
  bump(trace, indexOfNth(trace, "releasePolicy", 1), "reads");
  expect(runtimeBoundaryTraceWitnesses(trace).has(`bypass-preserves-cache:${leaf}`)).toBe(false);
});
it.each(bypasses)("%s under a layer enabled only by a runtime TTL reply shows no bypass", (prefix, leaf) => {
  // In fixture 6 the local layer is on only under code 18, so a coerced or inherited reading also starts a loader with no read.
  const trace = fixture(`${prefix}BypassesWithoutReplacingRemoteTest`);
  choose(trace.states[0]!, 6);
  trace.states.splice(1, 0, policyStep(trace, 18));
  choose(trace.states[indexOfNth(trace, "policy", 2)]!, 18);
  zeroRemoteCounters(trace);
  expect(runtimeBoundaryTraceWitnesses(trace).has(`bypass-preserves-cache:${leaf}`)).toBe(false);
});
it.each(bypasses.filter(([prefix]) => prefix.endsWith("RequestLocal")))("%s in a request-layer fixture is publicly identical to requestLocal:false", (prefix, leaf) => {
  const trace = fixture(`${prefix}BypassesWithoutReplacingRemoteTest`);
  choose(trace.states[0]!, 3);
  zeroRemoteCounters(trace);
  expect(runtimeBoundaryTraceWitnesses(trace).has(`bypass-preserves-cache:${leaf}`)).toBe(false);
});
it.each(["local", "remote"])("%s absence and literal text need the later hit on the latest publication", layer => {
  const trace = fixture(`${layer}AbsenceAndLiteralTextStayDistinctTest`);
  trace.states.pop();
  expect(runtimeBoundaryTraceWitnesses(trace).has(`absent-distinct-from-text:${layer}`)).toBe(false);
});
it("runtime enablement needs a second caller completed by the shared settlement", () => {
  const trace = fixture("runtimeTrueEnablesSharingOverFalseDefaultTest");
  for (const state of trace.states.slice(indexOfNth(trace, "resolveLoader", 0))) state.s.o.calls[1] = integer(0);
  expect(runtimeBoundaryTraceWitnesses(trace).has("runtime-enables-sharing")).toBe(false);
});
it("overlapping memoizing sources that settle the same value cannot show the last writer", () => {
  const trace = fixture("inheritedFalseKeepsIndependentMemoizingSourcesTest");
  const settlement = indexOfNth(trace, "resolveLoader", 0);
  choose(trace.states[settlement]!, 8); // loader 1 also settles value 1
  for (const state of trace.states.slice(settlement)) state.s.o.calls[1] = integer(1);
  expect(runtimeBoundaryTraceWitnesses(trace).has("inherited-false-request-last-writer")).toBe(false);
});
it("an above-sample source that overlapped the equality source cannot show the exact boundary", () => {
  // Policy 5: A starts loader 0. Policy 8: B starts loader 1 while A is pending. A settles 1, B settles 2, a probe under 8
  // hits 2. In the local fixture reads and writes stay 0, so a port admitting the key at equality shows the same history.
  const trace = fixture("localCohortEqualityBypassesBeforeAboveSampleCachesTest");
  trace.states = [trace.states[0]!, step(trace, "policy", 5, [], 0), step(trace, "beginCall", -1, [0], 0), step(trace, "releasePolicy", -1, [0], 1),
    step(trace, "policy", 8, [0], 1), step(trace, "beginCall", -1, [0, 0], 1), step(trace, "releasePolicy", -1, [0, 0], 2),
    step(trace, "resolveLoader", 0, [1, 0], 2), step(trace, "resolveLoader", 9, [1, 2], 2),
    step(trace, "beginCall", -1, [1, 2, 0], 2), step(trace, "releasePolicy", -1, [1, 2, 2], 2)];
  expect(runtimeBoundaryTraceWitnesses(trace).has("exact-serving-cohort:local")).toBe(false);
});
it("a runtime TTL without a ramp leaves the disabled baseline disabled", () => {
  const trace = fixture("disabledBaselineRampedUpKeepsDefaultSharingTest");
  choose(trace.states[indexOfNth(trace, "policy", 0)]!, 18);
  expect(runtimeBoundaryTraceWitnesses(trace).has("disabled-baseline-default-sharing")).toBe(false);
});
it("disabling only request memoization is the false-request-leaf bypass, not the kill switch", () => {
  const trace = fixture("fullFeatureKillSwitchKeepsOmittedSharingAndRetainedMemoTest");
  choose(trace.states[indexOfNth(trace, "policy", 0)]!, 13);
  const labels = runtimeBoundaryTraceWitnesses(trace);
  expect(labels.has("full-feature-kill-switch")).toBe(false);
  expect(labels.has("bypass-preserves-cache:false-request-leaf")).toBe(true);
});

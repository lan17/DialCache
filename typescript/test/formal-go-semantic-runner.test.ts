import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../../formal/measure-go-semantics.mjs", import.meta.url).href;
const { evaluateGoTestEvents } = await import(moduleUrl) as {
  evaluateGoTestEvents(events: string, exitCode: number, expectedPackages?: number): { state: string; assertionKinds: Record<string, string> };
};
const publicPackage = "github.com/lan17/DialCache/go";
const internalPackage = `${publicPackage}/internal/dialcache`;

function replayFailure(parent: string, file: string, output: string): string {
  const leaf = `${parent}/trace.itf.json`;
  return [
    { Action: "run", Test: parent },
    { Action: "run", Test: leaf },
    { Action: "output", Test: leaf, Output: `    ${file}:84: ${output}\n` },
    { Action: "fail", Test: leaf },
    { Action: "fail", Test: parent },
    { Action: "fail" },
  ].map(event => JSON.stringify({ Package: internalPackage, ...event })).join("\n");
}
const localClockFailure = (output: string) => replayFailure("TestLocalClockConformance", "local_clock_profile_test.go", output);

it("requires both public and internal package completion for ordinary Go mutations", () => {
  const publicTests = [
    { Action: "run", Test: "TestDocsRequestScope" },
    { Action: "pass", Test: "TestDocsRequestScope" },
    { Action: "pass" },
  ].map(event => JSON.stringify({ Package: publicPackage, ...event })).join("\n");
  const internalFailure = replayFailure("TestCache", "cache_test.go", "unexpected value");
  const both = `${publicTests}\n${internalFailure}`;
  expect(evaluateGoTestEvents(both, 1, 2)).toMatchObject({ state: "detected" });
  expect(() => evaluateGoTestEvents(internalFailure, 1, 2)).toThrow(/incomplete or skipped/);
  expect(() => evaluateGoTestEvents(both, 1)).toThrow(/incomplete or skipped/);
  expect(() => evaluateGoTestEvents(both.replace('"Action":"pass"}', '"Action":"skip"}'), 1, 2)).toThrow(/incomplete or skipped/);
});

it("does not let one package's assertion failure hide another package's crash", () => {
  const internalFailure = replayFailure("TestCache", "cache_test.go", "unexpected value");
  const publicCrash = [
    { Action: "run", Test: "TestPublicCacheAndErrors" },
    { Action: "pass", Test: "TestPublicCacheAndErrors" },
    { Action: "output", Output: "signal: killed\n" },
    { Action: "fail" },
  ].map(event => JSON.stringify({ Package: publicPackage, ...event })).join("\n");
  expect(() => evaluateGoTestEvents(`${internalFailure}\n${publicCrash}`, 1, 2)).toThrow(/package status and assertion results disagree/);
});

describe("Go local-clock mutation assertion attribution", () => {
  it("requires an observable replay mismatch for the new clock profile", () => {
    const result = evaluateGoTestEvents(localClockFailure("expected: {\"loaders\":1}\nactual: {\"loaders\":2}"), 1);
    expect(result).toMatchObject({ state: "detected", assertionKinds: {
      "TestLocalClockConformance/trace.itf.json": "observation-mismatch",
    } });
  });
  it("retains the raw failing assertion for diagnosis", () => {
    const message = "/tmp/corpus/regressions/shadow-layers/capturedRetentionTest.itf.json step 4 action resolveLoader: Observation mismatch\n" +
      "expected: {\"o\":{\"policyCalls\":1,\"writeTtls\":[]}}\nactual: {\"o\":{\"policyCalls\":2,\"writeTtls\":[]}}";
    const result = evaluateGoTestEvents(replayFailure("TestFeatureConformance", "feature_replay_test.go",
      message), 1);
    expect(result).toMatchObject({ assertionEvidence: {
      "TestFeatureConformance/trace.itf.json": `    feature_replay_test.go:84: ${message}\n`,
    } });
  });
  it("credits the core replay's coalesced-pair assertion, which carries no expected/actual pair", () => {
    const pair = replayFailure("TestCoreConformance", "core_replay_test.go", "pair returned different values");
    expect(evaluateGoTestEvents(pair, 1)).toMatchObject({ state: "detected", assertionKinds: { "TestCoreConformance/trace.itf.json": "pair-value-mismatch" } });
    const requestPair = replayFailure("TestCoreConformance", "core_replay_test.go", "request pair differs");
    expect(evaluateGoTestEvents(requestPair, 1)).toMatchObject({ state: "detected", assertionKinds: { "TestCoreConformance/trace.itf.json": "pair-value-mismatch" } });
    // The same text from another file is not the core replay's assertion.
    expect(() => evaluateGoTestEvents(replayFailure("TestCoreConformance", "feature_replay_test.go", "pair returned different values"), 1)).toThrow(/replay failure lacks observation/);
  });
  it("refuses a settlement violation as evidence and names the violating line", () => {
    const violation = replayFailure("TestFeatureConformance", "feature_replay_test.go",
      "control.itf.json step 3 action beginCall: Settlement violation: 1 runnable task(s) at observation");
    expect(() => evaluateGoTestEvents(violation, 1)).toThrow(/settlement violation under mutation is not comparison evidence/);
    // The violating line travels with the error, so a mutant's cohort can be recorded against it by name.
    const thrown = (() => { try { evaluateGoTestEvents(violation, 1); } catch (error) { return error as Error & { settlementViolation?: string }; } return undefined; })();
    expect(thrown?.settlementViolation).toBe("feature_replay_test.go:84: control.itf.json step 3 action beginCall: Settlement violation: 1 runnable task(s) at observation");
    // The bare phrase, or a printed expectation regex, is not a rule text: no violation is recorded and the strict rule applies.
    const quoted = replayFailure("TestFeatureConformance", "feature_replay_test.go", "control did not fail through a Settlement violation: \\d+ runnable task\\(s\\) at observation");
    const strict = (() => { try { evaluateGoTestEvents(quoted, 1); } catch (error) { return error as Error & { settlementViolation?: string }; } return undefined; })();
    expect(strict?.message).toMatch(/replay failure lacks observation/);
    expect(strict?.settlementViolation).toBeUndefined();
  });
  it.each(["unknown trace input", "call before instance construction", "default clock started with negative elapsed time"])(
    "does not credit infrastructure failure: %s", message => {
      expect(() => evaluateGoTestEvents(localClockFailure(message), 1)).toThrow(/replay failure lacks observation/);
    },
  );
});


it("does not count Redis transport or driver errors as native assertions", () => {
  expect(() => evaluateGoTestEvents(replayFailure("TestGeneratedInvalidationVectors", "invalidation_vector_driver_test.go",
    "INVALIDATION_INFRASTRUCTURE: connection refused"), 1)).toThrow(/Redis vector infrastructure failure/);
  expect(evaluateGoTestEvents(replayFailure("TestGeneratedInvalidationVectors", "invalidation_vector_driver_test.go",
    "invalidation result: got cutoff=1000 want cutoff=10000000"), 1)).toMatchObject({state: "detected"});
});

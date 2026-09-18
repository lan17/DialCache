import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../formal/measure-go-semantics.mjs", import.meta.url).href;
const { evaluateGoTestEvents } = await import(moduleUrl) as {
  evaluateGoTestEvents(events: string, exitCode: number): { state: string; assertionKinds: Record<string, string> };
};

function replayFailure(parent: string, file: string, output: string): string {
  const leaf = `${parent}/trace.itf.json`;
  return [
    { Action: "run", Test: parent },
    { Action: "run", Test: leaf },
    { Action: "output", Test: leaf, Output: `    ${file}:84: ${output}\n` },
    { Action: "fail", Test: leaf },
    { Action: "fail", Test: parent },
    { Action: "fail" },
  ].map(event => JSON.stringify(event)).join("\n");
}
const localClockFailure = (output: string) => replayFailure("TestLocalClockConformance", "local_clock_profile_test.go", output);

describe("Go local-clock mutation assertion attribution", () => {
  it("requires an observable replay mismatch for the new clock profile", () => {
    const result = evaluateGoTestEvents(localClockFailure("expected: {\"loaders\":1}\nactual: {\"loaders\":2}"), 1);
    expect(result).toMatchObject({ state: "detected", assertionKinds: {
      "TestLocalClockConformance/trace.itf.json": "observation-mismatch",
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
  });
  it.each(["unknown trace input", "call before instance construction", "default clock started with negative elapsed time"])(
    "does not credit infrastructure failure: %s", message => {
      expect(() => evaluateGoTestEvents(localClockFailure(message), 1)).toThrow(/replay failure lacks observation/);
    },
  );
});

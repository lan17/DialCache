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
  it.each(["unknown trace input", "call before instance construction", "default clock started with negative elapsed time"])(
    "does not credit infrastructure failure: %s", message => {
      expect(() => evaluateGoTestEvents(localClockFailure(message), 1)).toThrow(/replay failure lacks observation/);
    },
  );
});

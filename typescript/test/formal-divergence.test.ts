import { describe, expect, it } from "vitest";
import assert, { AssertionError } from "node:assert/strict";
import { assertObservation, countingPaths, diffPaths, isObservationComparison } from "../../formal/replay/divergence.mjs";

describe("comparison divergence paths", () => {
  it("tags only a complete comparison, preserving the original assertion and records", () => {
    const capture = (run: () => void) => { try { run(); } catch (error) { return error; } throw new Error("Expected an assertion"); };
    const complete = capture(() => assertObservation({ o: { loads: 2 } }, { o: { loads: 1 } }));
    expect(complete).toBeInstanceOf(AssertionError);
    expect(isObservationComparison(complete)).toBe(true);
    expect(complete).toMatchObject({ actual: { o: { loads: 2 } }, expected: { o: { loads: 1 } } });
    const project = () => { assert.equal("served", undefined); return {}; };
    const partial = capture(() => assertObservation(project(), {}));
    expect(partial).toBeInstanceOf(AssertionError);
    expect(isObservationComparison(partial)).toBe(false);
  });

  it("compares named fields, array elements and lengths without losing missing members", () => {
    expect(diffPaths({ o: { calls: [1], loaders: 1 } }, { o: { calls: [2, 1], loaders: 1 } }))
      .toEqual(["o.calls.0", "o.calls.1", "o.calls.length"]);
    expect(diffPaths({ a: undefined }, {})).toEqual(["a"]);
    expect(diffPaths([], [undefined])).toEqual(["0", "length"]);
    expect(diffPaths({ o: { calls: [] } }, { o: { calls: [] } })).toEqual([]);
    expect(diffPaths(1, 2)).toEqual(["$"]);
  });

  it("counts the carried write consequence at M29's checkpoint, never its earlier provider call", () => {
    const divergences = [
      { step: 4, paths: ["o.policyCalls"] },
      { step: 6, paths: ["o.policyCalls", "o.writeTtls.0"] },
      { step: 7, paths: ["o.policyCalls", "o.writeTtls.0"] },
    ];
    expect(countingPaths(["o.writeTtls", "o.shadow"], divergences[2]!.paths, divergences[1]!.paths)).toEqual(["o.writeTtls.0"]);
    expect(countingPaths(["o.policyCalls", "o.writeTtls"], divergences[2]!.paths, divergences[1]!.paths)).toEqual(["o.writeTtls.0"]);
  });

  it("counts new counters where that effect is the boundary, including flat projections", () => {
    expect(countingPaths(["o.calls", "o.dumps", "o.loads"], ["o.dumps", "o.loads"], [])).toEqual(["o.dumps", "o.loads"]);
    expect(countingPaths(["o.dumps"], ["o.dumps"], ["o.dumps"])).toEqual([]);
    expect(countingPaths(["loaders", "calls"], ["loaders", "calls.0"], ["loaders", "calls.0"])).toEqual(["calls.0"]);
    expect(countingPaths(["d.configErrors", "d.warnings"], ["d.configErrors", "d.warnings"], ["d.configErrors"]))
      .toEqual(["d.warnings"]);
  });

  it("requires the declared field itself or a descendant and never credits a scalar assertion", () => {
    expect(countingPaths(["o.calls"], ["o", "o.callsExtra", "$", "o.calls.0"], [])).toEqual(["o.calls.0"]);
    // A counter repaired at k-1 can newly diverge at k; older differences do not suppress it.
    expect(countingPaths(["o.reads"], ["o.reads"], [])).toEqual(["o.reads"]);
  });

  it("does not reuse core's earlier counter mismatch as evidence at a later result", () => {
    const counters = ["outsideLoaderCalls", "requestLoaderCalls", "localLoaderCalls", "coalescedLoaderCalls", "remoteLoaderCalls", "redisReads", "redisWrites"];
    expect(countingPaths([...counters, "lastResult"], [...counters, "lastResult"], counters)).toEqual(["lastResult"]);
    expect(countingPaths(["redisWrites", "remoteLoaderCalls"], ["redisWrites", "remoteLoaderCalls"], ["redisWrites"]))
      .toEqual(["remoteLoaderCalls"]);
  });
});

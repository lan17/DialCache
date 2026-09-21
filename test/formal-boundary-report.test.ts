import { describe, expect, it } from "vitest";

type Evidence = { challenge: string; mutant: string; history: string; step: number; fields: string[] };
type Recording = { path: string; completed: boolean; lastStep: number; divergences: Array<{ step: number; paths: string[] }>; error?: string };
type Verdict = { state: string; matched?: string[]; reason?: string; divergences?: unknown[] };
const { assessBoundary, parseAssertionDivergences, boundaryReview } = await import(new URL("../formal/mutation-reports.mjs", import.meta.url).href) as {
  assessBoundary(evidence: Evidence | { challenge: string; mutant: string; state: string }, recording?: Recording): Verdict;
  parseAssertionDivergences(text: string, name?: string): unknown[];
  boundaryReview(report: unknown, evidence: unknown[], options?: { requireEntries?: boolean }): Verdict[];
};
const evidence: Evidence = { challenge: "captured-retention", mutant: "M29", history: "shadow-layers/capturedTest", step: 7, fields: ["o.writeTtls", "o.shadow"] };
const record = (changes: Partial<Recording> = {}): Recording => ({
  path: "/tmp/corpus/regressions/shadow-layers/capturedTest.itf.json", completed: true, lastStep: 11,
  divergences: [{ step: 4, paths: ["o.policyCalls"] }, { step: 6, paths: ["o.policyCalls", "o.writeTtls.0"] }, { step: 7, paths: ["o.policyCalls", "o.writeTtls.0"] }],
  ...changes,
});

describe("native boundary evidence", () => {
  it("credits the captured TTL at its checkpoint after an earlier unrelated provider call", () => {
    expect(assessBoundary(evidence, record())).toMatchObject({ state: "confirmed", matched: ["o.writeTtls.0"] });
    expect(assessBoundary({ ...evidence, fields: ["o.policyCalls"] }, record()).state).toBe("side-effect-only");
    expect(assessBoundary({ ...evidence, step: 4, fields: ["o.policyCalls"] }, record()).state).toBe("confirmed");
  });

  it("credits newly divergent decode counters but not a carried counter", () => {
    const target = { ...evidence, fields: ["o.calls", "o.dumps", "o.loads"] };
    expect(assessBoundary(target, record({ divergences: [{ step: 7, paths: ["o.dumps", "o.loads"] }] })).state).toBe("confirmed");
    expect(assessBoundary(target, record({ divergences: [{ step: 6, paths: ["o.dumps"] }, { step: 7, paths: ["o.dumps"] }] })).state).toBe("side-effect-only");
  });

  it("keeps failed or incomplete replays outside detection even after a matching divergence", () => {
    expect(assessBoundary(evidence, record({ completed: false, lastStep: 7, error: "step 8 releaseDump: No pending dump 0" }))).toMatchObject({ state: "unreached", reason: expect.stringContaining("step 8 releaseDump") });
    expect(assessBoundary(evidence, record({ completed: false, error: "step 8: Settlement violation: read gates" }))).toMatchObject({ state: "unreached", reason: expect.stringContaining("Settlement violation") });
    expect(assessBoundary(evidence, record({ lastStep: 6 })).state).toBe("unreached");
    expect(assessBoundary(evidence, record({ path: "/tmp/regressions/shadow-layers/otherTest.itf.json" })).state).toBe("unreached");
    expect(assessBoundary(evidence).state).toBe("unreached");
    expect(assessBoundary(evidence, record({ divergences: [{ step: 7, paths: ["o.writeTtls.0"] }, { step: 7, paths: ["o.shadow"] }] })).state).toBe("unreached");
  });

  it("reports clean mutants and unmapped execution boundaries explicitly", () => {
    expect(assessBoundary(evidence, record({ divergences: [] })).state).toBe("not-divergent");
    for (const state of ["vector", "unreproduced"]) expect(assessBoundary({ challenge: "gap", mutant: "M06", state }).state).toBe(state);
  });

  it("parses comparable legacy observations without treating raw-driver layouts as differences", () => {
    const prefix = "/tmp/regressions/shadow-layers/capturedTest.itf.json step 7 action releaseWrite";
    expect(parseAssertionDivergences(`${prefix}\nexpected: {"o":{"writeTtls":[120000]}}\nactual: {"o":{"writeTtls":[180000]}}`)).toEqual([
      { history: evidence.history, step: 7, action: "releaseWrite", paths: ["o.writeTtls.0"] },
    ]);
    expect(parseAssertionDivergences(`${prefix}\nexpected: {"o":{"calls":[1]}}\nactual: {"calls":[1],"events":[]}`)).toEqual([]);
    expect(parseAssertionDivergences(`${prefix}\nexpected: invalid\nactual: {}`)).toEqual([]);
    expect(parseAssertionDivergences(`${prefix}\nexpected: true\nactual: false`)).toEqual([]);
  });

  it("does not turn first-mismatch artifacts into a complete recording", () => {
    const reviewed = boundaryReview({ mutations: [{ id: "M29", cohorts: { generated: { divergences: [{ history: evidence.history, step: 7, paths: ["o.writeTtls.0"] }] } } }] }, [evidence]);
    expect(reviewed).toEqual([expect.objectContaining({ state: "unreached", reason: expect.stringContaining("historical first-mismatch") })]);
  });

  it("requires an explicit entry for coverage limitations when gating a report", () => {
    const limitation = { challenge: "not-yet-reproduced", mutant: "M29", state: "unreproduced" };
    const report = { mutations: [{ id: "M29", cohorts: {} }] };
    expect(boundaryReview(report, [limitation])[0]?.state).toBe("unreproduced");
    expect(boundaryReview(report, [limitation], { requireEntries: true })[0]).toMatchObject({ state: "unreached", reason: expect.stringContaining("per-challenge") });
    expect(boundaryReview({ mutations: [{ ...report.mutations[0], boundary: [limitation] }] }, [limitation], { requireEntries: true })[0]?.state).toBe("unreproduced");
  });

  it("refuses missing mutants, stale pins and missing clean baselines when reading reports", () => {
    expect(boundaryReview({ mutations: [] }, [evidence])[0]).toMatchObject({ state: "unreached", reason: expect.stringContaining("absent") });
    const confirmed = assessBoundary(evidence, record());
    const report = { mutations: [{ id: "M29", cohorts: {}, boundary: [confirmed] }],
      boundaryBaselines: { [evidence.history]: { ...record({ divergences: [] }), history: evidence.history } } };
    expect(boundaryReview(report, [evidence])[0]?.state).toBe("confirmed");
    expect(boundaryReview(report, [{ ...evidence, step: 8 }])[0]).toMatchObject({ state: "unreached", reason: expect.stringContaining("current evidence") });
    expect(boundaryReview({ ...report, boundaryBaselines: {} }, [evidence])[0]).toMatchObject({ state: "unreached", reason: expect.stringContaining("baseline") });
    expect(boundaryReview({ ...report, mutations: [{ id: "M29", cohorts: {}, boundary: [{ ...confirmed, divergences: [] }] }] }, [evidence])[0]?.state).toBe("not-divergent");
  });
});

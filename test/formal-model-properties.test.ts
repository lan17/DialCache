import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Reproducer = { kind: string; run: string; family: string; profiles: string[]; exclusions: Record<string, string>; scope?: string };
type Challenge = { id: string; contract: string; source: string; model: string; invariant: string; before: string; after: string; measures?: string; reproducer?: Reproducer };
const { validatePropertyResult, validateReproducerResult, selectChallenges } = await import(new URL("../formal/check-model-properties.mjs", import.meta.url).href) as {
  validatePropertyResult(result: unknown, exitCode: number, expectation: string): void;
  validateReproducerResult(output: unknown, exitCode: number | null, run: unknown, expectation: string): { status: string; failure?: string };
  selectChallenges(manifest: { challenges: Challenge[] }, only?: string): Challenge[];
};
const manifest = JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as { challenges: Challenge[] };
// Shapes copied from `quint test --match=^run$` on Quint 0.32.0.
const passing = (run: string) => `\n  dialcache_source_budgets_conformance\n    ok ${run} passed 1 test(s)\n\n  1 passing (105ms)\n\n`;
const failing = (run: string, code = "QNT508", message = "Expect condition does not hold true") =>
  `\n  dialcache_source_budgets_conformance\n    1) ${run} failed after 1 test(s)\n\n  1 failed\n\n  1) ${run}:\n       Error [${code}]: ${message}\n        at formal/x.qnt:198:54\n    Use --seed=0xd1a1ca --match=${run} to repeat.\n\nerror: Tests failed\n`;
const selectedNothing = "\n  dialcache_source_budgets_conformance\n\n";
const compileError = "error: parsing failed\nformal/x.qnt:12:3 - error: [QNT000] mismatched input\n";

describe("model property challenge evidence", () => {
  it("accepts a successful baseline and a compiling initial-state invariant counterexample", () => {
    expect(() => validatePropertyResult({ status: "ok", errors: [], trace: [{}] }, 0, "baseline")).not.toThrow();
    expect(() => validatePropertyResult({ status: "violation", errors: [], trace: [{}] }, 1, "mutant")).not.toThrow();
  });
  it("rejects survivors, unexpected exits and broken baselines", () => {
    expect(() => validatePropertyResult({ status: "ok", errors: [], trace: [{}] }, 0, "mutant")).toThrow(/survived/);
    expect(() => validatePropertyResult({ status: "violation", errors: [], trace: [{}] }, 2, "mutant")).toThrow(/invariant violation/);
    expect(() => validatePropertyResult({ status: "violation", errors: [], trace: [{}] }, 1, "baseline")).toThrow(/Unmodified/);
  });
  it("never credits evaluator failures or missing counterexamples", () => {
    for (const result of [null, {}, { status: "violation", errors: ["type error"], trace: [{}] },
      { status: "violation", errors: [], trace: [] }, { status: "violation", trace: [{}] }]) {
      expect(() => validatePropertyResult(result, 1, "mutant")).toThrow(/not property evidence/);
    }
    expect(() => validatePropertyResult({ status: "ok", errors: [], trace: [{}] }, 0, "unknown")).toThrow(/Unknown/);
  });
  it("credits a reproducer only when its own named run passes clean and fails under the fault", () => {
    const run = "defaultSourceBudgetExpiresAtSixtySecondsTest";
    expect(validateReproducerResult(passing(run), 0, run, "baseline")).toEqual({ status: "passed" });
    expect(validateReproducerResult(failing(run), 1, run, "mutant")).toEqual({ status: "failed", failure: "QNT508" });
    expect(validateReproducerResult(failing(run, "QNT513", "Cannot continue in `then`"), 1, run, "mutant")).toEqual({ status: "failed", failure: "QNT513" });
    // A history the fault does not distinguish is a measurement failure with its own message.
    expect(() => validateReproducerResult(passing(run), 0, run, "mutant")).toThrow(/passes under the fault: this history does not distinguish it/);
    expect(() => validateReproducerResult(failing(run), 1, run, "baseline")).toThrow(/must pass on the unmodified model/);
    expect(() => validateReproducerResult(passing(run), 1, run, "baseline")).toThrow(/must pass on the unmodified model/);
    // The pattern selected nothing, another run failed, or the model did not compile.
    expect(() => validateReproducerResult(selectedNothing, 0, run, "baseline")).toThrow(/did not run/);
    expect(() => validateReproducerResult(selectedNothing, 0, run, "mutant")).toThrow(/did not run/);
    expect(() => validateReproducerResult(failing("someOtherTest"), 1, run, "mutant")).toThrow(/did not run/);
    expect(() => validateReproducerResult(compileError, 1, run, "mutant")).toThrow(/did not run/);
    expect(() => validateReproducerResult(passing("some.Test") + failing(run), 1, "some.Test", "mutant")).toThrow(/passes under the fault/);
    expect(() => validateReproducerResult(failing(run), 2, run, "mutant")).toThrow(/ended abnormally \(exit 2\)/);
    expect(() => validateReproducerResult(failing(run), null, run, "mutant")).toThrow(/ended abnormally/);
    expect(() => validateReproducerResult(failing(run).replace(/Error \[QNT508\]: /, ""), 1, run, "mutant")).toThrow(/without a Quint run error code/);
    expect(() => validateReproducerResult(passing(run), 0, run, "unknown")).toThrow(/Unknown/);
    expect(() => validateReproducerResult(undefined, 0, run, "baseline")).toThrow(/required/);
    expect(() => validateReproducerResult(passing(run), 0, "", "baseline")).toThrow(/required/);
  });
  it("carries every manifest reproducer into the report entries as pending until measured", () => {
    const cited = manifest.challenges.filter(challenge => challenge.reproducer);
    expect(cited.length).toBeGreaterThanOrEqual(5);
    for (const challenge of cited) {
      const model = readFileSync(new URL(`../${challenge.model}`, import.meta.url), "utf8");
      expect(model, challenge.id).toMatch(new RegExp(`\\brun ${challenge.reproducer!.run}\\b`));
    }
  });
  it("reads the catalog from the execution manifest and selects only known challenge ids", () => {
    expect(selectChallenges(manifest)).toBe(manifest.challenges);
    const [first, second] = manifest.challenges;
    expect(selectChallenges(manifest, `${second!.id},${first!.id}`)).toEqual([first, second]);
    expect(() => selectChallenges(manifest, `${first!.id},invented-fault`)).toThrow(/Unknown model property challenges: invented-fault/);
  });
  it("keeps unique compiling-fault anchors and named independent target properties", () => {
    expect(new Set(manifest.challenges.map(challenge => challenge.id)).size).toBe(manifest.challenges.length);
    for (const challenge of manifest.challenges) {
      const source = readFileSync(new URL(`../${challenge.source}`, import.meta.url), "utf8");
      const model = readFileSync(new URL(`../${challenge.model}`, import.meta.url), "utf8");
      expect(source.split(challenge.before), challenge.id).toHaveLength(2);
      expect(challenge.after, challenge.id).not.toBe(challenge.before);
      expect(model, challenge.id).toMatch(new RegExp(`\\bval ${challenge.invariant}\\b`));
    }
  });
});

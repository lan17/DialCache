import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Reproducer = { kind: string; run: string; model?: string; failure: string; family: string; profiles: string[]; exclusions: Record<string, string>; scope?: string };
type Challenge = { id: string; contract: string; source: string; model: string; invariant: string; before: string; after: string; measures?: string; reproducer?: Reproducer };
const { validatePropertyResult, validateReproducerResult, probeNames, selectChallenges } = await import(new URL("../formal/check-model-properties.mjs", import.meta.url).href) as {
  validatePropertyResult(result: unknown, exitCode: number, expectation: string): void;
  validateReproducerResult(output: unknown, exitCode: number | null, run: unknown, expectation: string): { status: string; code?: string };
  probeNames(run: string): { before: string; through: string };
  selectChallenges(manifest: { challenges: Challenge[] }, only?: string): Challenge[];
};
const { reproducerCheckpoint } = await import(new URL("../formal/execution.mjs", import.meta.url).href) as {
  reproducerCheckpoint(source: string, run: string, failure: string): { before: string; through: string };
};
const manifest = JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as { challenges: Challenge[] };
// Shapes copied from `quint test --match=^(run|probes)$` on Quint 0.32.0: one
// line per selected run, then one error block per failed run.
type Failure = { name: string; code?: string; message?: string };
const report = (passed: string[], failed: Failure[]) => {
  const lines = ["", "  dialcache_source_budgets_conformance"];
  passed.forEach(name => lines.push(`    ok ${name} passed 1 test(s)`));
  failed.forEach(({ name }, index) => lines.push(`    ${index + 1}) ${name} failed after 1 test(s)`));
  lines.push("", `  ${passed.length} passing (105ms)`);
  if (failed.length) {
    lines.push(`  ${failed.length} failed`, "");
    failed.forEach(({ name, code = "QNT508", message = "Expect condition does not hold true" }, index) => {
      lines.push(`  ${index + 1}) ${name}:`, `       Error [${code}]: ${message}`, "        at formal/x.qnt:198:54", `    Use --seed=0xd1a1ca --match=${name} to repeat.`, "");
    });
    lines.push("error: Tests failed");
  }
  return lines.join("\n") + "\n";
};
const run = "defaultSourceBudgetExpiresAtSixtySecondsTest";
const { before, through } = probeNames(run);
const clean = report([run, before, through], []);
const detected = report([before], [{ name: run }, { name: through }]);
const disabled = { code: "QNT513", message: "Cannot continue in `then` because the highlighted expression evaluated to false" };
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
  it("credits a reproducer only when its run passes clean and fails under the fault at the declared checkpoint", () => {
    expect(validateReproducerResult(clean, 0, run, "baseline")).toEqual({ status: "passed" });
    expect(validateReproducerResult(detected, 1, run, "mutant")).toEqual({ status: "failed", code: "QNT508" });
    // A history the fault does not distinguish is a measurement failure with its own message.
    expect(() => validateReproducerResult(clean, 0, run, "mutant")).toThrow(/passes under the fault: this history does not distinguish it/);
    expect(() => validateReproducerResult(detected, 1, run, "baseline")).toThrow(/must pass on the unmodified model/);
    expect(() => validateReproducerResult(report([run, through], [{ name: before }]), 1, run, "baseline")).toThrow(/must pass on the unmodified model/);
    expect(() => validateReproducerResult(clean, 1, run, "baseline")).toThrow(/must pass on the unmodified model/);
    // The failure must sit at the declared checkpoint: not at a step before it, not after it, and as an expect that did not hold.
    expect(() => validateReproducerResult(report([], [{ name: run, ...disabled }, { name: before, ...disabled }, { name: through, ...disabled }]), 1, run, "mutant"))
      .toThrow(/fails before its declared checkpoint: QNT513 Cannot continue in `then`/);
    expect(() => validateReproducerResult(report([], [{ name: run, ...disabled }, { name: before, code: "QNT511", message: `Test ${before} returned false` }, { name: through, ...disabled }]), 1, run, "mutant"))
      .toThrow(/fails before its declared checkpoint: QNT511 Test/);
    expect(() => validateReproducerResult(report([before, through], [{ name: run, ...disabled }]), 1, run, "mutant")).toThrow(/holds at its declared checkpoint under the fault; a later step or expectation fails instead/);
    expect(() => validateReproducerResult(report([before], [{ name: run, message: 'Cannot continue to "expect"' }, { name: through, message: 'Cannot continue to "expect"' }]), 1, run, "mutant"))
      .toThrow(/does not fail its declared expectation: QNT508 Cannot continue to "expect"/);
    expect(() => validateReproducerResult(report([before], [{ name: run, ...disabled }, { name: through, ...disabled }]), 1, run, "mutant")).toThrow(/does not fail its declared expectation: QNT513 Cannot continue/);
    expect(() => validateReproducerResult(detected.replace(/Error \[QNT508\]: Expect condition does not hold true/g, "boom"), 1, run, "mutant")).toThrow(/does not fail its declared expectation: no Quint error code/);
    // The pattern selected nothing, a probe is missing, another run failed, or the model did not compile.
    expect(() => validateReproducerResult(report([], []), 0, run, "baseline")).toThrow(/did not run: the output names its run neither passed nor failed/);
    expect(() => validateReproducerResult(report([run], []), 0, run, "baseline")).toThrow(/did not run: the output names its before-checkpoint probe neither passed nor failed/);
    expect(() => validateReproducerResult(report([run, before], []), 0, run, "mutant")).toThrow(/did not run: the output names its through-checkpoint probe/);
    expect(() => validateReproducerResult(report(["someOtherTest", before, through], [{ name: `${run}Extended` }]), 1, run, "mutant")).toThrow(/did not run/);
    expect(() => validateReproducerResult(compileError, 1, run, "mutant")).toThrow(/did not run/);
    expect(() => validateReproducerResult(detected, 2, run, "mutant")).toThrow(/ended abnormally \(exit 2\)/);
    expect(() => validateReproducerResult(detected, null, run, "mutant")).toThrow(/ended abnormally/);
    expect(() => validateReproducerResult(clean, 0, run, "unknown")).toThrow(/Unknown/);
    expect(() => validateReproducerResult(undefined, 0, run, "baseline")).toThrow(/required/);
    expect(() => validateReproducerResult(clean, 0, "", "baseline")).toThrow(/required/);
    expect(probeNames("some.Test")).toEqual({ before: "some.TestBeforeCheckpointProbe", through: "some.TestThroughCheckpointProbe" });
  });
  it("cites, for every manifest reproducer, a declared run whose chain the declared failure cuts at one expect", () => {
    const cited = manifest.challenges.filter(challenge => challenge.reproducer);
    expect(cited.length).toBeGreaterThanOrEqual(5);
    for (const challenge of cited) {
      const { run: name, model, failure } = challenge.reproducer!;
      const source = readFileSync(new URL(`../${model ?? challenge.model}`, import.meta.url), "utf8");
      expect(source, challenge.id).toMatch(new RegExp(`\\brun ${name}\\b`));
      const checkpoint = reproducerCheckpoint(source, name, failure);
      expect(checkpoint.through.startsWith(checkpoint.before), challenge.id).toBe(true);
      expect(checkpoint.through.slice(checkpoint.before.length), challenge.id).toMatch(/^\s*\.expect\(/);
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

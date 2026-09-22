import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessVectorBoundary, resolveVectorEvidence, validVectorResult } from "../../formal/vector-evidence.mjs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("formal/execution.json"));
const challenge = manifest.challenges.find((entry: { id: string }) => entry.id === "envelope-strips-unknown-zero-prefix");
const model = manifest.models.find((entry: { path: string }) => entry.path === challenge.model);
const written = challenge.nativeMutants.evidence.vector;
const vector = resolveVectorEvidence(written, model, read);
const evidence = { challenge: challenge.id, mutant: "M54", vector, history: `vector/${challenge.reproducer.run}`, step: 0,
  fields: vector.fields, origin: "vector" };
function recording(port: "typescript" | "go" = "typescript", changed = false) {
  const sample = vector.samples[port];
  return { history: evidence.history, completed: true, lastStep: 0, divergences: [], vectorResult: {
    port, history: evidence.history, row: sample.row, artifactSha256: vector.artifactSha256, inputSha256: sample.inputSha256,
    actual: changed ? { decodedHex: "03", outcome: "passthrough" } : structuredClone(sample.expected),
  } };
}

describe("exact generated vector evidence", () => {
  it("selects one owned row per binding and sends no expectations to the worker", () => {
    expect(vector.samples.typescript.request).toEqual({ operation: "envelope", input: { inputHex: "0003" } });
    expect(() => resolveVectorEvidence({ ...written, artifact: "formal/protocol-vectors.json" }, model, read)).toThrow();
    expect(() => resolveVectorEvidence({ ...written, rows: { ...written.rows, go: "missing" } }, model, read)).toThrow(/exactly one/);
    expect(() => resolveVectorEvidence(written, model, path => {
      const corpus = JSON.parse(read(path)); corpus.envelopeVectors.push(corpus.envelopeVectors.find((row: { name: string }) => row.name === written.rows.go));
      return JSON.stringify(corpus);
    })).toThrow(/exactly one/);
    expect(() => resolveVectorEvidence({ ...written, fields: ["loaders"] }, model, read)).toThrow();
  });
  it("recomputes a semantic mismatch from the native bytes", () => {
    for (const port of ["typescript", "go"] as const) {
      expect(assessVectorBoundary(evidence, recording(port)).state).toBe("not-divergent");
      expect(assessVectorBoundary(evidence, recording(port, true))).toMatchObject({ state: "confirmed",
        divergences: [{ step: 0, action: "envelope", paths: ["decodedHex"] }] });
    }
    const fakeDiff = { ...recording(), divergences: [{ step: 0, action: "envelope", paths: ["decodedHex"] }] };
    expect(assessVectorBoundary(evidence, fakeDiff).state).toBe("not-divergent");
  });
  it("rejects missing output, failed processes and mismatched row fingerprints", () => {
    expect(assessVectorBoundary(evidence).state).toBe("unreached");
    expect(assessVectorBoundary(evidence, { ...recording("go", true), completed: false }).state).toBe("unreached");
    expect(assessVectorBoundary(evidence, { ...recording("go", true), error: "process exited 1" }).state).toBe("unreached");
    for (const key of ["port", "history", "row", "artifactSha256", "inputSha256"] as const) {
      const wrong = recording(); wrong.vectorResult[key] = "wrong" as never;
      expect(assessVectorBoundary(evidence, wrong).state).toBe("unreached");
    }
    const wrong = recording(); wrong.vectorResult.actual = { decodedHex: "03" };
    expect(assessVectorBoundary(evidence, wrong).state).toBe("unreached");
  });
  it("requires a clean baseline with the same port and vector declaration", async () => {
    const url = new URL("../../formal/mutation-reports.mjs", import.meta.url).href;
    const { boundaryReview } = await import(url) as { boundaryReview(report: unknown, evidence: unknown[], options: unknown): Array<{state: string}> };
    const report: { configurationSha256?: object; go?: string; boundaryBaselines: Record<string, ReturnType<typeof recording>>;
      mutations: Array<{id: string; boundary: unknown[]}> } = { configurationSha256: {}, boundaryBaselines: { [evidence.history]: recording() }, mutations: [
      { id: "M54", boundary: [assessVectorBoundary(evidence, recording("typescript", true))] },
    ] };
    const assess = () => boundaryReview(report, [evidence], { requireEntries: true })[0]!.state;
    expect(assess()).toBe("confirmed");
    report.boundaryBaselines[evidence.history] = recording("go");
    expect(assess()).toBe("unreached");
    report.boundaryBaselines[evidence.history] = recording("typescript", true);
    expect(assess()).toBe("unreached");
    // Copying both matching TypeScript recordings cannot satisfy a Go report.
    report.boundaryBaselines[evidence.history] = recording();
    delete report.configurationSha256;
    report.go = "go test toolchain";
    expect(assess()).toBe("unreached");
  });
  it("keeps known API variants separate from malformed output", () => {
    expect(validVectorResult("key", { kind: "key_error" })).toBe(true);
    expect(validVectorResult("key", { error: "crashed" })).toBe(false);
    expect(validVectorResult("trackedDecode", { kind: "miss", reason: "watermark_fenced", observedWatermarkMs: 1 })).toBe(true);
    expect(validVectorResult("trackedDecode", { kind: "hit" })).toBe(false);
    expect(validVectorResult("compression", { outcome: "compressed", storedBytes: 18, marker: 1 })).toBe(true);
    expect(validVectorResult("compression", { outcome: "compressed", storedBytes: NaN, marker: 1 })).toBe(false);
    for (const outcome of ["", "test crashed", "unknown"]) {
      expect(validVectorResult("envelope", { outcome, decodedHex: "03" })).toBe(false);
      expect(validVectorResult("compression", { outcome, storedBytes: 18, marker: 1 })).toBe(false);
      expect(validVectorResult("trackedDecode", { kind: "miss", reason: outcome })).toBe(false);
      const malformed = recording(); malformed.vectorResult.actual = { decodedHex: "03", outcome };
      expect(assessVectorBoundary(evidence, malformed).state).toBe("unreached");
    }
  });
  it("permits another model's vector reproducer only for a shared rule", async () => {
    const url = new URL("../../formal/execution.mjs", import.meta.url).href;
    const { validateExecution } = await import(url) as { validateExecution(value: unknown): unknown };
    const changed = structuredClone(manifest);
    const originalFrame = changed.challenges.find((entry: { id: string }) => entry.id === "frame-vectors-inclusive-fence");
    const frame = structuredClone(originalFrame);
    frame.id = "shared-vector-schema-fixture";
    changed.challenges.push(frame);
    const rule = changed.challenges.find((entry: { id: string }) => entry.id === "fence-inclusive-timestamp");
    const cited = frame.model;
    // Structural validation does not establish reachability. The actual
    // challenge runner must still measure the primary property and both
    // before/through probes against the shared edit.
    Object.assign(frame, { source: rule.source, before: rule.before, after: rule.after,
      model: "formal/dialcache-redis-protocol.qnt", invariant: "trackedZeroTimestampIsNotHit", measures: "Fixture for shared vector citation validation." });
    Object.assign(frame.reproducer, { model: cited, profiles: [frame.model, cited],
      exclusions: Object.fromEntries(changed.models.filter((item: { profile?: string }) => item.profile)
        .map((item: { profile: string }) => [item.profile, "Schema fixture; runtime partition measurement is a separate mandatory check."])) });
    expect(() => validateExecution(changed)).not.toThrow();
    frame.reproducer.profiles.pop();
    expect(() => validateExecution(changed)).toThrow(/must name known profiles/);
    frame.reproducer.profiles.push(cited);
    frame.source = cited;
    frame.before = originalFrame.before;
    frame.after = originalFrame.after;
    expect(() => validateExecution(changed)).toThrow(/shared-library fault/);
  });
});


describe("real Redis vector evidence", () => {
  const challenge = manifest.challenges.find((item: {id: string}) => item.id === "invalidation-transition-cutoff-moves-backwards");
  const model = manifest.models.find((item: {path: string}) => item.path === challenge.model);
  const vector = resolveVectorEvidence(challenge.nativeMutants.evidence.vector, model, read);
  const evidence = { vector, history: `vector/${challenge.reproducer.run}`, fields: ["content", "ttlMs"] };
  const sample = vector.samples.typescript;
  const result = (actual: Record<string, unknown>) => ({ completed: true, lastStep: 0, vectorResult: {
    port: "typescript", history: evidence.history, row: sample.row, artifactSha256: vector.artifactSha256,
    inputSha256: sample.inputSha256, actual,
  } });
  it("keeps expected state out of the native Redis request", () => {
    expect(sample.request).toEqual({ operation: "invalidation", input: {
      existing: {kind: "string", value: "10000000", ttlMs: 100}, futureBufferMs: "0", invalidatedAtMs: "1000",
    } });
    expect(assessVectorBoundary(evidence, result(sample.expected)).state).toBe("not-divergent");
    expect(assessVectorBoundary(evidence, result({...sample.expected, content: "1000"}))).toMatchObject({state: "confirmed", divergences: [{paths: ["content"]}]});
  });
  it("uses only recorded server elapsed time to bound positive TTL drift", () => {
    const ttl = sample.expected.ttlMs as number;
    const assess = (ttlMs: number, elapsedMs: number) => assessVectorBoundary(evidence, result({...sample.expected, ttlMs, elapsedMs})).state;
    expect(assess(ttl - 3, 3)).toBe("not-divergent");
    expect(assess(ttl - 4, 3)).toBe("confirmed");
    expect(assess(ttl + 1, 3)).toBe("confirmed");
    expect(assess(ttl, -1)).toBe("unreached");
    expect(assess(-1, 100)).toBe("confirmed");
  });
  it("rejects unknown Lua replies, malformed state and missing time", () => {
    for (const actual of [ {...sample.expected, outcome: "unexpected_reply"}, {...sample.expected, elapsedMs: undefined},
      {...sample.expected, content: ["not a string"]}, {...sample.expected, ttlMs: -3} ]) {
      expect(validVectorResult("invalidation", actual)).toBe(false);
      expect(assessVectorBoundary(evidence, result(actual)).state).toBe("unreached");
    }
  });
});

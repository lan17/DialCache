import { describe, expect, it } from "vitest";

import {
  SHADOW_LOG_DIFF_MAX_BYTES,
  SHADOW_LOG_KEY_MAX_BYTES,
  SHADOW_LOG_TRUNCATION_MARKER,
  SHADOW_LOG_VALUE_MAX_BYTES,
  previewShadowLogJson,
  previewShadowLogKey,
  renderShadowMismatchJson,
} from "../src/internal/shadow-log-json.js";

const diffOf = (cached: unknown, source: unknown): string | null =>
  renderShadowMismatchJson(
    { available: true, value: cached },
    { available: true, value: source },
    { value: false, diff: true },
  ).diffJson ?? null;

describe("shadow mismatch log JSON", () => {
  it("uses native JSON for the values supplied to the comparator", () => {
    expect(previewShadowLogJson({
      id: "123",
      updatedAt: new Date("2026-07-31T00:00:00.000Z"),
    })).toBe('{"id":"123","updatedAt":"2026-07-31T00:00:00.000Z"}');
  });

  it("returns null for values that native JSON cannot serialize", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(previewShadowLogJson(circular)).toBeNull();
    expect(previewShadowLogJson(1n)).toBeNull();
    expect(previewShadowLogJson(undefined)).toBeNull();
  });

  it("catches user JSON hook failures", () => {
    const value = {
      toJSON(): never {
        throw new Error("not serializable");
      },
    };

    expect(previewShadowLogJson(value)).toBeNull();
  });

  it("honors an explicit byte budget", () => {
    const preview = previewShadowLogJson({ text: "a".repeat(200) }, 64);

    expect(preview).not.toBeNull();
    expect(Buffer.byteLength(preview!)).toBeLessThanOrEqual(64);
    expect(preview!.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
  });

  it("byte-clamps keys and JSON without splitting UTF-8 sequences", () => {
    const key = `${"k".repeat(SHADOW_LOG_KEY_MAX_BYTES)}🙂`;
    const value = { text: "🙂".repeat(SHADOW_LOG_VALUE_MAX_BYTES) };
    const keyPreview = previewShadowLogKey(key);
    const valuePreview = previewShadowLogJson(value);

    expect(keyPreview).not.toBeNull();
    expect(valuePreview).not.toBeNull();
    expect(Buffer.byteLength(keyPreview!)).toBeLessThanOrEqual(SHADOW_LOG_KEY_MAX_BYTES);
    expect(Buffer.byteLength(valuePreview!)).toBeLessThanOrEqual(SHADOW_LOG_VALUE_MAX_BYTES);
    expect(keyPreview!.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(valuePreview!.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(keyPreview).not.toContain("�");
    expect(valuePreview).not.toContain("�");
  });

  it("diffs plain objects and arrays from the cached side to the source side", () => {
    const diffJson = diffOf(
      { id: "123", version: 1, tags: ["a", "b"] },
      { id: "123", version: 2, tags: ["a"] },
    );

    expect(JSON.parse(diffJson!)).toEqual([
      { type: "CHANGE", path: ["version"], value: 2, oldValue: 1 },
      { type: "REMOVE", path: ["tags", 1], oldValue: "b" },
    ]);
  });

  it("reports source-only fields as CREATE entries", () => {
    expect(JSON.parse(diffOf({ a: 1 }, { a: 1, b: 2 })!)).toEqual([
      { type: "CREATE", path: ["b"], value: 2 },
    ]);
  });

  it("diffs the loggable forms, so toJSON redaction bounds the diff like value logging", () => {
    class User {
      constructor(
        readonly id: number,
        readonly apiKey: string,
      ) {}

      toJSON(): { id: number } {
        return { id: this.id };
      }
    }
    // Runtime shape: the cached side is deserialized JSON, the source is live.
    const cached = { user: { id: 1 } };

    expect(diffOf(cached, { user: new User(1, "SECRET-TOKEN") })).toBe("[]");
    const changed = diffOf(cached, { user: new User(2, "SECRET-TOKEN") });
    expect(changed).not.toContain("SECRET-TOKEN");
    expect(JSON.parse(changed!)).toEqual([
      { type: "CHANGE", path: ["user", "id"], value: 2, oldValue: 1 },
    ]);
  });

  it("does not emit phantom entries for serializer-normalized fields", () => {
    // Runtime shape: the cached Date arrived as its ISO string; the live
    // source still holds a Date for the same instant.
    const diffJson = diffOf(
      { updatedAt: "2026-07-31T00:00:00.000Z", n: 1 },
      { updatedAt: new Date("2026-07-31T00:00:00.000Z"), n: 2 },
    );

    expect(JSON.parse(diffJson!)).toEqual([
      { type: "CHANGE", path: ["n"], value: 2, oldValue: 1 },
    ]);
  });

  it("renders nested Date leaves as ISO strings in diff entries", () => {
    expect(JSON.parse(diffOf(
      { updatedAt: new Date("2026-07-31T00:00:00.000Z") },
      { updatedAt: new Date("2026-08-01T00:00:00.000Z") },
    )!)).toEqual([
      {
        type: "CHANGE",
        path: ["updatedAt"],
        value: "2026-08-01T00:00:00.000Z",
        oldValue: "2026-07-31T00:00:00.000Z",
      },
    ]);
  });

  it("reports an element shift as index-wise changes", () => {
    // Documented noise: array entries compare by index, so a shift reports
    // every later index instead of one insertion.
    expect(JSON.parse(diffOf(["a", "b", "c"], ["x", "a", "b"])!)).toEqual([
      { type: "CHANGE", path: [0], value: "x", oldValue: "a" },
      { type: "CHANGE", path: [1], value: "a", oldValue: "b" },
      { type: "CHANGE", path: [2], value: "b", oldValue: "c" },
    ]);
  });

  it("returns an empty diff for identical loggable forms", () => {
    expect(diffOf({ id: "123" }, { id: "123" })).toBe("[]");
    expect(diffOf("same", "same")).toBe("[]");
    // A Map renders as {} on both sides; the emptiness matches what value
    // logging would show for the same inputs.
    expect(diffOf({ m: {} }, { m: new Map([["k", 1]]) })).toBe("[]");
  });

  it("collapses non-container and mixed-kind roots to one root-level change entry", () => {
    expect(JSON.parse(diffOf("cached", "source")!)).toEqual([
      { type: "CHANGE", path: [], value: "source", oldValue: "cached" },
    ]);
    expect(JSON.parse(diffOf({ id: "123" }, null)!)).toEqual([
      { type: "CHANGE", path: [], value: null, oldValue: { id: "123" } },
    ]);
    expect(JSON.parse(diffOf(
      new Date("2026-07-31T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    )!)).toEqual([
      {
        type: "CHANGE",
        path: [],
        value: "2026-08-01T00:00:00.000Z",
        oldValue: "2026-07-31T00:00:00.000Z",
      },
    ]);
    expect(JSON.parse(diffOf({ a: 1, b: 2 }, [1, 2])!)).toEqual([
      { type: "CHANGE", path: [], value: [1, 2], oldValue: { a: 1, b: 2 } },
    ]);
    expect(JSON.parse(diffOf({}, [])!)).toEqual([
      { type: "CHANGE", path: [], value: [], oldValue: {} },
    ]);
  });

  it("reports nested kind mismatches at their path", () => {
    expect(JSON.parse(diffOf({ data: { a: 1 } }, { data: [1] })!)).toEqual([
      { type: "CHANGE", path: ["data"], value: [1], oldValue: { a: 1 } },
    ]);
  });

  it("fails the diff closed when either side has no JSON rendering", () => {
    expect(diffOf(undefined, null)).toBeNull();
    expect(diffOf(null, undefined)).toBeNull();
    expect(diffOf(undefined, undefined)).toBeNull();
    expect(diffOf(undefined, { a: 1 })).toBeNull();
  });

  it("renders null value fields and a null diff for an unavailable side", () => {
    expect(renderShadowMismatchJson(
      { available: false },
      { available: true, value: { id: "123" } },
      { value: true, diff: true },
    )).toEqual({
      cachedValueJson: null,
      sourceValueJson: '{"id":"123"}',
      diffJson: null,
    });
  });

  it("runs toJSON once per side and derives value and diff from the same snapshot", () => {
    const makeSide = (id: number) => {
      let calls = 0;
      return {
        calls: () => calls,
        value: {
          user: {
            toJSON(): { id: number; calls: number } {
              calls += 1;
              return { id, calls };
            },
          },
        },
      };
    };
    const cached = makeSide(1);
    const source = makeSide(2);

    const fields = renderShadowMismatchJson(
      { available: true, value: cached.value },
      { available: true, value: source.value },
      { value: true, diff: true },
    );

    // A second stringify per side would render calls: 2 somewhere; both
    // outputs must come from the single calls: 1 snapshot.
    expect(cached.calls()).toBe(1);
    expect(source.calls()).toBe(1);
    expect(fields.cachedValueJson).toBe('{"user":{"id":1,"calls":1}}');
    expect(fields.sourceValueJson).toBe('{"user":{"id":2,"calls":1}}');
    expect(JSON.parse(fields.diffJson!)).toEqual([
      { type: "CHANGE", path: ["user", "id"], value: 2, oldValue: 1 },
    ]);
  });

  it("keeps prototype-carried data out of the diff", () => {
    const objectProto = Object.prototype as unknown as Record<string, unknown>;
    const arrayProto = Array.prototype as unknown as Record<string, unknown>;
    objectProto.polluted = "PROTOTYPE-ONLY";
    arrayProto.pollutedEntry = "PROTOTYPE-ONLY";
    try {
      const diffJson = diffOf({ a: 1, list: ["x"] }, { a: 2, list: ["x"] });

      expect(diffJson).not.toContain("PROTOTYPE-ONLY");
      expect(diffJson).not.toContain("polluted");
      expect(JSON.parse(diffJson!)).toEqual([
        { type: "CHANGE", path: ["a"], value: 2, oldValue: 1 },
      ]);
    } finally {
      delete objectProto.polluted;
      delete arrayProto.pollutedEntry;
    }
  });

  it("fails closed to null for cyclic inputs instead of throwing", () => {
    const cached: { id: string; self?: unknown } = { id: "cached" };
    cached.self = cached;
    const source: { id: string; self?: unknown } = { id: "source" };
    source.self = source;

    // The loggable-form rendering throws on cycles before any diffing.
    expect(diffOf(cached, source)).toBeNull();
  });

  it("returns null when the diff entries cannot be serialized", () => {
    expect(diffOf({ n: 1n }, { n: 2n })).toBeNull();
  });

  it("byte-clamps the diff", () => {
    const diffJson = diffOf(
      { text: "a".repeat(SHADOW_LOG_DIFF_MAX_BYTES) },
      { text: "b".repeat(SHADOW_LOG_DIFF_MAX_BYTES) },
    );

    expect(diffJson).not.toBeNull();
    expect(Buffer.byteLength(diffJson!)).toBeLessThanOrEqual(SHADOW_LOG_DIFF_MAX_BYTES);
    expect(diffJson!.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
  });
});

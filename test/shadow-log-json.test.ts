import { describe, expect, it } from "vitest";

import {
  SHADOW_LOG_DIFF_MAX_BYTES,
  SHADOW_LOG_KEY_MAX_BYTES,
  SHADOW_LOG_TRUNCATION_MARKER,
  SHADOW_LOG_VALUE_MAX_BYTES,
  previewShadowLogDiff,
  previewShadowLogJson,
  previewShadowLogKey,
} from "../src/internal/shadow-log-json.js";

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

  it("byte-clamps keys and JSON without splitting UTF-8 sequences", () => {
    const key = `${"k".repeat(SHADOW_LOG_KEY_MAX_BYTES)}🙂`;
    const value = { text: "🙂".repeat(SHADOW_LOG_VALUE_MAX_BYTES) };
    const keyPreview = previewShadowLogKey(key);
    const valuePreview = previewShadowLogJson(value);

    expect(valuePreview).not.toBeNull();
    expect(Buffer.byteLength(keyPreview)).toBeLessThanOrEqual(SHADOW_LOG_KEY_MAX_BYTES);
    expect(Buffer.byteLength(valuePreview!)).toBeLessThanOrEqual(SHADOW_LOG_VALUE_MAX_BYTES);
    expect(keyPreview.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(valuePreview!.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(keyPreview).not.toContain("�");
    expect(valuePreview).not.toContain("�");
  });

  it("diffs plain objects and arrays from the cached side to the source side", () => {
    const diffJson = previewShadowLogDiff(
      { id: "123", version: 1, tags: ["a", "b"] },
      { id: "123", version: 2, tags: ["a"] },
    );

    expect(JSON.parse(diffJson!)).toEqual([
      { type: "CHANGE", path: ["version"], value: 2, oldValue: 1 },
      { type: "REMOVE", path: ["tags", 1], oldValue: "b" },
    ]);
  });

  it("reports source-only fields as CREATE entries", () => {
    expect(JSON.parse(previewShadowLogDiff({ a: 1 }, { a: 1, b: 2 })!)).toEqual([
      { type: "CREATE", path: ["b"], value: 2 },
    ]);
  });

  it("renders nested Date leaves as ISO strings in diff entries", () => {
    expect(JSON.parse(previewShadowLogDiff(
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
    expect(JSON.parse(previewShadowLogDiff(["a", "b", "c"], ["x", "a", "b"])!)).toEqual([
      { type: "CHANGE", path: [0], value: "x", oldValue: "a" },
      { type: "CHANGE", path: [1], value: "a", oldValue: "b" },
      { type: "CHANGE", path: [2], value: "b", oldValue: "c" },
    ]);
  });

  it("returns an empty diff for equal inputs", () => {
    expect(previewShadowLogDiff({ id: "123" }, { id: "123" })).toBe("[]");
    expect(previewShadowLogDiff("same", "same")).toBe("[]");
  });

  it("collapses non-plain-object roots to one root-level change entry", () => {
    expect(JSON.parse(previewShadowLogDiff("cached", "source")!)).toEqual([
      { type: "CHANGE", path: [], value: "source", oldValue: "cached" },
    ]);
    expect(JSON.parse(previewShadowLogDiff({ id: "123" }, null)!)).toEqual([
      { type: "CHANGE", path: [], value: null, oldValue: { id: "123" } },
    ]);
    expect(JSON.parse(previewShadowLogDiff(
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
  });

  it("fails closed to null for cyclic inputs instead of throwing", () => {
    const cached: { id: string; self?: unknown } = { id: "cached" };
    cached.self = cached;
    const source: { id: string; self?: unknown } = { id: "source" };
    source.self = source;

    // The traversal is cycle-safe, but the resulting entries reference the
    // cyclic structures, so JSON rendering fails closed to null.
    expect(previewShadowLogDiff(cached, source)).toBeNull();
  });

  it("returns null when the diff entries cannot be serialized", () => {
    expect(previewShadowLogDiff({ n: 1n }, { n: 2n })).toBeNull();
  });

  it("byte-clamps the diff", () => {
    const diffJson = previewShadowLogDiff(
      { text: "a".repeat(SHADOW_LOG_DIFF_MAX_BYTES) },
      { text: "b".repeat(SHADOW_LOG_DIFF_MAX_BYTES) },
    );

    expect(diffJson).not.toBeNull();
    expect(Buffer.byteLength(diffJson!)).toBeLessThanOrEqual(SHADOW_LOG_DIFF_MAX_BYTES);
    expect(diffJson!.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
  });
});

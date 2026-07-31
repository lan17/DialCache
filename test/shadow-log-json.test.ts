import { describe, expect, it } from "vitest";

import {
  SHADOW_LOG_KEY_MAX_BYTES,
  SHADOW_LOG_TRUNCATION_MARKER,
  SHADOW_LOG_VALUE_MAX_BYTES,
  previewShadowLogJson,
  previewShadowLogKey,
  shadowMismatchLogDetails,
} from "../src/internal/shadow-log-json.js";

describe("shadow mismatch log JSON", () => {
  it("uses native JSON for the values supplied to the comparator", () => {
    expect(shadowMismatchLogDetails(
      "urn:user_id:123#GetUser",
      { id: "123", updatedAt: new Date("2026-07-31T00:00:00.000Z") },
      { id: "123", updatedAt: new Date("2026-08-01T00:00:00.000Z") },
    )).toEqual({
      cacheKey: "urn:user_id:123#GetUser",
      cachedValueJson: '{"id":"123","updatedAt":"2026-07-31T00:00:00.000Z"}',
      sourceValueJson: '{"id":"123","updatedAt":"2026-08-01T00:00:00.000Z"}',
    });
  });

  it("returns null independently for values that native JSON cannot serialize", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(shadowMismatchLogDetails("key", circular, { version: 2 })).toEqual({
      cacheKey: "key",
      cachedValueJson: null,
      sourceValueJson: '{"version":2}',
    });
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

  it("replaces byte arrays with a length marker instead of per-byte decimals", () => {
    expect(previewShadowLogJson(Buffer.from("hi"))).toBe('"<binary 2 bytes>"');
    expect(previewShadowLogJson(new Uint8Array([1, 2, 3]))).toBe('"<binary 3 bytes>"');
    expect(previewShadowLogJson({ id: "1", blob: Buffer.from("hi") }))
      .toBe('{"id":"1","blob":"<binary 2 bytes>"}');
    expect(previewShadowLogJson({ blob: new Uint8Array([7, 7]) }))
      .toBe('{"blob":"<binary 2 bytes>"}');
    expect(previewShadowLogJson([Buffer.alloc(4)])).toBe('["<binary 4 bytes>"]');
  });

  it("keeps a large byte array from consuming the whole value preview", () => {
    const preview = previewShadowLogJson({ id: "1", blob: Buffer.alloc(200_000, 7) });

    expect(preview).toBe('{"id":"1","blob":"<binary 200000 bytes>"}');
    expect(preview).not.toContain("7,7");
    expect(preview!.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(false);
  });

  it("reports byte length for views over a shared or offset buffer", () => {
    const pooled = Buffer.from("abcd");
    const view = new Uint8Array(new ArrayBuffer(64), 8, 16);

    expect(previewShadowLogJson({ pooled })).toBe('{"pooled":"<binary 4 bytes>"}');
    expect(previewShadowLogJson({ view })).toBe('{"view":"<binary 16 bytes>"}');
  });

  it("leaves plain records that merely look like serialized buffers recognizable", () => {
    // Native JSON already renders a real Buffer this way, so collapsing the
    // shape is the same reduction rather than a loss of distinct information.
    expect(previewShadowLogJson({ type: "Buffer", data: [1, 2] })).toBe('"<binary 2 bytes>"');
    expect(previewShadowLogJson({ type: "Buffer", data: "not-an-array" }))
      .toBe('{"type":"Buffer","data":"not-an-array"}');
    expect(previewShadowLogJson({ type: "Other", data: [1, 2] }))
      .toBe('{"type":"Other","data":[1,2]}');
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
    expect(keyPreview).not.toContain("\uFFFD");
    expect(valuePreview).not.toContain("\uFFFD");
  });
});

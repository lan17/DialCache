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

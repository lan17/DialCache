import { describe, expect, it } from "vitest";

import {
  assertSupportedFutureBufferMs,
  cacheTtlSecToMs,
  isSupportedCacheTtlSec,
  MAX_CACHE_TTL_SEC,
  MAX_SUPPORTED_DURATION_MS,
} from "../src/internal/duration.js";

describe("DialCache supported durations", () => {
  it("uses one fixed 365-day ceiling for TTLs and invalidation buffers", () => {
    expect(MAX_CACHE_TTL_SEC).toBe(31_536_000);
    expect(MAX_SUPPORTED_DURATION_MS).toBe(31_536_000_000);
    expect(isSupportedCacheTtlSec(MAX_CACHE_TTL_SEC)).toBe(true);
    expect(cacheTtlSecToMs(MAX_CACHE_TTL_SEC)).toBe(MAX_SUPPORTED_DURATION_MS);
    expect(() => assertSupportedFutureBufferMs(MAX_SUPPORTED_DURATION_MS)).not.toThrow();
  });

  it.each([0, MAX_CACHE_TTL_SEC + 1, Number.MAX_SAFE_INTEGER])(
    "rejects unsupported cache TTL %s",
    (ttlSec) => {
      expect(isSupportedCacheTtlSec(ttlSec)).toBe(false);
      expect(() => cacheTtlSecToMs(ttlSec)).toThrow(
        `no greater than ${MAX_CACHE_TTL_SEC}`,
      );
    },
  );

  it.each([-1, MAX_SUPPORTED_DURATION_MS + 1, Number.MAX_SAFE_INTEGER])(
    "rejects unsupported future buffer %s",
    (futureBufferMs) => {
      expect(() => assertSupportedFutureBufferMs(futureBufferMs)).toThrow(
        `no greater than ${MAX_SUPPORTED_DURATION_MS}`,
      );
    },
  );
});

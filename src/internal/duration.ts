/** Fixed 365-day input ceiling shared by cache TTLs and invalidation buffers. */
export const MAX_SUPPORTED_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;
export const MAX_CACHE_TTL_SEC = MAX_SUPPORTED_DURATION_MS / 1_000;
/** Tracked Redis values are bounded so invalidation markers can safely age out. */
export const MAX_TRACKED_REDIS_VALUE_TTL_MS = 60 * 60 * 1_000;

export function isSupportedCacheTtlSec(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_CACHE_TTL_SEC
  );
}

export function cacheTtlSecToMs(ttlSec: number): number {
  if (!isSupportedCacheTtlSec(ttlSec)) {
    throw new RangeError(
      `DialCache cache TTL must be a positive safe integer no greater than ${MAX_CACHE_TTL_SEC} seconds`,
    );
  }
  return ttlSec * 1_000;
}

/**
 * Validate and ceil an adapter-level write TTL to the protocol's acceptance
 * domain: fractional milliseconds round up, and the result must be a
 * positive integer no greater than 365 days. Native SET PX requires an
 * integer. Core separately caps tracked Redis values at one hour.
 */
export function ceilSupportedCacheTtlMs(cacheTtlMs: number): number {
  const ceiled = typeof cacheTtlMs === "number" ? Math.ceil(cacheTtlMs) : Number.NaN;
  if (!Number.isFinite(ceiled) || ceiled <= 0 || ceiled > MAX_SUPPORTED_DURATION_MS) {
    throw new RangeError(
      `DialCache Redis write cacheTtlMs must be a positive duration no greater than ${MAX_SUPPORTED_DURATION_MS} milliseconds`,
    );
  }
  return ceiled;
}

export function assertSupportedFutureBufferMs(futureBufferMs: unknown): asserts futureBufferMs is number {
  if (
    typeof futureBufferMs !== "number"
    || !Number.isSafeInteger(futureBufferMs)
    || futureBufferMs < 0
    || futureBufferMs > MAX_SUPPORTED_DURATION_MS
  ) {
    throw new RangeError(
      `DialCache invalidation futureBufferMs must be a nonnegative safe integer no greater than ${MAX_SUPPORTED_DURATION_MS}`,
    );
  }
}

/** Fixed 365-day input ceiling shared by cache TTLs and invalidation buffers. */
export const MAX_SUPPORTED_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;
export const MAX_CACHE_TTL_SEC = MAX_SUPPORTED_DURATION_MS / 1_000;

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

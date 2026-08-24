import type { Awaitable } from "./config.js";

const redisPayloadErrorBrand = Symbol.for("dialcache.DialCacheRedisPayloadError");
const redisPayloadEncodingErrorBrand = Symbol.for("dialcache.DialCacheRedisPayloadEncodingError");
const redisProtocolErrorBrand = Symbol.for("dialcache.DialCacheRedisProtocolError");

export class DialCacheRedisPayloadError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== DialCacheRedisPayloadError) {
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
    return typeof value === "object"
      && value !== null
      && Object.getOwnPropertyDescriptor(value, redisPayloadErrorBrand)?.value === true;
  }

  constructor(message: string) {
    super(message);
    this.name = "DialCacheRedisPayloadError";
    // CJS adapter subpaths are separate bundles; a global symbol preserves root-export instanceof checks.
    Object.defineProperty(this, redisPayloadErrorBrand, { value: true });
  }
}

export class DialCacheRedisPayloadEncodingError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== DialCacheRedisPayloadEncodingError) {
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
    return typeof value === "object"
      && value !== null
      && Object.getOwnPropertyDescriptor(value, redisPayloadEncodingErrorBrand)?.value === true;
  }

  constructor(message: string) {
    super(message);
    this.name = "DialCacheRedisPayloadEncodingError";
    // CJS adapter subpaths are separate bundles; a global symbol preserves root-export instanceof checks.
    Object.defineProperty(this, redisPayloadEncodingErrorBrand, { value: true });
  }
}

export class DialCacheRedisProtocolError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== DialCacheRedisProtocolError) {
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
    return typeof value === "object"
      && value !== null
      && Object.getOwnPropertyDescriptor(value, redisProtocolErrorBrand)?.value === true;
  }

  constructor(message: string) {
    super(message);
    this.name = "DialCacheRedisProtocolError";
    // CJS adapter subpaths are separate bundles; a global symbol preserves root-export instanceof checks.
    Object.defineProperty(this, redisProtocolErrorBrand, { value: true });
  }
}

/** Serialized cache data, independent of any Redis client or wire framing. */
export type RedisCachePayload = string | Buffer;

/**
 * A served Redis frame: the payload bytes past the frame header plus the
 * header's creation time. The payload is the serializer output, possibly
 * still wrapped in a compression envelope that DialCache core interprets
 * above the adapter (see the `dialcache/redis-protocol` module doc). All
 * frames carry application-clock time supplied by the writer. DialCache
 * rejects frames dated after the reading process's clock before deserialization
 * and otherwise uses `createdAtMs` for shadow value-age observability. Tracked
 * watermark fencing already happened inside the decoder.
 */
export interface DecodedRedisFrame {
  readonly payload: RedisCachePayload;
  /** Epoch milliseconds copied from the frame header. */
  readonly createdAtMs: number;
}

interface RedisValueRequest {
  readonly valueKey: string;
}

interface TrackedRedisReadRequest extends RedisValueRequest {
  readonly watermarkKey: string;
}

interface UntrackedRedisReadRequest extends RedisValueRequest {
  readonly watermarkKey?: never;
}

export type RedisReadRequest = TrackedRedisReadRequest | UntrackedRedisReadRequest;

/**
 * Per-use-case read policy supplied by DialCache. Adapters may use the signal
 * for cooperative cancellation, but the core deadline remains authoritative.
 */
export interface RedisReadContext {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface RedisWriteRequest extends RedisValueRequest {
  /** Positive integer no greater than 31,536,000,000 (365 days). */
  readonly cacheTtlMs: number;
  readonly value: RedisCachePayload;
}

export interface RedisInvalidationRequest {
  readonly watermarkKey: string;
  /** Nonnegative integer no greater than 31,536,000,000 (365 days). */
  readonly futureBufferMs: number;
}

/**
 * Caller-owned semantic Redis boundary. DialCache borrows this client and does
 * not create, connect, drain, dispose, or close it.
 *
 * Clients must use finite application-defined connection, retry, reconnect,
 * offline-queue, dispatch, and response budgets to bound underlying resource
 * lifetime. DialCache additionally bounds how long it waits for reads, but
 * does not claim server-side cancellation. A command that times out after
 * dispatch may still have executed, so adapters must document their
 * queue-removal and ambiguous-write semantics.
 *
 * Tracked invalidation also requires the Redis deployment to preserve
 * watermark keys for their derived TTL. Losing a watermark through eviction,
 * failover, restore, or external deletion removes its prior read-time
 * invalidation fence.
 */
export interface DialCacheRedisClient {
  /**
   * Read a DialCache Redis frame and return its decoded serializer payload
   * together with the frame header's creation time. Implementations must use
   * `decodeRedisFrame` / `decodeTrackedRedisFrame` from
   * `dialcache/redis-protocol`, or preserve their exact behavior.
   *
   * Raw values are Redis bulk strings (`Buffer`) or null. A missing value, a
   * frame shorter than the version/timestamp/encoding header, or an
   * unsupported frame version is a cache miss. A missing tracked watermark
   * is the zero baseline. A tracked read misses when a present watermark is
   * not a finite unsigned decimal or is greater than or equal to the frame's
   * creation time. In other words, `createdAt <= watermark` is fenced.
   * Unsupported payload encodings and non-bulk runtime replies are payload
   * protocol errors rather than misses.
   *
   * Tracked implementations must read the value and watermark atomically from
   * one authoritative snapshot; replica lag must not hide an invalidation.
   *
   * A non-null frame is transferred to DialCache. A returned Buffer payload
   * must remain stable and must not be mutated, pooled, or reused after this
   * method settles; DialCache may retain it beyond the request for
   * best-effort shadow deserialization. Adapters that recycle response
   * storage must return a dedicated Buffer.
   */
  read(request: RedisReadRequest, context?: RedisReadContext): Awaitable<DecodedRedisFrame | null>;
  /**
   * Write a DialCache Redis frame using the `dialcache/redis-protocol`
   * encoders, or preserve their exact behavior.
   *
   * All writes are one native `SET valueKey frame PX cacheTtlMs` whose
   * frame comes from `encodeRedisFrame` with a client-clock `createdAtMs`.
   * DialCache uses the decoded frame's `createdAtMs` to reject future-dated
   * values and to feed shadow value-age observations, so writers
   * must stamp real client time, not a constant.
   *
   * Tracked and untracked writes use the same complete-frame SET. Core caps a
   * tracked value's physical TTL at one hour. Under the documented clock-skew
   * and in-flight-work bounds, invalidation markers outlive every value they
   * fence, so writers never read, create, or extend watermarks.
   */
  write(request: RedisWriteRequest): Awaitable<void>;
  /**
   * Advance the watermark monotonically after the source mutation commits.
   * The adapter supplies a nonnegative safe-integer `Date.now()` sample to
   * `INVALIDATE_CACHE_SCRIPT` as `ARGV[2]`; `futureBufferMs` is `ARGV[1]`.
   * Reuse that sample through retries within one adapter invocation.
   * Its TTL is at least two hours and otherwise derived to outlive the future
   * buffer plus the maximum tracked-value TTL. Longer or persistent existing
   * markers are preserved.
   */
  invalidate(request: RedisInvalidationRequest): Awaitable<void>;
}

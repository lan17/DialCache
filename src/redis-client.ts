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

/** Bounded classification for why a Redis read produced no payload. */
export type RedisReadMissReason =
  /** The value key is absent, expired, or held by a non-string Redis type. */
  | "not_found"
  /** The value frame is shorter than its header or has an unsupported version. */
  | "frame_unsupported"
  /** Tracked read whose watermark is missing, malformed, or not finite. */
  | "watermark_unreadable"
  /** Tracked read whose frame was created at or before the watermark. */
  | "watermark_invalidated";

/** Result of decoding one DialCache Redis read from an authoritative snapshot. */
export type RedisReadOutcome =
  | { readonly status: "hit"; readonly payload: RedisCachePayload }
  | { readonly status: "miss"; readonly reason: RedisReadMissReason };

interface RedisValueRequest {
  readonly valueKey: string;
}

interface TrackedRedisValueRequest extends RedisValueRequest {
  readonly watermarkKey: string;
}

interface UntrackedRedisValueRequest extends RedisValueRequest {
  readonly watermarkKey?: never;
}

export type RedisReadRequest = TrackedRedisValueRequest | UntrackedRedisValueRequest;

/**
 * Per-use-case read policy supplied by DialCache. Adapters may use the signal
 * for cooperative cancellation, but the core deadline remains authoritative.
 */
export interface RedisReadContext {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

interface RedisWriteBase extends RedisValueRequest {
  /** Positive integer no greater than 31,536,000,000 (365 days). */
  readonly cacheTtlMs: number;
  readonly value: RedisCachePayload;
}

type TrackedRedisWriteRequest = RedisWriteBase & TrackedRedisValueRequest;
type UntrackedRedisWriteRequest = RedisWriteBase & UntrackedRedisValueRequest;

export type RedisWriteRequest = TrackedRedisWriteRequest | UntrackedRedisWriteRequest;

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
 * failover, restore, or external deletion removes its prior publication fence.
 */
export interface DialCacheRedisClient {
  /**
   * Read a DialCache Redis frame and return its decoded read outcome.
   * Implementations must use `decodeRedisFrame` / `decodeTrackedRedisFrame`
   * from `dialcache/redis-protocol`, or preserve their exact behavior.
   *
   * Raw values are Redis bulk strings (`Buffer`) or null. A miss carries one
   * bounded `RedisReadMissReason`: a missing value is `not_found`; a frame
   * shorter than the version/timestamp/encoding header or with an unsupported
   * frame version is `frame_unsupported`; a tracked read whose watermark is
   * missing or is not a finite unsigned decimal is `watermark_unreadable`;
   * and a tracked frame with `createdAt <= watermark` is fenced as
   * `watermark_invalidated`. Frame state is classified before watermark
   * state, so a missing frame misses as `not_found` regardless of its
   * watermark. Unsupported payload encodings and non-bulk runtime replies are
   * payload protocol errors rather than misses.
   *
   * Tracked implementations must read the value and watermark atomically from
   * one authoritative snapshot; replica lag must not hide an invalidation.
   *
   * A hit payload is transferred to DialCache. A returned Buffer must remain
   * stable and must not be mutated, pooled, or reused after this method
   * settles; DialCache may retain it beyond the request for best-effort shadow
   * deserialization. Adapters that recycle response storage must return a
   * dedicated Buffer.
   */
  read(request: RedisReadRequest, context?: RedisReadContext): Awaitable<RedisReadOutcome>;
  /** Atomically write using server time. False means invalidation blocked the write. */
  write(request: RedisWriteRequest): Awaitable<boolean>;
  /**
   * Advance the watermark monotonically after the source mutation commits.
   * Its TTL is derived from the future buffer and any longer existing TTL.
   */
  invalidate(request: RedisInvalidationRequest): Awaitable<void>;
}

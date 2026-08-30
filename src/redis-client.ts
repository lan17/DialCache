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
 * frames carry application-clock time supplied by the writer. Caller-serving
 * reads apply their logical age ceiling and reject frames dated after the
 * reading process's clock before deserialization; stale-on-error may retain a
 * raw frame between its fresh and maximum ages. Confirmation reads may retain
 * a frame solely for payload comparison. DialCache also uses `createdAtMs` for
 * shadow and stale-recovery value-age observability. Tracked watermark fencing
 * already happened inside the decoder.
 */
export interface DecodedRedisFrame {
  readonly payload: RedisCachePayload;
  /** Epoch milliseconds copied from the frame header. */
  readonly createdAtMs: number;
}

/**
 * A semantic tracked-read miss carrying a trustworthy write fence from the
 * same authoritative value-and-watermark snapshot. A refill stamped at or
 * before `observedWatermarkMs` is known to remain unreadable.
 */
export interface RedisWatermarkMiss {
  readonly kind: "watermark_miss";
  readonly observedWatermarkMs: number;
  readonly payload?: never;
  readonly createdAtMs?: never;
}

/**
 * Semantic Redis read result. `null` remains the generic/legacy miss; bundled
 * adapters return `RedisWatermarkMiss` only when a tracked read observed a
 * present, valid numeric watermark that can safely fence a candidate refill.
 */
export type RedisReadResult = DecodedRedisFrame | RedisWatermarkMiss | null;

/** Package-private runtime discriminator for the semantic miss variant. */
export function isRedisWatermarkMiss(result: unknown): result is RedisWatermarkMiss {
  return typeof result === "object"
    && result !== null
    && "kind" in result
    && result.kind === "watermark_miss"
    && !("payload" in result)
    && !("createdAtMs" in result);
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
  /**
   * Nonnegative safe-integer epoch milliseconds to encode in the frame.
   * DialCache core supplies the final dispatch-adjacent sample for admitted
   * refills following `RedisWatermarkMiss`.
   * It remains optional so ordinary refills, existing direct adapter callers,
   * and custom adapter implementations keep their established behavior. An
   * adapter that returns `RedisWatermarkMiss` must honor a supplied value
   * exactly so the final fence decision and stored frame cannot diverge.
   */
  readonly createdAtMs?: number;
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
   * Read a DialCache Redis frame. Hits return the decoded serializer payload
   * with the frame header's creation time. Implementations must use
   * `decodeRedisFrame` and either `decodeTrackedRedisFrame` (legacy null
   * misses) or `decodeTrackedRedisReadResult` (typed watermark misses) from
   * `dialcache/redis-protocol`, or preserve their exact behavior.
   *
   * Raw values are Redis bulk strings (`Buffer`) or null. A missing value, a
   * frame shorter than the version/timestamp/encoding header, or an
   * unsupported frame version is a cache miss. A missing tracked watermark
   * is the zero baseline. A tracked read misses when a present watermark is
   * not a nonnegative safe-integer decimal or is greater than or equal to the
   * frame's creation time. In other words, `createdAt <= watermark` is fenced.
   * Unsupported payload encodings and non-bulk runtime replies are payload
   * protocol errors rather than misses.
   *
   * Tracked implementations must read the value and watermark atomically from
   * one authoritative snapshot; replica lag must not hide an invalidation.
   *
   * Implementations may return a `RedisWatermarkMiss` for a tracked semantic
   * miss when the same snapshot contained a present, valid numeric watermark.
   * Existing adapters may continue returning `null` and remain correct while
   * missing the conditional refill optimization. Adapters that opt into the
   * discriminated miss must also honor `RedisWriteRequest.createdAtMs` when
   * supplied.
   *
   * A returned frame's payload is transferred to DialCache. A returned Buffer
   * must remain stable and must not be mutated, pooled, or reused after this
   * method settles; DialCache may retain it for source-error recovery or
   * best-effort shadow work. Adapters that recycle response storage must
   * return a dedicated Buffer.
   */
  read(request: RedisReadRequest, context?: RedisReadContext): Awaitable<RedisReadResult>;
  /**
   * Write a DialCache Redis frame using the `dialcache/redis-protocol`
   * encoders, or preserve their exact behavior.
   *
   * All writes are one native `SET valueKey frame PX cacheTtlMs` whose frame
   * comes from `encodeRedisFrame`. Honor `request.createdAtMs` exactly when it
   * is supplied; callers that omit it may be stamped from the adapter's client
   * clock.
   * DialCache uses every frame's decoded `createdAtMs` for future-time
   * rejection and logical-age enforcement, and for shadow and stale-recovery
   * value-age observations, so writers must stamp real client time, not a
   * constant.
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
   * markers are preserved. A wrong-type watermark is repaired; any other Redis
   * read error surfaces without replacing prior state.
   */
  invalidate(request: RedisInvalidationRequest): Awaitable<void>;
}

import type { Awaitable } from "./config.js";

const redisPayloadErrorBrand = Symbol.for("dialcache.DialCacheRedisPayloadError");
const redisPayloadEncodingErrorBrand = Symbol.for("dialcache.DialCacheRedisPayloadEncodingError");
const redisProtocolErrorBrand = Symbol.for("dialcache.DialCacheRedisProtocolError");
const redisPlaceholderLostErrorBrand = Symbol.for("dialcache.DialCacheRedisPlaceholderLostError");

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

/**
 * A tracked write's stamp found no placeholder carrying its nonce: the paired
 * SET was rejected, overwritten by a concurrent writer, expired, or removed
 * by a fenced write. The value was not published, and DialCache suppresses the
 * corresponding process-local publication. Same-key write contention produces
 * a benign floor of these, concentrated on hot keys at TTL expiry.
 */
export class DialCacheRedisPlaceholderLostError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== DialCacheRedisPlaceholderLostError) {
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
    return typeof value === "object"
      && value !== null
      && Object.getOwnPropertyDescriptor(value, redisPlaceholderLostErrorBrand)?.value === true;
  }

  constructor(message: string) {
    super(message);
    this.name = "DialCacheRedisPlaceholderLostError";
    // CJS adapter subpaths are separate bundles; a global symbol preserves root-export instanceof checks.
    Object.defineProperty(this, redisPlaceholderLostErrorBrand, { value: true });
  }
}

/** Serialized cache data, independent of any Redis client or wire framing. */
export type RedisCachePayload = string | Buffer;

/**
 * A served Redis frame: the payload bytes past the frame header plus the
 * header's creation time. The payload is the serializer output, possibly
 * still wrapped in a compression envelope that DialCache core interprets
 * above the adapter (see the `dialcache/redis-protocol` module doc). Tracked
 * frames carry Redis server time written by the stamp script; untracked
 * frames carry the writer's client clock. DialCache consumes `createdAtMs`
 * only for observability (the shadow value-age observation) — tracked
 * watermark fencing already happened inside the decoder — so it never
 * affects serving decisions.
 */
export interface DecodedRedisFrame {
  readonly payload: RedisCachePayload;
  /** Epoch milliseconds copied from the frame header. */
  readonly createdAtMs: number;
}

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
   * Read a DialCache Redis frame and return its decoded serializer payload
   * together with the frame header's creation time. Implementations must use
   * `decodeRedisFrame` / `decodeTrackedRedisFrame` from
   * `dialcache/redis-protocol`, or preserve their exact behavior.
   *
   * Raw values are Redis bulk strings (`Buffer`) or null. A missing value, a
   * frame shorter than the version/timestamp/encoding header, or an
   * unsupported frame version is a cache miss. A tracked read also misses
   * when its watermark is missing, is not a finite unsigned decimal, or is
   * greater than or equal to the frame's creation time. In other words,
   * `createdAt <= watermark` is fenced. Unsupported payload encodings and
   * non-bulk runtime replies are payload protocol errors rather than misses.
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
   * Untracked writes are one native `SET valueKey frame PX cacheTtlMs` whose
   * frame comes from `encodeRedisFrame` with a client-clock `createdAtMs`.
   * Untracked reads never consult that stamp for serving or miss decisions,
   * but they do surface it as the decoded frame's `createdAtMs`, where it
   * feeds the shadow value-age observation — so untracked writers must stamp
   * real client time, not a constant.
   *
   * Tracked writes issue two commands ordered on one connection without a
   * transaction: a native `SET` of an `encodeTrackedRedisPlaceholder` frame,
   * followed by `WRITE_TRACKED_STAMP_SCRIPT` with `KEYS = [valueKey,
   * watermarkKey]` and `ARGV = [cacheTtlMs, nonce]`. Run `cacheTtlMs` through
   * `ceilSupportedCacheTtlMs` (exported by `dialcache/redis-protocol`) and
   * pass the result as both the SET's `PX` and `ARGV[1]` — `PX` rejects
   * fractions and the watermark's lifetime is derived from `ARGV[1]` — and
   * the nonce must be the placeholder's. The script fences against the watermark and
   * unlinks the value (reply 0), promotes exactly the placeholder carrying
   * its nonce to a served frame with server-time `createdAt` (reply 1), or
   * reports the placeholder gone (reply 2); it maintains the watermark's
   * existence and TTL in the non-fenced cases. Placeholders are unreadable on
   * both read paths, so an interleaved or lost stamp degrades to a miss
   * bounded by the value TTL — including briefly blanking a previously
   * readable key the write replaces — while a delayed stamp of its own
   * placeholder remains subject to the invalidation future buffer, like any
   * in-flight write.
   *
   * Implementations must not reorder the pair, must mint one placeholder per
   * logical write so client-level retries stay paired with their stamp, and
   * must surface a SET failure as the write error even when the stamp settled
   * (in that case the stamp may have promoted the landed SET, leaving the
   * value readable despite the reported failure). Reply 2 must fail the write
   * with `DialCacheRedisPlaceholderLostError` so split pairs stay observable;
   * after reply 2 the key holds another writer's frame or an unreadable
   * placeholder, never this write's value. False means invalidation blocked
   * the write.
   */
  write(request: RedisWriteRequest): Awaitable<boolean>;
  /**
   * Advance the watermark monotonically after the source mutation commits.
   * Its TTL is derived from the future buffer and any longer existing TTL.
   */
  invalidate(request: RedisInvalidationRequest): Awaitable<void>;
}

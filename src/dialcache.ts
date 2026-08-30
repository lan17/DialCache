import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import {
  CacheLayer,
  DialCacheKeyConfig,
  type Awaitable,
  type CacheConfigProvider,
  type DialCacheConfig,
  type Logger,
  type StaleRecoveryPredicate,
} from "./config.js";
import { DialCacheContext, getOrCreateRequestLocalCache, type RequestLocalCache } from "./context.js";
import { FallbackTimeoutError, UseCaseIsAlreadyRegisteredError, UseCaseNameIsReservedError } from "./errors.js";
import { DialCacheKey, assertValidNamespace, normalizeArgs } from "./key.js";
import {
  NO_CACHE_LAYER,
  REQUEST_LOCAL_CACHE_LAYER,
  labelsFor,
  type CacheMetricLabels,
  type DialCacheMetricsAdapter,
  type DisabledReason,
  type MetricErrorKind,
  type MetricLayer,
  type ShadowValidationOutcome,
} from "./metrics.js";
import type { DecodedRedisFrame, RedisCachePayload } from "./redis-client.js";
import type { Serializer } from "./serializer.js";
import type { CacheGetResult, RemoteCacheGetResult } from "./internal/cache-result.js";
import { MAX_TIMER_DELAY_MS, withMonotonicDeadline } from "./internal/deadline.js";
import {
  assertSupportedFutureBufferMs,
  isSupportedCacheTtlSec,
  MAX_CACHE_TTL_SEC,
} from "./internal/duration.js";
import { LocalCache } from "./internal/local-cache.js";
import { deterministicShadowRampSample } from "./internal/ramp.js";
import { RedisCache, type FutureFramePolicy } from "./internal/redis-cache.js";
import {
  fetchKeyConfig,
  resolveRemoteLayerConfigResult,
  type LayerConfigResolution,
  type ResolvedLayerConfig,
  type ResolvedRemoteLayerConfig,
} from "./internal/runtime-config.js";
import { shadowMismatchLogDetails } from "./internal/shadow-log-json.js";

type CacheKeyArgs = Record<string, string | number | boolean | bigint | null | undefined>;
type Id = string | number | bigint;

/** A cache-key spec: a bare id, or an id plus extra (secondary) key dimensions. */
export type CacheKeySpec = Id | { readonly id: Id; readonly args?: CacheKeyArgs };

// "Any function" without using `any`, so Parameters/ReturnType still apply.
type AnyFn = (...args: never[]) => unknown;
/** The cached value type, derived from the wrapped function's return. */
export type CachedValue<Fn extends AnyFn> = Awaited<ReturnType<Fn>>;
/**
 * Defines application-level equality for detached shadow validation.
 *
 * Inputs are borrowed snapshots. Comparators must be synchronous, deterministic,
 * side-effect-free, non-mutating, and bounded.
 */
export type ShadowComparator<Value> = (cachedValue: Value, sourceValue: Value) => boolean;
type CacheKeySelector<Fn extends AnyFn> = (...args: Parameters<Fn>) => CacheKeySpec;

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = IsAny<T> extends true
  ? false
  : unknown extends T
    ? [keyof T] extends [never]
      ? true
      : false
    : false;
type AllTrue<T> = Exclude<T, true> extends never ? true : false;

/**
 * A bounded, structural approximation of values whose decoded JSON remains
 * assignable to the declared type. It exists only in declarations and adds no
 * runtime validation or serialization work.
 */
type IsJsonCompatible<
  T,
  TopLevel extends boolean = true,
  Depth extends readonly unknown[] = [],
> = IsAny<T> extends true
  ? false
  : IsUnknown<T> extends true
    ? false
    : [T] extends [never]
      ? true
      : Depth["length"] extends 8
        ? false
        : AllTrue<T extends unknown ? IsJsonMember<T, TopLevel, Depth> : never>;

type IsJsonMember<T, TopLevel extends boolean, Depth extends readonly unknown[]> = [T] extends [
  string | number | boolean | null,
]
  ? true
  : [T] extends [void]
    ? TopLevel
    : T extends (...args: infer _Args) => infer _Result
      ? false
      : T extends readonly (infer Item)[]
        ? IsJsonCompatible<Item, false, [...Depth, unknown]>
        : T extends object
          ? IsJsonObject<T, Depth>
          : false;

type IsJsonObject<T extends object, Depth extends readonly unknown[]> = [keyof T] extends [never]
  ? true
  : AllTrue<{
      [Key in keyof T]-?: Key extends string | number
        // Omitting an optional undefined property remains type-compatible.
        ? {} extends Pick<T, Key>
          ? IsJsonCompatible<Exclude<T[Key], undefined>, false, [...Depth, unknown]>
          : IsJsonCompatible<T[Key], false, [...Depth, unknown]>
        : false;
    }[keyof T]>;

interface CacheOperationOptionsBase<Value> {
  readonly keyType: string;
  readonly useCase: string;
  readonly defaultConfig?: DialCacheKeyConfig | null;
  readonly trackForInvalidation?: boolean;
  /**
   * Overrides the strict deep-equality default for detached shadow validation.
   * This is stable use-case behavior, not runtime rollout configuration.
   */
  readonly shadowComparator?: ShadowComparator<Value>;
  /**
   * Overrides the DialCache-instance source-error classifier for this use
   * case, replacing both the instance and built-in policies. Must be
   * synchronous. Returning true authorizes recovery from the Redis candidate
   * retained by the initial read; every other result fails closed without
   * replacing the source rejection. Custom predicates should narrowly admit
   * transient, retriable infrastructure failures and deny authoritative
   * outcomes such as auth, permission, entitlement, revocation, deletion,
   * not-found, validation, and programmer errors. Use this override for data
   * that requires a stricter policy than the instance default.
   */
  readonly shouldAttemptStaleRecovery?: StaleRecoveryPredicate;
  /**
   * Monotonic deadline applied once an initially enabled invocation starts its
   * fallback, in milliseconds. Must be at most 2,147,483,647. Defaults to 60
   * seconds. Set to `null` to disable the deadline. Like every JavaScript
   * timer, delivery requires event-loop progress and cannot preempt synchronous
   * work.
   *
   * Concurrent same-key callers share the leader's remaining budget. Timing
   * out rejects those callers and prevents the eventual result from being
   * published by DialCache, but does not cancel the underlying operation.
   * The same finite value also bounds detached shadow validation. When this is
   * `null`, normal fallbacks are unbounded but shadow work still uses 60 seconds.
   */
  readonly fallbackTimeoutMs?: number | null;
}

interface CachedOptionsBase<Fn extends AnyFn> extends CacheOperationOptionsBase<CachedValue<Fn>> {
  /**
   * Select every input dimension that can affect the returned value. Concurrent
   * enabled calls with the same cache key may share one in-flight execution.
   * When shadow validation is active, the wrapped function runs later with the
   * original argument references. Treat values it reads as immutable, or
   * snapshot them before invocation so the detached read still matches this key.
   */
  readonly cacheKey: CacheKeySelector<Fn>;
}

type SerializerOption<Value> = IsJsonCompatible<Value> extends true
  ? { readonly serializer?: Serializer<Value> | null }
  : { readonly serializer: Serializer<Value> };
type CacheOperationOptions<Value> = CacheOperationOptionsBase<Value> & {
  readonly serializer?: Serializer<Value> | null;
};

/**
 * Options for a cached function. A serializer is required when the function's
 * resolved return type is not statically compatible with the default JSON
 * serializer. Supplying one is a trusted assertion; DialCache does not perform
 * runtime round-trip validation.
 */
export type CachedOptions<Fn extends AnyFn> = CachedOptionsBase<Fn> & SerializerOption<CachedValue<Fn>>;

interface GetOrLoadOptionsBase<Value> extends CacheOperationOptionsBase<Value> {
  /**
   * Include every captured value that can affect the loaded result. Concurrent
   * enabled calls with the same cache key may share one in-flight loader.
   * When shadow validation is active, snapshot mutable captured state before
   * calling getOrLoad so the detached loader still reads the value for this key.
   */
  readonly key: CacheKeySpec;
}

/**
 * Options for one inline cache operation. A serializer is required when the
 * loaded value is not statically compatible with the default JSON serializer.
 * Supplying one is a trusted assertion; DialCache does not perform runtime
 * round-trip validation.
 */
export type GetOrLoadOptions<Value> = GetOrLoadOptionsBase<Value> & SerializerOption<Value>;

/**
 * A cached function returns references owned by the cache. Treat returned
 * values as immutable; callers that need to mutate must copy them explicitly.
 */
export type CachedFn<Fn extends AnyFn> = (...args: Parameters<Fn>) => Promise<CachedValue<Fn>>;

/** Exact process-scoped single-flight state for one DialCache instance. */
export interface ProcessCoalescingState {
  readonly activeLeaders: number;
  readonly activeFollowers: number;
  readonly oldestLeaderAgeMs: number | null;
}

/** A point-in-time snapshot of DialCache-owned coalescing state. */
export interface CoalescingState {
  readonly process: ProcessCoalescingState;
}

interface ProcessFlight {
  promise: Promise<unknown> | null;
  readonly startedAtMs: number;
  followers: number;
}

interface ShadowFlight {
  cachedFrame: DecodedRedisFrame | null;
  abandoned: boolean;
  readonly startedAtMs: number;
}

interface ShadowValidationPlan<Value> {
  readonly source: () => Promise<Value>;
  readonly comparator: ShadowComparator<Value>;
  readonly timeoutMs: number;
  readonly didCallerFallbackTimeout: () => boolean;
}

interface ShadowMismatchDetails {
  readonly cachedValue: unknown;
  readonly sourceValue: unknown;
}

type ShadowValidationStart<Value> =
  | { readonly kind: "retained"; readonly frame: DecodedRedisFrame }
  | {
      readonly kind: "redis";
      /** The caller-owned, fallback-deadline-bounded SoT operation. */
      readonly source: Promise<Value>;
      /** Valid remote policy retained even though its serving ramp excluded this key. */
      readonly remoteConfig: ResolvedRemoteLayerConfig;
      /** Includes synchronous SoT work that ran before shadow admission. */
      readonly startedAtMs: number | null;
    };

type ShadowValidationRunStart<Value> =
  | { readonly kind: "retained" }
  | {
      readonly kind: "redis";
      readonly source: Promise<Value>;
      readonly remoteConfig: ResolvedRemoteLayerConfig;
    };

const DEFAULT_LOCAL_MAX_SIZE = 10_000;
const DEFAULT_FALLBACK_TIMEOUT_MS = 60_000;
const DEFAULT_SHADOW_MAX_IN_FLIGHT = 1;
const defaultConfigProvider: CacheConfigProvider = () => null;
const defaultLogger: Logger = console;
const defaultStaleRecoveryPredicate: StaleRecoveryPredicate =
  (error) => error instanceof FallbackTimeoutError;

export class DialCache {
  private readonly context = new DialCacheContext();
  private readonly localCache: LocalCache;
  private readonly useCases = new Set<string>();
  private readonly configProvider: CacheConfigProvider;
  private readonly namespace: string;
  private readonly logger: Logger;
  private readonly redisCache: RedisCache | null;
  private readonly metrics: DialCacheMetricsAdapter | null;
  private readonly staleRecoveryPredicate: StaleRecoveryPredicate;
  private readonly shadowMaxInFlight: number;
  private readonly shadowFlights = new Map<string, ShadowFlight>();
  private readonly processFlights = new Map<string, ProcessFlight>();
  private activeProcessFollowers = 0;

  constructor(config: DialCacheConfig = {}) {
    if (Object.hasOwn(config, "urnPrefix")) {
      throw new TypeError('DialCacheConfig.urnPrefix was renamed to "namespace"');
    }
    if (Object.hasOwn(config, "rampSampler")) {
      throw new TypeError(
        "DialCacheConfig.rampSampler was removed; partial ramps use DialCache's deterministic key-and-layer assignment",
      );
    }

    const namespace = config.namespace ?? "urn";
    assertValidNamespace(namespace);

    const localMaxSize = config.localMaxSize ?? DEFAULT_LOCAL_MAX_SIZE;
    if (!Number.isSafeInteger(localMaxSize) || localMaxSize < 0) {
      throw new RangeError("DialCache localMaxSize must be a nonnegative safe integer");
    }

    const shadowMaxInFlight = config.shadowMaxInFlight === undefined
      ? DEFAULT_SHADOW_MAX_IN_FLIGHT
      : config.shadowMaxInFlight;
    if (!Number.isSafeInteger(shadowMaxInFlight) || shadowMaxInFlight <= 0) {
      throw new RangeError("DialCache shadowMaxInFlight must be a positive safe integer");
    }

    this.configProvider = config.cacheConfigProvider ?? defaultConfigProvider;
    this.namespace = namespace;
    this.logger = safeLogger(config.logger ?? defaultLogger);
    this.metrics = safeMetrics(config.metrics ?? null);
    this.staleRecoveryPredicate = resolveStaleRecoveryPredicate(
      config.shouldAttemptStaleRecovery,
      defaultStaleRecoveryPredicate,
    );
    this.shadowMaxInFlight = shadowMaxInFlight;
    this.localCache = new LocalCache(localMaxSize);
    this.redisCache =
      config.redis === undefined
        ? null
        : new RedisCache({
            redis: config.redis,
            metrics: this.metrics,
          });
  }

  enable<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.context.enable(fn);
  }

  disable<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.context.disable(fn);
  }

  withEnabled<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.enable(fn);
  }

  withDisabled<T>(fn: () => Awaitable<T>): Promise<T> {
    return this.disable(fn);
  }

  isEnabled(): boolean {
    return this.context.isEnabled();
  }

  /** Returns exact process-scoped single-flight state for this instance. */
  getCoalescingState(): CoalescingState {
    const oldestFlight = this.processFlights.values().next().value as ProcessFlight | undefined;
    return {
      process: {
        activeLeaders: this.processFlights.size,
        activeFollowers: this.activeProcessFollowers,
        oldestLeaderAgeMs:
          oldestFlight === undefined ? null : Math.max(performance.now() - oldestFlight.startedAtMs, 0),
      },
    };
  }

  /**
   * Wraps a function with the configured cache chain. Returned in-memory
   * values are shared by reference and must be treated as immutable.
   */
  cached<Fn extends AnyFn>(fn: Fn, options: CachedOptions<Fn>): CachedFn<Fn> {
    const defaultConfig = snapshotDefaultConfig(options.defaultConfig);
    const fallbackTimeoutMs = resolveFallbackTimeoutMs(options.fallbackTimeoutMs);
    const shadowComparator = resolveShadowComparator(options.shadowComparator);
    const staleRecoveryPredicate = resolveStaleRecoveryPredicate(
      options.shouldAttemptStaleRecovery,
      this.staleRecoveryPredicate,
    );
    this.registerUseCase(options.useCase);

    return (...args: Parameters<Fn>): Promise<CachedValue<Fn>> =>
      this.executeCacheOperation(
        // `Fn` preserves the public parameter and return types, but its
        // `AnyFn` constraint erases the invocation result to `unknown`.
        () => fn(...args) as Awaitable<CachedValue<Fn>>,
        () => options.cacheKey(...args),
        options,
        defaultConfig,
        fallbackTimeoutMs,
        shadowComparator,
        staleRecoveryPredicate,
      );
  }

  /**
   * Executes one inline loader through the configured cache chain. Unlike
   * `cached()`, this method does not register the use case, so a stable use case
   * can be declared repeatedly at the call site. Returned in-memory values are
   * shared by reference and must be treated as immutable.
   */
  getOrLoad<Value>(load: () => Awaitable<Value>, options: GetOrLoadOptions<Value>): Promise<Value> {
    const defaultConfig = snapshotDefaultConfig(options.defaultConfig);
    const fallbackTimeoutMs = resolveFallbackTimeoutMs(options.fallbackTimeoutMs);
    const shadowComparator = resolveShadowComparator(options.shadowComparator);
    const staleRecoveryPredicate = resolveStaleRecoveryPredicate(
      options.shouldAttemptStaleRecovery,
      this.staleRecoveryPredicate,
    );
    this.assertUseCaseIsNotReserved(options.useCase);

    return this.executeCacheOperation(
      load,
      () => options.key,
      options,
      defaultConfig,
      fallbackTimeoutMs,
      shadowComparator,
      staleRecoveryPredicate,
    );
  }

  private async executeCacheOperation<Value>(
    load: () => Awaitable<Value>,
    selectKey: () => CacheKeySpec,
    options: CacheOperationOptions<Value>,
    defaultConfig: DialCacheKeyConfig | null,
    fallbackTimeoutMs: number | null,
    shadowComparator: ShadowComparator<Value>,
    staleRecoveryPredicate: StaleRecoveryPredicate,
  ): Promise<Value> {
    const rawFallback = async (): Promise<Value> => await load();
    const noLayerLabels = {
      cacheNamespace: this.namespace,
      useCase: options.useCase,
      keyType: options.keyType,
      layer: NO_CACHE_LAYER,
    } as const;

    if (!this.isEnabled()) {
      this.metrics?.disabled({ ...noLayerLabels, reason: "context" });
      return await rawFallback();
    }

    let callerFallbackTimedOut = false;
    const fallback = (): Promise<Value> => withFallbackTimeout(
      rawFallback,
      options.useCase,
      fallbackTimeoutMs,
      () => {
        callerFallbackTimedOut = true;
      },
    );
    const shadowValidation: ShadowValidationPlan<Value> = {
      source: rawFallback,
      comparator: shadowComparator,
      timeoutMs: fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS,
      didCallerFallbackTimeout: () => callerFallbackTimedOut,
    };

    let key: DialCacheKey;
    try {
      key = this.buildKey(options, selectKey(), defaultConfig);
    } catch (error) {
      this.logger.error("Could not construct DialCache key", error);
      this.metrics?.error({
        ...noLayerLabels,
        error: "key_construction",
        inFallback: false,
      });
      return await this.callFallback(noLayerLabels, fallback);
    }

    let keyConfig: DialCacheKeyConfig | null;
    try {
      keyConfig = await fetchKeyConfig(this.configProvider, key);
    } catch (error) {
      // Provider failure: fail open and run uncached, mirroring the per-layer config_error path.
      this.logger.warn("Could not resolve DialCache key config", error);
      this.recordError(key, NO_CACHE_LAYER, "config_resolution");
      this.metrics?.disabled({ ...noLayerLabels, reason: "config_error" });
      return await this.callFallback(noLayerLabels, fallback);
    }

    // An unawaited child can inherit the async store after its outer enable()
    // callback settles. The closed holder turns that detached work back into
    // pass-through instead of allowing it to repopulate request state.
    if (!this.isEnabled()) {
      this.metrics?.disabled({ ...noLayerLabels, reason: "context" });
      return await this.callFallback(noLayerLabels, fallback);
    }

    if (keyConfig?.requestLocal === true) {
      const requestLocalCache = getOrCreateRequestLocalCache(this.context);
      if (requestLocalCache !== null) {
        return await this.getThroughRequestLocal(
          requestLocalCache,
          key,
          keyConfig,
          fallback,
          shadowValidation,
          staleRecoveryPredicate,
        );
      }
    }

    return await this.getThroughSharedLayers(
      key,
      keyConfig,
      fallback,
      shadowValidation,
      staleRecoveryPredicate,
      CacheLayer.LOCAL,
    );
  }

  /**
   * Writes a remote invalidation watermark for Redis-tracked entries.
   *
   * Requires a Redis client in the DialCache configuration. If Redis is not
   * configured, the call rejects rather than reporting an invalidation that
   * did not occur.
   *
   * This does not synchronously evict existing local cache hits or untracked
   * Redis values. Call it only after the source mutation commits.
   *
   * The invalidation watermark is the maximum of its prior value and the
   * invalidating process's `Date.now() + futureBufferMs`. A tracked read serves
   * a complete frame only when its writer timestamp is strictly greater than
   * that watermark. A missing watermark is the natural zero baseline. Writes
   * never read, create, or extend watermarks; every write is one native SET of
   * a complete client-stamped frame.
   *
   * Core caps tracked Redis values at one hour and reports a bounded metric
   * error when a dispatched write is clamped. Invalidation keeps a watermark
   * for at least two hours, or long enough to outlive its future window plus
   * the one-hour value bound and a safety margin; longer and persistent
   * existing TTLs are preserved. Watermarks are invalidation state and must not
   * be evicted or lost during that interval. Losing one removes its read-time
   * invalidation fence and can make an existing frame readable. Use
   * `noeviction` or an equivalent guarantee when relying on the fence, and
   * choose persistence and failover guarantees accordingly; DialCache does not
   * issue `WAIT`.
   *
   * `futureBufferMs` is application-owned. Size it through the point where a
   * stale SET can become visible: source visibility lag, in-flight fallback and
   * serialization work, bounded client queue/reconnect delay, network and Redis
   * execution, plus the maximum writer-clock lead over the invalidator.
   * DialCache reports future-dated tracked frames through optional metrics but
   * does not calibrate clocks.
   * A zero buffer fences only frames stamped no later than the invalidation;
   * an undersized buffer can admit stale work, while an oversized one causes
   * more tracked misses without delaying the returned fallback value.
   *
   * When an invocation reaches the tracked Redis read/write path, its fallback
   * is not published directly to process-local cache; a later validated Redis
   * hit may warm it. Local-only, remote-policy-disabled, and ramped-down paths
   * retain their local publication policy. Request-local memoization remains
   * unconditional, and already-warm local entries are not evicted by this
   * remote operation. Ramped-out invocations without shadow work do not consult
   * Redis.
   *
   * @param futureBufferMs Nonnegative safe integer no greater than
   * 31,536,000,000 (365 days); defaults to zero for backward compatibility.
   */
  async invalidateRemote(keyType: string, id: Id, futureBufferMs = 0): Promise<void> {
    assertSupportedFutureBufferMs(futureBufferMs);

    this.metrics?.invalidation({ cacheNamespace: this.namespace, keyType, layer: CacheLayer.REMOTE });
    try {
      if (this.redisCache === null) {
        throw new TypeError("DialCache invalidateRemote requires a configured Redis client");
      }

      await this.redisCache.invalidate(keyType, String(id), futureBufferMs, this.namespace);
    } catch (error) {
      this.logger.warn("Error writing DialCache invalidation watermark", error);
      this.metrics?.error({
        cacheNamespace: this.namespace,
        useCase: "watermark",
        keyType,
        layer: CacheLayer.REMOTE,
        error: "invalidation",
        inFallback: false,
      });
      throw error;
    }
  }

  private async getThroughRequestLocal<T>(
    requestLocalCache: RequestLocalCache,
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig,
    fallback: () => Promise<T>,
    shadowValidation: ShadowValidationPlan<T>,
    staleRecoveryPredicate: StaleRecoveryPredicate,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const start = performance.now();
      const result = requestLocalCache.read<T>(key.urn);
      this.metrics?.request(labelsFor(key, REQUEST_LOCAL_CACHE_LAYER));
      this.metrics?.observeGet(labelsFor(key, REQUEST_LOCAL_CACHE_LAYER), elapsedSeconds(start));
      if (result.status === "hit") {
        return result.value;
      }

      this.metrics?.miss(labelsFor(key, REQUEST_LOCAL_CACHE_LAYER));
      const value = await this.getThroughSharedLayers(
        key,
        keyConfig,
        fallback,
        shadowValidation,
        staleRecoveryPredicate,
        REQUEST_LOCAL_CACHE_LAYER,
      );
      requestLocalCache.set(key.urn, value);
      return value;
    };
    if (keyConfig.coalesce === false) {
      return await run();
    }
    return await this.singleFlightRequestLocal(requestLocalCache.inFlight, key, run);
  }

  private async getThroughSharedLayers<T>(
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig | null,
    fallback: () => Promise<T>,
    shadowValidation: ShadowValidationPlan<T>,
    staleRecoveryPredicate: StaleRecoveryPredicate,
    fallbackMetricLayer: MetricLayer,
  ): Promise<T> {
    // This predicate is the single home of the default: omission means on in
    // every config shape (null, unmerged default, merged); only explicit false opts out.
    const coalesce = keyConfig?.coalesce !== false;
    const localLayer = await this.resolveLocalLayerConfig(key, keyConfig);
    if (localLayer.status === "enabled") {
      const run = async (): Promise<T> =>
        await this.getThroughActiveLocal(
          key,
          keyConfig,
          localLayer.config,
          fallback,
          shadowValidation,
          staleRecoveryPredicate,
        );
      return coalesce ? await this.singleFlightProcess(key, run) : await run();
    }

    const redisCache = this.redisCache;
    if (redisCache === null) {
      return await this.callFallback(labelsFor(key, fallbackMetricLayer), fallback);
    }

    const remoteLayer = await this.resolveRemoteLayerConfig(key, keyConfig);
    if (remoteLayer.status === "disabled") {
      const fallbackLayer = remoteLayer.reason === "config_error" ? CacheLayer.REMOTE : fallbackMetricLayer;
      if (remoteLayer.reason === "ramped_down") {
        return await this.finishRampedDownRemote(
          redisCache,
          key,
          keyConfig,
          null,
          remoteLayer.config,
          labelsFor(key, fallbackLayer),
          fallback,
          shadowValidation,
        );
      }
      return await this.callFallback(labelsFor(key, fallbackLayer), fallback);
    }

    const run = async (): Promise<T> => {
      const remote = await this.readRemoteWithResolvedConfig<T>(
        redisCache,
        key,
        remoteLayer.config,
        keyConfig?.remoteReadTimeoutMs ?? redisCache.readTimeoutMs,
      );
      return await this.finishRedisChain(
        redisCache,
        key,
        keyConfig,
        localLayer,
        remote,
        fallback,
        shadowValidation,
        staleRecoveryPredicate,
      );
    };
    return coalesce ? await this.singleFlightProcess(key, run) : await run();
  }

  private async getThroughActiveLocal<T>(
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig | null,
    localConfig: ResolvedLayerConfig,
    fallback: () => Promise<T>,
    shadowValidation: ShadowValidationPlan<T>,
    staleRecoveryPredicate: StaleRecoveryPredicate,
  ): Promise<T> {
    const local = this.readLocalWithResolvedConfig<T>(key, localConfig);
    if (local.status === "hit") {
      return local.value;
    }

    const redisCache = this.redisCache;
    if (redisCache === null) {
      return await this.finishLocalOnly(key, local, fallback);
    }

    const remoteLayer = await this.resolveRemoteLayerConfig(key, keyConfig);
    if (remoteLayer.status === "disabled") {
      if (remoteLayer.reason === "ramped_down") {
        return await this.finishRampedDownRemote(
          redisCache,
          key,
          keyConfig,
          local,
          remoteLayer.config,
          labelsFor(key, CacheLayer.LOCAL),
          fallback,
          shadowValidation,
        );
      }
      return await this.finishRedisChain(
        redisCache,
        key,
        keyConfig,
        local,
        remoteLayer,
        fallback,
        shadowValidation,
        staleRecoveryPredicate,
      );
    }

    const remote = await this.readRemoteWithResolvedConfig<T>(
      redisCache,
      key,
      remoteLayer.config,
      keyConfig?.remoteReadTimeoutMs ?? redisCache.readTimeoutMs,
    );
    return await this.finishRedisChain(
      redisCache,
      key,
      keyConfig,
      local,
      remote,
      fallback,
      shadowValidation,
      staleRecoveryPredicate,
    );
  }

  private async finishLocalOnly<T>(key: DialCacheKey, local: CacheGetResult<T>, fallback: () => Promise<T>): Promise<T> {
    const value = await this.callFallback(labelsFor(key, CacheLayer.LOCAL), fallback);
    if (local.status === "miss") {
      await this.putLocalFailOpen(key, value, local.config);
    }
    return value;
  }

  private async finishRampedDownRemote<T>(
    redisCache: RedisCache,
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig | null,
    local: CacheGetResult<T> | null,
    remoteConfig: ResolvedRemoteLayerConfig,
    fallbackLabels: CacheMetricLabels,
    fallback: () => Promise<T>,
    shadowValidation: ShadowValidationPlan<T>,
  ): Promise<T> {
    const shadowStartedAtMs = keyConfig?.shadow?.ramp === undefined || keyConfig.shadow.ramp === 0
      ? null
      : performance.now();
    const valuePromise = this.callFallback(fallbackLabels, fallback);
    this.scheduleShadowValidation(
      redisCache,
      key,
      keyConfig,
      { kind: "redis", source: valuePromise, remoteConfig, startedAtMs: shadowStartedAtMs },
      shadowValidation,
      keyConfig?.remoteReadTimeoutMs ?? redisCache.readTimeoutMs,
    );

    const value = await valuePromise;
    if (local?.status === "miss") {
      await this.putLocalFailOpen(key, value, local.config);
    }
    return value;
  }

  private async finishRedisChain<T>(
    redisCache: RedisCache,
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig | null,
    local: CacheGetResult<T>,
    remote: RemoteCacheGetResult<T>,
    fallback: () => Promise<T>,
    shadowValidation: ShadowValidationPlan<T>,
    staleRecoveryPredicate: StaleRecoveryPredicate,
  ): Promise<T> {
    if (remote.status === "hit") {
      if (local.status === "miss") {
        await this.putLocalFailOpen(key, remote.value, local.config);
      }
      this.scheduleShadowValidation(
        redisCache,
        key,
        keyConfig,
        { kind: "retained", frame: remote.frame },
        shadowValidation,
        keyConfig?.remoteReadTimeoutMs ?? redisCache.readTimeoutMs,
      );
      return remote.value;
    }

    if (remote.status === "error") {
      const value = await this.callFallback(labelsFor(key, CacheLayer.REMOTE), fallback);
      if (!key.trackForInvalidation && local.status === "miss") {
        await this.putLocalFailOpen(key, value, local.config);
      }
      return value;
    }

    const remoteConfigErrored = remote.status === "disabled" && remote.reason === "config_error";
    const remoteWriteConfig = remote.status === "miss" || remote.status === "retained"
      ? remote.config
      : undefined;
    const fallbackLayer = remote.status === "miss" || remote.status === "retained" || remoteConfigErrored
      ? CacheLayer.REMOTE
      : CacheLayer.LOCAL;
    const staleRecoveryMaxAgeSec = remote.status === "retained"
      || (remote.status === "miss" && remote.reason === "cache_miss")
      ? remote.config.staleOnErrorMaxAgeSec
      : null;
    const retainedFrame = remote.status === "retained" ? remote.frame : null;
    let value: T;
    try {
      value = await this.callFallback(labelsFor(key, fallbackLayer), fallback);
    } catch (fallbackError) {
      if (
        staleRecoveryMaxAgeSec !== null
        && this.shouldAttemptStaleRecovery(staleRecoveryPredicate, fallbackError)
      ) {
        try {
          const recovered = await redisCache.recoverRetainedCandidate<T>(
            key,
            retainedFrame,
            staleRecoveryMaxAgeSec,
          );
          if (recovered.status === "hit") {
            return recovered.value;
          }
        } catch (recoveryError) {
          // Recovery is subordinate to the source rejection and must never
          // replace it, including for a custom serializer that violates its
          // declared contract in an unexpected way.
          this.logger.warn("Error using retained Redis value during stale recovery", recoveryError);
        }
      }
      throw fallbackError;
    }
    // A tracked fallback was not validated against a watermark after the source
    // call. If this invocation reached the Redis write path, let a later
    // authoritative Redis hit populate local regardless of write success.
    const suppressLocalWrite = (remote.status === "disabled" && remote.skipCacheWrite === true)
      || (remoteWriteConfig !== undefined && key.trackForInvalidation);
    if (remoteWriteConfig !== undefined) {
      try {
        await redisCache.put(key, value, remoteWriteConfig);
      } catch (error) {
        this.logger.warn("Error putting value in Redis cache", error);
      }
    }
    if (!suppressLocalWrite && local.status === "miss") {
      await this.putLocalFailOpen(key, value, local.config);
    }
    return value;
  }

  private shouldAttemptStaleRecovery(
    predicate: StaleRecoveryPredicate,
    fallbackError: unknown,
  ): boolean {
    let result: unknown;
    try {
      result = predicate(fallbackError);
    } catch (predicateError) {
      this.logger.warn("DialCache stale recovery predicate threw; recovery was denied", predicateError);
      return false;
    }
    if (typeof result !== "boolean") {
      // The public contract is synchronous. Consume an accidental rejecting
      // thenable without awaiting it, and fail closed without delaying the
      // original source rejection.
      void settleUnexpectedThenable(result);
      this.logger.warn("DialCache stale recovery predicate returned a non-boolean; recovery was denied");
      return false;
    }
    return result;
  }

  private scheduleShadowValidation<T>(
    redisCache: RedisCache,
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig | null,
    start: ShadowValidationStart<T>,
    validation: ShadowValidationPlan<T>,
    readTimeoutMs: number,
  ): void {
    const shadowConfig: unknown = keyConfig?.shadow;
    if (
      shadowConfig === null
      || typeof shadowConfig !== "object"
      || Array.isArray(shadowConfig)
    ) {
      if (shadowConfig !== undefined) {
        this.recordError(key, CacheLayer.REMOTE, "config_resolution");
      }
      return;
    }

    const resolvedShadowConfig = shadowConfig as Record<string, unknown>;
    const shadowPercentage: unknown = resolvedShadowConfig.ramp;
    if (shadowPercentage === undefined || shadowPercentage === 0) {
      return;
    }
    if (
      typeof shadowPercentage !== "number"
      || !Number.isFinite(shadowPercentage)
      || shadowPercentage < 0
      || shadowPercentage > 100
    ) {
      this.recordError(key, CacheLayer.REMOTE, "config_resolution");
      return;
    }
    if (this.metrics?.shadowValidation === undefined) {
      return;
    }
    if (shadowPercentage < 100 && deterministicShadowRampSample(key) >= shadowPercentage) {
      return;
    }

    if (this.shadowFlights.has(key.urn) || this.shadowFlights.size >= this.shadowMaxInFlight) {
      this.recordShadowValidation(key, "dropped");
      return;
    }
    const logMismatches = this.resolveShadowLogging(key, resolvedShadowConfig);

    const flight: ShadowFlight = {
      cachedFrame: start.kind === "retained" ? start.frame : null,
      abandoned: false,
      startedAtMs: start.kind === "redis" && start.startedAtMs !== null
        ? start.startedAtMs
        : performance.now(),
    };
    const runStart: ShadowValidationRunStart<T> = start.kind === "retained"
      ? { kind: "retained" }
      : { kind: "redis", source: start.source, remoteConfig: start.remoteConfig };
    this.shadowFlights.set(key.urn, flight);
    this.deferShadowValidation(
      redisCache,
      key,
      flight,
      runStart,
      validation,
      readTimeoutMs,
      logMismatches,
    );
  }

  private resolveShadowLogging(
    key: DialCacheKey,
    shadowConfig: Record<string, unknown>,
  ): boolean {
    const configuredLogMismatches = shadowConfig.logMismatches;
    if (configuredLogMismatches === undefined) {
      return false;
    }
    if (typeof configuredLogMismatches !== "boolean") {
      this.recordError(key, CacheLayer.REMOTE, "config_resolution");
      return false;
    }
    return configuredLogMismatches;
  }

  private deferShadowValidation<T>(
    redisCache: RedisCache,
    key: DialCacheKey,
    flight: ShadowFlight,
    start: ShadowValidationRunStart<T>,
    validation: ShadowValidationPlan<T>,
    readTimeoutMs: number,
    logMismatches: boolean,
  ): void {
    setImmediate(() => {
      this.runShadowValidation(
        redisCache,
        key,
        flight,
        start,
        validation,
        readTimeoutMs,
        logMismatches,
      );
    }).unref();
  }

  private runShadowValidation<T>(
    redisCache: RedisCache,
    key: DialCacheKey,
    flight: ShadowFlight,
    start: ShadowValidationRunStart<T>,
    plan: ShadowValidationPlan<T>,
    readTimeoutMs: number,
    logMismatches: boolean,
  ): void {
    const pendingRedisReads = new Set<Promise<void>>();
    let operationFinished = false;
    let released = false;
    let signalShadowTimeout = (): void => undefined;
    const shadowTimeoutSignal = new Promise<void>((resolve) => {
      signalShadowTimeout = resolve;
    });
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      flight.cachedFrame = null;
      if (this.shadowFlights.get(key.urn) === flight) {
        this.shadowFlights.delete(key.urn);
      }
    };
    const maybeRelease = (): void => {
      if (operationFinished && pendingRedisReads.size === 0) {
        release();
      }
    };
    const finishOperation = (): void => {
      flight.cachedFrame = null;
      operationFinished = true;
      maybeRelease();
    };
    const readShadowFrame = (
      maxAgeSec: number | null,
      futureFramePolicy: FutureFramePolicy,
    ): Promise<DecodedRedisFrame | null> => {
      const read = redisCache.startPayloadReadForShadow(
        key,
        maxAgeSec,
        readTimeoutMs,
        futureFramePolicy,
      );
      pendingRedisReads.add(read.settled);
      void read.settled.then(() => {
        pendingRedisReads.delete(read.settled);
        maybeRelease();
      });
      return read.result;
    };
    const deadlineStartedAtMs = start.kind === "retained"
      ? performance.now()
      : flight.startedAtMs;
    const abandonIfExpired = (): boolean => {
      if (!flight.abandoned && performance.now() - deadlineStartedAtMs >= plan.timeoutMs) {
        flight.abandoned = true;
        flight.cachedFrame = null;
      }
      return flight.abandoned;
    };
    const elapsedBeforeStartMs = Math.max(performance.now() - deadlineStartedAtMs, 0);
    const remainingTimeoutMs = Math.max(plan.timeoutMs - elapsedBeforeStartMs, 0);
    let mismatchDetails: ShadowMismatchDetails | undefined;
    let validatedValueAgeSeconds: number | undefined;

    const validation = withMonotonicDeadline({
      timeoutMs: remainingTimeoutMs,
      unrefTimer: true,
      timeoutError: () => new Error("DialCache shadow validation timed out"),
      onTimeout: () => {
        flight.abandoned = true;
        flight.cachedFrame = null;
        signalShadowTimeout();
      },
      operation: async (): Promise<ShadowValidationOutcome> => {
        try {
          if (abandonIfExpired()) {
            return "timeout";
          }

          let shadowFillConfig: ResolvedRemoteLayerConfig | null = null;
          if (start.kind === "redis") {
            let frame: DecodedRedisFrame | null;
            try {
              frame = await readShadowFrame(start.remoteConfig.ttlSec, "reject");
            } catch {
              return "redis_error";
            }
            if (abandonIfExpired()) {
              return "timeout";
            }
            if (frame === null) {
              shadowFillConfig = start.remoteConfig;
            } else {
              flight.cachedFrame = frame;
            }
          }

          let sourceValue: T;
          try {
            if (start.kind === "redis") {
              const sharedSource = await Promise.race([
                start.source.then((value) => ({ kind: "value" as const, value })),
                shadowTimeoutSignal.then(() => ({ kind: "timeout" as const })),
              ]);
              if (sharedSource.kind === "timeout") {
                return "timeout";
              }
              sourceValue = sharedSource.value;
              // Let the caller finish its normal SoT continuation before any
              // synchronous shadow deserialization, comparison, or dump work.
              await yieldUnreferencedImmediate();
            } else {
              sourceValue = await this.disable(plan.source);
            }
          } catch {
            return start.kind === "redis" && plan.didCallerFallbackTimeout()
              ? "timeout"
              : "source_error";
          }
          if (abandonIfExpired()) {
            return "timeout";
          }

          if (shadowFillConfig !== null) {
            try {
              await redisCache.putForShadow(
                key,
                sourceValue,
                shadowFillConfig,
                () => !abandonIfExpired(),
              );
              // A late result remains the already-emitted whole-job timeout:
              // dispatch success does not retroactively change its outcome.
              if (abandonIfExpired()) {
                return "timeout";
              }
              return "filled";
            } catch (error) {
              this.logger.warn("Error populating Redis from DialCache shadow work", error);
              return "fill_error";
            }
          }

          const retainedFrame = flight.cachedFrame;
          if (retainedFrame === null) {
            return "timeout";
          }

          let cachedValue: T;
          try {
            cachedValue = await redisCache.deserializeForShadow<T>(key, retainedFrame.payload);
          } catch {
            return "deserialization_error";
          }
          if (abandonIfExpired()) {
            return "timeout";
          }

          let matches: boolean;
          try {
            const result: unknown = plan.comparator(cachedValue, sourceValue);
            if (typeof result !== "boolean") {
              await settleUnexpectedThenable(result);
              if (abandonIfExpired()) {
                return "timeout";
              }
              return "comparison_error";
            }
            matches = result;
          } catch {
            return "comparison_error";
          }
          if (abandonIfExpired()) {
            return "timeout";
          }
          if (matches) {
            validatedValueAgeSeconds = shadowValueAgeSeconds(retainedFrame.createdAtMs);
            return "match";
          }

          let confirmationFrame: DecodedRedisFrame | null;
          try {
            confirmationFrame = await readShadowFrame(null, "retain");
          } catch {
            return "confirmation_error";
          }
          if (abandonIfExpired()) {
            return "timeout";
          }

          const originalFrame = flight.cachedFrame;
          if (originalFrame === null) {
            return "timeout";
          }
          if (confirmationFrame === null || !redisPayloadsEqual(originalFrame.payload, confirmationFrame.payload)) {
            return "superseded";
          }
          if (logMismatches) {
            mismatchDetails = { cachedValue, sourceValue };
          }
          validatedValueAgeSeconds = shadowValueAgeSeconds(originalFrame.createdAtMs);
          return "mismatch";
        } finally {
          finishOperation();
        }
      },
    });

    void validation.then(
      (outcome) => this.recordShadowValidation(key, outcome, logMismatches, mismatchDetails, validatedValueAgeSeconds),
      () => this.recordShadowValidation(key, "timeout"),
    );
  }

  private recordShadowValidation(
    key: DialCacheKey,
    outcome: ShadowValidationOutcome,
    logMismatches = false,
    mismatchDetails?: ShadowMismatchDetails,
    valueAgeSeconds?: number,
  ): void {
    const labels = {
      cacheNamespace: key.namespace,
      useCase: key.useCase,
      keyType: key.keyType,
      outcome,
    } as const;
    this.metrics?.shadowValidation?.(labels);
    if (valueAgeSeconds !== undefined) {
      this.metrics?.observeShadowValueAge?.(labels, valueAgeSeconds);
    }
    if (outcome !== "mismatch" || !logMismatches) {
      return;
    }

    const warning = {
      cacheNamespace: key.namespace,
      useCase: key.useCase,
      keyType: key.keyType,
      outcome: "mismatch",
    } as const;
    if (mismatchDetails !== undefined) {
      try {
        this.logger.warn(
          "DialCache shadow validation mismatch",
          {
            ...warning,
            ...shadowMismatchLogDetails(
              key.urn,
              mismatchDetails.cachedValue,
              mismatchDetails.sourceValue,
            ),
          },
        );
        return;
      } catch {
        // JSON detail construction is best-effort; preserve the metadata warning.
      }
    }
    this.logger.warn("DialCache shadow validation mismatch", warning);
  }

  private async resolveLocalLayerConfig(
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig | null,
  ): Promise<LayerConfigResolution> {
    try {
      const result = await this.localCache.resolveLayerConfig(key, keyConfig);
      if (result.status === "disabled") {
        this.metrics?.disabled({ ...labelsFor(key, CacheLayer.LOCAL), reason: result.reason });
        this.recordInvalidLeaf(key, CacheLayer.LOCAL, result.reason);
      }
      return result;
    } catch (error) {
      this.logger.error("Error resolving local cache config", error);
      this.recordError(key, CacheLayer.LOCAL, "config_resolution");
      this.metrics?.disabled({ ...labelsFor(key, CacheLayer.LOCAL), reason: "config_error" });
      return { status: "disabled", reason: "config_error" };
    }
  }

  private readLocalWithResolvedConfig<T>(key: DialCacheKey, layerConfig: ResolvedLayerConfig): CacheGetResult<T> {
    const start = performance.now();
    try {
      const result = this.localCache.getWithResolvedConfig<T>(key, layerConfig);
      this.metrics?.request(labelsFor(key, CacheLayer.LOCAL));
      this.metrics?.observeGet(labelsFor(key, CacheLayer.LOCAL), elapsedSeconds(start));
      if (result.status === "miss") {
        this.metrics?.miss(labelsFor(key, CacheLayer.LOCAL));
      }
      return result;
    } catch (error) {
      this.logger.error("Error getting value from local cache", error);
      this.recordError(key, CacheLayer.LOCAL, "cache_read");
      this.metrics?.disabled({ ...labelsFor(key, CacheLayer.LOCAL), reason: "config_error" });
      return { status: "disabled", reason: "config_error" } as const;
    }
  }

  private async resolveRemoteLayerConfig(key: DialCacheKey, keyConfig: DialCacheKeyConfig | null) {
    try {
      const result = resolveRemoteLayerConfigResult({
        config: keyConfig,
        key,
      });
      if (result.staleOnErrorConfigError === true) {
        this.recordError(key, CacheLayer.REMOTE, "config_resolution");
      }
      if (result.status === "disabled") {
        this.metrics?.disabled({ ...labelsFor(key, CacheLayer.REMOTE), reason: result.reason });
        this.recordInvalidLeaf(key, CacheLayer.REMOTE, result.reason);
      }
      return result;
    } catch (error) {
      this.logger.warn("Error resolving Redis cache config", error);
      this.recordError(key, CacheLayer.REMOTE, "config_resolution");
      this.metrics?.disabled({ ...labelsFor(key, CacheLayer.REMOTE), reason: "config_error" });
      return { status: "disabled", reason: "config_error", ...(key.trackForInvalidation ? { skipCacheWrite: true } : {}) } as const;
    }
  }

  private async readRemoteWithResolvedConfig<T>(
    redisCache: RedisCache,
    key: DialCacheKey,
    layerConfig: ResolvedRemoteLayerConfig,
    readTimeoutMs: number,
  ): Promise<RemoteCacheGetResult<T>> {
    try {
      return await redisCache.getWithResolvedConfig<T>(key, layerConfig, readTimeoutMs);
    } catch (error) {
      this.logger.warn("Error getting value from Redis cache", error);
      return { status: "error" };
    }
  }

  private async putLocalFailOpen<T>(key: DialCacheKey, value: T, config: { readonly ttlSec: number }): Promise<void> {
    try {
      this.localCache.put(key, value, config);
    } catch (error) {
      this.logger.warn("Error putting value in local cache", error);
      this.recordError(key, CacheLayer.LOCAL, "cache_write");
    }
  }

  private async callFallback<T>(labels: CacheMetricLabels, fallback: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fallback();
    } catch (error) {
      this.metrics?.error({ ...labels, error: "fallback", inFallback: true });
      throw error;
    } finally {
      this.metrics?.observeFallback(labels, elapsedSeconds(start));
    }
  }

  private recordError(key: DialCacheKey, layer: MetricLayer, kind: MetricErrorKind): void {
    this.metrics?.error({ ...labelsFor(key, layer), error: kind, inFallback: false });
  }

  /**
   * Invalid runtime TTL/ramp leaves can only come from provider results, since
   * static defaults are validated before the operation executes. Count them as
   * config_resolution errors as well as disabled skips so garbage config is
   * alertable separately from intentional ramp-downs and disabled policy.
   */
  private recordInvalidLeaf(key: DialCacheKey, layer: MetricLayer, reason: DisabledReason): void {
    if (reason === "invalid_ttl" || reason === "invalid_ramp") {
      this.recordError(key, layer, "config_resolution");
    }
  }

  private registerUseCase(useCase: string): void {
    this.assertUseCaseIsNotReserved(useCase);
    if (this.useCases.has(useCase)) {
      throw new UseCaseIsAlreadyRegisteredError(useCase);
    }
    this.useCases.add(useCase);
  }

  private assertUseCaseIsNotReserved(useCase: string): void {
    if (useCase === "watermark") {
      throw new UseCaseNameIsReservedError(useCase);
    }
  }

  private buildKey<Value>(
    options: CacheOperationOptions<Value>,
    cacheKey: CacheKeySpec,
    defaultConfig: DialCacheKeyConfig | null,
  ): DialCacheKey {
    const spec = typeof cacheKey === "object" ? cacheKey : { id: cacheKey };
    return new DialCacheKey({
      keyType: options.keyType,
      id: String(spec.id),
      useCase: options.useCase,
      args: normalizeArgs(spec.args ?? {}),
      namespace: this.namespace,
      defaultConfig,
      serializer: (options.serializer as Serializer<unknown> | null | undefined) ?? null,
      trackForInvalidation: options.trackForInvalidation ?? false,
    });
  }

  private singleFlightRequestLocal<T>(
    inFlight: Map<string, Promise<unknown>>,
    key: DialCacheKey,
    run: () => Promise<T>,
  ): Promise<T> {
    const existing = inFlight.get(key.urn);
    if (existing !== undefined) {
      this.metrics?.coalesced?.({
        cacheNamespace: key.namespace,
        useCase: key.useCase,
        keyType: key.keyType,
        scope: "request_local",
      });
      return existing as Promise<T>;
    }

    const promise = run();
    inFlight.set(key.urn, promise);
    const clear = (): void => {
      if (inFlight.get(key.urn) === promise) {
        inFlight.delete(key.urn);
      }
    };
    void promise.then(clear, clear);
    return promise;
  }

  private singleFlightProcess<T>(key: DialCacheKey, run: () => Promise<T>): Promise<T> {
    const existing = this.processFlights.get(key.urn);
    if (existing !== undefined) {
      if (existing.promise === null) {
        throw new Error("DialCache process flight was joined before initialization");
      }
      existing.followers += 1;
      this.activeProcessFollowers += 1;
      this.metrics?.coalesced?.({
        cacheNamespace: key.namespace,
        useCase: key.useCase,
        keyType: key.keyType,
        scope: "process",
      });
      return existing.promise as Promise<T>;
    }

    const flight: ProcessFlight = {
      promise: null,
      startedAtMs: performance.now(),
      followers: 0,
    };
    this.processFlights.set(key.urn, flight);
    let promise: Promise<T>;
    try {
      promise = run();
    } catch (error) {
      if (this.processFlights.get(key.urn) === flight) {
        this.processFlights.delete(key.urn);
      }
      throw error;
    }
    flight.promise = promise;
    const clear = (): void => {
      if (this.processFlights.get(key.urn) === flight) {
        this.activeProcessFollowers -= flight.followers;
        this.processFlights.delete(key.urn);
      }
    };
    void promise.then(clear, clear);
    return promise;
  }
}

function elapsedSeconds(startMs: number): number {
  return Math.max((performance.now() - startMs) / 1000, 0);
}

function yieldUnreferencedImmediate(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve).unref();
  });
}

function snapshotDefaultConfig(config: DialCacheKeyConfig | null | undefined): DialCacheKeyConfig | null {
  if (config === null || config === undefined) {
    return null;
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("DialCache defaultConfig must be an object");
  }
  if (Object.hasOwn(config, "shadowRamp")) {
    throw new TypeError('DialCacheKeyConfig.shadowRamp was replaced by "shadow.ramp"');
  }
  const ttlSecConfig = config.ttlSec;
  const rampConfig = config.ramp;
  const shadowConfig = config.shadow;
  const requestLocal = config.requestLocal;
  const coalesce = config.coalesce;
  const staleOnErrorMaxAgeSec = config.staleOnErrorMaxAgeSec;
  const remoteReadTimeoutMs = config.remoteReadTimeoutMs;
  if (requestLocal !== undefined && typeof requestLocal !== "boolean") {
    throw new TypeError("DialCache defaultConfig requestLocal must be a boolean");
  }
  if (coalesce !== undefined && typeof coalesce !== "boolean") {
    throw new TypeError("DialCache defaultConfig coalesce must be a boolean");
  }

  assertDefaultLayerMap(ttlSecConfig, "ttlSec");
  assertDefaultLayerMap(rampConfig, "ramp");
  assertDefaultShadowConfig(shadowConfig);

  const snapshot = new DialCacheKeyConfig({
    ttlSec: ttlSecConfig,
    ramp: rampConfig,
    ...(requestLocal === undefined ? {} : { requestLocal }),
    ...(coalesce === undefined ? {} : { coalesce }),
    ...(staleOnErrorMaxAgeSec === undefined ? {} : { staleOnErrorMaxAgeSec }),
    ...(remoteReadTimeoutMs === undefined ? {} : { remoteReadTimeoutMs }),
    ...(shadowConfig === undefined ? {} : { shadow: shadowConfig }),
  });

  for (const layer of [CacheLayer.LOCAL, CacheLayer.REMOTE]) {
    const ttlSec = snapshot.ttlSec[layer];
    if (ttlSec !== undefined) {
      if (typeof ttlSec !== "number") {
        throw new TypeError(`DialCache defaultConfig ttlSec.${layer} must be a number`);
      }
      if (!isSupportedCacheTtlSec(ttlSec)) {
        throw new RangeError(
          `DialCache defaultConfig ttlSec.${layer} must be a positive safe integer no greater than ${MAX_CACHE_TTL_SEC}`,
        );
      }
    }

    const ramp = snapshot.ramp[layer];
    if (ramp !== undefined) {
      if (typeof ramp !== "number") {
        throw new TypeError(`DialCache defaultConfig ramp.${layer} must be a number`);
      }
      if (!Number.isFinite(ramp) || ramp < 0 || ramp > 100) {
        throw new RangeError(`DialCache defaultConfig ramp.${layer} must be between 0 and 100`);
      }
    }
  }

  if (snapshot.staleOnErrorMaxAgeSec !== undefined) {
    const maxAgeSec = snapshot.staleOnErrorMaxAgeSec;
    if (typeof maxAgeSec !== "number") {
      throw new TypeError("DialCache defaultConfig staleOnErrorMaxAgeSec must be a number");
    }
    if (maxAgeSec !== 0 && !isSupportedCacheTtlSec(maxAgeSec)) {
      throw new RangeError(
        `DialCache defaultConfig staleOnErrorMaxAgeSec must be a nonnegative safe integer no greater than ${MAX_CACHE_TTL_SEC}`,
      );
    }
    if (maxAgeSec > 0) {
      const remoteTtlSec = snapshot.ttlSec[CacheLayer.REMOTE];
      if (remoteTtlSec === undefined) {
        throw new RangeError(
          "DialCache defaultConfig staleOnErrorMaxAgeSec requires ttlSec.remote",
        );
      }
      if (maxAgeSec <= remoteTtlSec) {
        throw new RangeError(
          "DialCache defaultConfig staleOnErrorMaxAgeSec must be greater than ttlSec.remote",
        );
      }
    }
  }

  if (snapshot.shadow !== undefined) {
    if (snapshot.shadow.ramp !== undefined) {
      if (typeof snapshot.shadow.ramp !== "number") {
        throw new TypeError("DialCache defaultConfig shadow.ramp must be a number");
      }
      if (!Number.isFinite(snapshot.shadow.ramp) || snapshot.shadow.ramp < 0 || snapshot.shadow.ramp > 100) {
        throw new RangeError("DialCache defaultConfig shadow.ramp must be between 0 and 100");
      }
    }
    if (snapshot.shadow.logMismatches !== undefined && typeof snapshot.shadow.logMismatches !== "boolean") {
      throw new TypeError("DialCache defaultConfig shadow.logMismatches must be a boolean");
    }
  }

  Object.freeze(snapshot.ttlSec);
  Object.freeze(snapshot.ramp);
  if (snapshot.shadow !== undefined) {
    Object.freeze(snapshot.shadow);
  }
  return Object.freeze(snapshot);
}

function assertDefaultLayerMap(config: unknown, name: "ttlSec" | "ramp"): void {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError(`DialCache defaultConfig ${name} must be a layer map`);
  }
}

function assertDefaultShadowConfig(config: unknown): asserts config is Record<string, unknown> | undefined {
  if (
    config !== undefined
    && (config === null || typeof config !== "object" || Array.isArray(config))
  ) {
    throw new TypeError("DialCache defaultConfig shadow must be an object");
  }
}

function resolveFallbackTimeoutMs(value: number | null | undefined): number | null {
  if (value === null) {
    return null;
  }

  const timeoutMs = value ?? DEFAULT_FALLBACK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `DialCache fallbackTimeoutMs must be null or a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  return timeoutMs;
}

function withFallbackTimeout<T>(
  fallback: () => Promise<T>,
  useCase: string,
  timeoutMs: number | null,
  onTimeout: () => void,
): Promise<T> {
  if (timeoutMs === null) {
    return fallback();
  }

  return withMonotonicDeadline({
    operation: fallback,
    timeoutMs,
    timeoutError: () => {
      onTimeout();
      return new FallbackTimeoutError(useCase, timeoutMs);
    },
  });
}

function safeLogger(logger: Logger): Logger {
  return {
    debug: (...args: Parameters<Logger["debug"]>) => callObserver(() => logger.debug(...args)),
    error: (...args: Parameters<Logger["error"]>) => callObserver(() => logger.error(...args)),
    warn: (...args: Parameters<Logger["warn"]>) => callObserver(() => logger.warn(...args)),
  };
}

function safeMetrics(metrics: DialCacheMetricsAdapter | null): DialCacheMetricsAdapter | null {
  if (metrics === null) {
    return null;
  }

  return {
    request: (labels) => callObserver(() => metrics.request(labels)),
    miss: (labels) => callObserver(() => metrics.miss(labels)),
    disabled: (labels) => callObserver(() => metrics.disabled(labels)),
    error: (labels) => callObserver(() => metrics.error(labels)),
    invalidation: (labels) => callObserver(() => metrics.invalidation(labels)),
    coalesced: (labels) => callObserver(() => metrics.coalesced?.(labels)),
    compression: (labels) => callObserver(() => metrics.compression?.(labels)),
    ...(typeof metrics.shadowValidation === "function"
      ? {
          shadowValidation: (labels) =>
            callObserver(() => metrics.shadowValidation!(labels)),
        }
      : {}),
    staleRecovery: (labels) => callObserver(() => metrics.staleRecovery?.(labels)),
    observeStaleRecoveryValueAge: (labels, seconds) =>
      callObserver(() => metrics.observeStaleRecoveryValueAge?.(labels, seconds)),
    observeShadowValueAge: (labels, seconds) =>
      callObserver(() => metrics.observeShadowValueAge?.(labels, seconds)),
    observeFutureTimestampOffset: (labels, seconds) =>
      callObserver(() => metrics.observeFutureTimestampOffset?.(labels, seconds)),
    observeGet: (labels, seconds) => callObserver(() => metrics.observeGet(labels, seconds)),
    observeFallback: (labels, seconds) => callObserver(() => metrics.observeFallback(labels, seconds)),
    observeSerialization: (labels, seconds) => callObserver(() => metrics.observeSerialization(labels, seconds)),
    observeSize: (labels, bytes) => callObserver(() => metrics.observeSize(labels, bytes)),
    observeStoredSize: (labels, bytes) => callObserver(() => metrics.observeStoredSize?.(labels, bytes)),
    observeCompressionRatio: (labels, ratio) => callObserver(() => metrics.observeCompressionRatio?.(labels, ratio)),
    observeCompression: (labels, seconds) => callObserver(() => metrics.observeCompression?.(labels, seconds)),
  };
}

function callObserver(record: () => unknown): void {
  try {
    const result = record();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {
        // Observer failures must not produce unhandled rejections.
      });
    }
  } catch {
    // Injected observers must not affect cache correctness or application fallbacks.
  }
}

function resolveShadowComparator<Value>(
  comparator: ShadowComparator<Value> | undefined,
): ShadowComparator<Value> {
  return comparator ?? isDeepStrictEqual;
}

function resolveStaleRecoveryPredicate(
  predicate: StaleRecoveryPredicate | undefined,
  fallback: StaleRecoveryPredicate,
): StaleRecoveryPredicate {
  if (predicate === undefined) {
    return fallback;
  }
  if (typeof predicate !== "function") {
    throw new TypeError("DialCache shouldAttemptStaleRecovery must be a function");
  }
  return predicate;
}

// Frame stamps and the observation both use application-process epoch clocks.
// Core rejects future frames before they can serve, but a confirmation read
// may retain one solely for payload supersession comparison. Clamp that
// diagnostic age to zero. A custom client that violates the decode contract
// can hand over a non-finite stamp; recording it would permanently poison
// backend histogram sums, so the observation is skipped instead.
function shadowValueAgeSeconds(createdAtMs: number): number | undefined {
  const ageSeconds = (Date.now() - createdAtMs) / 1000;
  if (!Number.isFinite(ageSeconds)) {
    return undefined;
  }
  return Math.max(ageSeconds, 0);
}

function redisPayloadsEqual(left: RedisCachePayload, right: RedisCachePayload): boolean {
  if (typeof left === "string" && typeof right === "string") {
    return left === right;
  }
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) {
    return left.equals(right);
  }
  if (Buffer.isBuffer(left)) {
    return typeof right === "string" && left.equals(Buffer.from(right, "utf8"));
  }
  return Buffer.isBuffer(right) && right.equals(Buffer.from(left, "utf8"));
}

async function settleUnexpectedThenable(value: unknown): Promise<void> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return;
  }
  try {
    await Promise.resolve(value);
  } catch {
    // Synchronous extension points may accidentally return a rejected thenable;
    // consume it without letting that rejection affect cache control flow.
  }
}

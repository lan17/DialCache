import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  type CachedOptions,
  type DecodedRedisFrame,
  type DialCacheMetricsAdapter,
  type RedisReadContext,
  type RedisReadRequest,
  type Serializer,
} from "../src/index.js";
import { MARKER_ZSTD_UTF8 } from "../src/internal/compression.js";
import { decodeFrame, encodeFrame, FakeRedis } from "./fake-redis.js";

const FRESH_TTL_SEC = 1;
const MAX_AGE_SEC = 10;
const SOURCE_UNAVAILABLE = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
const allowStaleRecovery = (): boolean => true;

class RecordingRedis extends FakeRedis {
  readonly readRequests: RedisReadRequest[] = [];
  readonly readContexts: Array<RedisReadContext | undefined> = [];

  override async read(
    request: RedisReadRequest,
    context?: RedisReadContext,
  ): Promise<DecodedRedisFrame | null> {
    this.readRequests.push(request);
    this.readContexts.push(context);
    return await super.read(request);
  }
}

class HangingReadRedis extends FakeRedis {
  readonly readRequests: RedisReadRequest[] = [];
  readonly readContexts: Array<RedisReadContext | undefined> = [];

  constructor(private readonly hangOnCall: number) {
    super();
  }

  override async read(
    request: RedisReadRequest,
    context?: RedisReadContext,
  ): Promise<DecodedRedisFrame | null> {
    this.readRequests.push(request);
    this.readContexts.push(context);
    if (this.readRequests.length === this.hangOnCall) {
      return await new Promise<DecodedRedisFrame | null>(() => undefined);
    }
    return await super.read(request);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function staleConfig(options: { readonly local?: boolean; readonly requestLocal?: boolean } = {}): DialCacheKeyConfig {
  return new DialCacheKeyConfig({
    ttlSec: {
      ...(options.local ? { [CacheLayer.LOCAL]: 60 } : {}),
      [CacheLayer.REMOTE]: FRESH_TTL_SEC,
    },
    ramp: {
      ...(options.local ? { [CacheLayer.LOCAL]: 100 } : {}),
      [CacheLayer.REMOTE]: 100,
    },
    ...(options.requestLocal ? { requestLocal: true } : {}),
    staleOnErrorMaxAgeSec: MAX_AGE_SEC,
  });
}

function redisValueKey(useCase: string, id = "123", trackForInvalidation = false): string {
  const key = new DialCacheKey({ keyType: "user_id", id, useCase, trackForInvalidation });
  return `${key.urn}:dialcache-frame-v1`;
}

function watermarkKey(id = "123"): string {
  return `{urn:user_id:${id}}#watermark`;
}

function seedStale(redis: FakeRedis, useCase: string, value: unknown, trackForInvalidation = false): void {
  redis.setRaw(
    redisValueKey(useCase, "123", trackForInvalidation),
    encodeFrame(value, Date.now() - 2_000),
    MAX_AGE_SEC * 1_000,
  );
}

function expectNativeReadCount(redis: RecordingRedis | HangingReadRedis, count: number): void {
  expect(redis.readRequests).toHaveLength(count);
  expect(redis.readRequests.every((request) => !Object.hasOwn(request, "maxAgeMs"))).toBe(true);
}

function recordingMetrics(): {
  readonly metrics: DialCacheMetricsAdapter;
  readonly staleRecovery: ReturnType<typeof vi.fn>;
  readonly shadowValidation: ReturnType<typeof vi.fn>;
} {
  const staleRecovery = vi.fn();
  const shadowValidation = vi.fn();
  return {
    staleRecovery,
    shadowValidation,
    metrics: {
      request: vi.fn(),
      miss: vi.fn(),
      disabled: vi.fn(),
      error: vi.fn(),
      invalidation: vi.fn(),
      shadowValidation,
      staleRecovery,
      observeGet: vi.fn(),
      observeFallback: vi.fn(),
      observeSerialization: vi.fn(),
      observeSize: vi.fn(),
    },
  };
}

function setupDefaultStaleUseCase<Fn extends () => unknown>(
  useCase: string,
  source: Fn,
  options: { readonly defaultConfig?: DialCacheKeyConfig } = {},
) {
  const redis = new RecordingRedis();
  const recordedMetrics = recordingMetrics();
  const dialcache = new DialCache({
    redis: { client: redis, readTimeoutMs: 1_000 },
    metrics: recordedMetrics.metrics,
    shouldAttemptStaleRecovery: allowStaleRecovery,
  });
  // Every fixture source is JSON-compatible; the generic helper cannot retain
  // that conditional-type proof across all callers.
  const getUser = dialcache.cached(source, {
    keyType: "user_id",
    useCase,
    cacheKey: () => "123",
    defaultConfig: options.defaultConfig ?? staleConfig(),
  } as CachedOptions<Fn>);
  return { redis, dialcache, getUser, staleRecovery: recordedMetrics.staleRecovery };
}

function rejectionReason<T>(result: PromiseSettledResult<T>): unknown {
  if (result.status !== "rejected") {
    throw new Error("Expected rejection");
  }
  return result.reason;
}

describe("DialCache stale-on-error recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
    const clockOriginMs = Date.now();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - clockOriginMs);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("serves the raw stale candidate retained by the initial Redis read without publication", async () => {
    const useCase = "StaleRecoveryServed";
    const staleValue = { id: "123", version: 1 };
    const source = vi.fn((): { readonly id: string; readonly version: number } => {
      throw SOURCE_UNAVAILABLE;
    });
    const { redis, dialcache, getUser, staleRecovery } = setupDefaultStaleUseCase(useCase, source);
    seedStale(redis, useCase, staleValue);
    const ttlBefore = redis.ttlMs(redisValueKey(useCase));

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(staleValue);

    expect(source).toHaveBeenCalledOnce();
    expectNativeReadCount(redis, 1);
    expect(redis.setCalls).toBe(0);
    expect(redis.ttlMs(redisValueKey(useCase))).toBe(ttlBefore);
    expect(staleRecovery).toHaveBeenCalledOnce();
    expect(staleRecovery).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase,
      keyType: "user_id",
      outcome: "served",
    });
  });

  it("returns a logically fresh Redis hit without calling the source or recovery", async () => {
    const useCase = "StaleRecoveryFreshHit";
    const source = vi.fn(async () => ({ id: "123", version: 2 }));
    const { redis, dialcache, getUser, staleRecovery } = setupDefaultStaleUseCase(useCase, source);
    redis.setRaw(
      redisValueKey(useCase),
      encodeFrame({ id: "123", version: 1 }, Date.now()),
      MAX_AGE_SEC * 1_000,
    );

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123", version: 1 });

    expect(source).not.toHaveBeenCalled();
    expectNativeReadCount(redis, 1);
    expect(staleRecovery).not.toHaveBeenCalled();
  });

  it("treats a frame at the exact fresh-age boundary as stale", async () => {
    const useCase = "StaleRecoveryExactFreshBoundary";
    const retained = { id: "123", version: 1 };
    const source = vi.fn(async () => {
      throw new Error("source unavailable");
    });
    const { redis, dialcache, getUser, staleRecovery } = setupDefaultStaleUseCase(useCase, source);
    redis.setRaw(
      redisValueKey(useCase),
      encodeFrame(retained, Date.now() - FRESH_TTL_SEC * 1_000),
      MAX_AGE_SEC * 1_000,
    );

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(retained);

    expect(source).toHaveBeenCalledOnce();
    expectNativeReadCount(redis, 1);
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "served" }));
  });

  it("fails closed on a future-dated frame without retaining it for recovery", async () => {
    const useCase = "StaleRecoveryFutureFrame";
    const source = vi.fn(async () => {
      throw SOURCE_UNAVAILABLE;
    });
    const { redis, dialcache, getUser, staleRecovery } = setupDefaultStaleUseCase(useCase, source);
    redis.setRaw(
      redisValueKey(useCase),
      encodeFrame({ id: "123", version: 1 }, Date.now() + 1),
      MAX_AGE_SEC * 1_000,
    );

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(SOURCE_UNAVAILABLE);

    expect(source).toHaveBeenCalledOnce();
    expectNativeReadCount(redis, 1);
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "miss" }));
  });

  it("keeps feature-off writes at the fresh TTL and never performs a recovery read", async () => {
    const useCase = "StaleRecoveryFeatureOff";
    const source = vi.fn<() => Promise<{ readonly id: string; readonly version: number }>>()
      .mockResolvedValueOnce({ id: "123", version: 1 })
      .mockRejectedValueOnce(SOURCE_UNAVAILABLE);
    const { redis, dialcache, getUser, staleRecovery } = setupDefaultStaleUseCase(useCase, source, {
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: FRESH_TTL_SEC },
        ramp: { [CacheLayer.REMOTE]: 100 },
      }),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123", version: 1 });
    expect(redis.ttlMs(redisValueKey(useCase))).toBe(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const [settled] = await Promise.allSettled([dialcache.enable(async () => await getUser())]);

    expect(rejectionReason(settled!)).toBe(SOURCE_UNAVAILABLE);
    expectNativeReadCount(redis, 2);
    expect(redis.setCalls).toBe(1);
    expect(staleRecovery).not.toHaveBeenCalled();
  });

  it("does not deserialize a retained candidate when the source succeeds", async () => {
    const useCase = "StaleRecoverySourceSuccess";
    const sourceValue = { id: "123", version: 2 };
    const source = vi.fn(async () => sourceValue);
    const redis = new RecordingRedis();
    const { metrics, staleRecovery } = recordingMetrics();
    const serializer: Serializer<typeof sourceValue> = {
      dump: vi.fn(async (value) => JSON.stringify(value)),
      load: vi.fn(async () => {
        throw new Error("retained candidate should stay raw while the source succeeds");
      }),
    };
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
      serializer,
    });
    seedStale(redis, useCase, { id: "123", version: 1 });

    await expect(dialcache.enable(async () => await getUser())).resolves.toBe(sourceValue);

    expect(source).toHaveBeenCalledOnce();
    expectNativeReadCount(redis, 1);
    expect(redis.setCalls).toBe(1);
    expect(redis.ttlMs(redisValueKey(useCase))).toBe(10_000);
    expect(serializer.load).not.toHaveBeenCalled();
    const refreshedFrame = decodeFrame(redis.raw(redisValueKey(useCase)));
    expect(refreshedFrame.createdAtMs).toBe(Date.now());
    expect(JSON.parse(refreshedFrame.payload as string)).toEqual(sourceValue);
    expect(staleRecovery).not.toHaveBeenCalled();
  });

  it("rejects with the original source error when a retained frame reaches the exact maximum age", async () => {
    const useCase = "StaleRecoveryCrossesMaximumDuringSource";
    const redis = new RecordingRedis();
    const valueKey = redisValueKey(useCase);
    redis.setRaw(
      valueKey,
      encodeFrame({ id: "123", version: 1 }, Date.now() - 9_000),
      20_000,
    );
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const sourceStarted = deferred<void>();
    const sourceGate = deferred<{ readonly id: string; readonly version: number }>();
    const { metrics, staleRecovery } = recordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(async () => {
      sourceStarted.resolve();
      return await sourceGate.promise;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
    });

    const result = Promise.allSettled([dialcache.enable(async () => await getUser())]);
    await sourceStarted.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    sourceGate.reject(sourceError);
    const [settled] = await result;

    expect(rejectionReason(settled!)).toBe(sourceError);
    expectNativeReadCount(redis, 1);
    expect(redis.ttlMs(valueKey)).toBe(19_000);
    expect(redis.setCalls).toBe(0);
    expect(staleRecovery).toHaveBeenCalledOnce();
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "miss" }));
  });

  it("uses one runtime policy snapshot for the initial read and delayed recovery", async () => {
    const useCase = "StaleRecoveryRuntimePolicySnapshot";
    const redis = new RecordingRedis();
    const staleValue = { id: "123", version: 1 };
    seedStale(redis, useCase, staleValue);
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const sourceStarted = deferred<void>();
    const sourceGate = deferred<{ readonly id: string; readonly version: number }>();
    let freshTtlSec = 1;
    let maxAgeSec = 3;
    let remoteReadTimeoutMs = 25;
    const cacheConfigProvider = vi.fn(async () => new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: freshTtlSec },
      ramp: { [CacheLayer.REMOTE]: 100 },
      staleOnErrorMaxAgeSec: maxAgeSec,
      remoteReadTimeoutMs,
    }));
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      cacheConfigProvider,
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(async () => {
      sourceStarted.resolve();
      return await sourceGate.promise;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
    });

    const result = Promise.allSettled([dialcache.enable(async () => await getUser())]);
    await sourceStarted.promise;
    freshTtlSec = 4;
    maxAgeSec = 20;
    remoteReadTimeoutMs = 75;
    sourceGate.reject(sourceError);
    const [settled] = await result;

    expect(settled).toEqual({ status: "fulfilled", value: staleValue });
    expect(cacheConfigProvider).toHaveBeenCalledOnce();
    expectNativeReadCount(redis, 1);
    expect(redis.readContexts.map((context) => context?.timeoutMs)).toEqual([25]);
  });

  it("applies the current runtime fresh age to an existing retained frame", async () => {
    const useCase = "StaleRecoveryRuntimeFreshAge";
    const redis = new RecordingRedis();
    const retainedValue = { id: "123", version: 1 };
    redis.setRaw(
      redisValueKey(useCase),
      encodeFrame(retainedValue, Date.now() - 3_000),
      MAX_AGE_SEC * 1_000,
    );
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const source = vi.fn(async () => {
      throw sourceError;
    });
    let freshTtlSec = 4;
    const cacheConfigProvider = vi.fn(async () => new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: freshTtlSec },
      ramp: { [CacheLayer.REMOTE]: 100 },
      staleOnErrorMaxAgeSec: MAX_AGE_SEC,
    }));
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      cacheConfigProvider,
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(retainedValue);
    expect(source).not.toHaveBeenCalled();

    freshTtlSec = 2;
    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(retainedValue);
    expect(source).toHaveBeenCalledOnce();

    freshTtlSec = 4;
    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(retainedValue);

    expect(source).toHaveBeenCalledOnce();
    expect(cacheConfigProvider).toHaveBeenCalledTimes(3);
    expectNativeReadCount(redis, 3);
  });

  it("caps tracked stale retention at one hour without creating a watermark", async () => {
    const useCase = "StaleRecoveryTrackedRetentionCap";
    const redis = new RecordingRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    const getUser = dialcache.cached(async () => ({ id: "123" }), {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        staleOnErrorMaxAgeSec: 7_200,
      }),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });

    expect(redis.ttlMs(redisValueKey(useCase, "123", true))).toBe(60 * 60 * 1_000);
    expect(redis.ttlMs(watermarkKey())).toBe(-2);
    expect(redis.readRequests).toEqual([
      { valueKey: redisValueKey(useCase, "123", true), watermarkKey: watermarkKey() },
    ]);
  });

  it("does not clamp the configured tracked logical maximum age to the physical one-hour cap", async () => {
    const useCase = "StaleRecoveryTrackedLogicalMaximum";
    const redis = new RecordingRedis();
    const retained = { id: "123", version: 1 };
    redis.setRaw(
      redisValueKey(useCase, "123", true),
      encodeFrame(retained, Date.now() - 3_700_000),
      10_000,
    );
    redis.setRaw(watermarkKey(), "0", 10_000);
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const getUser = dialcache.cached(async (): Promise<typeof retained> => {
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        staleOnErrorMaxAgeSec: 7_200,
      }),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(retained);
    expectNativeReadCount(redis, 1);
  });

  it.each([
    ["object", Object.freeze({ code: "SOURCE_OBJECT" })],
    ["null", null],
    ["undefined", undefined],
  ] as const)("preserves an arbitrary %s rejection when recovery misses", async (_name, sourceError) => {
    const useCase = `StaleRecoveryIdentity${_name}`;
    const source = vi.fn(async () => {
      throw sourceError;
    });
    const { redis, dialcache, getUser, staleRecovery } = setupDefaultStaleUseCase(useCase, source);

    const [settled] = await Promise.allSettled([dialcache.enable(async () => await getUser())]);

    expect(rejectionReason(settled!)).toBe(sourceError);
    expectNativeReadCount(redis, 1);
    expect(staleRecovery).toHaveBeenCalledOnce();
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "miss" }));
  });

  it("never attempts recovery after the initial Redis read fails", async () => {
    const useCase = "StaleRecoveryInitialReadError";
    const redis = new RecordingRedis();
    redis.failGet = true;
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const { metrics, staleRecovery } = recordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(async () => {
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
    });

    const [settled] = await Promise.allSettled([dialcache.enable(async () => await getUser())]);

    expect(rejectionReason(settled!)).toBe(sourceError);
    expect(redis.readRequests).toHaveLength(1);
    expect(staleRecovery).not.toHaveBeenCalled();
  });

  it("serves the retained candidate when Redis becomes unavailable during the source attempt", async () => {
    const useCase = "StaleRecoveryRedisUnavailableAfterRead";
    const redis = new RecordingRedis();
    const retained = { id: "123", version: 1 };
    seedStale(redis, useCase, retained);
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const { metrics, staleRecovery } = recordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(async () => {
      redis.failGet = true;
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(retained);

    expect(redis.readRequests).toHaveLength(1);
    expect(staleRecovery).toHaveBeenCalledOnce();
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "served" }));
  });

  it("serves the retained candidate after its Redis key expires during the source attempt", async () => {
    const useCase = "StaleRecoveryRedisExpiryAfterRead";
    const redis = new RecordingRedis();
    const retained = { id: "123", version: 1 };
    redis.setRaw(
      redisValueKey(useCase),
      encodeFrame(retained, Date.now() - 2_000),
      500,
    );
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const sourceStarted = deferred<void>();
    const sourceGate = deferred<{ readonly id: string; readonly version: number }>();
    const { metrics, staleRecovery } = recordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 10 },
      metrics,
      logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(async () => {
      sourceStarted.resolve();
      return await sourceGate.promise;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
    });

    const result = dialcache.enable(async () => await getUser());
    await sourceStarted.promise;
    await vi.advanceTimersByTimeAsync(500);
    expect(redis.ttlMs(redisValueKey(useCase))).toBe(0);
    sourceGate.reject(sourceError);

    await expect(result).resolves.toEqual(retained);
    expect(redis.readRequests).toHaveLength(1);
    expect(staleRecovery).toHaveBeenCalledOnce();
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "served" }));
  });

  it("does not retry Redis when the initial read times out", async () => {
    const useCase = "StaleRecoveryInitialReadTimeout";
    const redis = new HangingReadRedis(1);
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const { metrics, staleRecovery } = recordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 10 },
      metrics,
      logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
    });
    const getUser = dialcache.cached(async () => {
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
    });

    const result = Promise.allSettled([dialcache.enable(async () => await getUser())]);
    await vi.advanceTimersByTimeAsync(10);
    const [settled] = await result;

    expect(rejectionReason(settled!)).toBe(sourceError);
    expect(redis.readRequests).toHaveLength(1);
    expect(redis.readContexts[0]?.signal.aborted).toBe(true);
    expect(staleRecovery).not.toHaveBeenCalled();
  });

  it("serves stale after the fallback deadline and ignores the late source result", async () => {
    const useCase = "StaleRecoveryFallbackTimeout";
    const redis = new RecordingRedis();
    seedStale(redis, useCase, { id: "123", version: 1 });
    const sourceGate = deferred<{ readonly id: string; readonly version: number }>();
    const sourceStarted = deferred<void>();
    const { metrics, staleRecovery } = recordingMetrics();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 100 }, metrics });
    const getUser = dialcache.cached(async () => {
      sourceStarted.resolve();
      return await sourceGate.promise;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      defaultConfig: staleConfig(),
    });

    const result = dialcache.enable(async () => await getUser());
    await sourceStarted.promise;
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toEqual({ id: "123", version: 1 });
    expect(redis.readRequests).toHaveLength(1);
    expect(redis.setCalls).toBe(0);
    expect(staleRecovery).toHaveBeenCalledOnce();
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "served" }));

    sourceGate.resolve({ id: "123", version: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.setCalls).toBe(0);
  });

  it("classifies recovery deserialization failure and never retries a normal deserialization miss", async () => {
    const recoveryUseCase = "StaleRecoveryDeserializeError";
    const normalUseCase = "StaleRecoveryInitialDeserializeError";
    const redis = new RecordingRedis();
    seedStale(redis, recoveryUseCase, { id: "123" });
    redis.setRaw(
      redisValueKey(normalUseCase),
      encodeFrame({ id: "123" }, Date.now()),
      MAX_AGE_SEC * 1_000,
    );
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const serializer: Serializer<{ readonly id: string }> = {
      dump: vi.fn(async (value) => JSON.stringify(value)),
      load: vi.fn(async () => {
        throw new Error("cannot decode");
      }),
    };
    const { metrics, staleRecovery } = recordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const recover = dialcache.cached(async (): Promise<{ readonly id: string }> => {
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase: recoveryUseCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
      serializer,
    });
    const initialFailure = dialcache.cached(async (): Promise<{ readonly id: string }> => {
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase: normalUseCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
      serializer,
    });

    const [recoverySettled] = await Promise.allSettled([dialcache.enable(async () => await recover())]);
    expect(rejectionReason(recoverySettled!)).toBe(sourceError);
    expect(staleRecovery).toHaveBeenCalledOnce();
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({
      useCase: recoveryUseCase,
      outcome: "deserialization_error",
    }));

    const readsBeforeInitialFailure = redis.readRequests.length;
    const [initialSettled] = await Promise.allSettled([
      dialcache.enable(async () => await initialFailure()),
    ]);
    expect(rejectionReason(initialSettled!)).toBe(sourceError);
    expect(redis.readRequests).toHaveLength(readsBeforeInitialFailure + 1);
    expect(staleRecovery).toHaveBeenCalledTimes(1);
    expect(staleRecovery).not.toHaveBeenCalledWith(expect.objectContaining({ useCase: normalUseCase }));
  });

  it("rejects with the source error when asynchronous recovery deserialization crosses M", async () => {
    const useCase = "StaleRecoveryDeserializeCrossesMaximum";
    const redis = new RecordingRedis();
    const retained = { id: "123", version: 1 };
    redis.setRaw(
      redisValueKey(useCase),
      encodeFrame(retained, Date.now() - 9_000),
      20_000,
    );
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const loadStarted = deferred<void>();
    const loadGate = deferred<typeof retained>();
    const serializer: Serializer<typeof retained> = {
      dump: vi.fn(async (value) => JSON.stringify(value)),
      load: vi.fn(async () => {
        loadStarted.resolve();
        return await loadGate.promise;
      }),
    };
    const { metrics, staleRecovery } = recordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(async (): Promise<typeof retained> => {
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
      serializer,
    });

    const result = Promise.allSettled([dialcache.enable(async () => await getUser())]);
    await loadStarted.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    loadGate.resolve(retained);
    const [settled] = await result;

    expect(rejectionReason(settled!)).toBe(sourceError);
    expectNativeReadCount(redis, 1);
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "miss" }));
  });

  it("serves the initial tracked snapshot when invalidation races with the source attempt", async () => {
    const useCase = "StaleRecoveryInvalidatedDuringSource";
    const redis = new RecordingRedis();
    seedStale(redis, useCase, { id: "123", version: 1 }, true);
    redis.setRaw(watermarkKey(), "0", MAX_AGE_SEC * 1_000 + 60_000);
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const sourceStarted = deferred<void>();
    const sourceGate = deferred<{ readonly id: string; readonly version: number }>();
    const { metrics, staleRecovery } = recordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(async () => {
      sourceStarted.resolve();
      return await sourceGate.promise;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: staleConfig(),
    });

    const result = dialcache.enable(async () => await getUser());
    await sourceStarted.promise;
    await dialcache.invalidateRemote("user_id", "123");
    sourceGate.reject(sourceError);

    await expect(result).resolves.toEqual({ id: "123", version: 1 });
    expect(redis.readRequests).toHaveLength(1);
    expect(redis.readRequests.every(({ watermarkKey: key }) => key === watermarkKey())).toBe(true);
    expect(staleRecovery).toHaveBeenCalledOnce();
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "served" }));
  });

  it("blocks a tracked candidate invalidated before the initial Redis snapshot", async () => {
    const useCase = "StaleRecoveryInvalidatedBeforeRead";
    const redis = new RecordingRedis();
    seedStale(redis, useCase, { id: "123", version: 1 }, true);
    redis.setRaw(watermarkKey(), String(Date.now()), MAX_AGE_SEC * 1_000 + 60_000);
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const { metrics, staleRecovery } = recordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(async (): Promise<{ readonly id: string; readonly version: number }> => {
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: staleConfig(),
    });

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(sourceError);

    expect(redis.readRequests).toHaveLength(1);
    expect(staleRecovery).toHaveBeenCalledOnce();
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "miss" }));
  });

  it("serves the initial candidate when Redis is refreshed during the source attempt", async () => {
    const useCase = "StaleRecoveryRefreshedDuringSource";
    const redis = new RecordingRedis();
    const initial = { id: "123", version: 1 };
    const refreshed = { id: "123", version: 2 };
    seedStale(redis, useCase, initial);
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const sourceStarted = deferred<void>();
    const sourceGate = deferred<typeof refreshed>();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(async () => {
      sourceStarted.resolve();
      return await sourceGate.promise;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
    });

    const result = dialcache.enable(async () => await getUser());
    await sourceStarted.promise;
    redis.setRaw(redisValueKey(useCase), encodeFrame(refreshed), MAX_AGE_SEC * 1_000);
    sourceGate.reject(sourceError);

    await expect(result).resolves.toEqual(initial);
    expect(redis.readRequests).toHaveLength(1);
    expect(JSON.parse(decodeFrame(redis.raw(redisValueKey(useCase))).payload as string)).toEqual(refreshed);
  });

  it("recovers cached undefined without starting shadow validation", async () => {
    const useCase = "StaleRecoveryUndefinedNoShadow";
    const redis = new RecordingRedis();
    redis.setRaw(
      redisValueKey(useCase, "123", true),
      encodeFrame("__dialcache_json_undefined_v1__", Date.now() - 2_000),
      MAX_AGE_SEC * 1_000,
    );
    redis.setRaw(watermarkKey(), "0", MAX_AGE_SEC * 1_000 + 60_000);
    const { metrics, staleRecovery, shadowValidation } = recordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getOptional = dialcache.cached(async (): Promise<void> => {
      throw new Error("source unavailable");
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: FRESH_TTL_SEC },
        ramp: { [CacheLayer.REMOTE]: 100 },
        staleOnErrorMaxAgeSec: MAX_AGE_SEC,
        shadow: { ramp: 100 },
      }),
    });

    await expect(dialcache.enable(async () => await getOptional())).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    expect(redis.readRequests).toHaveLength(1);
    expect(redis.setCalls).toBe(0);
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "served" }));
    expect(shadowValidation).not.toHaveBeenCalled();
  });

  it("applies a lowered runtime recovery maximum to an existing retained frame immediately", async () => {
    const useCase = "StaleRecoveryLoweredRuntimeMaximum";
    const redis = new RecordingRedis();
    redis.setRaw(
      redisValueKey(useCase),
      encodeFrame({ id: "123", version: 1 }, Date.now() - 5_000),
      10_000,
    );
    let maxAgeSec = 10;
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      cacheConfigProvider: async () => new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: FRESH_TTL_SEC },
        ramp: { [CacheLayer.REMOTE]: 100 },
        staleOnErrorMaxAgeSec: maxAgeSec,
      }),
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(async (): Promise<{ readonly id: string; readonly version: number }> => {
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123", version: 1 });
    maxAgeSec = 3;
    const [settled] = await Promise.allSettled([dialcache.enable(async () => await getUser())]);

    expect(rejectionReason(settled!)).toBe(sourceError);
    expectNativeReadCount(redis, 2);
  });

  it("does not resurrect or extend a frame after raising the runtime recovery maximum", async () => {
    const useCase = "StaleRecoveryRaisedRuntimeMaximum";
    const redis = new RecordingRedis();
    let maxAgeSec = 3;
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    let sourceCalls = 0;
    const source = vi.fn(async (): Promise<{ readonly id: string; readonly version: number }> => {
      if (++sourceCalls === 1) {
        return { id: "123", version: 1 };
      }
      throw sourceError;
    });
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      cacheConfigProvider: async () => new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: FRESH_TTL_SEC },
        ramp: { [CacheLayer.REMOTE]: 100 },
        staleOnErrorMaxAgeSec: maxAgeSec,
      }),
      shouldAttemptStaleRecovery: allowStaleRecovery,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123", version: 1 });
    expect(redis.ttlMs(redisValueKey(useCase))).toBe(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    maxAgeSec = 10;
    const [settled] = await Promise.allSettled([dialcache.enable(async () => await getUser())]);

    expect(rejectionReason(settled!)).toBe(sourceError);
    expectNativeReadCount(redis, 2);
    expect(redis.setCalls).toBe(1);
  });

  it("coalesces recovery and does not populate process-local cache", async () => {
    const useCase = "StaleRecoveryProcessCoalescing";
    const source = vi.fn(async () => {
      throw SOURCE_UNAVAILABLE;
    });
    const { redis, dialcache, getUser, staleRecovery } = setupDefaultStaleUseCase(useCase, source, {
      defaultConfig: staleConfig({ local: true }),
    });
    seedStale(redis, useCase, { id: "123", version: 1 });
    const localCache = (dialcache as unknown as {
      readonly localCache: { put: (...args: unknown[]) => void };
    }).localCache;
    const localPut = vi.spyOn(localCache, "put");

    const values = await dialcache.enable(async () => await Promise.all([getUser(), getUser(), getUser()]));

    expect(source).toHaveBeenCalledOnce();
    expect(redis.readRequests).toHaveLength(1);
    expect(values[1]).toBe(values[0]);
    expect(values[2]).toBe(values[0]);
    expect(localPut).not.toHaveBeenCalled();
    expect(staleRecovery).toHaveBeenCalledTimes(1);

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(values[0]);
    expect(source).toHaveBeenCalledTimes(2);
    expect(redis.readRequests).toHaveLength(2);
    expect(localPut).not.toHaveBeenCalled();
  });

  it("memoizes a recovered reference only within the active request-local scope", async () => {
    const useCase = "StaleRecoveryRequestLocal";
    const source = vi.fn(async () => {
      throw new Error("source unavailable");
    });
    const { redis, dialcache, getUser } = setupDefaultStaleUseCase(useCase, source, {
      defaultConfig: staleConfig({ requestLocal: true }),
    });
    seedStale(redis, useCase, { id: "123", version: 1 });

    const [first, second] = await dialcache.enable(async () => {
      const firstValue = await getUser();
      const secondValue = await getUser();
      return [firstValue, secondValue] as const;
    });

    expect(second).toBe(first);
    expect(source).toHaveBeenCalledOnce();
    expect(redis.readRequests).toHaveLength(1);

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(first);
    expect(source).toHaveBeenCalledTimes(2);
    expect(redis.readRequests).toHaveLength(2);
  });

  it("decompresses a retained value during stale recovery", async () => {
    const useCase = "StaleRecoveryCompressed";
    const retained = { id: "123", blob: "compressible stale payload ".repeat(1_024) };
    let available = true;
    const source = vi.fn(async () => {
      if (available) {
        return retained;
      }
      throw SOURCE_UNAVAILABLE;
    });
    const { redis, dialcache, getUser, staleRecovery } = setupDefaultStaleUseCase(useCase, source);

    await expect(dialcache.enable(async () => await getUser())).resolves.toBe(retained);
    const stored = decodeFrame(redis.raw(redisValueKey(useCase))).payload;
    expect(Buffer.isBuffer(stored) && stored[0]).toBe(MARKER_ZSTD_UTF8);

    available = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(retained);

    expectNativeReadCount(redis, 2);
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "served" }));
  });

  it("contains a corrupt compression envelope and preserves the source rejection", async () => {
    const useCase = "StaleRecoveryCorruptCompression";
    const source = vi.fn(async (): Promise<{ readonly id: string }> => {
      throw SOURCE_UNAVAILABLE;
    });
    const { redis, dialcache, getUser, staleRecovery } = setupDefaultStaleUseCase(useCase, source);
    redis.setRaw(
      redisValueKey(useCase),
      encodeFrame(
        Buffer.concat([Buffer.from([MARKER_ZSTD_UTF8]), Buffer.from("not a zstd frame")]),
        Date.now() - 2_000,
        1,
      ),
      MAX_AGE_SEC * 1_000,
    );

    const [settled] = await Promise.allSettled([dialcache.enable(async () => await getUser())]);

    expect(rejectionReason(settled!)).toBe(SOURCE_UNAVAILABLE);
    expect(staleRecovery).toHaveBeenCalledWith(expect.objectContaining({ outcome: "deserialization_error" }));
    expectNativeReadCount(redis, 1);
  });

  it("runs independent stale recovery chains when coalescing is disabled", async () => {
    const useCase = "StaleRecoveryCoalescingDisabled";
    const retained = { id: "123", version: 1 };
    const source = vi.fn(async () => {
      throw new Error("source unavailable");
    });
    const { redis, dialcache, getUser, staleRecovery } = setupDefaultStaleUseCase(useCase, source, {
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: FRESH_TTL_SEC },
        ramp: { [CacheLayer.REMOTE]: 100 },
        staleOnErrorMaxAgeSec: MAX_AGE_SEC,
        coalesce: false,
      }),
    });
    seedStale(redis, useCase, retained);

    const values = await dialcache.enable(async () => await Promise.all([getUser(), getUser()]));

    expect(values).toEqual([retained, retained]);
    expect(source).toHaveBeenCalledTimes(2);
    expectNativeReadCount(redis, 2);
    expect(staleRecovery).toHaveBeenCalledTimes(2);
  });
});

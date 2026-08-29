import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  invalidationPrefix,
  redisClusterHashTag,
  type CacheMetricLabels,
  type DisabledMetricLabels,
  type ErrorMetricLabels,
  type DialCacheMetricsAdapter,
  type InvalidationMetricLabels,
  type SerializationMetricLabels,
  type Serializer,
} from "../src/index.js";
import {
  MAX_SUPPORTED_DURATION_MS,
  MAX_TRACKED_REDIS_VALUE_TTL_MS,
} from "../src/internal/duration.js";
import { MIN_WATERMARK_TTL_MS } from "../src/internal/redis-scripts.js";
import { decodeFrame, encodeFrame, FakeRedis } from "./fake-redis.js";

class RecordingMetrics implements DialCacheMetricsAdapter {
  readonly events: Array<{ readonly name: string; readonly labels: Record<string, unknown> }> = [];

  request(labels: CacheMetricLabels): void {
    this.record("request", labels);
  }

  miss(labels: CacheMetricLabels): void {
    this.record("miss", labels);
  }

  disabled(labels: DisabledMetricLabels): void {
    this.record("disabled", labels);
  }

  error(labels: ErrorMetricLabels): void {
    this.record("error", labels);
  }

  invalidation(labels: InvalidationMetricLabels): void {
    this.record("invalidation", labels);
  }

  observeGet(labels: CacheMetricLabels): void {
    this.record("get", labels);
  }

  observeFallback(labels: CacheMetricLabels): void {
    this.record("fallback", labels);
  }

  observeSerialization(labels: SerializationMetricLabels): void {
    this.record("serialization", labels);
  }

  observeSize(labels: CacheMetricLabels): void {
    this.record("size", labels);
  }

  private record(name: string, labels: object): void {
    this.events.push({ name, labels: { ...labels } });
  }
}

const remoteOnly = (ttlSec = 60) =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: ttlSec },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

const localAndRemote = (ttlSec = 60) => DialCacheKeyConfig.enabled(ttlSec);
const valueKey = (useCase: string, args = ""): string => `{urn:user_id:123}${args}#${useCase}:dialcache-frame-v1`;
const watermarkKey = "{urn:user_id:123}#watermark";
const MAX_CACHE_TTL_SEC = 31_536_000;
const WATERMARK_TTL_MARGIN_MS = 60_000;

describe("DialCache targeted invalidation watermarks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T18:00:00.000Z"));
  });

  it("invalidates all tracked use cases sharing a key type and id", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let profileVersion = 1;
    let permissionsVersion = 1;
    const getProfile = dialcache.cached(async (userId: string) => ({ userId, profileVersion }), {
      keyType: "user_id",
      useCase: "InvalidateProfile",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });
    const getPermissions = dialcache.cached(async (userId: string) => ({ userId, permissionsVersion }), {
      keyType: "user_id",
      useCase: "InvalidatePermissions",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    await dialcache.enable(async () => {
      await getProfile("123");
      await getPermissions("123");
    });
    profileVersion = 2;
    permissionsVersion = 2;
    await dialcache.invalidateRemote("user_id", "123");
    vi.advanceTimersByTime(1);

    const values = await dialcache.enable(async () => [await getProfile("123"), await getPermissions("123")]);

    expect(values).toEqual([
      { userId: "123", profileVersion: 2 },
      { userId: "123", permissionsVersion: 2 },
    ]);
    expect(redis.readWatermarkValue(watermarkKey)).toBe(Date.parse("2026-05-12T18:00:00.000Z"));
  });

  it("skips remote refills and local publication during an observed future invalidation window", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "FutureBufferUser",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    });

    await dialcache.invalidateRemote("user_id", "123", 1_000);
    vi.advanceTimersByTime(500);
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect([...redis.values.keys()]).toEqual([watermarkKey]);
    expect(redis.setCalls).toBe(1);
    await expect(redis.read({
      valueKey: valueKey("FutureBufferUser"),
      watermarkKey,
    })).resolves.toEqual({
      observedWatermarkMs: Date.parse("2026-05-12T18:00:01.000Z"),
    });
    await expect(redis.read({ valueKey: valueKey("FutureBufferUser") })).resolves.toBeNull();
  });

  it("writes the exact refill candidate when it is newer than the observed watermark", async () => {
    const now = Date.now();
    const redis = new FakeRedis();
    redis.setRaw(valueKey("NewerRefillCandidate"), encodeFrame({ source: "old" }, now - 15));
    redis.setRaw(watermarkKey, String(now - 5));
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "NewerRefillCandidate",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(redis.mGetCalls).toBe(2);
    expect(redis.setCalls).toBe(1);
    expect(decodeFrame(redis.raw(valueKey("NewerRefillCandidate"))).createdAtMs).toBe(now);
  });

  it.each([
    { boundary: "equal to", watermarkOffsetMs: 0 },
    { boundary: "behind", watermarkOffsetMs: 10 },
  ])("skips a refill $boundary the observed watermark before serialization", async ({ watermarkOffsetMs }) => {
    const now = Date.now();
    const useCase = `SkippedRefillCandidate${watermarkOffsetMs}`;
    const redis = new FakeRedis();
    redis.setRaw(valueKey(useCase), encodeFrame({ source: "old" }, now - 20));
    redis.setRaw(watermarkKey, String(now + watermarkOffsetMs));
    const dump = vi.fn((): string => {
      throw new Error("fenced refill must not serialize");
    });
    const serializer: Serializer<{ userId: string; calls: number }> = {
      dump,
      load: () => {
        throw new Error("fenced stale frame must not deserialize");
      },
    };
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase,
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
      serializer,
    });

    const value = await dialcache.enable(async () => await getUser("123"));

    expect(value).toEqual({ userId: "123", calls: 1 });
    expect(dump).not.toHaveBeenCalled();
    expect(redis.mGetCalls).toBe(1);
    expect(redis.setCalls).toBe(0);
    expect(decodeFrame(redis.raw(valueKey(useCase))).createdAtMs).toBe(now - 20);
  });

  it("stores but fences a write when invalidation arrives during fallback", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getUser = dialcache.cached(
      async (userId: string) => {
        calls += 1;
        await dialcache.invalidateRemote("user_id", userId, 1_000);
        return { userId, calls };
      },
      {
        keyType: "user_id",
        useCase: "FutureBufferFallbackRace",
        cacheKey: (userId) => userId,
        trackForInvalidation: true,
        defaultConfig: localAndRemote(),
      },
    );

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect([...redis.values.keys()].sort()).toEqual([
      watermarkKey,
      valueKey("FutureBufferFallbackRace"),
    ].sort());
    await expect(redis.read({
      valueKey: valueKey("FutureBufferFallbackRace"),
      watermarkKey,
    })).resolves.toEqual({
      observedWatermarkMs: Date.parse("2026-05-12T18:00:01.000Z"),
    });
  });

  it("stores but fences a write when invalidation remains active after slow serialization", async () => {
    const redis = new FakeRedis();
    let signalDumpStarted = (): void => undefined;
    const dumpStarted = new Promise<void>((resolve) => {
      signalDumpStarted = resolve;
    });
    let releaseDump = (): void => undefined;
    const dumpGate = new Promise<void>((resolve) => {
      releaseDump = resolve;
    });
    const serializer: Serializer<{ userId: string; calls: number }> = {
      dump: async (value) => {
        signalDumpStarted();
        await dumpGate;
        return JSON.stringify(value);
      },
      load: async (value) => {
        const payload = Buffer.isBuffer(value) ? value.toString("utf8") : value;
        return JSON.parse(payload) as { userId: string; calls: number };
      },
    };
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "FutureBufferSerializationRace",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
      serializer,
    });

    const pending = dialcache.enable(async () => await getUser("123"));
    await dumpStarted;
    await dialcache.invalidateRemote("user_id", "123", 1_000);
    vi.advanceTimersByTime(500);
    releaseDump();
    const first = await pending;
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect([...redis.values.keys()].sort()).toEqual([
      watermarkKey,
      valueKey("FutureBufferSerializationRace"),
    ].sort());
    await expect(redis.read({
      valueKey: valueKey("FutureBufferSerializationRace"),
      watermarkKey,
    })).resolves.toEqual({
      observedWatermarkMs: Date.parse("2026-05-12T18:00:01.000Z"),
    });
  });

  it("fences a same-millisecond complete write for a zero-length future buffer", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "ZeroBufferBoundary",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    await dialcache.invalidateRemote("user_id", "123", 0);
    const fenced = await dialcache.enable(async () => await getUser("123"));
    expect(redis.values.has(valueKey("ZeroBufferBoundary"))).toBe(false);
    expect(redis.setCalls).toBe(1);
    vi.advanceTimersByTime(1);
    const written = await dialcache.enable(async () => await getUser("123"));
    const cached = await dialcache.enable(async () => await getUser("123"));

    expect(fenced).toEqual({ userId: "123", calls: 1 });
    expect(written).toEqual({ userId: "123", calls: 2 });
    expect(cached).toEqual(written);
    expect(calls).toBe(2);
    expect(redis.setCalls).toBe(2);
  });

  it("serves tracked writes after the future buffer", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "FutureBufferExpires",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    await dialcache.invalidateRemote("user_id", "123", 1_000);
    vi.advanceTimersByTime(1_001);
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(redis.values.has(valueKey("FutureBufferExpires"))).toBe(true);
  });

  it("treats a missing tracked watermark as the zero baseline", async () => {
    const redis = new FakeRedis();
    redis.setRaw(valueKey("MissingWatermark"), encodeFrame({ source: "stale" }));
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, source: `fallback-${++calls}` }), {
      keyType: "user_id",
      useCase: "MissingWatermark",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ source: "stale" });
    expect(second).toEqual(first);
    expect(calls).toBe(0);
    expect(redis.readWatermarkValue(watermarkKey)).toBeNull();
  });

  it("preserves the furthest watermark across repeated invalidations", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });

    await dialcache.invalidateRemote("user_id", "123", 5_000);
    const first = redis.readWatermarkValue(watermarkKey);
    vi.advanceTimersByTime(100);
    await dialcache.invalidateRemote("user_id", "123", 1_000);

    expect(redis.readWatermarkValue(watermarkKey)).toBe(first);
  });

  it("creates watermarks only on invalidation and does not extend them on reads or writes", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    const getUser = dialcache.cached(async (userId: string) => ({ userId }), {
      keyType: "user_id",
      useCase: "WatermarkLifetime",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(2 * 60 * 60),
    });

    await dialcache.enable(async () => await getUser("123"));
    expect(redis.ttlMs(watermarkKey)).toBe(-2);
    expect(redis.ttlMs(valueKey("WatermarkLifetime"))).toBe(MAX_TRACKED_REDIS_VALUE_TTL_MS);

    await dialcache.invalidateRemote("user_id", "123");
    const afterInvalidation = redis.ttlMs(watermarkKey);
    vi.advanceTimersByTime(1_000);
    await dialcache.enable(async () => await getUser("123"));
    const afterReadAndWrite = redis.ttlMs(watermarkKey);

    expect(afterInvalidation).toBe(MIN_WATERMARK_TTL_MS);
    expect(afterReadAndWrite).toBe(afterInvalidation - 1_000);
  });

  it("does not create or extend a shared watermark for tracked values with different TTLs", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis } });
    const getLongLived = dialcache.cached(async (userId: string) => ({ userId, lifetime: "long" }), {
      keyType: "user_id",
      useCase: "LongWatermarkLifetime",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(2 * 60 * 60),
    });
    const getShortLived = dialcache.cached(async (userId: string) => ({ userId, lifetime: "short" }), {
      keyType: "user_id",
      useCase: "ShortWatermarkLifetime",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(60),
    });

    await dialcache.enable(async () => await getLongLived("123"));
    expect(redis.ttlMs(watermarkKey)).toBe(-2);
    expect(redis.ttlMs(valueKey("LongWatermarkLifetime"))).toBe(MAX_TRACKED_REDIS_VALUE_TTL_MS);

    await dialcache.invalidateRemote("user_id", "123");
    const afterInvalidation = redis.ttlMs(watermarkKey);
    vi.advanceTimersByTime(60 * 60 * 1_000);
    await dialcache.enable(async () => await getShortLived("123"));

    expect(afterInvalidation).toBe(MIN_WATERMARK_TTL_MS);
    expect(redis.ttlMs(watermarkKey)).toBe(afterInvalidation - 60 * 60 * 1_000);
  });

  it("fails open without caching when tracked watermark reads fail", async () => {
    const redis = new FakeRedis();
    redis.failWatermarkGet = true;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 }, logger, metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "WatermarkReadFailOpen",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(redis.values.size).toBe(0);
    expect(metrics.events).toContainEqual({
      name: "error",
      labels: {
        cacheNamespace: "urn",
        useCase: "WatermarkReadFailOpen",
        keyType: "user_id",
        layer: CacheLayer.REMOTE,
        error: "cache_read",
        inFallback: false,
      },
    });
  });

  it("propagates invalidation write failures", async () => {
    const redis = new FakeRedis();
    redis.failSet = true;
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 }, logger, metrics });

    await expect(dialcache.invalidateRemote("user_id", "123")).rejects.toThrow("redis set failed");

    expect(logger.warn).toHaveBeenCalledWith("Error writing DialCache invalidation watermark", expect.any(Error));
    expect(metrics.events).toContainEqual({
      name: "invalidation",
      labels: { cacheNamespace: "urn", keyType: "user_id", layer: CacheLayer.REMOTE },
    });
    expect(metrics.events).toContainEqual({
      name: "error",
      labels: {
        cacheNamespace: "urn",
        useCase: "watermark",
        keyType: "user_id",
        layer: CacheLayer.REMOTE,
        error: "invalidation",
        inFallback: false,
      },
    });
  });

  it("rejects missing Redis configuration and records the invalidation failure", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ logger, metrics });

    const rejection = await dialcache.invalidateRemote("user_id", "123").catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(TypeError);
    expect(rejection).toHaveProperty(
      "message",
      "DialCache invalidateRemote requires a configured Redis client",
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "Error writing DialCache invalidation watermark",
      rejection,
    );
    expect(metrics.events).toEqual([
      {
        name: "invalidation",
        labels: { cacheNamespace: "urn", keyType: "user_id", layer: CacheLayer.REMOTE },
      },
      {
        name: "error",
        labels: {
          cacheNamespace: "urn",
          useCase: "watermark",
          keyType: "user_id",
          layer: CacheLayer.REMOTE,
          error: "invalidation",
          inFallback: false,
        },
      },
    ]);
  });

  it("preserves the missing Redis error when invalidation observers fail", async () => {
    const observerError = new Error("observer failed");
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(() => {
        throw observerError;
      }),
    };
    const metrics = new RecordingMetrics();
    const invalidationMetric = vi.spyOn(metrics, "invalidation").mockImplementation(() => {
      throw observerError;
    });
    const errorMetric = vi.spyOn(metrics, "error").mockImplementation(() => {
      throw observerError;
    });
    const dialcache = new DialCache({ logger, metrics });

    const rejection = await dialcache.invalidateRemote("user_id", "123").catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(TypeError);
    expect(rejection).toHaveProperty(
      "message",
      "DialCache invalidateRemote requires a configured Redis client",
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(invalidationMetric).toHaveBeenCalledOnce();
    expect(errorMetric).toHaveBeenCalledOnce();
  });

  it("rejects invalid future buffers before calling Redis", async () => {
    const redis = new FakeRedis();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      logger,
      metrics,
    });

    await expect(dialcache.invalidateRemote("user_id", "123", -1)).rejects.toThrow("futureBufferMs");
    await expect(dialcache.invalidateRemote("user_id", "123", 1.5)).rejects.toThrow("futureBufferMs");
    await expect(dialcache.invalidateRemote("user_id", "123", Number.NaN)).rejects.toThrow("futureBufferMs");
    await expect(dialcache.invalidateRemote("user_id", "123", Number.POSITIVE_INFINITY)).rejects.toThrow("futureBufferMs");
    await expect(
      dialcache.invalidateRemote("user_id", "123", MAX_SUPPORTED_DURATION_MS + 1),
    ).rejects.toThrow(`no greater than ${MAX_SUPPORTED_DURATION_MS}`);
    await expect(
      dialcache.invalidateRemote("user_id", "123", Number.MAX_SAFE_INTEGER),
    ).rejects.toThrow(`no greater than ${MAX_SUPPORTED_DURATION_MS}`);
    expect(redis.setCalls).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(metrics.events).toEqual([]);
  });

  it("caps tracked Redis values at one hour while retaining the configured local TTL", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 }, metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
      keyType: "user_id",
      useCase: "MaximumSupportedTtl",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(MAX_CACHE_TTL_SEC),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));
    expect(redis.ttlMs(valueKey("MaximumSupportedTtl"))).toBe(MAX_TRACKED_REDIS_VALUE_TTL_MS);
    expect(redis.ttlMs(watermarkKey)).toBe(-2);
    expect(metrics.events.filter(({ name }) => name === "error").map(({ labels }) => labels)).toEqual([
      {
        cacheNamespace: "urn",
        useCase: "MaximumSupportedTtl",
        keyType: "user_id",
        layer: CacheLayer.REMOTE,
        error: "tracked_ttl_clamped",
        inFallback: false,
      },
    ]);

    vi.advanceTimersByTime(MAX_TRACKED_REDIS_VALUE_TTL_MS + 1);
    const third = await dialcache.enable(async () => await getUser("123"));

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(third).toBe(second);
    expect(calls).toBe(1);
    expect(redis.mGetCalls).toBe(2);
  });

  it("caps only tracked Redis TTLs above one hour", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    const trackedTtlSec = MAX_TRACKED_REDIS_VALUE_TTL_MS / 1_000 - 1;
    const untrackedTtlSec = 2 * MAX_TRACKED_REDIS_VALUE_TTL_MS / 1_000;
    const getTracked = dialcache.cached(async (id: string) => ({ id }), {
      keyType: "user_id",
      useCase: "TrackedBelowCap",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(trackedTtlSec),
    });
    const getUntracked = dialcache.cached(async (id: string) => ({ id }), {
      keyType: "user_id",
      useCase: "UntrackedAboveCap",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly(untrackedTtlSec),
    });

    await dialcache.enable(async () => await getTracked("123"));
    await dialcache.enable(async () => await getUntracked("123"));

    const untrackedValueKey = `${new DialCacheKey({
      keyType: "user_id",
      id: "123",
      useCase: "UntrackedAboveCap",
    }).urn}:dialcache-frame-v1`;
    expect(redis.ttlMs(valueKey("TrackedBelowCap"))).toBe(trackedTtlSec * 1_000);
    expect(redis.ttlMs(untrackedValueKey)).toBe(untrackedTtlSec * 1_000);
  });

  it("accepts the maximum future buffer and derives its watermark TTL safely", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });

    await dialcache.invalidateRemote("user_id", "123", MAX_SUPPORTED_DURATION_MS);

    expect(redis.setCalls).toBe(1);
    expect(redis.readWatermarkValue(watermarkKey)).toBe(
      Date.now() + MAX_SUPPORTED_DURATION_MS,
    );
    expect(redis.ttlMs(watermarkKey)).toBe(
      MAX_SUPPORTED_DURATION_MS + MAX_TRACKED_REDIS_VALUE_TTL_MS + WATERMARK_TTL_MARGIN_MS,
    );
  });

  it("constructs cluster-compatible tracked value and watermark keys", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({
      namespace: "urn:galileo:test",
      redis: { client: redis, readTimeoutMs: 1_000 },
    });
    const getUser = dialcache.cached(async (userId: string, locale: string) => ({ userId, locale }), {
      keyType: "User",
      useCase: "ClusterSlotUser",
      cacheKey: (userId, locale) => ({ id: userId, args: { locale } }),
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    await dialcache.enable(async () => await getUser("123", "en"));
    await dialcache.invalidateRemote("User", "123");

    expect([...redis.values.keys()].sort()).toEqual([
      "{urn%3Agalileo%3Atest:User:123}#watermark",
      "{urn%3Agalileo%3Atest:User:123}?locale=en#ClusterSlotUser:dialcache-frame-v1",
    ]);
    expect(redisClusterHashTag(invalidationPrefix("urn", "user_id", "123"))).toBe("{urn:user_id:123}");
    expect(() => new DialCacheKey({ keyType: "user_id", id: "{123}", useCase: "BadTrackedKey", trackForInvalidation: true })).toThrow(
      /hash tag/,
    );
  });

  it("documents that Redis invalidation does not evict a validated local cache entry", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let version = 1;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, version }), {
      keyType: "user_id",
      useCase: "LocalInvalidationLimit",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: localAndRemote(),
    });

    const before = await dialcache.enable(async () => await getUser("123"));
    const warmed = await dialcache.enable(async () => await getUser("123"));
    version = 2;
    await dialcache.invalidateRemote("user_id", "123");
    const after = await dialcache.enable(async () => await getUser("123"));

    expect(before).toEqual({ userId: "123", version: 1 });
    expect(warmed).toEqual(before);
    expect(after).toEqual({ userId: "123", version: 1 });
  });

  it("keeps a memoized request-local value after remote invalidation and refreshes in the next request", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let version = 1;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, version }), {
      keyType: "user_id",
      useCase: "RequestLocalInvalidationBoundary",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: new DialCacheKeyConfig({
        requestLocal: true,
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
      }),
    });

    const sameRequest = await dialcache.enable(async () => {
      const before = await getUser("123");
      version = 2;
      await dialcache.invalidateRemote("user_id", "123");
      const after = await getUser("123");
      return { before, after };
    });
    const nextRequest = await dialcache.enable(async () => await getUser("123"));

    expect(sameRequest.before).toEqual({ userId: "123", version: 1 });
    expect(sameRequest.after).toBe(sameRequest.before);
    expect(nextRequest).toEqual({ userId: "123", version: 2 });
  });
});

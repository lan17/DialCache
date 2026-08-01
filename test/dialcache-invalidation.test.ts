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
  type DialCacheRedisClient,
  type ErrorMetricLabels,
  type DialCacheMetricsAdapter,
  type InvalidationMetricLabels,
  type SerializationMetricLabels,
  type Serializer,
} from "../src/index.js";
import { encodeFrame, FakeRedis } from "./fake-redis.js";

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
const MAX_SUPPORTED_DURATION_MS = 31_536_000_000;
const WATERMARK_TTL_MARGIN_MS = 60_000;

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

  it("does not write remote or local cache during a future invalidation window", async () => {
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
  });

  it("rejects a write when invalidation arrives during fallback", async () => {
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
    expect([...redis.values.keys()]).toEqual([watermarkKey]);
  });

  it("rejects a write when invalidation remains active after slow serialization", async () => {
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
    expect([...redis.values.keys()]).toEqual([watermarkKey]);
  });

  it("blocks a same-millisecond write for a zero-length future buffer", async () => {
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
    const blocked = await dialcache.enable(async () => await getUser("123"));
    vi.advanceTimersByTime(1);
    const written = await dialcache.enable(async () => await getUser("123"));
    const cached = await dialcache.enable(async () => await getUser("123"));

    expect(blocked).toEqual({ userId: "123", calls: 1 });
    expect(written).toEqual({ userId: "123", calls: 2 });
    expect(cached).toEqual(written);
    expect(calls).toBe(2);
  });

  it("resumes tracked writes after the future buffer", async () => {
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

  it("treats a tracked value with a missing watermark marker as a miss", async () => {
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

    expect(first).toEqual({ userId: "123", source: "fallback-1" });
    expect(second).toEqual({ userId: "123", source: "fallback-1" });
    expect(redis.readWatermarkValue(watermarkKey)).toBe(0);
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

  it("derives watermark lifetime from value TTLs and invalidations without extending it on reads", async () => {
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
    const afterWrite = redis.ttlMs(watermarkKey);
    vi.advanceTimersByTime(1_000);
    await dialcache.enable(async () => await getUser("123"));
    const afterRead = redis.ttlMs(watermarkKey);
    await dialcache.invalidateRemote("user_id", "123");
    const afterInvalidation = redis.ttlMs(watermarkKey);

    expect(afterWrite).toBe(2 * 60 * 60 * 1_000 + 60_000);
    expect(afterRead).toBe(afterWrite - 1_000);
    expect(afterInvalidation).toBe(afterRead);
  });

  it("keeps one shared watermark alive for the longest outstanding tracked value", async () => {
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
    const afterLongWrite = redis.ttlMs(watermarkKey);
    vi.advanceTimersByTime(60 * 60 * 1_000);
    await dialcache.enable(async () => await getShortLived("123"));

    expect(afterLongWrite).toBe(2 * 60 * 60 * 1_000 + 60_000);
    expect(redis.ttlMs(watermarkKey)).toBe(afterLongWrite - 60 * 60 * 1_000);
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

  it("batches unique canonical invalidation targets through a batch-capable client", async () => {
    const invalidate = vi.fn(async () => undefined);
    const invalidateMany = vi.fn(async () => undefined);
    const redis: DialCacheRedisClient = {
      read: async () => null,
      write: async () => true,
      invalidate,
      invalidateMany,
    };
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({
      namespace: "batch:cache",
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });

    await dialcache.invalidateRemoteMany([
      { keyType: "user_id", id: 1 },
      { keyType: "user_id", id: "1" },
      { keyType: "user_id", id: 1n },
      { keyType: "account_id", id: "1" },
      { keyType: "user_id", id: "2" },
    ], 250);

    expect(invalidate).not.toHaveBeenCalled();
    expect(invalidateMany).toHaveBeenCalledOnce();
    expect(invalidateMany).toHaveBeenCalledWith([
      { watermarkKey: "{batch%3Acache:user_id:1}#watermark", futureBufferMs: 250 },
      { watermarkKey: "{batch%3Acache:account_id:1}#watermark", futureBufferMs: 250 },
      { watermarkKey: "{batch%3Acache:user_id:2}#watermark", futureBufferMs: 250 },
    ]);
    expect(metrics.events.filter(({ name }) => name === "invalidation")).toEqual([
      {
        name: "invalidation",
        labels: { cacheNamespace: "batch:cache", keyType: "user_id", layer: CacheLayer.REMOTE },
      },
      {
        name: "invalidation",
        labels: { cacheNamespace: "batch:cache", keyType: "account_id", layer: CacheLayer.REMOTE },
      },
      {
        name: "invalidation",
        labels: { cacheNamespace: "batch:cache", keyType: "user_id", layer: CacheLayer.REMOTE },
      },
    ]);
  });

  it("keeps scalar-only custom clients compatible and waits for every launched invalidation", async () => {
    const gate = deferred();
    const firstError = new Error("first invalidation failed");
    const invalidate = vi.fn(async ({ watermarkKey }: { readonly watermarkKey: string }) => {
      if (watermarkKey.includes(":first}")) {
        throw firstError;
      }
      await gate.promise;
    });
    const redis: DialCacheRedisClient = {
      read: async () => null,
      write: async () => true,
      invalidate,
    };
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });

    let settled = false;
    const operation = dialcache.invalidateRemoteMany([
      { keyType: "user_id", id: "first" },
      { keyType: "user_id", id: "second" },
    ]).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await expect(operation).rejects.toBe(firstError);
    expect(settled).toBe(true);
  });

  it("aggregates multiple scalar fallback failures in target order", async () => {
    const errors = [new Error("first"), new Error("second")];
    let call = 0;
    const redis: DialCacheRedisClient = {
      read: async () => null,
      write: async () => true,
      invalidate: async () => {
        throw errors[call++]!;
      },
    };
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });

    let rejection: unknown;
    try {
      await dialcache.invalidateRemoteMany([
        { keyType: "user_id", id: "first" },
        { keyType: "user_id", id: "second" },
      ]);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual(errors);
  });

  it("validates the whole batch before dispatch and treats an empty batch as a no-op", async () => {
    const invalidate = vi.fn(async () => undefined);
    const invalidateMany = vi.fn(async () => undefined);
    const redis: DialCacheRedisClient = {
      read: async () => null,
      write: async () => true,
      invalidate,
      invalidateMany,
    };
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 }, metrics });

    await dialcache.invalidateRemoteMany([]);
    await expect(dialcache.invalidateRemoteMany([], -1)).rejects.toThrow("futureBufferMs");
    await expect(dialcache.invalidateRemoteMany([
      { keyType: "user_id", id: "valid" },
      { keyType: "user_id", id: "{invalid}" },
    ])).rejects.toThrow(/hash tag/);

    expect(invalidate).not.toHaveBeenCalled();
    expect(invalidateMany).not.toHaveBeenCalled();
    expect(metrics.events.filter(({ name }) => name === "invalidation")).toHaveLength(2);
  });

  it("logs batch failure once and records each distinct targeted key type", async () => {
    const batchError = new Error("batch failed");
    const redis: DialCacheRedisClient = {
      read: async () => null,
      write: async () => true,
      invalidate: async () => undefined,
      invalidateMany: async () => {
        throw batchError;
      },
    };
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 }, logger, metrics });

    await expect(dialcache.invalidateRemoteMany([
      { keyType: "user_id", id: "1" },
      { keyType: "user_id", id: "2" },
      { keyType: "account_id", id: "1" },
    ])).rejects.toBe(batchError);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("Error writing DialCache invalidation watermarks", batchError);
    expect(metrics.events.filter(({ name }) => name === "error")).toEqual([
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
      {
        name: "error",
        labels: {
          cacheNamespace: "urn",
          useCase: "watermark",
          keyType: "account_id",
          layer: CacheLayer.REMOTE,
          error: "invalidation",
          inFallback: false,
        },
      },
    ]);
  });

  it("refreshes multiple tracked identities after one public batch call", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    const versions = new Map([["1", 1], ["2", 1]]);
    const getUser = dialcache.cached(async (id: string) => ({ id, version: versions.get(id)! }), {
      keyType: "user_id",
      useCase: "BatchRefreshUsers",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    await dialcache.enable(async () => await Promise.all([getUser("1"), getUser("2")]));
    versions.set("1", 2);
    versions.set("2", 2);
    await dialcache.invalidateRemoteMany([
      { keyType: "user_id", id: "1" },
      { keyType: "user_id", id: "2" },
    ]);
    vi.advanceTimersByTime(1);

    await expect(dialcache.enable(async () => await Promise.all([getUser("1"), getUser("2")]))).resolves.toEqual([
      { id: "1", version: 2 },
      { id: "2", version: 2 },
    ]);
  });

  it("rejects invalid future buffers before calling Redis", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });

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
  });

  it("accepts the maximum TTL across local, Redis, and tracked-watermark storage", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
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

    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(redis.mGetCalls).toBe(1);
    expect(redis.ttlMs(valueKey("MaximumSupportedTtl"))).toBe(MAX_SUPPORTED_DURATION_MS);
    expect(redis.ttlMs(watermarkKey)).toBe(
      MAX_SUPPORTED_DURATION_MS + WATERMARK_TTL_MARGIN_MS,
    );
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
      MAX_SUPPORTED_DURATION_MS + WATERMARK_TTL_MARGIN_MS,
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

  it("documents that Redis invalidation does not evict local cache", async () => {
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
    version = 2;
    await dialcache.invalidateRemote("user_id", "123");
    const after = await dialcache.enable(async () => await getUser("123"));

    expect(before).toEqual({ userId: "123", version: 1 });
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

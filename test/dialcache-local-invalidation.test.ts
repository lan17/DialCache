import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  type DialCacheInvalidationCoordinator,
  type DialCacheInvalidationCoordinatorListener,
  type DialCacheMetricsAdapter,
  type RedisConfig,
  type Serializer,
} from "../src/index.js";
import { InvalidationCoordinator } from "../src/internal/invalidation-coordinator.js";
import { FakeRedis } from "./fake-redis.js";

const localOnly = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.LOCAL]: 60 },
  ramp: { [CacheLayer.LOCAL]: 100 },
});
const remoteOnly = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});
const localAndRemote = DialCacheKeyConfig.enabled(60);
const watermarkKey = "{urn:user_id:123}#watermark";

describe("coordinated tracked process-local invalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const clockOriginMs = Date.parse("2026-07-29T00:00:00.000Z");
    vi.setSystemTime(new Date(clockOriginMs));
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - clockOriginMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts one identity across instances, use cases, and args without touching neighbors", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const first = coordinatedCache(redis, coordinator);
    const second = coordinatedCache(redis, coordinator);
    let version = 1;
    const profile = first.cached(async (id: string, locale: string) => ({ id, locale, version }), {
      keyType: "user_id",
      useCase: "CoordinatedProfile",
      cacheKey: (id, locale) => ({ id, args: { locale } }),
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });
    const permissions = first.cached(async (id: string) => ({ id, version }), {
      keyType: "user_id",
      useCase: "CoordinatedPermissions",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });
    const peerProfile = second.cached(async (id: string) => ({ id, version }), {
      keyType: "user_id",
      useCase: "CoordinatedPeerProfile",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });
    const adjacent = first.cached(async (id: string) => ({ id, version }), {
      keyType: "user_id",
      useCase: "CoordinatedAdjacent",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });
    const untracked = first.cached(async (id: string) => ({ id, version }), {
      keyType: "user_id",
      useCase: "CoordinatedUntracked",
      cacheKey: (id) => id,
      defaultConfig: localOnly,
    });

    await first.enable(async () => {
      await profile("123", "en");
      await profile("123", "fr");
      await permissions("123");
      await adjacent("1234");
      await untracked("123");
    });
    await second.enable(async () => await peerProfile("123"));

    version = 2;
    await first.invalidateRemote("user_id", "123");

    await expect(first.enable(async () => profile("123", "en"))).resolves.toMatchObject({
      version: 2,
    });
    await expect(first.enable(async () => profile("123", "fr"))).resolves.toMatchObject({
      version: 2,
    });
    await expect(first.enable(async () => permissions("123"))).resolves.toMatchObject({
      version: 2,
    });
    await expect(second.enable(async () => peerProfile("123"))).resolves.toMatchObject({
      version: 2,
    });
    await expect(first.enable(async () => adjacent("1234"))).resolves.toMatchObject({
      version: 1,
    });
    await expect(first.enable(async () => untracked("123"))).resolves.toMatchObject({
      version: 1,
    });
  });

  it("applies provisional eviction synchronously before Redis completes", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const cache = coordinatedCache(redis, coordinator);
    const gate = deferred<void>();
    redis.coordinatedInvalidationGate = gate.promise;
    let version = 1;
    let calls = 0;
    const load = cache.cached(async (id: string) => ({ id, version, call: ++calls }), {
      keyType: "user_id",
      useCase: "ProvisionalOriginEviction",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });
    await cache.enable(async () => await load("123"));

    version = 2;
    const invalidation = cache.invalidateRemote("user_id", "123", 1_000);
    expect(redis.coordinatedInvalidations).toHaveLength(1);

    await expect(cache.enable(async () => await load("123"))).resolves.toMatchObject({
      version: 2,
      call: 2,
    });
    await expect(cache.enable(async () => await load("123"))).resolves.toMatchObject({
      version: 2,
      call: 3,
    });

    gate.resolve();
    await invalidation;
  });

  it("uses the furthest effective Redis watermark rather than the shorter request", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const cache = coordinatedCache(redis, coordinator);
    let version = 1;
    let calls = 0;
    const load = cache.cached(async (id: string) => ({ id, version, call: ++calls }), {
      keyType: "user_id",
      useCase: "EffectiveLocalFence",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });
    await cache.enable(async () => await load("123"));
    await redis.invalidate({ watermarkKey, futureBufferMs: 5_000 });

    vi.advanceTimersByTime(100);
    version = 2;
    await cache.invalidateRemote("user_id", "123", 100);
    vi.advanceTimersByTime(200);

    await cache.enable(async () => await load("123"));
    await cache.enable(async () => await load("123"));
    expect(calls).toBe(3);

    vi.advanceTimersByTime(4_701);
    await cache.enable(async () => await load("123"));
    await cache.enable(async () => await load("123"));
    expect(calls).toBe(4);
  });

  it("preserves process-flight results while suppressing stale publication", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const cache = coordinatedCache(redis, coordinator);
    const started = deferred<void>();
    const release = deferred<void>();
    let version = 1;
    let calls = 0;
    const load = cache.cached(async (id: string) => {
      calls += 1;
      const observedVersion = version;
      started.resolve();
      await release.promise;
      return { id, observedVersion, call: calls };
    }, {
      keyType: "user_id",
      useCase: "CoordinatedProcessFlight",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });

    const leader = cache.enable(async () => await load("123"));
    await started.promise;
    version = 2;
    await cache.invalidateRemote("user_id", "123", 1_000);
    const follower = cache.enable(async () => await load("123"));
    release.resolve();

    const [leaderValue, followerValue] = await Promise.all([leader, follower]);
    expect(followerValue).toBe(leaderValue);
    expect(leaderValue.observedVersion).toBe(1);
    expect(calls).toBe(1);

    await expect(cache.enable(async () => await load("123"))).resolves.toMatchObject({
      observedVersion: 2,
      call: 2,
    });
  });

  it("blocks a late Redis-hit promotion after an invalidation event", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const writer = coordinatedCache(redis, coordinator);
    let version = 1;
    const write = writer.cached(async (id: string) => ({ id, version, fallback: 0 }), {
      keyType: "user_id",
      useCase: "LateRedisPromotion",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });
    await writer.enable(async () => await write("123"));

    const loadStarted = deferred<void>();
    const releaseLoad = deferred<void>();
    const serializer: Serializer<{ id: string; version: number; fallback: number }> = {
      dump: JSON.stringify,
      load: async (payload) => {
        const parsed = JSON.parse(Buffer.isBuffer(payload) ? payload.toString() : payload) as {
          id: string;
          version: number;
          fallback: number;
        };
        loadStarted.resolve();
        await releaseLoad.promise;
        return parsed;
      },
    };
    const reader = coordinatedCache(redis, coordinator);
    let fallbackCalls = 0;
    const read = reader.cached(async (id: string) => ({ id, version, fallback: ++fallbackCalls }), {
      keyType: "user_id",
      useCase: "LateRedisPromotion",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localAndRemote,
      serializer,
    });

    const pending = reader.enable(async () => await read("123"));
    await loadStarted.promise;
    version = 2;
    await writer.invalidateRemote("user_id", "123", 1_000);
    releaseLoad.resolve();
    await expect(pending).resolves.toEqual({ id: "123", version: 1, fallback: 0 });

    await expect(reader.enable(async () => await read("123"))).resolves.toMatchObject({
      version: 2,
      fallback: 1,
    });
    await expect(reader.enable(async () => await read("123"))).resolves.toMatchObject({
      fallback: 2,
    });
  });

  it("rejects old-epoch publication across detected disconnect and recovery", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const cache = coordinatedCache(redis, coordinator);
    const started = deferred<void>();
    const release = deferred<void>();
    let version = 1;
    let calls = 0;
    const load = cache.cached(async (id: string) => {
      calls += 1;
      const observedVersion = version;
      started.resolve();
      await release.promise;
      return { id, observedVersion, call: calls };
    }, {
      keyType: "user_id",
      useCase: "HealthEpochPublication",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });

    const pending = cache.enable(async () => await load("123"));
    await started.promise;
    version = 2;
    coordinator.unavailable(new Error("connection lost"));
    coordinator.ready();
    release.resolve();
    await pending;

    await cache.enable(async () => await load("123"));
    await cache.enable(async () => await load("123"));
    expect(calls).toBe(2);
  });

  it("keeps provisional eviction and fencing when coordinated publication fails", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const cache = coordinatedCache(redis, coordinator);
    let version = 1;
    let calls = 0;
    const load = cache.cached(async (id: string) => ({ id, version, call: ++calls }), {
      keyType: "user_id",
      useCase: "FailedCoordinatedInvalidation",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });
    await cache.enable(async () => await load("123"));
    version = 2;
    redis.failSet = true;

    await expect(cache.invalidateRemote("user_id", "123", 1_000)).rejects.toThrow(
      "redis set failed",
    );
    await cache.enable(async () => await load("123"));
    await cache.enable(async () => await load("123"));
    expect(calls).toBe(3);
  });

  it("keeps request-local snapshot semantics while refreshing the next request", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const cache = coordinatedCache(redis, coordinator);
    let version = 1;
    const load = cache.cached(async (id: string) => ({ id, version }), {
      keyType: "user_id",
      useCase: "CoordinatedRequestSnapshot",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: new DialCacheKeyConfig({
        requestLocal: true,
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });

    const sameRequest = await cache.enable(async () => {
      const before = await load("123");
      version = 2;
      await cache.invalidateRemote("user_id", "123");
      const after = await load("123");
      return { before, after };
    });
    const nextRequest = await cache.enable(async () => await load("123"));

    expect(sameRequest.after).toBe(sameRequest.before);
    expect(nextRequest.version).toBe(2);
  });

  it("suppresses coordinated local storage until initial readiness", async () => {
    const redis = new FakeRedis();
    const coordinator = new InvalidationCoordinator("urn");
    const cache = coordinatedCache(redis, coordinator);
    let calls = 0;
    const load = cache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "InitialCoordinationHealth",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });

    await cache.enable(async () => await load("123"));
    await cache.enable(async () => await load("123"));
    expect(calls).toBe(2);

    coordinator.ready();
    await cache.enable(async () => await load("123"));
    await cache.enable(async () => await load("123"));
    expect(calls).toBe(3);
  });

  it("permanently disables coordinated local storage when an instance is disposed", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const cache = coordinatedCache(redis, coordinator);
    let calls = 0;
    const load = cache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "DisposedCoordination",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });

    await cache.enable(async () => await load("123"));
    cache.dispose();
    cache.dispose();
    await cache.enable(async () => await load("123"));
    await cache.enable(async () => await load("123"));

    expect(calls).toBe(3);
  });

  it("establishes terminal local safety before invoking coordinator cleanup", async () => {
    const redis = new FakeRedis();
    let attachedListener: DialCacheInvalidationCoordinatorListener | undefined;
    const coordinator: DialCacheInvalidationCoordinator = {
      namespace: "urn",
      state: "ready",
      addListener(listener) {
        attachedListener = listener;
        listener.onStateChange("ready");
        return () => {
          throw new Error("listener removal failed");
        };
      },
      invalidate(invalidation) {
        attachedListener?.onInvalidation(invalidation);
      },
    };
    const cache = coordinatedCache(redis, coordinator);
    let calls = 0;
    const load = cache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "ThrowingCoordinationCleanup",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });

    await cache.enable(async () => await load("123"));
    expect(() => cache.dispose()).toThrow("listener removal failed");
    attachedListener?.onStateChange("ready");
    attachedListener?.onInvalidation({
      namespace: "urn",
      keyType: "user_id",
      id: "123",
      remainingMs: 1_000,
      source: "event",
    });
    await cache.enable(async () => await load("123"));
    await cache.enable(async () => await load("123"));

    expect(calls).toBe(3);
  });

  it("records bounded local applications and isolates logger/metrics failures", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const invalidation = vi.fn(() => {
      throw new Error("metrics failed");
    });
    const metrics = metricsAdapter({ invalidation });
    const logger = {
      debug: vi.fn(() => {
        throw new Error("logger failed");
      }),
      warn: vi.fn(() => {
        throw new Error("logger failed");
      }),
      error: vi.fn(),
    };
    const cache = coordinatedCache(redis, coordinator, { metrics, logger });

    await expect(cache.invalidateRemote("user_id", "123", 100)).resolves.toBeUndefined();
    expect(invalidation).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
    });
    expect(invalidation).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      keyType: "user_id",
      layer: CacheLayer.LOCAL,
    });

    expect(() => coordinator.unavailable(new Error("subscriber failed"))).not.toThrow();
    expect(() => coordinator.ready()).not.toThrow();
  });

  it("rejects invalid caller identity without degrading coordination or evicting local values", async () => {
    const redis = new FakeRedis();
    const coordinator = readyCoordinator();
    const cache = coordinatedCache(redis, coordinator);
    let calls = 0;
    const load = cache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "InvalidCallerIdentity",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });

    await cache.enable(async () => await load("safe"));
    await expect(cache.invalidateRemote("user_id", "bad{id", 100)).rejects.toThrow(/braces/);

    expect(coordinator.state).toBe("ready");
    await cache.enable(async () => await load("safe"));
    expect(calls).toBe(1);
  });

  it("fails the affected instance unavailable on an invalid custom-coordinator signal", async () => {
    const redis = new FakeRedis();
    let attachedListener: DialCacheInvalidationCoordinatorListener | undefined;
    const coordinator: DialCacheInvalidationCoordinator = {
      namespace: "urn",
      state: "ready",
      addListener(listener) {
        attachedListener = listener;
        listener.onStateChange("ready");
        return () => undefined;
      },
      invalidate(invalidation) {
        attachedListener?.onInvalidation(invalidation);
      },
    };
    const cache = coordinatedCache(redis, coordinator);
    let calls = 0;
    const load = cache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "InvalidCustomSignal",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnly,
    });

    await cache.enable(async () => await load("123"));
    attachedListener?.onInvalidation({
      namespace: "urn",
      keyType: "user_id",
      id: "123",
      remainingMs: Number.NaN,
      source: "event",
    });
    await cache.enable(async () => await load("123"));
    await cache.enable(async () => await load("123"));

    expect(calls).toBe(3);
  });

  it("validates coordinator namespace and coordinated client capability at construction", () => {
    const redis = new FakeRedis();
    const wrongNamespace = new InvalidationCoordinator("other");
    expect(() => new DialCache({
      namespace: "urn",
      redis: { client: redis, coordinator: wrongNamespace },
    })).toThrow(/namespace must match/);

    const legacyClient = {
      read: async () => null,
      write: async () => true,
      invalidate: async () => undefined,
    };
    expect(() => new DialCache({
      redis: {
        client: legacyClient,
        coordinator: readyCoordinator(),
      } as unknown as RedisConfig,
    })).toThrow(/supports invalidateAndPublish/);

    expect(() => new DialCache({
      redis: {
        client: redis,
        coordinator: null,
      } as unknown as RedisConfig,
    })).toThrow(/coordinator must be an object/);
  });
});

function readyCoordinator(): InvalidationCoordinator {
  const coordinator = new InvalidationCoordinator("urn");
  coordinator.ready();
  return coordinator;
}

function coordinatedCache(
  redis: FakeRedis,
  coordinator: DialCacheInvalidationCoordinator,
  options: {
    readonly metrics?: DialCacheMetricsAdapter;
    readonly logger?: Pick<Console, "debug" | "warn" | "error">;
  } = {},
): DialCache {
  return new DialCache({
    redis: { client: redis, coordinator, readTimeoutMs: 1_000 },
    ...options,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function metricsAdapter(
  overrides: Partial<DialCacheMetricsAdapter> = {},
): DialCacheMetricsAdapter {
  return {
    request: vi.fn(),
    miss: vi.fn(),
    disabled: vi.fn(),
    error: vi.fn(),
    invalidation: vi.fn(),
    observeGet: vi.fn(),
    observeFallback: vi.fn(),
    observeSerialization: vi.fn(),
    observeSize: vi.fn(),
    ...overrides,
  };
}

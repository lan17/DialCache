import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheError,
  DialCacheKeyConfig,
  RedisReadTimeoutError,
  type CachedOptions,
  type DecodedRedisFrame,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type RedisConfig,
  type RedisReadContext,
} from "../src/index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const remoteConfig = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

const localAndRemoteConfig = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
});

function metricsWithError(error: DialCacheMetricsAdapter["error"]): DialCacheMetricsAdapter {
  return {
    request: vi.fn(),
    miss: vi.fn(),
    disabled: vi.fn(),
    error,
    invalidation: vi.fn(),
    observeGet: vi.fn(),
    observeFallback: vi.fn(),
    observeSerialization: vi.fn(),
    observeSize: vi.fn(),
  };
}

function redisClient(read: DialCacheRedisClient["read"]): {
  readonly client: DialCacheRedisClient;
  readonly read: ReturnType<typeof vi.fn<DialCacheRedisClient["read"]>>;
  readonly write: ReturnType<typeof vi.fn<DialCacheRedisClient["write"]>>;
} {
  const readMock = vi.fn<DialCacheRedisClient["read"]>(read);
  const write = vi.fn<DialCacheRedisClient["write"]>(async () => true);
  return {
    client: {
      enforcesMaxAge: true,
      read: readMock,
      write,
      invalidate: async () => undefined,
    },
    read: readMock,
    write,
  };
}

function useFakeTimersWithMonotonicClock(): void {
  vi.useFakeTimers();
  const clockOriginMs = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - clockOriginMs);
}

describe("DialCache Redis read deadlines", () => {
  beforeEach(() => {
    useFakeTimersWithMonotonicClock();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the library default and resolves instance, static, and runtime precedence", async () => {
    const contexts: RedisReadContext[] = [];
    const redis = redisClient(async (_request, context) => {
      if (context === undefined) {
        throw new Error("missing read context");
      }
      contexts.push(context);
      return null;
    });
    const libraryDefault = new DialCache({ redis: { client: redis.client } });
    const defaulted = libraryDefault.cached(async () => "defaulted", {
      keyType: "id",
      useCase: "DefaultRedisReadDeadline",
      cacheKey: () => "0",
      defaultConfig: remoteConfig,
    });

    let runtimeTimeoutMs = 25;
    const dialcache = new DialCache({
      redis: { client: redis.client, readTimeoutMs: 100 },
      cacheConfigProvider: (key) => key.useCase === "RuntimeRedisReadDeadline"
        ? new DialCacheKeyConfig({ remoteReadTimeoutMs: runtimeTimeoutMs })
        : null,
    });
    const inherited = dialcache.cached(async () => "inherited", {
      keyType: "id",
      useCase: "InheritedRedisReadDeadline",
      cacheKey: () => "1",
      defaultConfig: remoteConfig,
    });
    const staticallyOverridden = dialcache.cached(async () => "static", {
      keyType: "id",
      useCase: "StaticRedisReadDeadline",
      cacheKey: () => "2",
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
        remoteReadTimeoutMs: 75,
      }),
    });
    const runtimeOverridden = dialcache.cached(async () => "runtime", {
      keyType: "id",
      useCase: "RuntimeRedisReadDeadline",
      cacheKey: () => "3",
      defaultConfig: remoteConfig,
    });

    await expect(libraryDefault.enable(async () => await defaulted())).resolves.toBe("defaulted");
    await expect(dialcache.enable(async () => await inherited())).resolves.toBe("inherited");
    await expect(dialcache.enable(async () => await staticallyOverridden())).resolves.toBe("static");
    await expect(dialcache.enable(async () => await runtimeOverridden())).resolves.toBe("runtime");
    runtimeTimeoutMs = 30;
    await expect(dialcache.enable(async () => await runtimeOverridden())).resolves.toBe("runtime");

    expect(contexts.map(({ timeoutMs }) => timeoutMs)).toEqual([50, 100, 75, 25, 30]);
    expect(contexts.every(({ signal }) => signal.aborted === false)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts an omitted instance default and rejects invalid explicit values", () => {
    const client = redisClient(async () => null).client;
    expect(() => new DialCache({ redis: { client } })).not.toThrow();

    const invalidValues: readonly unknown[] = [
      null,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      2_147_483_648,
      "100",
    ];
    for (const readTimeoutMs of invalidValues) {
      expect(
        () => new DialCache({
          redis: { client, readTimeoutMs } as unknown as RedisConfig,
        }),
      ).toThrow(
        new RangeError(
          "Redis readTimeoutMs must be a positive safe integer no greater than 2147483647",
        ),
      );
    }
    expect(
      () => new DialCache({ redis: { client, readTimeoutMs: 2_147_483_647 } }),
    ).not.toThrow();
  });

  it("rejects legacy semantic clients that do not attest max-age enforcement", () => {
    const legacyClient = {
      read: async () => null,
      write: async () => true,
      invalidate: async () => undefined,
    };

    expect(
      () => new DialCache({
        redis: { client: legacyClient as unknown as DialCacheRedisClient },
      }),
    ).toThrow(new TypeError("DialCache Redis client must declare enforcesMaxAge: true"));
  });

  it("rejects invalid static use-case overrides before reserving the use-case name", () => {
    const client = redisClient(async () => null).client;
    const invalidValues: readonly unknown[] = [
      null,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      2_147_483_648,
      "100",
    ];

    for (const [index, remoteReadTimeoutMs] of invalidValues.entries()) {
      const useCase = `InvalidRedisReadDeadline${index}`;
      const options = {
        keyType: "id",
        useCase,
        cacheKey: () => String(index),
        defaultConfig: {
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 100 },
          remoteReadTimeoutMs,
        },
      } as unknown as CachedOptions<() => Promise<string>>;
      const dialcache = new DialCache({ redis: { client, readTimeoutMs: 100 } });

      expect(() => dialcache.cached(async () => "value", options)).toThrow(
        new RangeError(
          "DialCache remoteReadTimeoutMs must be a positive safe integer no greater than 2147483647",
        ),
      );
      expect(
        () => dialcache.cached(async () => "value", {
          ...options,
          defaultConfig: new DialCacheKeyConfig({ remoteReadTimeoutMs: 10 }),
        }),
      ).not.toThrow();
    }

    const dialcache = new DialCache({ redis: { client, readTimeoutMs: 100 } });
    expect(
      () => dialcache.cached(async () => "value", {
        keyType: "id",
        useCase: "MaximumRedisReadDeadline",
        cacheKey: () => "max",
        defaultConfig: new DialCacheKeyConfig({ remoteReadTimeoutMs: 2_147_483_647 }),
      }),
    ).not.toThrow();
  });

  it("fails open before Redis when an explicit runtime timeout is invalid", async () => {
    const redis = redisClient(async () => null);
    const error = vi.fn<DialCacheMetricsAdapter["error"]>();
    const metrics = metricsWithError(error);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({
      redis: { client: redis.client },
      cacheConfigProvider: () => ({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
        remoteReadTimeoutMs: null,
      }) as unknown as DialCacheKeyConfig,
      metrics,
      logger,
    });
    const load = dialcache.cached(async () => "source", {
      keyType: "id",
      useCase: "InvalidRuntimeRedisReadDeadline",
      cacheKey: () => "1",
      defaultConfig: remoteConfig,
    });

    await expect(dialcache.enable(async () => await load())).resolves.toBe("source");

    expect(redis.read).not.toHaveBeenCalled();
    expect(redis.write).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("Could not resolve DialCache key config", expect.any(RangeError));
    expect(error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "InvalidRuntimeRedisReadDeadline",
      keyType: "id",
      layer: "noop",
      error: "config_resolution",
      inFallback: false,
    });
    expect(metrics.disabled).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "InvalidRuntimeRedisReadDeadline",
      keyType: "id",
      layer: "noop",
      reason: "config_error",
    });
  });

  it.each(["return", "throw"] as const)(
    "classifies a synchronous over-deadline read %s as a timeout",
    async (settlement) => {
      let elapsedMs = 0;
      vi.mocked(performance.now).mockImplementation(() => elapsedMs);
      const redis = redisClient(() => {
        elapsedMs = 10;
        if (settlement === "throw") {
          throw new Error("late synchronous Redis failure");
        }
        return null;
      });
      const error = vi.fn<DialCacheMetricsAdapter["error"]>();
      const metrics = metricsWithError(error);
      const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const dialcache = new DialCache({
        redis: { client: redis.client, readTimeoutMs: 5 },
        metrics,
        logger,
      });
      const load = dialcache.cached(async () => "source", {
        keyType: "id",
        useCase: `SynchronousRedisRead${settlement}`,
        cacheKey: () => "1",
        defaultConfig: remoteConfig,
      });

      await expect(dialcache.enable(async () => await load())).resolves.toBe("source");

      expect(redis.write).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith({
        cacheNamespace: "urn",
        useCase: `SynchronousRedisRead${settlement}`,
        keyType: "id",
        layer: CacheLayer.REMOTE,
        error: "cache_read_timeout",
        inFallback: false,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "Error getting value from Redis cache",
        expect.any(RedisReadTimeoutError),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cleans up the read timer after hits and misses", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const redis = redisClient(
      vi.fn()
        .mockResolvedValueOnce({ payload: JSON.stringify({ source: "redis" }), createdAtMs: Date.now() })
        .mockResolvedValueOnce(null),
    );
    const dialcache = new DialCache({ redis: { client: redis.client, readTimeoutMs: 100 } });
    const hit = dialcache.cached(async () => ({ source: "fallback" }), {
      keyType: "id",
      useCase: "RedisReadDeadlineHit",
      cacheKey: () => "1",
      defaultConfig: remoteConfig,
    });
    const miss = dialcache.cached(async () => ({ source: "fallback" }), {
      keyType: "id",
      useCase: "RedisReadDeadlineMiss",
      cacheKey: () => "2",
      defaultConfig: remoteConfig,
    });

    await expect(dialcache.enable(async () => await hit())).resolves.toEqual({ source: "redis" });
    expect(vi.getTimerCount()).toBe(0);
    await expect(dialcache.enable(async () => await miss())).resolves.toEqual({ source: "fallback" });

    expect(redis.read).toHaveBeenCalledTimes(2);
    expect(redis.write).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out one shared leader, aborts cooperatively, and fails open once", async () => {
    const readStarted = deferred<void>();
    const contexts: RedisReadContext[] = [];
    const redis = redisClient(async (_request, context) => {
      if (context === undefined) {
        throw new Error("missing read context");
      }
      contexts.push(context);
      readStarted.resolve();
      return await new Promise<null>(() => undefined);
    });
    const error = vi.fn<DialCacheMetricsAdapter["error"]>();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const metrics = metricsWithError(error);
    const dialcache = new DialCache({
      redis: { client: redis.client, readTimeoutMs: 10 },
      metrics,
      logger,
    });
    const fallback = vi.fn(async () => {
      expect(contexts[0]?.signal.aborted).toBe(true);
      return { source: "fallback" };
    });
    const load = dialcache.cached(fallback, {
      keyType: "id",
      useCase: "SharedRedisReadDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 100,
      defaultConfig: remoteConfig,
    });

    const result = dialcache.enable(async () =>
      await Promise.all([load(), load(), load()]),
    );
    await readStarted.promise;

    expect(redis.read).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect((setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout).hasRef()).toBe(true);
    expect(dialcache.getCoalescingState().process).toMatchObject({
      activeLeaders: 1,
      activeFollowers: 2,
    });

    await vi.advanceTimersByTimeAsync(9);
    expect(fallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual([
      { source: "fallback" },
      { source: "fallback" },
      { source: "fallback" },
    ]);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(redis.write).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const timeout = logger.warn.mock.calls[0]?.[1];
    expect(timeout).toBeInstanceOf(RedisReadTimeoutError);
    expect(timeout).toBeInstanceOf(DialCacheError);
    expect(timeout).toMatchObject({
      useCase: "SharedRedisReadDeadline",
      timeoutMs: 10,
    });
    expect(String((timeout as Error).message)).not.toContain("123");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "SharedRedisReadDeadline",
      keyType: "id",
      layer: CacheLayer.REMOTE,
      error: "cache_read_timeout",
      inFallback: false,
    });
    expect(metrics.request).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "SharedRedisReadDeadline",
      keyType: "id",
      layer: CacheLayer.REMOTE,
    });
    expect(metrics.observeGet).toHaveBeenCalledOnce();
    expect(metrics.observeGet).toHaveBeenCalledWith(
      {
        cacheNamespace: "urn",
        useCase: "SharedRedisReadDeadline",
        keyType: "id",
        layer: CacheLayer.REMOTE,
      },
      0.01,
    );
    expect(metrics.disabled).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "config_error" }),
    );
    expect(dialcache.getCoalescingState().process).toEqual({
      activeLeaders: 0,
      activeFollowers: 0,
      oldestLeaderAgeMs: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cached", "getOrLoad"] as const)(
    "applies runtime remote-read deadlines to %s",
    async (api) => {
      const contexts: RedisReadContext[] = [];
      const redis = redisClient(async (_request, context) => {
        if (context === undefined) {
          throw new Error("missing read context");
        }
        contexts.push(context);
        return await new Promise<null>(() => undefined);
      });
      const dialcache = new DialCache({
        redis: { client: redis.client, readTimeoutMs: 100 },
        cacheConfigProvider: () => new DialCacheKeyConfig({ remoteReadTimeoutMs: 10 }),
        logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const operation = api === "cached"
        ? dialcache.cached(async () => "source", {
            keyType: "id",
            useCase: "CachedRuntimeRedisReadDeadline",
            cacheKey: () => "123",
            defaultConfig: remoteConfig,
          })
        : async () => await dialcache.getOrLoad(
            async () => "source",
            {
              keyType: "id",
              useCase: "InlineRuntimeRedisReadDeadline",
              key: "123",
              defaultConfig: remoteConfig,
            },
          );

      const result = dialcache.enable(operation);
      await vi.advanceTimersByTimeAsync(10);

      await expect(result).resolves.toBe("source");
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({ timeoutMs: 10 });
      expect(contexts[0]?.signal.aborted).toBe(true);
      expect(redis.write).not.toHaveBeenCalled();
    },
  );

  it("gives a late process follower only the leader's remaining read budget", async () => {
    const readStarted = deferred<void>();
    const redis = redisClient(async () => {
      readStarted.resolve();
      return await new Promise<null>(() => undefined);
    });
    const dialcache = new DialCache({ redis: { client: redis.client, readTimeoutMs: 10 } });
    const fallback = vi.fn(async () => "fallback");
    const load = dialcache.cached(fallback, {
      keyType: "id",
      useCase: "LateRedisReadFollower",
      cacheKey: () => "123",
      defaultConfig: remoteConfig,
    });

    const first = dialcache.enable(async () => await load());
    await readStarted.promise;
    await vi.advanceTimersByTimeAsync(7);
    const second = dialcache.enable(async () => await load());
    await vi.advanceTimersByTimeAsync(0);

    expect(redis.read).toHaveBeenCalledTimes(1);
    expect(dialcache.getCoalescingState().process.activeFollowers).toBe(1);

    await vi.advanceTimersByTimeAsync(3);
    await expect(Promise.all([first, second])).resolves.toEqual(["fallback", "fallback"]);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("gives each caller its own full read budget when coalescing is disabled", async () => {
    const readStarted = deferred<void>();
    const redis = redisClient(async () => {
      readStarted.resolve();
      return await new Promise<null>(() => undefined);
    });
    const dialcache = new DialCache({ redis: { client: redis.client, readTimeoutMs: 10 } });
    const fallback = vi.fn(async () => "fallback");
    const load = dialcache.cached(fallback, {
      keyType: "id",
      useCase: "UncoalescedRedisReadBudget",
      cacheKey: () => "123",
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
        coalesce: false,
      }),
    });

    const first = dialcache.enable(async () => await load());
    await readStarted.promise;
    await vi.advanceTimersByTimeAsync(7);
    const second = dialcache.enable(async () => await load());
    await vi.advanceTimersByTimeAsync(0);

    expect(redis.read).toHaveBeenCalledTimes(2);
    expect(dialcache.getCoalescingState().process).toEqual({
      activeLeaders: 0,
      activeFollowers: 0,
      oldestLeaderAgeMs: null,
    });

    // The first read times out at t=10; the second, started at t=7 with its
    // own budget, is still waiting until t=17.
    await vi.advanceTimersByTimeAsync(3);
    await expect(first).resolves.toBe("fallback");
    expect(fallback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(7);
    await expect(second).resolves.toBe("fallback");
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("shares one read deadline with request-local followers", async () => {
    const readStarted = deferred<void>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const redis = redisClient(async () => {
      readStarted.resolve();
      return await new Promise<null>(() => undefined);
    });
    const dialcache = new DialCache({ redis: { client: redis.client, readTimeoutMs: 10 } });
    const fallback = vi.fn(async () => "fallback");
    const load = dialcache.cached(fallback, {
      keyType: "id",
      useCase: "RequestLocalRedisReadDeadline",
      cacheKey: () => "123",
      defaultConfig: new DialCacheKeyConfig({
        requestLocal: true,
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
      }),
    });

    const result = dialcache.enable(async () => await Promise.all([load(), load(), load()]));
    await readStarted.promise;

    expect(redis.read).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toEqual(["fallback", "fallback", "fallback"]);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it.each(["fulfillment", "rejection"] as const)(
    "consumes late read %s and lets a later invocation recover",
    async (settlement) => {
      const firstRead = deferred<DecodedRedisFrame | null>();
      let readCalls = 0;
      const redis = redisClient(async () => {
        readCalls += 1;
        return readCalls === 1
          ? await firstRead.promise
          : { payload: JSON.stringify({ source: "redis" }), createdAtMs: Date.now() };
      });
      const error = vi.fn<DialCacheMetricsAdapter["error"]>();
      const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const dialcache = new DialCache({
        redis: { client: redis.client, readTimeoutMs: 10 },
        metrics: metricsWithError(error),
        logger,
      });
      const fallback = vi.fn(async () => ({ source: "fallback" }));
      const load = dialcache.cached(fallback, {
        keyType: "id",
        useCase: `LateRedisRead${settlement}`,
        cacheKey: () => "123",
        defaultConfig: remoteConfig,
      });

      const first = dialcache.enable(async () => await load());
      await vi.advanceTimersByTimeAsync(10);
      await expect(first).resolves.toEqual({ source: "fallback" });
      await expect(dialcache.enable(async () => await load())).resolves.toEqual({ source: "redis" });

      if (settlement === "fulfillment") {
        firstRead.resolve({ payload: JSON.stringify({ source: "late" }), createdAtMs: Date.now() });
      } else {
        firstRead.reject(new Error("late Redis failure"));
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.read).toHaveBeenCalledTimes(2);
      expect(redis.write).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { failure: "exception", tracked: false, expectedReadCalls: 1, expectedFallbackCalls: 1 },
    { failure: "exception", tracked: true, expectedReadCalls: 2, expectedFallbackCalls: 2 },
    { failure: "timeout", tracked: false, expectedReadCalls: 1, expectedFallbackCalls: 1 },
    { failure: "timeout", tracked: true, expectedReadCalls: 2, expectedFallbackCalls: 2 },
  ])(
    "skips Redis writes and applies safe local publication after a read $failure (tracked=$tracked)",
    async ({ failure, tracked, expectedReadCalls, expectedFallbackCalls }) => {
      const redis = redisClient(
        failure === "exception"
          ? async () => {
              throw new Error("Redis unavailable");
            }
          : async () => await new Promise<null>(() => undefined),
      );
      const dialcache = new DialCache({
        redis: { client: redis.client, readTimeoutMs: 10 },
        logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      let fallbackCalls = 0;
      const load = dialcache.cached(async () => ({ call: ++fallbackCalls }), {
        keyType: "id",
        useCase: tracked ? "TrackedReadFailure" : "UntrackedReadFailure",
        cacheKey: () => "123",
        trackForInvalidation: tracked,
        defaultConfig: localAndRemoteConfig,
      });

      const firstResult = dialcache.enable(async () => await load());
      if (failure === "timeout") {
        await vi.advanceTimersByTimeAsync(10);
      }
      const first = await firstResult;
      const secondResult = dialcache.enable(async () => await load());
      if (failure === "timeout" && tracked) {
        await vi.advanceTimersByTimeAsync(10);
      }
      const second = await secondResult;

      expect(first).toEqual({ call: 1 });
      expect(second).toEqual({ call: expectedFallbackCalls });
      expect(redis.read).toHaveBeenCalledTimes(expectedReadCalls);
      expect(redis.write).not.toHaveBeenCalled();
      expect(fallbackCalls).toBe(expectedFallbackCalls);
    },
  );

  it("allocates no read timer for disabled calls, ramped-out Redis, or local hits", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const redis = redisClient(async () => null);
    const dialcache = new DialCache({ redis: { client: redis.client, readTimeoutMs: 100 } });
    const disabled = dialcache.cached(async () => "disabled", {
      keyType: "id",
      useCase: "DisabledRedisReadDeadline",
      cacheKey: () => "disabled",
      defaultConfig: remoteConfig,
    });
    const rampedOut = dialcache.cached(async () => "ramped", {
      keyType: "id",
      useCase: "RampedOutRedisReadDeadline",
      cacheKey: () => "ramped",
      fallbackTimeoutMs: null,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 0 },
      }),
    });
    const localHit = dialcache.cached(async () => "local", {
      keyType: "id",
      useCase: "LocalHitRedisReadDeadline",
      cacheKey: () => "local",
      defaultConfig: localAndRemoteConfig,
    });

    await expect(disabled()).resolves.toBe("disabled");
    await expect(dialcache.enable(async () => await rampedOut())).resolves.toBe("ramped");
    expect(redis.read).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    await expect(dialcache.enable(async () => await localHit())).resolves.toBe("local");
    expect(redis.read).toHaveBeenCalledTimes(1);
    setTimeoutSpy.mockClear();
    await expect(dialcache.enable(async () => await localHit())).resolves.toBe("local");
    expect(redis.read).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

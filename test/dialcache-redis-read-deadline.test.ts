import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheError,
  DialCacheKeyConfig,
  RedisReadTimeoutError,
  type CachedOptions,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type RedisCachePayload,
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

  it("resolves the instance default and static per-use-case override at registration", async () => {
    const contexts: RedisReadContext[] = [];
    const redis = redisClient(async (_request, context) => {
      if (context === undefined) {
        throw new Error("missing read context");
      }
      contexts.push(context);
      return null;
    });
    const dialcache = new DialCache({ redis: { client: redis.client, readTimeoutMs: 100 } });
    const inherited = dialcache.cached(async () => "inherited", {
      keyType: "id",
      useCase: "InheritedRedisReadDeadline",
      cacheKey: () => "1",
      defaultConfig: remoteConfig,
    });
    const overriddenOptions = {
      keyType: "id",
      useCase: "OverriddenRedisReadDeadline",
      cacheKey: () => "2",
      redisReadTimeoutMs: 25,
      defaultConfig: remoteConfig,
    };
    const overridden = dialcache.cached(async () => "overridden", overriddenOptions);
    overriddenOptions.redisReadTimeoutMs = 50;

    await expect(dialcache.enable(async () => await inherited())).resolves.toBe("inherited");
    await expect(dialcache.enable(async () => await overridden())).resolves.toBe("overridden");

    expect(contexts.map(({ timeoutMs }) => timeoutMs)).toEqual([100, 25]);
    expect(contexts.every(({ signal }) => signal.aborted === false)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects missing and invalid instance defaults", () => {
    const client = redisClient(async () => null).client;
    expect(
      () => new DialCache({ redis: { client } as RedisConfig }),
    ).toThrow(new TypeError("Redis config requires readTimeoutMs"));

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

  it("rejects invalid use-case overrides before reserving the use-case name", () => {
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

    for (const [index, redisReadTimeoutMs] of invalidValues.entries()) {
      const useCase = `InvalidRedisReadDeadline${index}`;
      const options = {
        keyType: "id",
        useCase,
        cacheKey: () => String(index),
        redisReadTimeoutMs,
      } as unknown as CachedOptions<() => Promise<string>>;
      const dialcache = new DialCache({ redis: { client, readTimeoutMs: 100 } });

      expect(() => dialcache.cached(async () => "value", options)).toThrow(
        new RangeError(
          "DialCache redisReadTimeoutMs must be a positive safe integer no greater than 2147483647",
        ),
      );
      expect(
        () => dialcache.cached(async () => "value", { ...options, redisReadTimeoutMs: 10 }),
      ).not.toThrow();
    }

    const dialcache = new DialCache({ redis: { client, readTimeoutMs: 100 } });
    expect(
      () => dialcache.cached(async () => "value", {
        keyType: "id",
        useCase: "MaximumRedisReadDeadline",
        cacheKey: () => "max",
        redisReadTimeoutMs: 2_147_483_647,
      }),
    ).not.toThrow();
  });

  it("cleans up the read timer after hits and misses", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const redis = redisClient(
      vi.fn()
        .mockResolvedValueOnce(JSON.stringify({ source: "redis" }))
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
      error: "cache_read",
      inFallback: false,
    });
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
      const firstRead = deferred<RedisCachePayload | null>();
      let readCalls = 0;
      const redis = redisClient(async () => {
        readCalls += 1;
        return readCalls === 1
          ? await firstRead.promise
          : JSON.stringify({ source: "redis" });
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
        firstRead.resolve(JSON.stringify({ source: "late" }));
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

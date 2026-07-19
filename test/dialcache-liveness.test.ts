import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheError,
  DialCacheKeyConfig,
  FallbackTimeoutError,
  type CachedOptions,
  type DialCacheMetricsAdapter,
} from "../src/index.js";
import { FakeRedis } from "./fake-redis.js";

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

const localConfig = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.LOCAL]: 60 },
  ramp: { [CacheLayer.LOCAL]: 100 },
});

const remoteConfig = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
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

describe("DialCache fallback liveness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defaults to 60 seconds and shares the leader deadline with process followers", async () => {
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const gate = deferred<{ readonly id: string }>();
    const started = deferred<void>();
    const error = vi.fn<DialCacheMetricsAdapter["error"]>();
    const dialcache = new DialCache({ metrics: metricsWithError(error) });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => {
      calls += 1;
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "user_id",
      useCase: "DefaultFallbackDeadline",
      cacheKey: (id) => id,
      defaultConfig: localConfig,
    });

    const result = dialcache.enable(async () =>
      await Promise.allSettled([getUser("123"), getUser("123"), getUser("123")]),
    );
    await started.promise;

    expect(calls).toBe(1);
    expect(dialcache.getCoalescingState().process).toMatchObject({
      activeLeaders: 1,
      activeFollowers: 2,
    });
    expect(dialcache.getCoalescingState().process.oldestLeaderAgeMs).toBeGreaterThanOrEqual(0);

    nowMs = 59_999;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);

    nowMs = 60_000;
    await vi.advanceTimersByTimeAsync(1);
    const settled = await result;
    expect(settled).toHaveLength(3);
    const reasons = settled.map((entry) => entry.status === "rejected" ? entry.reason : undefined);
    expect(reasons[0]).toBeInstanceOf(FallbackTimeoutError);
    expect(reasons[1]).toBe(reasons[0]);
    expect(reasons[2]).toBe(reasons[0]);
    expect(reasons[0]).toMatchObject({
      useCase: "DefaultFallbackDeadline",
      timeoutMs: 60_000,
    });
    expect(reasons[0]).toBeInstanceOf(DialCacheError);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "DefaultFallbackDeadline",
      keyType: "user_id",
      layer: CacheLayer.LOCAL,
      error: "fallback",
      inFallback: true,
    });
    expect(dialcache.getCoalescingState().process).toEqual({
      activeLeaders: 0,
      activeFollowers: 0,
      oldestLeaderAgeMs: null,
    });
  });

  it("uses a caller-selected timeout on enabled pass-through calls", async () => {
    const started = deferred<void>();
    const gate = deferred<string>();
    const dialcache = new DialCache();
    const load = dialcache.cached(async () => {
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "id",
      useCase: "PassThroughFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 25,
    });

    const result = Promise.allSettled([dialcache.enable(async () => await load())]);
    await started.promise;
    await vi.advanceTimersByTimeAsync(24);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    const [settled] = await result;
    expect(settled).toEqual({ status: "rejected", reason: expect.any(FallbackTimeoutError) });
    expect(settled?.status === "rejected" ? settled.reason.timeoutMs : undefined).toBe(25);
  });

  it("gives a late follower only the leader's remaining budget", async () => {
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const started = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const load = dialcache.cached(async () => {
      calls += 1;
      started.resolve();
      return await new Promise<string>(() => undefined);
    }, {
      keyType: "id",
      useCase: "FollowerInheritsDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 1_000,
      defaultConfig: localConfig,
    });

    const leader = dialcache.enable(async () => await load());
    await started.promise;
    nowMs = 900;
    await vi.advanceTimersByTimeAsync(900);
    const follower = dialcache.enable(async () => await load());
    await vi.advanceTimersByTimeAsync(0);
    const result = Promise.allSettled([leader, follower]);

    expect(calls).toBe(1);
    expect(dialcache.getCoalescingState().process.activeFollowers).toBe(1);
    nowMs = 999;
    await vi.advanceTimersByTimeAsync(99);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);

    nowMs = 1_000;
    await vi.advanceTimersByTimeAsync(1);
    const settled = await result;
    expect(
      settled.every((entry) => entry.status === "rejected" && entry.reason instanceof FallbackTimeoutError),
    ).toBe(true);
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);
  });

  it("shares one deadline across request-local followers and permits a same-scope retry", async () => {
    const firstStarted = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const load = dialcache.cached(async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        return await new Promise<string>(() => undefined);
      }
      return "retry";
    }, {
      keyType: "id",
      useCase: "RequestLocalFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });

    const result = dialcache.enable(async () => {
      const settled = await Promise.allSettled([load(), load(), load()]);
      const retry = await load();
      return { settled, retry };
    });
    await firstStarted.promise;
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);

    await vi.advanceTimersByTimeAsync(10);
    const { settled, retry } = await result;
    const reasons = settled.map((entry) => entry.status === "rejected" ? entry.reason : undefined);
    expect(calls).toBe(2);
    expect(reasons[0]).toBeInstanceOf(FallbackTimeoutError);
    expect(reasons[1]).toBe(reasons[0]);
    expect(reasons[2]).toBe(reasons[0]);
    expect(retry).toBe("retry");
  });

  it("counts synchronous pre-await fallback work against the deadline", async () => {
    let nowMs = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const dialcache = new DialCache();
    const load = dialcache.cached(async () => {
      nowMs += 11;
      return "late";
    }, {
      keyType: "id",
      useCase: "SynchronousFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      defaultConfig: localConfig,
    });

    await expect(dialcache.enable(async () => await load())).rejects.toMatchObject({
      useCase: "SynchronousFallbackDeadline",
      timeoutMs: 10,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps initially disabled calls as true pass-through", async () => {
    const started = deferred<void>();
    const gate = deferred<string>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = new DialCache();
    const load = dialcache.cached(async () => {
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "id",
      useCase: "DisabledContextHasNoDeadline",
      cacheKey: () => {
        throw new Error("cacheKey must not run");
      },
      fallbackTimeoutMs: 1,
      defaultConfig: localConfig,
    });

    const result = load();
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    gate.resolve("value");
    await expect(result).resolves.toBe("value");
  });

  it("allows the fallback deadline to be explicitly disabled", async () => {
    const started = deferred<void>();
    const gate = deferred<string>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = new DialCache();
    const load = dialcache.cached(async () => {
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "id",
      useCase: "DisabledFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: null,
      defaultConfig: localConfig,
    });

    const result = dialcache.enable(async () => await load());
    await started.promise;
    await vi.advanceTimersByTimeAsync(60_001);

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(1);
    gate.resolve("value");
    await expect(result).resolves.toBe("value");
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(0);
  });

  it("clears a successful fallback timer and creates no timer on a cache hit", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = new DialCache();
    let calls = 0;
    const load = dialcache.cached(async () => ++calls, {
      keyType: "id",
      useCase: "FallbackTimerCleanup",
      cacheKey: () => "123",
      fallbackTimeoutMs: 1_000,
      defaultConfig: localConfig,
    });

    await expect(dialcache.enable(async () => await load())).resolves.toBe(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await expect(dialcache.enable(async () => await load())).resolves.toBe(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("does not publish a fallback result that resolves after its deadline", async () => {
    const firstGate = deferred<{ readonly id: string; readonly version: number }>();
    const firstStarted = deferred<void>();
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis } });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        return await firstGate.promise;
      }
      return { id, version: 2 };
    }, {
      keyType: "user_id",
      useCase: "IgnoreLateFallbackResult",
      cacheKey: (id) => id,
      fallbackTimeoutMs: 10,
      defaultConfig: remoteConfig,
    });

    const first = Promise.allSettled([dialcache.enable(async () => await getUser("123"))]);
    await firstStarted.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect((await first)[0]).toEqual({ status: "rejected", reason: expect.any(FallbackTimeoutError) });
    expect(redis.setCalls).toBe(0);

    await expect(dialcache.enable(async () => await getUser("123"))).resolves.toEqual({ id: "123", version: 2 });
    expect(redis.setCalls).toBe(1);

    firstGate.resolve({ id: "123", version: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.setCalls).toBe(1);
    await expect(dialcache.enable(async () => await getUser("123"))).resolves.toEqual({ id: "123", version: 2 });
    expect(calls).toBe(2);
  });

  it("consumes a late fallback rejection without recording a second error", async () => {
    const gate = deferred<string>();
    const started = deferred<void>();
    const error = vi.fn<DialCacheMetricsAdapter["error"]>();
    const dialcache = new DialCache({ metrics: metricsWithError(error) });
    const load = dialcache.cached(async () => {
      started.resolve();
      return await gate.promise;
    }, {
      keyType: "id",
      useCase: "IgnoreLateFallbackError",
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      defaultConfig: localConfig,
    });

    const result = Promise.allSettled([dialcache.enable(async () => await load())]);
    await started.promise;
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(error).toHaveBeenCalledTimes(1);

    gate.reject(new Error("late source failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid fallbackTimeoutMs value %s without reserving the use case",
    (fallbackTimeoutMs) => {
      const dialcache = new DialCache();
      const options: CachedOptions<() => Promise<string>> = {
        keyType: "id",
        useCase: "InvalidFallbackDeadline",
        cacheKey: () => "123",
        fallbackTimeoutMs,
      };

      expect(() => dialcache.cached(async () => "value", options)).toThrow(
        new RangeError(
          "DialCache fallbackTimeoutMs must be null or a positive safe integer no greater than 2147483647",
        ),
      );
      expect(() => dialcache.cached(async () => "value", { ...options, fallbackTimeoutMs: 1 })).not.toThrow();
    },
  );

  it("rejects nonnumeric fallbackTimeoutMs from untyped callers", () => {
    const dialcache = new DialCache();
    const options = {
      keyType: "id",
      useCase: "UntypedFallbackDeadline",
      cacheKey: () => "123",
      fallbackTimeoutMs: "1000",
    } as unknown as CachedOptions<() => Promise<string>>;

    expect(() => dialcache.cached(async () => "value", options)).toThrow(RangeError);
  });
});

describe("DialCache coalescing state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports leaders, followers, oldest age, and settlement cleanup", async () => {
    let nowMs = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const dialcache = new DialCache();
    const load = dialcache.cached(async (id: string) => {
      if (id === "first") {
        firstStarted.resolve();
        return await firstGate.promise;
      }
      secondStarted.resolve();
      return await secondGate.promise;
    }, {
      keyType: "id",
      useCase: "InspectProcessFlights",
      cacheKey: (id) => id,
      defaultConfig: localConfig,
    });

    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null },
    });

    const firstLeader = dialcache.enable(async () => await load("first"));
    const firstFollower = dialcache.enable(async () => await load("first"));
    const secondFollower = dialcache.enable(async () => await load("first"));
    await firstStarted.promise;
    nowMs = 1_040;
    const secondLeader = dialcache.enable(async () => await load("second"));
    await secondStarted.promise;
    nowMs = 1_100;

    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 2, activeFollowers: 2, oldestLeaderAgeMs: 100 },
    });

    firstGate.resolve("first-value");
    await expect(Promise.all([firstLeader, firstFollower, secondFollower])).resolves.toEqual([
      "first-value",
      "first-value",
      "first-value",
    ]);
    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 1, activeFollowers: 0, oldestLeaderAgeMs: 60 },
    });

    secondGate.reject(new Error("second failed"));
    await expect(secondLeader).rejects.toThrow("second failed");
    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null },
    });
  });

  it("keeps process state isolated by instance and excludes request-local-only work", async () => {
    const processGate = deferred<string>();
    const processStarted = deferred<void>();
    const requestGate = deferred<string>();
    const requestStarted = deferred<void>();
    const first = new DialCache();
    const second = new DialCache();
    const processLoad = first.cached(async () => {
      processStarted.resolve();
      return await processGate.promise;
    }, {
      keyType: "id",
      useCase: "InstanceProcessState",
      cacheKey: () => "123",
      defaultConfig: localConfig,
    });
    const requestLoad = second.cached(async () => {
      requestStarted.resolve();
      return await requestGate.promise;
    }, {
      keyType: "id",
      useCase: "RequestLocalStateExcluded",
      cacheKey: () => "123",
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });

    const processResult = first.enable(async () => await processLoad());
    const requestResult = second.enable(async () => await Promise.all([requestLoad(), requestLoad()]));
    await Promise.all([processStarted.promise, requestStarted.promise]);

    expect(first.getCoalescingState().process.activeLeaders).toBe(1);
    expect(second.getCoalescingState()).toEqual({
      process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null },
    });

    processGate.resolve("process");
    requestGate.resolve("request");
    await expect(processResult).resolves.toBe("process");
    await expect(requestResult).resolves.toEqual(["request", "request"]);
  });

  it("releases a burst of unique-key flights at their fallback deadlines", async () => {
    const dialcache = new DialCache();
    let started = 0;
    const allStarted = deferred<void>();
    const load = dialcache.cached(async (id: string) => {
      started += 1;
      if (started === 32) {
        allStarted.resolve();
      }
      return await new Promise<string>(() => undefined);
    }, {
      keyType: "id",
      useCase: "ReleaseUniqueKeyBurst",
      cacheKey: (id) => id,
      fallbackTimeoutMs: 5,
      defaultConfig: localConfig,
    });

    const result = Promise.allSettled(
      Array.from({ length: 32 }, (_, index) => dialcache.enable(async () => await load(String(index)))),
    );
    await allStarted.promise;
    expect(dialcache.getCoalescingState().process.activeLeaders).toBe(32);

    await vi.advanceTimersByTimeAsync(5);
    const settled = await result;
    expect(
      settled.every((entry) => entry.status === "rejected" && entry.reason instanceof FallbackTimeoutError),
    ).toBe(true);
    expect(dialcache.getCoalescingState()).toEqual({
      process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null },
    });
  });
});

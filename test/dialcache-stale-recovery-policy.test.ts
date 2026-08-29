import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  FallbackTimeoutError,
  type CachedOptions,
  type GetOrLoadOptions,
} from "../src/index.js";
import { encodeFrame, FakeRedis } from "./fake-redis.js";

const FRESH_TTL_SEC = 1;
const MAX_AGE_SEC = 10;

type CachedValue = { readonly id: string; readonly version: number };
type StaleRecoveryPredicate = (error: unknown) => boolean;

function staleConfig(): DialCacheKeyConfig {
  return new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: FRESH_TTL_SEC },
    ramp: { [CacheLayer.REMOTE]: 100 },
    staleOnErrorMaxAgeSec: MAX_AGE_SEC,
  });
}

function redisValueKey(useCase: string): string {
  const key = new DialCacheKey({
    keyType: "user_id",
    id: "123",
    useCase,
    trackForInvalidation: false,
  });
  return `${key.urn}:dialcache-frame-v1`;
}

function seedStale(redis: FakeRedis, useCase: string): void {
  redis.setRaw(
    redisValueKey(useCase),
    encodeFrame({ id: "123", version: 1 }, Date.now() - 2_000),
    MAX_AGE_SEC * 1_000,
  );
}

function createDialCache(
  redis: FakeRedis,
  shouldAttemptStaleRecovery?: StaleRecoveryPredicate,
): DialCache {
  return new DialCache({
    redis: { client: redis, readTimeoutMs: 1_000 },
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    ...(shouldAttemptStaleRecovery === undefined ? {} : { shouldAttemptStaleRecovery }),
  });
}

function cachedRejecting(
  dialcache: DialCache,
  useCase: string,
  sourceError: unknown,
  shouldAttemptStaleRecovery?: StaleRecoveryPredicate,
) {
  const source = vi.fn(async (): Promise<CachedValue> => {
    throw sourceError;
  });
  const options = {
    keyType: "user_id",
    useCase,
    cacheKey: () => "123",
    defaultConfig: staleConfig(),
    ...(shouldAttemptStaleRecovery === undefined ? {} : { shouldAttemptStaleRecovery }),
  } satisfies CachedOptions<typeof source>;
  return { source, getUser: dialcache.cached(source, options) };
}

describe("DialCache stale-recovery error policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates the instance predicate at construction", () => {
    expect(() =>
      new DialCache({
        shouldAttemptStaleRecovery: "yes" as unknown as StaleRecoveryPredicate,
      }),
    ).toThrow(TypeError);
  });

  it("validates use-case predicates when each API captures them", () => {
    const dialcache = new DialCache();
    const invalidPredicate = "yes" as unknown as StaleRecoveryPredicate;
    const source = async (): Promise<CachedValue> => ({ id: "123", version: 1 });

    expect(() =>
      dialcache.cached(source, {
        keyType: "user_id",
        useCase: "InvalidCachedStaleRecoveryPolicy",
        cacheKey: () => "123",
        shouldAttemptStaleRecovery: invalidPredicate,
      }),
    ).toThrow(TypeError);
    expect(() =>
      dialcache.getOrLoad(source, {
        keyType: "user_id",
        useCase: "InvalidGetOrLoadStaleRecoveryPolicy",
        key: "123",
        shouldAttemptStaleRecovery: invalidPredicate,
      }),
    ).toThrow(TypeError);
  });

  it("denies an ordinary source rejection by default", async () => {
    const useCase = "DefaultDeniedStaleRecovery";
    const sourceError = new Error("source unavailable");
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis);
    const { getUser } = cachedRejecting(dialcache, useCase, sourceError);
    seedStale(redis, useCase);

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(sourceError);

    expect(redis.getCalls).toBe(1);
  });

  it("allows any FallbackTimeoutError through the built-in policy", async () => {
    const useCase = "DefaultTimeoutStaleRecovery";
    const timeout = new FallbackTimeoutError("NestedUseCase", 25);
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis);
    const { getUser } = cachedRejecting(dialcache, useCase, timeout);
    seedStale(redis, useCase);

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({
      id: "123",
      version: 1,
    });

    expect(redis.getCalls).toBe(1);
  });

  it("uses the instance predicate when the use case has no override", async () => {
    const useCase = "InstanceStaleRecoveryPolicy";
    const sourceError = new Error("source unavailable");
    const predicate = vi.fn((error: unknown) => error === sourceError);
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis, predicate);
    const { getUser } = cachedRejecting(dialcache, useCase, sourceError);
    seedStale(redis, useCase);

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({
      id: "123",
      version: 1,
    });

    expect(predicate).toHaveBeenCalledOnce();
    expect(predicate).toHaveBeenCalledWith(sourceError);
  });

  it("lets a use-case predicate allow recovery over an instance denial", async () => {
    const useCase = "UseCaseAllowsStaleRecovery";
    const sourceError = new Error("source unavailable");
    const instancePredicate = vi.fn(() => false);
    const useCasePredicate = vi.fn(() => true);
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis, instancePredicate);
    const { getUser } = cachedRejecting(dialcache, useCase, sourceError, useCasePredicate);
    seedStale(redis, useCase);

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({
      id: "123",
      version: 1,
    });

    expect(useCasePredicate).toHaveBeenCalledOnce();
    expect(useCasePredicate).toHaveBeenCalledWith(sourceError);
    expect(instancePredicate).not.toHaveBeenCalled();
  });

  it("lets a use-case predicate deny recovery over an instance allowance", async () => {
    const useCase = "UseCaseDeniesStaleRecovery";
    const sourceError = new Error("source unavailable");
    const instancePredicate = vi.fn(() => true);
    const useCasePredicate = vi.fn(() => false);
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis, instancePredicate);
    const { getUser } = cachedRejecting(dialcache, useCase, sourceError, useCasePredicate);
    seedStale(redis, useCase);

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(sourceError);

    expect(useCasePredicate).toHaveBeenCalledOnce();
    expect(useCasePredicate).toHaveBeenCalledWith(sourceError);
    expect(instancePredicate).not.toHaveBeenCalled();
  });

  it("lets an explicit instance predicate replace the built-in timeout policy", async () => {
    const useCase = "InstanceDeniesTimeoutStaleRecovery";
    const timeout = new FallbackTimeoutError("NestedUseCase", 25);
    const predicate = vi.fn(() => false);
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis, predicate);
    const { getUser } = cachedRejecting(dialcache, useCase, timeout);
    seedStale(redis, useCase);

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(timeout);

    expect(predicate).toHaveBeenCalledOnce();
    expect(predicate).toHaveBeenCalledWith(timeout);
  });

  it.each([
    {
      name: "throws",
      predicate: vi.fn(() => {
        throw new Error("predicate failed");
      }) as StaleRecoveryPredicate,
    },
    {
      name: "returns a non-boolean",
      predicate: vi.fn(() => "yes") as unknown as StaleRecoveryPredicate,
    },
    {
      name: "returns a thenable",
      predicate: vi.fn(() => Promise.resolve(true)) as unknown as StaleRecoveryPredicate,
    },
  ])("fails closed and preserves the source rejection when the predicate $name", async ({ predicate }) => {
    const useCase = `DefensiveStaleRecoveryPolicy${predicate.name}`;
    const sourceError = new Error("source unavailable");
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis);
    const { getUser } = cachedRejecting(dialcache, useCase, sourceError, predicate);
    seedStale(redis, useCase);

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(sourceError);

    expect(predicate).toHaveBeenCalledOnce();
    expect(predicate).toHaveBeenCalledWith(sourceError);
  });

  it("snapshots a cached function's predicate at registration", async () => {
    const useCase = "CachedPredicateSnapshot";
    const sourceError = new Error("source unavailable");
    const registeredPredicate = vi.fn(() => false);
    const replacementPredicate = vi.fn(() => true);
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis);
    const source = vi.fn(async (): Promise<CachedValue> => {
      throw sourceError;
    });
    const options = {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
      shouldAttemptStaleRecovery: registeredPredicate,
    } satisfies CachedOptions<typeof source>;
    const getUser = dialcache.cached(source, options);
    (options as { shouldAttemptStaleRecovery: StaleRecoveryPredicate }).shouldAttemptStaleRecovery =
      replacementPredicate;
    seedStale(redis, useCase);

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(sourceError);

    expect(registeredPredicate).toHaveBeenCalledOnce();
    expect(replacementPredicate).not.toHaveBeenCalled();
  });

  it("resolves a getOrLoad predicate independently for each invocation", async () => {
    const useCase = "GetOrLoadPredicatePerInvocation";
    const sourceError = new Error("source unavailable");
    const deny = vi.fn(() => false);
    const allow = vi.fn(() => true);
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis);
    const load = vi.fn(async (): Promise<CachedValue> => {
      throw sourceError;
    });
    const options = {
      keyType: "user_id",
      useCase,
      key: "123",
      defaultConfig: staleConfig(),
      shouldAttemptStaleRecovery: deny,
    } satisfies GetOrLoadOptions<CachedValue>;
    seedStale(redis, useCase);

    await expect(dialcache.enable(async () => await dialcache.getOrLoad(load, options))).rejects.toBe(sourceError);

    (options as { shouldAttemptStaleRecovery: StaleRecoveryPredicate }).shouldAttemptStaleRecovery = allow;
    await expect(dialcache.enable(async () => await dialcache.getOrLoad(load, options))).resolves.toEqual({
      id: "123",
      version: 1,
    });

    expect(deny).toHaveBeenCalledOnce();
    expect(allow).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not invoke the predicate outside an enabled context", async () => {
    const useCase = "DisabledContextStaleRecoveryPolicy";
    const sourceError = new Error("source unavailable");
    const predicate = vi.fn(() => true);
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis);
    const { source, getUser } = cachedRejecting(dialcache, useCase, sourceError, predicate);
    seedStale(redis, useCase);

    await expect(getUser()).rejects.toBe(sourceError);

    expect(source).toHaveBeenCalledOnce();
    expect(predicate).not.toHaveBeenCalled();
    expect(redis.getCalls).toBe(0);
  });

  it("invokes the policy once for a coalesced leader", async () => {
    const useCase = "CoalescedStaleRecoveryPolicy";
    const sourceError = new Error("source unavailable");
    const predicate = vi.fn(() => true);
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    const redis = new FakeRedis();
    const dialcache = createDialCache(redis);
    const source = vi.fn(async (): Promise<CachedValue> => {
      await sourceGate;
      throw sourceError;
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleConfig(),
      shouldAttemptStaleRecovery: predicate,
    });
    seedStale(redis, useCase);

    const pending = dialcache.enable(async () => await Promise.all([getUser(), getUser(), getUser()]));
    await vi.waitFor(() => expect(source).toHaveBeenCalledOnce());
    releaseSource();
    const values = await pending;

    expect(predicate).toHaveBeenCalledOnce();
    expect(predicate).toHaveBeenCalledWith(sourceError);
    expect(values[1]).toBe(values[0]);
    expect(values[2]).toBe(values[0]);
    expect(redis.getCalls).toBe(1);
  });
});

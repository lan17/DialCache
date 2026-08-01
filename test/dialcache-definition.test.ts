import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  JsonSerializer,
  UseCaseIsAlreadyRegisteredError,
  type CachedOptions,
  type DialCacheKey,
  type DialCacheMetricsAdapter,
} from "../src/index.js";

const localOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
    ramp: { [CacheLayer.LOCAL]: 100 },
  });

function metricsWithRequest(request: DialCacheMetricsAdapter["request"]): DialCacheMetricsAdapter {
  return {
    request,
    miss: vi.fn(),
    disabled: vi.fn(),
    error: vi.fn(),
    invalidation: vi.fn(),
    coalesced: vi.fn(),
    observeGet: vi.fn(),
    observeFallback: vi.fn(),
    observeSerialization: vi.fn(),
    observeSize: vi.fn(),
  };
}

describe("DialCache cached definition registration", () => {
  it("snapshots caller-owned definition options before returning the wrapper", async () => {
    type Value = { readonly owner: "first" | "second"; readonly id: string; readonly load: number };

    const firstSerializer = new JsonSerializer<Value>();
    const secondSerializer = new JsonSerializer<Value>();
    const originalCacheKey = vi.fn((id: string) => `registered:${id}`);
    const sharedCacheKey = vi.fn((id: string) => id);
    const observedKeys: DialCacheKey[] = [];
    const request = vi.fn<DialCacheMetricsAdapter["request"]>();
    const dialcache = new DialCache({
      cacheConfigProvider: (key) => {
        observedKeys.push(key);
        return null;
      },
      metrics: metricsWithRequest(request),
    });
    let firstLoads = 0;
    let secondLoads = 0;
    const options = {
      keyType: "registered_id",
      useCase: "RegisteredFirst",
      cacheKey: originalCacheKey,
      serializer: firstSerializer,
      trackForInvalidation: false,
      defaultConfig: localOnly(),
    };
    const first = dialcache.cached(async (id: string): Promise<Value> => ({
      owner: "first",
      id,
      load: ++firstLoads,
    }), options);

    options.keyType = "shared_id";
    options.useCase = "SharedAfterMutation";
    options.cacheKey = sharedCacheKey;
    options.serializer = secondSerializer;
    options.trackForInvalidation = true;
    const second = dialcache.cached(async (id: string): Promise<Value> => ({
      owner: "second",
      id,
      load: ++secondLoads,
    }), { ...options, defaultConfig: localOnly() });

    const values = await dialcache.enable(async () => [await first("123"), await second("123")] as const);

    expect(values).toEqual([
      { owner: "first", id: "123", load: 1 },
      { owner: "second", id: "123", load: 1 },
    ]);
    expect(firstLoads).toBe(1);
    expect(secondLoads).toBe(1);
    expect(originalCacheKey).toHaveBeenCalledOnce();
    expect(sharedCacheKey).toHaveBeenCalledOnce();
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toMatchObject({
      id: "registered:123",
      keyType: "registered_id",
      useCase: "RegisteredFirst",
      serializer: firstSerializer,
      trackForInvalidation: false,
    });
    expect(observedKeys[1]).toMatchObject({
      id: "123",
      keyType: "shared_id",
      useCase: "SharedAfterMutation",
      serializer: secondSerializer,
      trackForInvalidation: true,
    });
    expect(observedKeys[0]?.serializer).toBe(firstSerializer);
    expect(observedKeys[1]?.serializer).toBe(secondSerializer);
    expect(request).toHaveBeenNthCalledWith(1, {
      cacheNamespace: "urn",
      keyType: "registered_id",
      useCase: "RegisteredFirst",
      layer: CacheLayer.LOCAL,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      cacheNamespace: "urn",
      keyType: "shared_id",
      useCase: "SharedAfterMutation",
      layer: CacheLayer.LOCAL,
    });
  });

  it("uses the exact use case value that was checked and registered", async () => {
    let useCaseReads = 0;
    const observedKeys: DialCacheKey[] = [];
    const dialcache = new DialCache({
      cacheConfigProvider: (key) => {
        observedKeys.push(key);
        return null;
      },
    });
    const options: CachedOptions<() => Promise<string>> = {
      keyType: "id",
      get useCase(): string {
        useCaseReads += 1;
        return useCaseReads === 1 ? "RegisteredOnce" : "watermark";
      },
      cacheKey: () => "123",
      defaultConfig: localOnly(),
    };
    const load = dialcache.cached(async () => "value", options);

    await expect(dialcache.enable(async () => await load())).resolves.toBe("value");

    expect(useCaseReads).toBe(1);
    expect(observedKeys).toHaveLength(1);
    expect(observedKeys[0]?.useCase).toBe("RegisteredOnce");
    expect(() =>
      dialcache.cached(async () => "value", {
        keyType: "id",
        useCase: "RegisteredOnce",
        cacheKey: () => "123",
      }),
    ).toThrow(UseCaseIsAlreadyRegisteredError);
  });

  it("does not reserve the use case when reading a definition option throws", () => {
    const dialcache = new DialCache();
    const readError = new Error("could not read invalidation tracking");
    const options: CachedOptions<() => Promise<string>> = {
      keyType: "id",
      useCase: "AtomicDefinitionRegistration",
      cacheKey: () => "123",
      get trackForInvalidation(): boolean {
        throw readError;
      },
    };

    expect(() => dialcache.cached(async () => "value", options)).toThrow(readError);
    expect(() =>
      dialcache.cached(async () => "value", {
        keyType: "id",
        useCase: "AtomicDefinitionRegistration",
        cacheKey: () => "123",
      }),
    ).not.toThrow();
  });
});

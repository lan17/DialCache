import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  deterministicRampSampler,
  type LayerConfig,
} from "../src/index.js";
import { FakeRedis } from "./fake-redis.js";

const configFor = (ttlSec: Partial<Record<CacheLayer, number>>, ramp: Partial<Record<CacheLayer, number>>) =>
  new DialCacheKeyConfig({ ttlSec, ramp });

describe("DialCache runtime config and ramp controls", () => {
  it("preserves requestLocal omission until baseline and runtime config are merged", () => {
    expect(new DialCacheKeyConfig({}).requestLocal).toBeUndefined();
    expect(new DialCacheKeyConfig({ requestLocal: false }).requestLocal).toBe(false);
  });

  it("captures an immutable default policy snapshot when the use case is registered", async () => {
    const suppliedDefault = new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
      ramp: { [CacheLayer.LOCAL]: 100 },
    });
    const observedDefaults: Array<DialCacheKeyConfig | null> = [];
    const dialcache = new DialCache({
      cacheConfigProvider: (key) => {
        observedDefaults.push(key.defaultConfig);
        (key as unknown as { defaultConfig: DialCacheKeyConfig | null }).defaultConfig = null;
        return null;
      },
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "ImmutableRegisteredDefault",
      cacheKey: (userId) => userId,
      defaultConfig: suppliedDefault,
    });

    suppliedDefault.ttlSec[CacheLayer.LOCAL] = 0;
    suppliedDefault.ramp[CacheLayer.LOCAL] = 0;
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(observedDefaults).toHaveLength(2);
    expect(observedDefaults[0]).not.toBe(suppliedDefault);
    expect(observedDefaults[1]).toBe(observedDefaults[0]);
    expect(observedDefaults[0]?.ttlSec[CacheLayer.LOCAL]).toBe(60);
    expect(observedDefaults[0]?.ramp[CacheLayer.LOCAL]).toBe(100);
    expect(Object.isFrozen(observedDefaults[0])).toBe(true);
    expect(Object.isFrozen(observedDefaults[0]?.ttlSec)).toBe(true);
    expect(Object.isFrozen(observedDefaults[0]?.ramp)).toBe(true);
  });

  it("enables request-local caching without TTL, ramp, or ramp sampling", async () => {
    const rampSampler = vi.fn(() => {
      throw new Error("request-local caching must not use the layer ramp sampler");
    });
    const dialcache = new DialCache({ rampSampler });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RequestLocalWithoutLayerPolicy",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });

    const values = await dialcache.enable(async () => [await getUser("123"), await getUser("123")] as const);

    expect(values[1]).toBe(values[0]);
    expect(calls).toBe(1);
    expect(rampSampler).not.toHaveBeenCalled();
  });

  it("fetches runtime config once while traversing request-local, local, and remote layers", async () => {
    const redis = new FakeRedis();
    const keyConfig = new DialCacheKeyConfig({
      requestLocal: true,
      ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 60 },
      ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
    });
    const cacheConfigProvider = vi.fn(async () => keyConfig);
    const dialcache = new DialCache({ redis: { client: redis }, cacheConfigProvider });
    const getUser = dialcache.cached(async (userId: string) => ({ userId }), {
      keyType: "user_id",
      useCase: "SingleRuntimeConfigSnapshot",
      cacheKey: (userId) => userId,
    });

    await dialcache.enable(async () => await getUser("123"));

    expect(cacheConfigProvider).toHaveBeenCalledTimes(1);
    expect(redis.getCalls).toBe(1);
    expect(redis.setCalls).toBe(1);
  });

  it("fails open without refetching when remote ramp resolution throws", async () => {
    const redis = new FakeRedis();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const keyConfig = new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 60 },
      ramp: { [CacheLayer.REMOTE]: 50 },
    });
    const cacheConfigProvider = vi.fn(async () => keyConfig);
    const dialcache = new DialCache({
      redis: { client: redis },
      cacheConfigProvider,
      rampSampler: () => {
        throw new Error("ramp source unavailable");
      },
      logger,
    });
    const getUser = dialcache.cached(async (userId: string) => ({ userId }), {
      keyType: "user_id",
      useCase: "RemoteRampResolutionFailOpen",
      cacheKey: (userId) => userId,
    });

    await expect(dialcache.enable(async () => await getUser("123"))).resolves.toEqual({ userId: "123" });

    expect(cacheConfigProvider).toHaveBeenCalledTimes(1);
    expect(redis.getCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith("Error resolving Redis cache config", expect.any(Error));
  });

  it.each(["throws synchronously", "rejects asynchronously"] as const)(
    "fails open without caching when local ramp resolution $failureMode",
    async (failureMode) => {
      const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const samplerError = new Error("ramp source unavailable");
      const keyConfig = new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 50 },
      });
      const cacheConfigProvider = vi.fn(async () => keyConfig);
      const rampSampler = vi.fn(() => {
        if (failureMode === "throws synchronously") {
          throw samplerError;
        }
        return Promise.reject(samplerError);
      });
      const dialcache = new DialCache({
        cacheConfigProvider,
        rampSampler,
        logger,
      });
      let calls = 0;
      const getUser = dialcache.cached(async (userId: string) => ({ userId, call: ++calls }), {
        keyType: "user_id",
        useCase: "LocalRampResolutionFailOpen",
        cacheKey: (userId) => userId,
      });

      await expect(
        dialcache.enable(async () => [await getUser("123"), await getUser("123")] as const),
      ).resolves.toEqual([
        { userId: "123", call: 1 },
        { userId: "123", call: 2 },
      ]);

      expect(cacheConfigProvider).toHaveBeenCalledTimes(2);
      expect(rampSampler).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith("Error resolving local cache config", samplerError);
    },
  );

  it("continues through Redis when local ramp resolution throws", async () => {
    // Given local ramp resolution fails while the remote layer is fully enabled.
    const redis = new FakeRedis();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const samplerError = new Error("local ramp source unavailable");
    const rampSampler = vi.fn(() => {
      throw samplerError;
    });
    const dialcache = new DialCache({
      redis: { client: redis },
      rampSampler,
      logger,
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "LocalRampFailureContinuesThroughRedis",
      cacheKey: (userId) => userId,
      defaultConfig: configFor(
        { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 60 },
        { [CacheLayer.LOCAL]: 50, [CacheLayer.REMOTE]: 100 },
      ),
    });

    // When the same key is read twice.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then the first call stores its fallback in Redis and the second call hits it.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(2);
    expect(redis.setCalls).toBe(1);
    expect(rampSampler).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith("Error resolving local cache config", samplerError);
  });

  it("populates local cache when remote ramp resolution throws after a local miss", async () => {
    // Given local caching is fully enabled while remote ramp resolution fails.
    const redis = new FakeRedis();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const samplerError = new Error("remote ramp source unavailable");
    const rampSampler = vi.fn(() => {
      throw samplerError;
    });
    const dialcache = new DialCache({
      redis: { client: redis },
      rampSampler,
      logger,
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RemoteRampFailurePopulatesLocal",
      cacheKey: (userId) => userId,
      defaultConfig: configFor(
        { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 60 },
        { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 50 },
      ),
    });

    // When the same key is read twice.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then the fallback is stored locally and the local hit does not resolve remote again.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
    expect(rampSampler).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Error resolving Redis cache config", samplerError);
  });

  it("uses a deterministic default ramp sample per cache key and layer", async () => {
    // Given the built-in sampler is asked to sample the same key multiple times.
    const key = new DialCacheKey({ keyType: "user_id", id: "123", useCase: "DeterministicRampSample" });

    // When the key is sampled repeatedly for a partial rollout.
    const first = await deterministicRampSampler({ key, layer: CacheLayer.LOCAL, ramp: 50 });
    const second = await deterministicRampSampler({ key, layer: CacheLayer.LOCAL, ramp: 50 });
    const remote = await deterministicRampSampler({ key, layer: CacheLayer.REMOTE, ramp: 50 });

    // Then the sample is stable, bounded, and layer-specific.
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
    expect(remote).toBeGreaterThanOrEqual(0);
    expect(remote).toBeLessThan(100);
    expect(remote).not.toBe(first);
  });

  it("falls back to cached-function defaultConfig when the provider returns null", async () => {
    // Given a runtime config provider that has no dynamic config for this key.
    const cacheConfigProvider = vi.fn(async () => null);
    const dialcache = new DialCache({ cacheConfigProvider });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "ProviderFallbackDefaultConfig",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the same key is read twice inside an enabled scope.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then the cached-function defaultConfig keeps the local cache active.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(cacheConfigProvider).toHaveBeenCalled();
  });

  it("inherits defaults per field when the runtime config is sparse", async () => {
    // Given the static baseline enables local and remote caching with distinct policies,
    // while runtime config changes only the local ramp and remote TTL.
    const redis = new FakeRedis();
    const dialcache = new DialCache({
      redis: { client: redis },
      cacheConfigProvider: async () => new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 30 },
        ramp: { [CacheLayer.LOCAL]: 0 },
      }),
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "SparseRuntimeOverlay",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 120 },
        ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
      }),
    });

    // When the same key is read twice, the explicit local ramp disables local
    // caching while the remote TTL override inherits the baseline remote ramp.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(2);
    expect(redis.setCalls).toBe(1);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty config", new DialCacheKeyConfig({})],
    [
      "undefined leaves",
      new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: undefined } as unknown as LayerConfig,
        ramp: { [CacheLayer.LOCAL]: undefined } as unknown as LayerConfig,
      }),
    ],
  ] as const)("inherits the full baseline when the provider returns %s", async (_name, runtimeConfig) => {
    const cacheConfigProvider = vi.fn(async () => runtimeConfig as DialCacheKeyConfig | null);
    const dialcache = new DialCache({ cacheConfigProvider });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: `WholeBaselineInheritance${String(_name)}`,
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
      }),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(cacheConfigProvider).toHaveBeenCalledTimes(2);
  });

  it("defaults a shared layer ramp to 100 when its effective TTL is configured", async () => {
    const rampSampler = vi.fn(() => {
      throw new Error("the default 100 ramp must not sample");
    });
    const dialcache = new DialCache({ rampSampler });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "ImplicitFullRamp",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 } }),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(rampSampler).not.toHaveBeenCalled();
  });

  it.each([
    ["a null config", () => new DialCacheKeyConfig(null as never), "DialCache key config must be an object"],
    [
      "a null layer map",
      () => new DialCacheKeyConfig({ ttlSec: null as unknown as LayerConfig }),
      "DialCache ttlSec config must be a layer map",
    ],
    [
      "a non-boolean requestLocal value",
      () => new DialCacheKeyConfig({ requestLocal: null as unknown as boolean }),
      "DialCache requestLocal config must be a boolean",
    ],
  ])("rejects $0 in the public config constructor", (_name, construct, message) => {
    expect(construct).toThrow(message);
  });

  it.each([
    ["zero TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 0 } }), RangeError, "positive safe integer"],
    ["negative TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: -1 } }), RangeError, "positive safe integer"],
    ["fractional TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 0.5 } }), RangeError, "positive safe integer"],
    ["non-finite TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: Number.NaN } }), RangeError, "positive safe integer"],
    ["negative ramp", new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: -1 } }), RangeError, "between 0 and 100"],
    ["over-100 ramp", new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: 101 } }), RangeError, "between 0 and 100"],
    ["non-finite ramp", new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: Number.POSITIVE_INFINITY } }), RangeError, "between 0 and 100"],
    [
      "wrong-type TTL",
      new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: "60" as unknown as number } }),
      TypeError,
      "must be a number",
    ],
    [
      "wrong-type ramp",
      new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: null as unknown as number } }),
      TypeError,
      "must be a number",
    ],
    ["primitive config", 42 as unknown as DialCacheKeyConfig, TypeError, "must be an object"],
    ["array config", [] as unknown as DialCacheKeyConfig, TypeError, "must be an object"],
    [
      "null TTL map",
      { ttlSec: null, ramp: {} } as unknown as DialCacheKeyConfig,
      TypeError,
      "must be a layer map",
    ],
  ])("rejects a malformed static defaultConfig with $0 at registration", (_name, defaultConfig, ErrorType, message) => {
    const dialcache = new DialCache();

    expect(() => dialcache.cached(async () => "value", {
      keyType: "item_id",
      useCase: "InvalidStaticPolicy",
      cacheKey: () => "123",
      defaultConfig,
    })).toThrow(ErrorType);
    expect(() => dialcache.cached(async () => "value", {
      keyType: "item_id",
      useCase: "InvalidStaticPolicy",
      cacheKey: () => "123",
      defaultConfig,
    })).toThrow(message);

    // Validation runs before use-case registration, so a corrected policy can
    // reuse the same name instead of being rejected as a duplicate.
    expect(() => dialcache.cached(async () => "value", {
      keyType: "item_id",
      useCase: "InvalidStaticPolicy",
      cacheKey: () => "123",
      defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 } }),
    })).not.toThrow();
  });

  it.each([
    ["a primitive", 42],
    ["an array", []],
    ["a null layer map", { ttlSec: null, ramp: {} }],
    ["a null requestLocal value", { ttlSec: {}, ramp: {}, requestLocal: null }],
  ] as const)("fails open instead of inheriting defaults when the provider returns %s", async (_name, runtimeConfig) => {
    const cacheConfigProvider = vi.fn(async () => runtimeConfig as unknown as DialCacheKeyConfig);
    const dialcache = new DialCache({ cacheConfigProvider });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: `MalformedRuntimeConfig${String(_name)}`,
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 } }),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first.calls).toBe(1);
    expect(second.calls).toBe(2);
    expect(cacheConfigProvider).toHaveBeenCalledTimes(2);
  });

  it("returns the explicit kill-switch overlay from DialCacheKeyConfig.disabled()", () => {
    expect(DialCacheKeyConfig.disabled()).toEqual(new DialCacheKeyConfig({
      requestLocal: false,
      ramp: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 0 },
    }));
  });

  it.each([
    [
      "explicit runtime field values",
      () => new DialCacheKeyConfig({
        requestLocal: false,
        ramp: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 0 },
      }),
    ],
    ["the DialCacheKeyConfig.disabled() kill switch", () => DialCacheKeyConfig.disabled()],
  ])("uses %s to disable every inherited layer", async (_name, overlayFor) => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({
      redis: { client: redis },
      cacheConfigProvider: async () => overlayFor(),
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "ExplicitDisableAll",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        requestLocal: true,
        ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
      }),
    });

    const values = await dialcache.enable(async () => [await getUser("123"), await getUser("123")] as const);

    expect(values).toEqual([
      { userId: "123", calls: 1 },
      { userId: "123", calls: 2 },
    ]);
    expect(redis.getCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
  });

  it.each([
    ["null TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: null as unknown as number } })],
    ["NaN TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: Number.NaN } })],
    ["wrong-type TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: "60" as unknown as number } })],
    ["null ramp", new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: null as unknown as number } })],
    ["NaN ramp", new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: Number.NaN } })],
    ["wrong-type ramp", new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: "50" as unknown as number } })],
  ])("does not inherit a valid default over an explicit malformed runtime $0", async (_name, runtimeConfig) => {
    const dialcache = new DialCache({ cacheConfigProvider: async () => runtimeConfig });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: `MalformedRuntimeLeaf${String(_name)}`,
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(first.calls).toBe(1);
    expect(second.calls).toBe(2);
  });

  it("applies runtime config changes to subsequent calls", async () => {
    // Given a provider whose config can change without redeploying the cached function.
    let runtimeConfig: DialCacheKeyConfig | null = DialCacheKeyConfig.enabled(60);
    const dialcache = new DialCache({ cacheConfigProvider: async () => runtimeConfig });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "DynamicProviderConfig",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the provider disables local caching after the first cached read.
    const first = await dialcache.enable(async () => await getUser("123"));
    runtimeConfig = new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: 0 } });
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then the second call honors the new disabled config instead of returning the existing local entry.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(calls).toBe(2);
  });

  it("treats ramp 0 and 100 as deterministic layer controls", async () => {
    // Given one local key is ramped out and another is fully ramped in.
    const rampSampler = vi.fn(() => {
      throw new Error("0/100 ramps should not need random sampling");
    });
    const dialcache = new DialCache({ rampSampler });
    let disabledCalls = 0;
    const disabled = dialcache.cached(async (userId: string) => ({ userId, calls: ++disabledCalls }), {
      keyType: "user_id",
      useCase: "LocalRampZero",
      cacheKey: (userId) => userId,
      defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 0 }),
    });
    let enabledCalls = 0;
    const enabled = dialcache.cached(async (userId: string) => ({ userId, calls: ++enabledCalls }), {
      keyType: "user_id",
      useCase: "LocalRampHundred",
      cacheKey: (userId) => userId,
      defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 100 }),
    });

    // When each key is read twice.
    const disabledFirst = await dialcache.enable(async () => await disabled("123"));
    const disabledSecond = await dialcache.enable(async () => await disabled("123"));
    const enabledFirst = await dialcache.enable(async () => await enabled("456"));
    const enabledSecond = await dialcache.enable(async () => await enabled("456"));

    // Then ramp 0 disables the layer, ramp 100 enables it, and neither path samples randomness.
    expect(disabledFirst).toEqual({ userId: "123", calls: 1 });
    expect(disabledSecond).toEqual({ userId: "123", calls: 2 });
    expect(enabledFirst).toEqual({ userId: "456", calls: 1 });
    expect(enabledSecond).toEqual({ userId: "456", calls: 1 });
    expect(rampSampler).not.toHaveBeenCalled();
  });

  it("uses the injected sampler to make ramp 50 behavior testable", async () => {
    // Given one sampler lands inside ramp 50 and another lands just outside it.
    const passingSampler = vi.fn(() => 49);
    const blockedSampler = vi.fn(() => 50);
    const passingCache = new DialCache({ rampSampler: passingSampler });
    const blockedCache = new DialCache({ rampSampler: blockedSampler });
    let passingCalls = 0;
    const passing = passingCache.cached(async (userId: string) => ({ userId, calls: ++passingCalls }), {
      keyType: "user_id",
      useCase: "LocalRampFiftyPassing",
      cacheKey: (userId) => userId,
      defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 50 }),
    });
    let blockedCalls = 0;
    const blocked = blockedCache.cached(async (userId: string) => ({ userId, calls: ++blockedCalls }), {
      keyType: "user_id",
      useCase: "LocalRampFiftyBlocked",
      cacheKey: (userId) => userId,
      defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 50 }),
    });

    // When both caches read the same key twice.
    const passingFirst = await passingCache.enable(async () => await passing("123"));
    const passingSecond = await passingCache.enable(async () => await passing("123"));
    const blockedFirst = await blockedCache.enable(async () => await blocked("123"));
    const blockedSecond = await blockedCache.enable(async () => await blocked("123"));

    // Then the sampled-in key caches and the sampled-out key falls through.
    expect(passingFirst).toEqual({ userId: "123", calls: 1 });
    expect(passingSecond).toEqual({ userId: "123", calls: 1 });
    expect(blockedFirst).toEqual({ userId: "123", calls: 1 });
    expect(blockedSecond).toEqual({ userId: "123", calls: 2 });
    expect(passingSampler).toHaveBeenCalledWith(expect.objectContaining({ layer: CacheLayer.LOCAL, ramp: 50 }));
    expect(blockedSampler).toHaveBeenCalledWith(expect.objectContaining({ layer: CacheLayer.LOCAL, ramp: 50 }));
  });

  it("uses the injected sampler for remote ramp 50 behavior", async () => {
    // Given remote-only config with one sampler inside ramp 50 and another just outside it.
    const passingRedis = new FakeRedis();
    const blockedRedis = new FakeRedis();
    const passingSampler = vi.fn(() => 49);
    const blockedSampler = vi.fn(() => 50);
    const passingCache = new DialCache({
      redis: { client: passingRedis },
      rampSampler: passingSampler,
      cacheConfigProvider: async () => configFor({ [CacheLayer.REMOTE]: 60 }, { [CacheLayer.REMOTE]: 50 }),
    });
    const blockedCache = new DialCache({
      redis: { client: blockedRedis },
      rampSampler: blockedSampler,
      cacheConfigProvider: async () => configFor({ [CacheLayer.REMOTE]: 60 }, { [CacheLayer.REMOTE]: 50 }),
    });
    let passingCalls = 0;
    const passing = passingCache.cached(async (userId: string) => ({ userId, calls: ++passingCalls }), {
      keyType: "user_id",
      useCase: "RemoteRampFiftyPassing",
      cacheKey: (userId) => userId,
    });
    let blockedCalls = 0;
    const blocked = blockedCache.cached(async (userId: string) => ({ userId, calls: ++blockedCalls }), {
      keyType: "user_id",
      useCase: "RemoteRampFiftyBlocked",
      cacheKey: (userId) => userId,
    });

    // When both remote-only caches read the same key twice.
    const passingFirst = await passingCache.enable(async () => await passing("123"));
    const passingSecond = await passingCache.enable(async () => await passing("123"));
    const blockedFirst = await blockedCache.enable(async () => await blocked("123"));
    const blockedSecond = await blockedCache.enable(async () => await blocked("123"));

    // Then the sampled-in key uses Redis and the sampled-out key never touches Redis.
    expect(passingFirst).toEqual({ userId: "123", calls: 1 });
    expect(passingSecond).toEqual({ userId: "123", calls: 1 });
    expect(blockedFirst).toEqual({ userId: "123", calls: 1 });
    expect(blockedSecond).toEqual({ userId: "123", calls: 2 });
    expect(passingRedis.getCalls).toBe(2);
    expect(passingRedis.setCalls).toBe(1);
    expect(blockedRedis.getCalls).toBe(0);
    expect(blockedRedis.setCalls).toBe(0);
    expect(passingSampler).toHaveBeenCalledWith(expect.objectContaining({ layer: CacheLayer.REMOTE, ramp: 50 }));
    expect(blockedSampler).toHaveBeenCalledWith(expect.objectContaining({ layer: CacheLayer.REMOTE, ramp: 50 }));
  });

  it("handles out-of-range and non-finite ramp inputs defensively", async () => {
    // Given configured ramps can come from dynamic config and may be outside the normal 0-100 range.
    const deterministicSampler = vi.fn(() => {
      throw new Error("clamped terminal ramps should not need random sampling");
    });
    const clampedCache = new DialCache({
      rampSampler: deterministicSampler,
      cacheConfigProvider: async (key) => configFor(
        { [CacheLayer.LOCAL]: 60 },
        {
          [CacheLayer.LOCAL]: key.useCase === "NegativeConfiguredRamp"
            ? -10
            : key.useCase === "OverHundredConfiguredRamp"
              ? 150
              : Number.NaN,
        },
      ),
    });
    let negativeCalls = 0;
    const negativeRamp = clampedCache.cached(async (userId: string) => ({ userId, calls: ++negativeCalls }), {
      keyType: "user_id",
      useCase: "NegativeConfiguredRamp",
      cacheKey: (userId) => userId,
    });
    let overHundredCalls = 0;
    const overHundredRamp = clampedCache.cached(async (userId: string) => ({ userId, calls: ++overHundredCalls }), {
      keyType: "user_id",
      useCase: "OverHundredConfiguredRamp",
      cacheKey: (userId) => userId,
    });
    let nanConfiguredCalls = 0;
    const nanConfiguredRamp = clampedCache.cached(async (userId: string) => ({ userId, calls: ++nanConfiguredCalls }), {
      keyType: "user_id",
      useCase: "NanConfiguredRamp",
      cacheKey: (userId) => userId,
    });

    // When the same keys are read twice.
    const negativeFirst = await clampedCache.enable(async () => await negativeRamp("123"));
    const negativeSecond = await clampedCache.enable(async () => await negativeRamp("123"));
    const overHundredFirst = await clampedCache.enable(async () => await overHundredRamp("456"));
    const overHundredSecond = await clampedCache.enable(async () => await overHundredRamp("456"));
    const nanConfiguredFirst = await clampedCache.enable(async () => await nanConfiguredRamp("789"));
    const nanConfiguredSecond = await clampedCache.enable(async () => await nanConfiguredRamp("789"));

    // Then finite out-of-range ramps clamp to safe terminal behavior, and non-finite config disables caching.
    expect(negativeFirst).toEqual({ userId: "123", calls: 1 });
    expect(negativeSecond).toEqual({ userId: "123", calls: 2 });
    expect(overHundredFirst).toEqual({ userId: "456", calls: 1 });
    expect(overHundredSecond).toEqual({ userId: "456", calls: 1 });
    expect(nanConfiguredFirst).toEqual({ userId: "789", calls: 1 });
    expect(nanConfiguredSecond).toEqual({ userId: "789", calls: 2 });
    expect(deterministicSampler).not.toHaveBeenCalled();

    // Given partial ramps still depend on sampler output.
    for (const [sample, useCase] of [
      [Number.NaN, "NanRampSample"],
      [Number.POSITIVE_INFINITY, "InfinityRampSample"],
    ] as const) {
      const sampler = vi.fn(() => sample);
      const sampledCache = new DialCache({ rampSampler: sampler });
      let calls = 0;
      const getUser = sampledCache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
        keyType: "user_id",
        useCase,
        cacheKey: (userId) => userId,
        defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 50 }),
      });

      const first = await sampledCache.enable(async () => await getUser("123"));
      const second = await sampledCache.enable(async () => await getUser("123"));

      expect(first.calls).toBe(1);
      expect(second.calls).toBe(2);
      expect(sampler).toHaveBeenCalledTimes(2);
    }
  });

  it("uses one ramp sample for a local miss and write decision", async () => {
    // Given the first ramp sample admits the read path and any immediate second sample would reject the write path.
    const rampSampler = vi.fn().mockReturnValueOnce(49).mockReturnValueOnce(50);
    const dialcache = new DialCache({ rampSampler });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "LocalRampSingleSample",
      cacheKey: (userId) => userId,
      defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 50 }),
    });

    // When the key misses once.
    const first = await dialcache.enable(async () => await getUser("123"));

    // Then the sampled-in miss writes local cache without resampling during the same call.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(rampSampler).toHaveBeenCalledTimes(1);

    // When the next read is sampled into the local layer again.
    rampSampler.mockReset();
    rampSampler.mockReturnValueOnce(49);
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then it can hit the value written by the original sampled-in miss.
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(rampSampler).toHaveBeenCalledTimes(1);
  });

  it("uses one ramp sample for a remote miss and write decision", async () => {
    // Given the first remote ramp sample admits the read path and any immediate second sample would reject the write path.
    const redis = new FakeRedis();
    const rampSampler = vi.fn().mockReturnValueOnce(49).mockReturnValueOnce(50);
    const dialcache = new DialCache({
      redis: { client: redis },
      rampSampler,
      cacheConfigProvider: async () => configFor({ [CacheLayer.REMOTE]: 60 }, { [CacheLayer.REMOTE]: 50 }),
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RemoteRampSingleSample",
      cacheKey: (userId) => userId,
    });

    // When the Redis key misses once.
    const first = await dialcache.enable(async () => await getUser("123"));

    // Then the sampled-in miss writes Redis without resampling during the same call.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(redis.setCalls).toBe(1);
    expect(rampSampler).toHaveBeenCalledTimes(1);

    // When the next read is sampled into the remote layer again.
    rampSampler.mockReset();
    rampSampler.mockReturnValueOnce(49);
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then it can hit the value written by the original sampled-in miss.
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(rampSampler).toHaveBeenCalledTimes(1);
  });

  it("treats non-finite and fractional TTLs as invalid config", async () => {
    // Given invalid TTL values are configured for local and remote layers.
    const redis = new FakeRedis();
    const badTtls = [Number.NaN, Number.POSITIVE_INFINITY, 0.5];

    // When each cached function is called twice.
    for (const ttl of badTtls) {
      const dialcache = new DialCache({
        redis: { client: redis },
        cacheConfigProvider: async () => configFor(
          { [CacheLayer.LOCAL]: ttl, [CacheLayer.REMOTE]: ttl },
          { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
        ),
      });
      let calls = 0;
      const getUser = dialcache.cached(async (userId: string) => ({ userId, ttl: String(ttl), calls: ++calls }), {
        keyType: "user_id",
        useCase: `InvalidTtl${String(ttl)}`,
        cacheKey: (userId) => userId,
      });

      const first = await dialcache.enable(async () => await getUser("123"));
      const second = await dialcache.enable(async () => await getUser("123"));

      expect(first.calls).toBe(1);
      expect(second.calls).toBe(2);
    }

    // Then no invalid TTL reaches Redis.
    expect(redis.getCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
  });

  it("disables missing local config while allowing the remote layer to work", async () => {
    // Given runtime config only enables the remote layer.
    const redis = new FakeRedis();
    const dialcache = new DialCache({
      redis: { client: redis },
      cacheConfigProvider: async () => new DialCacheKeyConfig({ ttlSec: { [CacheLayer.REMOTE]: 60 } }),
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RemoteOnlyRuntimeConfig",
      cacheKey: (userId) => userId,
    });

    // When the same key is read twice through a Redis-backed cache.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then local is skipped, Redis stores the fallback, and the second read comes from Redis.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(2);
    expect(redis.setCalls).toBe(1);
  });

  it("disables missing remote config while allowing the local layer to work", async () => {
    // Given Redis exists but runtime config only enables the local layer.
    const redis = new FakeRedis();
    const dialcache = new DialCache({
      redis: { client: redis },
      cacheConfigProvider: async () => configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 100 }),
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "LocalOnlyRuntimeConfig",
      cacheKey: (userId) => userId,
    });

    // When the same key is read twice through a Redis-backed cache.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then Redis is skipped and the second read comes from local cache.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
  });

  it("fails open when the runtime config provider throws", async () => {
    // Given the runtime config provider is temporarily unavailable.
    const providerError = new Error("config provider unavailable");
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({
      logger,
      cacheConfigProvider: vi.fn(async () => {
        throw providerError;
      }),
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "ConfigProviderThrows",
      cacheKey: (userId) => userId,
      defaultConfig: DialCacheKeyConfig.enabled(60),
    });

    // When the cached function is called while config lookup fails.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then no provider error escapes and no value is accidentally cached. The
    // config is resolved once up front, so the failure is logged there rather
    // than surfacing as a per-layer cache-read error.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 2 });
    expect(logger.warn).toHaveBeenCalledWith("Could not resolve DialCache key config", providerError);
  });
});

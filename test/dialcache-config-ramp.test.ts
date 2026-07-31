import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  type LayerConfig,
  type Serializer,
} from "../src/index.js";
import { deterministicRampSample, deterministicShadowRampSample } from "../src/internal/ramp.js";
import { FakeRedis } from "./fake-redis.js";

const configFor = (ttlSec: Partial<Record<CacheLayer, number>>, ramp: Partial<Record<CacheLayer, number>>) =>
  new DialCacheKeyConfig({ ttlSec, ramp });
const MAX_CACHE_TTL_SEC = 31_536_000;

function idForRamp(useCase: string, layer: CacheLayer, ramp: number, enabled: boolean): string {
  for (let index = 0; index < 10_000; index += 1) {
    const id = String(index);
    const key = new DialCacheKey({ keyType: "user_id", id, useCase });
    if ((deterministicRampSample(key, layer) < ramp) === enabled) {
      return id;
    }
  }
  throw new Error(`Could not find a ${enabled ? "sampled-in" : "sampled-out"} ramp key`);
}

describe("DialCache runtime config and ramp controls", () => {
  it("rejects the removed public ramp sampler override", () => {
    expect(() => new DialCache({ rampSampler: () => 0 } as never)).toThrow(
      "DialCacheConfig.rampSampler was removed; partial ramps use DialCache's deterministic key-and-layer assignment",
    );
  });

  it("preserves requestLocal omission until baseline and runtime config are merged", () => {
    expect(new DialCacheKeyConfig({}).requestLocal).toBeUndefined();
    expect(new DialCacheKeyConfig({ requestLocal: false }).requestLocal).toBe(false);
  });

  it("preserves shadow omission and explicit kill-switch values", () => {
    expect(new DialCacheKeyConfig({}).shadow).toBeUndefined();
    expect(new DialCacheKeyConfig({ shadow: {} }).shadow).toEqual({});
    expect(new DialCacheKeyConfig({
      shadow: {
        ramp: 0,
        logMismatches: false,
        logMismatchDetails: false,
      },
    }).shadow).toEqual({
      ramp: 0,
      logMismatches: false,
      logMismatchDetails: false,
    });
  });

  it("clones the supplied shadow policy", () => {
    const suppliedShadow = {
      ramp: 25,
      logMismatches: true,
      logMismatchDetails: true,
    };
    const config = new DialCacheKeyConfig({ shadow: suppliedShadow });

    suppliedShadow.ramp = 0;
    suppliedShadow.logMismatches = false;
    suppliedShadow.logMismatchDetails = false;

    expect(config.shadow).not.toBe(suppliedShadow);
    expect(config.shadow).toEqual({
      ramp: 25,
      logMismatches: true,
      logMismatchDetails: true,
    });
  });

  it("captures an immutable default policy snapshot when the use case is registered", async () => {
    const suppliedDefault = new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
      ramp: { [CacheLayer.LOCAL]: 100 },
      shadow: {
        ramp: 25,
        logMismatches: true,
        logMismatchDetails: true,
      },
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
    const mutableShadow = suppliedDefault.shadow as {
      ramp?: number;
      logMismatches?: boolean;
      logMismatchDetails?: boolean;
    };
    mutableShadow.ramp = 0;
    mutableShadow.logMismatches = false;
    mutableShadow.logMismatchDetails = false;
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(observedDefaults).toHaveLength(2);
    expect(observedDefaults[0]).not.toBe(suppliedDefault);
    expect(observedDefaults[1]).toBe(observedDefaults[0]);
    expect(observedDefaults[0]?.ttlSec[CacheLayer.LOCAL]).toBe(60);
    expect(observedDefaults[0]?.ramp[CacheLayer.LOCAL]).toBe(100);
    expect(observedDefaults[0]?.shadow).toEqual({
      ramp: 25,
      logMismatches: true,
      logMismatchDetails: true,
    });
    expect(Object.isFrozen(observedDefaults[0])).toBe(true);
    expect(Object.isFrozen(observedDefaults[0]?.ttlSec)).toBe(true);
    expect(Object.isFrozen(observedDefaults[0]?.ramp)).toBe(true);
    expect(Object.isFrozen(observedDefaults[0]?.shadow)).toBe(true);
  });

  it("enables request-local caching without TTL or ramp policy", async () => {
    const dialcache = new DialCache();
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

  it("uses a deterministic ramp sample per cache key and layer", () => {
    // Given the internal sampler is asked to sample the same key multiple times.
    const key = new DialCacheKey({ keyType: "user_id", id: "123", useCase: "DeterministicRampSample" });

    // When the key is sampled repeatedly for a partial rollout.
    const first = deterministicRampSample(key, CacheLayer.LOCAL);
    const second = deterministicRampSample(key, CacheLayer.LOCAL);
    const remote = deterministicRampSample(key, CacheLayer.REMOTE);

    // Then the sample is stable, bounded, and layer-specific.
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
    expect(remote).toBeGreaterThanOrEqual(0);
    expect(remote).toBeLessThan(100);
    expect(remote).not.toBe(first);
    expect(first).toBe(46.13065940793604);
    expect(remote).toBe(69.22761839814484);
  });

  it("uses a stable shadow cohort independent of shared-layer ramps", () => {
    const key = new DialCacheKey({ keyType: "user_id", id: "123", useCase: "DeterministicShadowRampSample" });

    const first = deterministicShadowRampSample(key);
    const second = deterministicShadowRampSample(key);

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
    expect(first).not.toBe(deterministicRampSample(key, CacheLayer.REMOTE));
    expect(first).toBe(20.792101603001356);
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
    const dialcache = new DialCache();
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
    [
      "a null shadow config",
      () => new DialCacheKeyConfig({ shadow: null as never }),
      "DialCache shadow config must be an object",
    ],
    [
      "an array shadow config",
      () => new DialCacheKeyConfig({ shadow: [] as never }),
      "DialCache shadow config must be an object",
    ],
    [
      "the removed shadowRamp field",
      () => new DialCacheKeyConfig({ shadowRamp: 100 } as never),
      'DialCacheKeyConfig.shadowRamp was replaced by "shadow.ramp"',
    ],
  ])("rejects $0 in the public config constructor", (_name, construct, message) => {
    expect(construct).toThrow(message);
  });

  it.each([
    ["zero TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 0 } }), RangeError, "positive safe integer"],
    ["negative TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: -1 } }), RangeError, "positive safe integer"],
    ["fractional TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 0.5 } }), RangeError, "positive safe integer"],
    ["non-finite TTL", new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: Number.NaN } }), RangeError, "positive safe integer"],
    [
      "over-maximum local TTL",
      new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: MAX_CACHE_TTL_SEC + 1 } }),
      RangeError,
      `no greater than ${MAX_CACHE_TTL_SEC}`,
    ],
    [
      "maximum-safe-integer remote TTL",
      new DialCacheKeyConfig({ ttlSec: { [CacheLayer.REMOTE]: Number.MAX_SAFE_INTEGER } }),
      RangeError,
      `no greater than ${MAX_CACHE_TTL_SEC}`,
    ],
    ["negative ramp", new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: -1 } }), RangeError, "between 0 and 100"],
    ["over-100 ramp", new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: 101 } }), RangeError, "between 0 and 100"],
    ["non-finite ramp", new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: Number.POSITIVE_INFINITY } }), RangeError, "between 0 and 100"],
    [
      "negative shadow ramp",
      new DialCacheKeyConfig({ shadow: { ramp: -1 } }),
      RangeError,
      "between 0 and 100",
    ],
    [
      "over-100 shadow ramp",
      new DialCacheKeyConfig({ shadow: { ramp: 101 } }),
      RangeError,
      "between 0 and 100",
    ],
    [
      "non-finite shadow ramp",
      new DialCacheKeyConfig({ shadow: { ramp: Number.POSITIVE_INFINITY } }),
      RangeError,
      "between 0 and 100",
    ],
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
    [
      "wrong-type shadow ramp",
      new DialCacheKeyConfig({ shadow: { ramp: null as unknown as number } }),
      TypeError,
      "must be a number",
    ],
    [
      "wrong-type shadow mismatch logging flag",
      new DialCacheKeyConfig({ shadow: { logMismatches: null as unknown as boolean } }),
      TypeError,
      "must be a boolean",
    ],
    [
      "wrong-type shadow mismatch detail flag",
      new DialCacheKeyConfig({ shadow: { logMismatchDetails: null as unknown as boolean } }),
      TypeError,
      "must be a boolean",
    ],
    ["primitive config", 42 as unknown as DialCacheKeyConfig, TypeError, "must be an object"],
    ["array config", [] as unknown as DialCacheKeyConfig, TypeError, "must be an object"],
    [
      "null TTL map",
      { ttlSec: null, ramp: {} } as unknown as DialCacheKeyConfig,
      TypeError,
      "must be a layer map",
    ],
    [
      "array shadow config",
      { ttlSec: {}, ramp: {}, shadow: [] } as unknown as DialCacheKeyConfig,
      TypeError,
      "shadow must be an object",
    ],
    [
      "removed shadowRamp",
      { ttlSec: {}, ramp: {}, shadowRamp: 100 } as unknown as DialCacheKeyConfig,
      TypeError,
      'shadowRamp was replaced by "shadow.ramp"',
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
    ["an array shadow config", { ttlSec: {}, ramp: {}, shadow: [] }],
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
      shadow: {
        ramp: 0,
        logMismatches: false,
        logMismatchDetails: false,
      },
      ramp: { [CacheLayer.LOCAL]: 0, [CacheLayer.REMOTE]: 0 },
    }));
  });

  it.each([null as unknown as number, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid shadowMaxInFlight value %s",
    (shadowMaxInFlight) => {
      expect(() => new DialCache({ shadowMaxInFlight })).toThrow(
        "DialCache shadowMaxInFlight must be a positive safe integer",
      );
    },
  );

  it("accepts a positive shadowMaxInFlight", () => {
    expect(() => new DialCache({ shadowMaxInFlight: 2 })).not.toThrow();
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
    const dialcache = new DialCache();
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

    // Then ramp 0 disables the layer and ramp 100 enables it.
    expect(disabledFirst).toEqual({ userId: "123", calls: 1 });
    expect(disabledSecond).toEqual({ userId: "123", calls: 2 });
    expect(enabledFirst).toEqual({ userId: "456", calls: 1 });
    expect(enabledSecond).toEqual({ userId: "456", calls: 1 });
  });

  it("uses stable deterministic cohorts for a partial local ramp", async () => {
    // Given one key falls inside ramp 50 and another falls outside it.
    const useCase = "LocalRampFifty";
    const passingId = idForRamp(useCase, CacheLayer.LOCAL, 50, true);
    const blockedId = idForRamp(useCase, CacheLayer.LOCAL, 50, false);
    const dialcache = new DialCache();
    const calls = new Map<string, number>();
    const getUser = dialcache.cached(async (userId: string) => {
      const count = (calls.get(userId) ?? 0) + 1;
      calls.set(userId, count);
      return { userId, calls: count };
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: (userId) => userId,
      defaultConfig: configFor({ [CacheLayer.LOCAL]: 60 }, { [CacheLayer.LOCAL]: 50 }),
    });

    // When both keys are read twice.
    const passingFirst = await dialcache.enable(async () => await getUser(passingId));
    const passingSecond = await dialcache.enable(async () => await getUser(passingId));
    const blockedFirst = await dialcache.enable(async () => await getUser(blockedId));
    const blockedSecond = await dialcache.enable(async () => await getUser(blockedId));

    // Then the sampled-in key caches and the sampled-out key falls through.
    expect(passingFirst).toEqual({ userId: passingId, calls: 1 });
    expect(passingSecond).toEqual({ userId: passingId, calls: 1 });
    expect(blockedFirst).toEqual({ userId: blockedId, calls: 1 });
    expect(blockedSecond).toEqual({ userId: blockedId, calls: 2 });
  });

  it("uses stable deterministic cohorts for a partial remote ramp", async () => {
    // Given one Redis key falls inside ramp 50 and another falls outside it.
    const useCase = "RemoteRampFifty";
    const passingId = idForRamp(useCase, CacheLayer.REMOTE, 50, true);
    const blockedId = idForRamp(useCase, CacheLayer.REMOTE, 50, false);
    const redis = new FakeRedis();
    const dialcache = new DialCache({
      redis: { client: redis },
      cacheConfigProvider: async () => configFor({ [CacheLayer.REMOTE]: 60 }, { [CacheLayer.REMOTE]: 50 }),
    });
    const calls = new Map<string, number>();
    const getUser = dialcache.cached(async (userId: string) => {
      const count = (calls.get(userId) ?? 0) + 1;
      calls.set(userId, count);
      return { userId, calls: count };
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: (userId) => userId,
    });

    // When both remote-only keys are read twice.
    const passingFirst = await dialcache.enable(async () => await getUser(passingId));
    const passingSecond = await dialcache.enable(async () => await getUser(passingId));
    const blockedFirst = await dialcache.enable(async () => await getUser(blockedId));
    const blockedSecond = await dialcache.enable(async () => await getUser(blockedId));

    // Then the sampled-in key uses Redis and the sampled-out key never touches Redis.
    expect(passingFirst).toEqual({ userId: passingId, calls: 1 });
    expect(passingSecond).toEqual({ userId: passingId, calls: 1 });
    expect(blockedFirst).toEqual({ userId: blockedId, calls: 1 });
    expect(blockedSecond).toEqual({ userId: blockedId, calls: 2 });
    expect(redis.getCalls).toBe(2);
    expect(redis.setCalls).toBe(1);
  });

  it("rejects runtime ramps outside the inclusive 0-100 domain", async () => {
    // Given malformed ramp leaves arrive through otherwise well-shaped runtime config.
    const invalidRamps: readonly unknown[] = [
      -1,
      101,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "50",
    ];

    for (const [index, configuredRamp] of invalidRamps.entries()) {
      let calls = 0;
      const dialcache = new DialCache({
        cacheConfigProvider: async () => configFor(
          { [CacheLayer.LOCAL]: 60 },
          { [CacheLayer.LOCAL]: configuredRamp as number },
        ),
      });
      const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
        keyType: "user_id",
        useCase: `InvalidRuntimeRamp${index}`,
        cacheKey: (userId) => userId,
      });

      const first = await dialcache.enable(async () => await getUser("123"));
      const second = await dialcache.enable(async () => await getUser("123"));

      expect(first).toEqual({ userId: "123", calls: 1 });
      expect(second).toEqual({ userId: "123", calls: 2 });
    }
  });

  it("preserves valid runtime ramp boundaries and other active layers", async () => {
    // Given exact boundary ramps and one invalid remote ramp paired with a valid local layer.
    const boundaryCache = new DialCache({
      cacheConfigProvider: async (key) => configFor(
        { [CacheLayer.LOCAL]: 60 },
        { [CacheLayer.LOCAL]: key.useCase === "ZeroRuntimeRamp" ? 0 : 100 },
      ),
    });
    let zeroCalls = 0;
    const zeroRamp = boundaryCache.cached(async () => ++zeroCalls, {
      keyType: "user_id",
      useCase: "ZeroRuntimeRamp",
      cacheKey: () => "123",
    });
    let hundredCalls = 0;
    const hundredRamp = boundaryCache.cached(async () => ++hundredCalls, {
      keyType: "user_id",
      useCase: "HundredRuntimeRamp",
      cacheKey: () => "456",
    });

    expect(await boundaryCache.enable(async () => await zeroRamp())).toBe(1);
    expect(await boundaryCache.enable(async () => await zeroRamp())).toBe(2);
    expect(await boundaryCache.enable(async () => await hundredRamp())).toBe(1);
    expect(await boundaryCache.enable(async () => await hundredRamp())).toBe(1);

    const redis = new FakeRedis();
    let mixedCalls = 0;
    const mixedCache = new DialCache({
      redis: { client: redis },
      cacheConfigProvider: async () => configFor(
        { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 60 },
        { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: -1 },
      ),
    });
    const mixedRamp = mixedCache.cached(async () => ++mixedCalls, {
      keyType: "user_id",
      useCase: "InvalidRemoteValidLocalRamp",
      cacheKey: () => "789",
    });

    expect(await mixedCache.enable(async () => await mixedRamp())).toBe(1);
    expect(await mixedCache.enable(async () => await mixedRamp())).toBe(1);
    expect(redis.getCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
  });

  it("rejects unsupported runtime TTLs before cache or serialization work", async () => {
    // Given invalid TTL values are configured for local and remote layers.
    const redis = new FakeRedis();
    type Value = { readonly userId: string; readonly ttl: string; readonly calls: number };
    const serializer: Serializer<Value> = {
      dump: vi.fn(async (value) => JSON.stringify(value)),
      load: vi.fn(async (value) =>
        JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value) as Value
      ),
    };
    const badTtls = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0.5,
      MAX_CACHE_TTL_SEC + 1,
      Number.MAX_SAFE_INTEGER,
    ];

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
        serializer,
      });

      const first = await dialcache.enable(async () => await getUser("123"));
      const second = await dialcache.enable(async () => await getUser("123"));

      expect(first.calls).toBe(1);
      expect(second.calls).toBe(2);
    }

    // Then no invalid TTL reaches a cache layer or serializer.
    expect(redis.getCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
    expect(serializer.dump).not.toHaveBeenCalled();
    expect(serializer.load).not.toHaveBeenCalled();
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

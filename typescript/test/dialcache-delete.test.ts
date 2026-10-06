import { describe, expect, it, vi } from "vitest";
import {
  CacheLayer, DialCache, DialCacheKey, DialCacheKeyConfig, RemoteDeleteUnsupportedError,
  UseCaseNameIsReservedError, type CacheIdentityOptions, type CachedOptions,
  type DialCacheMetricsAdapter, type DialCacheRedisClient, type GetOrLoadOptions,
} from "../src/index.js";
import { FakeRedis } from "./fake-redis.js";

const identity = { keyType: "user_id", useCase: "GetUser", key: { id: "123", args: { locale: "en" } } } as const;
const policy = new DialCacheKeyConfig({ requestLocal: true, ttlSec: { local: 60, remote: 60 }, ramp: { local: 100, remote: 100 } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const valueKey = (tracked = false) => `${new DialCacheKey({ keyType: identity.keyType, useCase: identity.useCase,
  id: identity.key.id, args: [["locale", "en"]], trackForInvalidation: tracked }).urn}:dialcache-frame-v1`;
function withoutDelete(redis: FakeRedis): DialCacheRedisClient {
  return { read: redis.read.bind(redis), write: redis.write.bind(redis), invalidate: redis.invalidate.bind(redis) };
}
function observer() {
  const metrics = { request: vi.fn(), miss: vi.fn(), disabled: vi.fn(), error: vi.fn(), invalidation: vi.fn(),
    deletion: vi.fn(), observeGet: vi.fn(), observeFallback: vi.fn(), observeSerialization: vi.fn(), observeSize: vi.fn() } satisfies DialCacheMetricsAdapter;
  return metrics;
}

// Compile-time contracts: reader options carry an identity; a selector does not.
function typeContracts(cache: DialCache, options: GetOrLoadOptions<number>, registered: CachedOptions<() => number>) {
  void cache.delete(options);
  // @ts-expect-error CachedOptions names a selector, not a concrete key.
  void cache.delete(registered);
}
void typeContracts;

describe("exact-key delete", () => {
  it.each([false, true])("removes all reachable stores, including a disabled live memo (disabled=%s)", async disabled => {
    const redis = new FakeRedis();
    const configProvider = vi.fn(() => policy);
    const cache = new DialCache({ redis: { client: redis }, cacheConfigProvider: configProvider });
    const source = vi.fn(async () => source.mock.calls.length);
    await cache.enable(async () => {
      expect(await cache.getOrLoad(source, identity)).toBe(1);
      await tick();
      expect(redis.values.has(valueKey())).toBe(true);
      const lookups = configProvider.mock.calls.length;
      if (disabled) await cache.disable(() => cache.delete(identity));
      else await cache.delete(identity);
      expect(configProvider).toHaveBeenCalledTimes(lookups);
      expect(redis.values.has(valueKey())).toBe(false);
      expect(await cache.getOrLoad(source, identity)).toBe(2);
    });
  });

  it.each([0, 5])("works without a remote, outside a scope, and on absent entries (capacity=%s)", async localMaxSize => {
    const cache = new DialCache({ localMaxSize, cacheConfigProvider: () => policy });
    const source = vi.fn(async () => source.mock.calls.length);
    expect(await cache.enable(() => cache.getOrLoad(source, identity))).toBe(1);
    await cache.delete(identity);
    await cache.delete(identity);
    expect(await cache.enable(() => cache.getOrLoad(source, identity))).toBe(2);
  });

  it("keeps the live memo and local entry until the remote step succeeds", async () => {
    const redis = new FakeRedis();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalDelete = redis.delete.bind(redis);
    const remove = vi.spyOn(redis, "delete").mockImplementation(async request => { await gate; await originalDelete(request); });
    const cache = new DialCache({ redis: { client: redis }, cacheConfigProvider: () => policy });
    const source = vi.fn(async () => source.mock.calls.length);
    await cache.enable(async () => {
      await cache.getOrLoad(source, identity);
      await tick();
      const pending = cache.delete(identity);
      expect(remove).toHaveBeenCalledOnce();
      expect(await cache.getOrLoad(source, identity)).toBe(1);
      release();
      await pending;
      expect(await cache.getOrLoad(source, identity)).toBe(2);
    });
  });

  it.each(["unsupported", "failure"] as const)("%s leaves local and memo intact", async mode => {
    const redis = new FakeRedis();
    const metrics = observer();
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const failure = new Error("DEL failed");
    const adapter = mode === "unsupported" ? withoutDelete(redis) : redis;
    const cache = new DialCache({ redis: { client: adapter }, cacheConfigProvider: () => policy, metrics, logger });
    const source = vi.fn(async () => source.mock.calls.length);
    await cache.enable(async () => {
      expect(await cache.getOrLoad(source, identity)).toBe(1);
      await tick();
      if (mode === "failure") vi.spyOn(redis, "delete").mockRejectedValue(failure);
      await expect(cache.delete(identity)).rejects.toSatisfy(error => mode === "unsupported"
        ? error instanceof RemoteDeleteUnsupportedError : error === failure);
      expect(await cache.getOrLoad(source, identity)).toBe(1);
      expect(redis.values.has(valueKey())).toBe(true);
    });
    expect(await cache.enable(() => cache.getOrLoad(source, identity))).toBe(1);
    expect(metrics.deletion).toHaveBeenCalledTimes(mode === "failure" ? 1 : 0);
    expect(logger.warn).toHaveBeenCalledTimes(mode === "failure" ? 1 : 0);
    if (mode === "failure") expect(metrics.error).toHaveBeenCalledWith({ cacheNamespace: "urn", keyType: "user_id",
      useCase: "GetUser", layer: "remote", error: "deletion", inFallback: false });
  });

  it("validates reserved use cases and key construction before capability, metrics or mutation", async () => {
    const redis = new FakeRedis();
    const remove = vi.spyOn(redis, "delete");
    const metrics = observer();
    const cache = new DialCache({ redis: { client: redis }, cacheConfigProvider: () => policy, metrics });
    await cache.enable(() => cache.getOrLoad(async () => 1, identity));
    await tick();
    await expect(cache.delete({ ...identity, useCase: "watermark" })).rejects.toBeInstanceOf(UseCaseNameIsReservedError);
    await expect(cache.delete({ ...identity, key: null } as unknown as CacheIdentityOptions)).rejects.toBeInstanceOf(TypeError);
    expect(remove).not.toHaveBeenCalled();
    expect(metrics.deletion).not.toHaveBeenCalled();
    expect(redis.values.has(valueKey())).toBe(true);
    expect(await cache.enable(() => cache.getOrLoad(async () => 2, identity))).toBe(1);
  });

  it.each([false, true])("deletes exact key bytes and preserves watermarks and siblings (tracked=%s)", async tracked => {
    const redis = new FakeRedis();
    const cache = new DialCache({ redis: { client: redis }, cacheConfigProvider: () => policy });
    const options = { ...identity, trackForInvalidation: tracked };
    const other = { ...options, key: { id: "123", args: { locale: "fr" } } };
    await cache.enable(() => cache.getOrLoad(async () => 1, options));
    await cache.enable(() => cache.getOrLoad(async () => 2, other));
    await tick();
    await cache.invalidateRemote("user_id", "123");
    const watermark = [...redis.values].find(([key]) => key.endsWith("#watermark"))!;
    const snapshot = new Map(redis.values);
    const remove = vi.spyOn(redis, "delete");
    await cache.delete(options);
    expect(remove).toHaveBeenCalledExactlyOnceWith({ valueKey: valueKey(tracked) });
    snapshot.delete(valueKey(tracked));
    expect(redis.values).toEqual(snapshot);
    expect(redis.values.get(watermark[0])).toBe(watermark[1]);
  });

  it("outside deletion leaves another request's acquired memo and another instance's local entry", async () => {
    const redis = new FakeRedis();
    const cache = new DialCache({ redis: { client: redis }, cacheConfigProvider: () => policy });
    const other = new DialCache({ redis: { client: redis }, cacheConfigProvider: () => policy });
    let ready!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const active = cache.enable(async () => {
      await cache.getOrLoad(async () => 1, identity);
      await tick();
      ready();
      await gate;
      return cache.getOrLoad(async () => 2, identity);
    });
    await started;
    expect(await other.enable(() => other.getOrLoad(async () => 3, identity))).toBe(1);
    await cache.delete(identity);
    resume();
    expect(await active).toBe(1);
    expect(await other.enable(() => other.getOrLoad(async () => 4, identity))).toBe(1);
    expect(await cache.enable(() => cache.getOrLoad(async () => 5, identity))).toBe(5);
  });

  it("does not detach active flights or suppress their later publication", async () => {
    const cache = new DialCache({ cacheConfigProvider: () => new DialCacheKeyConfig({ ttlSec: { local: 60 } }) });
    let release!: (value: number) => void;
    const source = vi.fn(() => new Promise<number>(resolve => { release = resolve; }));
    const first = cache.enable(() => cache.getOrLoad(source, identity));
    await tick();
    await cache.delete(identity);
    const follower = cache.enable(() => cache.getOrLoad(source, identity));
    await tick();
    expect(source).toHaveBeenCalledOnce();
    release(7);
    expect(await first).toBe(7);
    expect(await follower).toBe(7);
    expect(await cache.enable(() => cache.getOrLoad(async () => 8, identity))).toBe(7);
  });

  it("ignores reader configuration and serializer fields", async () => {
    const cache = new DialCache({ cacheConfigProvider: () => { throw new Error("policy consulted"); } });
    await cache.delete({ ...identity,
      get serializer() { throw new Error("serializer consulted"); },
      get defaultConfig() { throw new Error("config consulted"); },
    } as CacheIdentityOptions);
  });

  it("an ambiguous remote error surfaces even if the remote value was already removed", async () => {
    const redis = new FakeRedis();
    const cache = new DialCache({ redis: { client: redis }, cacheConfigProvider: () => policy,
      logger: { warn() {}, error() {}, debug() {} } });
    await cache.enable(async () => {
      await cache.getOrLoad(async () => 1, identity);
      await tick();
      vi.spyOn(redis, "delete").mockImplementation(async ({ valueKey }) => {
        redis.values.delete(valueKey);
        throw new Error("reply lost");
      });
      await expect(cache.delete(identity)).rejects.toThrow("reply lost");
      expect(redis.values.has(valueKey())).toBe(false);
      expect(await cache.getOrLoad(async () => 2, identity)).toBe(1);
    });
    expect(await cache.enable(() => cache.getOrLoad(async () => 3, identity))).toBe(1);
  });

  it("an acquired remote snapshot can finish decoding after deletion", async () => {
    const redis = new FakeRedis();
    redis.setRaw(valueKey(), (await import("./fake-redis.js")).encodeFrame("1", Date.now()));
    let acquired!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cache = new DialCache({ redis: { client: redis }, cacheConfigProvider: () => policy });
    const read = cache.enable(() => cache.getOrLoad(async () => 2, { ...identity,
      serializer: { dump: JSON.stringify, async load() { acquired(); await gate; return 1; } },
    }));
    await started;
    await cache.delete(identity);
    expect(redis.values.has(valueKey())).toBe(false);
    release();
    expect(await read).toBe(1);
  });

  it("counts local-only deletion separately from invalidation and isolates observer failures", async () => {
    const metrics = observer();
    const cache = new DialCache({ metrics });
    metrics.deletion.mockImplementation(() => { throw new Error("observer failed"); });
    await cache.delete(identity);
    expect(metrics.deletion).toHaveBeenCalledWith({ cacheNamespace: "urn", keyType: "user_id", useCase: "GetUser", layer: CacheLayer.LOCAL });
    expect(metrics.invalidation).not.toHaveBeenCalled();
  });
});

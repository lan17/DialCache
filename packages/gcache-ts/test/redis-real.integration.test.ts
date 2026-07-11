import { createClient } from "redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  GCache,
  GCacheKeyConfig,
  type GCacheMetricsAdapter,
  type GCacheRedisClient,
  type Serializer,
} from "../src/index.js";
import { createNodeRedisGCacheClient, gcacheRedisScripts } from "../src/node-redis.js";

const engines = [
  { name: "Redis 6.2", image: "redis:6.2-alpine" },
  { name: "Valkey 8", image: "valkey/valkey:8-alpine" },
] as const;

const remoteOnly = new GCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

const createTestClient = (url: string) => createClient({ url, scripts: gcacheRedisScripts });

function encodeFrame(payload: string, encoding: number): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Date.now()));
  return Buffer.concat([Buffer.from([1]), timestamp, Buffer.from([encoding]), Buffer.from(payload)]);
}

describe.each(engines)("GCache Lua protocol on $name", ({ image }) => {
  let container: StartedTestContainer | undefined;
  let client: ReturnType<typeof createTestClient> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(image)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    client = createTestClient(`redis://${container.getHost()}:${container.getMappedPort(6379)}`);
    client.on("error", () => undefined);
    await client.connect();
  });

  afterAll(async () => {
    await client?.quit();
    await container?.stop();
  });

  it("round-trips untracked UTF-8 and binary values", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient: GCacheRedisClient = createNodeRedisGCacheClient(client);
    const gcache = new GCache({ redis: { client: scriptClient, keyPrefix: "real:" } });
    let jsonCalls = 0;
    let binaryCalls = 0;
    const getJson = gcache.cached(async (id: string) => ({ id, calls: ++jsonCalls }), {
      keyType: "item_id",
      useCase: "RealJson",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly,
    });
    const binarySerializer: Serializer<string> = {
      dump: async (value) => Buffer.from(value, "utf8"),
      load: async (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value),
    };
    const getBinary = gcache.cached(async (id: string) => `binary:${id}:${++binaryCalls}`, {
      keyType: "item_id",
      useCase: "RealBinary",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly,
      serializer: binarySerializer,
    });

    const firstJson = await gcache.enable(async () => await getJson("json"));
    const secondJson = await gcache.enable(async () => await getJson("json"));
    const firstBinary = await gcache.enable(async () => await getBinary("buffer"));
    const secondBinary = await gcache.enable(async () => await getBinary("buffer"));

    expect(firstJson).toEqual({ id: "json", calls: 1 });
    expect(secondJson).toEqual(firstJson);
    expect(firstBinary).toBe("binary:buffer:1");
    expect(secondBinary).toBe(firstBinary);
    expect(jsonCalls).toBe(1);
    expect(binaryCalls).toBe(1);
  });

  it("invalidates tracked entries and recovers after SCRIPT FLUSH", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient: GCacheRedisClient = createNodeRedisGCacheClient(client);
    const gcache = new GCache({ redis: { client: scriptClient, keyPrefix: "tracked:" } });
    let version = 1;
    let calls = 0;
    const getUser = gcache.cached(async (id: string) => ({ id, version, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RealTracked",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });

    const first = await gcache.enable(async () => await getUser("123"));
    version = 2;
    const cached = await gcache.enable(async () => await getUser("123"));
    await gcache.invalidateRemote("user_id", "123");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const refreshed = await gcache.enable(async () => await getUser("123"));
    await client.scriptFlush();
    const afterScriptFlush = await gcache.enable(async () => await getUser("123"));

    expect(first).toEqual({ id: "123", version: 1, calls: 1 });
    expect(cached).toEqual(first);
    expect(refreshed).toEqual({ id: "123", version: 2, calls: 2 });
    expect(afterScriptFlush).toEqual(refreshed);
  });

  it("fails open without caching malformed watermark state", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisGCacheClient(client);
    const logger = { debug: () => undefined, warn: () => undefined, error: () => undefined };
    const gcache = new GCache({ redis: { client: scriptClient, keyPrefix: "malformed:" }, logger });
    let calls = 0;
    const getUser = gcache.cached(async (id: string) => ({ id, calls: ++calls }), {
      keyType: "user_id",
      useCase: "MalformedWatermark",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });
    await client.set("malformed:{urn:user_id:bad}#watermark", "0x10");

    const first = await gcache.enable(async () => await getUser("bad"));
    const second = await gcache.enable(async () => await getUser("bad"));

    expect(first).toEqual({ id: "bad", calls: 1 });
    expect(second).toEqual({ id: "bad", calls: 2 });
  });

  it("labels malformed payload encoding through the production adapter", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const adapter = createNodeRedisGCacheClient(client);
    const write = vi.fn(adapter.write);
    const redisClient: GCacheRedisClient = { ...adapter, write };
    const metrics: GCacheMetricsAdapter = {
      request: vi.fn(),
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
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const keyPrefix = "bad-encoding:";
    const valueKey = `${keyPrefix}{urn:user_id:bad}#RealMalformedEncoding:gcache-frame-v1`;
    const watermarkKey = `${keyPrefix}{urn:user_id:bad}#watermark`;
    await client.set(valueKey, encodeFrame("malformed", 2), { PX: 60_000 });
    await client.set(watermarkKey, "0", { PX: 60_000 });

    const gcache = new GCache({ redis: { client: redisClient, keyPrefix }, logger, metrics });
    let calls = 0;
    const getUser = gcache.cached(async (id: string) => ({ id, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RealMalformedEncoding",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });

    const value = await gcache.enable(async () => await getUser("bad"));

    expect(value).toEqual({ id: "bad", calls: 1 });
    expect(write).not.toHaveBeenCalled();
    expect(metrics.error).toHaveBeenCalledWith({
      useCase: "RealMalformedEncoding",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
      error: "GCacheRedisPayloadEncodingError",
      inFallback: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Error getting value from Redis cache",
      expect.objectContaining({ name: "GCacheRedisPayloadEncodingError" }),
    );
  });

  it("preserves a fractional legacy watermark when invalidating", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisGCacheClient(client);
    const watermarkKey = "legacy:{urn:user_id:123}#watermark";
    const legacyWatermark = Date.now() + 60_000.5;
    await client.set(watermarkKey, String(legacyWatermark), { PX: 120_000 });

    await scriptClient.invalidate({
      watermarkKey,
      futureBufferMs: 1_000,
      watermarkTtlFloorMs: 60_000,
    });

    expect(Number(await client.get(watermarkKey))).toBeGreaterThanOrEqual(Math.ceil(legacyWatermark));
  });

  it("preserves a fractional legacy watermark while extending its TTL", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisGCacheClient(client);
    const valueKey = "legacy-write:{urn:user_id:123}:value";
    const watermarkKey = "legacy-write:{urn:user_id:123}:watermark";
    await client.set(watermarkKey, "1.75", { PX: 1_000 });

    const wrote = await scriptClient.write({
      valueKey,
      watermarkKey,
      cacheTtlMs: 2_000,
      encoding: "utf8",
      value: "cached",
      watermarkTtlFloorMs: 1_000,
    });

    expect(wrote).toBe(true);
    expect(await client.get(watermarkKey)).toBe("1.75");
    expect(await client.pTTL(watermarkKey)).toBeGreaterThanOrEqual(61_000);
    expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({ encoding: "utf8", value: "cached" });
  });

  it("atomically blocks writes during the buffer and extends watermark TTL", async () => {
    if (client === undefined) {
      throw new Error("Redis client did not start");
    }
    const scriptClient = createNodeRedisGCacheClient(client);
    const valueKey = "protocol:{item:ttl}:value";
    const watermarkKey = "protocol:{item:ttl}:watermark";
    const writeRequest = {
      valueKey,
      watermarkKey,
      cacheTtlMs: 2_000,
      encoding: "utf8" as const,
      value: "cached",
      watermarkTtlFloorMs: 1_000,
    };

    expect(await scriptClient.write(writeRequest)).toBe(true);
    const ttlAfterWrite = await client.pTTL(watermarkKey);
    expect(ttlAfterWrite).toBeGreaterThanOrEqual(61_000);

    await scriptClient.invalidate({ watermarkKey, futureBufferMs: 100, watermarkTtlFloorMs: 1_000 });
    expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();
    expect(await scriptClient.write(writeRequest)).toBe(false);
    const ttlBeforeRead = await client.pTTL(watermarkKey);
    await scriptClient.read({ valueKey, watermarkKey });
    expect(await client.pTTL(watermarkKey)).toBeLessThanOrEqual(ttlBeforeRead);

    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(await scriptClient.write(writeRequest)).toBe(true);
    expect(await scriptClient.read({ valueKey, watermarkKey })).toEqual({ encoding: "utf8", value: "cached" });
  });
});

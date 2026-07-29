import * as valkeyGlide from "@valkey/valkey-glide";
import { commandOptions, createClient } from "redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type Serializer,
} from "../src/index.js";
import {
  INVALIDATE_CACHE_SCRIPT,
  WRITE_CACHE_SCRIPT,
  WRITE_TRACKED_CACHE_SCRIPT,
} from "../src/internal/redis-scripts.js";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "../src/node-redis.js";
import {
  createValkeyGlideDialCacheClient,
  type ValkeyGlideDialCacheClient,
} from "../src/valkey-glide.js";

const engines = [
  { name: "Redis 6.2", image: "redis:6.2-alpine" },
  { name: "Valkey 8", image: "valkey/valkey:8-alpine" },
] as const;

const adapterKinds = [
  { kind: "nodeRedis", name: "node-redis" },
  { kind: "valkeyGlide", name: "Valkey GLIDE" },
] as const;
type AdapterKind = (typeof adapterKinds)[number]["kind"];

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const remoteOnly = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

const createTestClient = (url: string) => createClient({ url, scripts: dialcacheRedisScripts });
type NodeRedisTestClient = ReturnType<typeof createTestClient>;

interface RawRedisScriptClient {
  write(
    valueKey: string,
    cacheTtlMs: number,
    encoding: number,
    payload: string | Buffer,
  ): Promise<number>;
  writeTracked(
    valueKey: string,
    watermarkKey: string,
    cacheTtlMs: number,
    encoding: number,
    payload: string | Buffer,
  ): Promise<number>;
  invalidate(watermarkKey: string, futureBufferMs: number): Promise<number>;
}

interface RedisAdapterHarness {
  readonly adapter: DialCacheRedisClient;
  /** Exercise Lua argument validation that the semantic adapter cannot represent. */
  readonly raw: RawRedisScriptClient;
  dispose(): void;
}

function createNodeRedisHarness(client: NodeRedisTestClient): RedisAdapterHarness {
  return {
    adapter: createNodeRedisDialCacheClient(client),
    raw: {
      write: async (...args) => await client.dialcacheWrite(...args),
      writeTracked: async (...args) => await client.dialcacheWriteTracked(...args),
      invalidate: async (...args) => await client.dialcacheInvalidate(...args),
    },
    dispose: () => undefined,
  };
}

function createValkeyGlideHarness(client: valkeyGlide.GlideClient): RedisAdapterHarness {
  const adapter: ValkeyGlideDialCacheClient = createValkeyGlideDialCacheClient(client, valkeyGlide);
  const rawScripts = {
    write: new valkeyGlide.Script(WRITE_CACHE_SCRIPT),
    writeTracked: new valkeyGlide.Script(WRITE_TRACKED_CACHE_SCRIPT),
    invalidate: new valkeyGlide.Script(INVALIDATE_CACHE_SCRIPT),
  };
  const invoke = async (
    script: valkeyGlide.Script,
    keys: Array<string>,
    args: Array<string | Buffer>,
  ): Promise<number> => {
    const reply = await client.invokeScript(script, {
      keys,
      args,
      decoder: valkeyGlide.Decoder.Bytes,
    });
    if (typeof reply !== "number") {
      throw new Error("Unexpected non-integer reply from DialCache test script");
    }
    return reply;
  };

  return {
    adapter,
    raw: {
      write: async (valueKey, cacheTtlMs, encoding, payload) =>
        await invoke(rawScripts.write, [valueKey], [String(cacheTtlMs), String(encoding), payload]),
      writeTracked: async (
        valueKey,
        watermarkKey,
        cacheTtlMs,
        encoding,
        payload,
      ) =>
        await invoke(
          rawScripts.writeTracked,
          [valueKey, watermarkKey],
          [String(cacheTtlMs), String(encoding), payload],
        ),
      invalidate: async (watermarkKey, futureBufferMs) =>
        await invoke(
          rawScripts.invalidate,
          [watermarkKey],
          [String(futureBufferMs)],
        ),
    },
    dispose() {
      adapter.dispose();
      for (const script of Object.values(rawScripts)) {
        script.release();
      }
    },
  };
}

function encodeFrame(payload: string | Buffer, encoding: number, createdAtMs = Date.now(), version = 1): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(createdAtMs));
  return Buffer.concat([Buffer.from([version]), timestamp, Buffer.from([encoding]), Buffer.from(payload)]);
}

describe.each(engines)("DialCache Lua protocol on $name", ({ image }) => {
  let container: StartedTestContainer | undefined;
  // This connection controls and inspects server state; cache operations use the selected adapter harness.
  let admin: NodeRedisTestClient | undefined;
  let glide: valkeyGlide.GlideClient | undefined;
  let harnesses: Record<AdapterKind, RedisAdapterHarness> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(image)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    const host = container.getHost();
    const port = container.getMappedPort(6379);
    admin = createTestClient(`redis://${host}:${port}`);
    admin.on("error", () => undefined);
    await admin.connect();
    glide = await valkeyGlide.GlideClient.createClient({ addresses: [{ host, port }] });
    harnesses = {
      nodeRedis: createNodeRedisHarness(admin),
      valkeyGlide: createValkeyGlideHarness(glide),
    };
  });

  afterAll(async () => {
    for (const harness of Object.values(harnesses ?? {})) {
      harness.dispose();
    }
    glide?.close();
    await admin?.quit();
    await container?.stop();
  });

  describe.each(adapterKinds)("with $name", ({ kind }) => {
    let client: RedisAdapterHarness | undefined;

    beforeEach(async () => {
      if (admin === undefined || harnesses === undefined) {
        throw new Error("Redis test clients did not start");
      }
      await admin.flushAll();
      client = harnesses[kind];
    });

    it("round-trips untracked UTF-8, binary, and inline-loader values", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient: DialCacheRedisClient = client.adapter;
      const dialcache = new DialCache({ namespace: "real", redis: { client: scriptClient, readTimeoutMs: 10_000 } });
      let jsonCalls = 0;
      let binaryCalls = 0;
      const getJson = dialcache.cached(async (id: string) => ({ id, calls: ++jsonCalls }), {
        keyType: "item_id",
        useCase: "RealJson",
        cacheKey: (id) => id,
        defaultConfig: remoteOnly,
      });
      const binarySerializer: Serializer<string> = {
        dump: async (value) => Buffer.from(value, "utf8"),
        load: async (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value),
      };
      const getBinary = dialcache.cached(async (id: string) => `binary:${id}:${++binaryCalls}`, {
        keyType: "item_id",
        useCase: "RealBinary",
        cacheKey: (id) => id,
        defaultConfig: remoteOnly,
        serializer: binarySerializer,
      });
      let inlineCalls = 0;
      const inlineOptions = {
        keyType: "item_id",
        useCase: "RealInline",
        key: "inline",
        defaultConfig: remoteOnly,
      } as const;

      const firstJson = await dialcache.enable(async () => await getJson("json"));
      const secondJson = await dialcache.enable(async () => await getJson("json"));
      const firstBinary = await dialcache.enable(async () => await getBinary("buffer"));
      const secondBinary = await dialcache.enable(async () => await getBinary("buffer"));
      const firstInline = await dialcache.enable(async () =>
        await dialcache.getOrLoad(async () => ({ source: "inline", calls: ++inlineCalls }), inlineOptions),
      );
      const secondInline = await dialcache.enable(async () =>
        await dialcache.getOrLoad(async () => ({ source: "unexpected", calls: ++inlineCalls }), inlineOptions),
      );

      expect(firstJson).toEqual({ id: "json", calls: 1 });
      expect(secondJson).toEqual(firstJson);
      expect(firstBinary).toBe("binary:buffer:1");
      expect(secondBinary).toBe(firstBinary);
      expect(firstInline).toEqual({ source: "inline", calls: 1 });
      expect(secondInline).toEqual(firstInline);
      expect(jsonCalls).toBe(1);
      expect(binaryCalls).toBe(1);
      expect(inlineCalls).toBe(1);
    });

    it("stores arbitrary binary payloads without base64 expansion", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const payloads = [
        Buffer.alloc(0),
        Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
        Buffer.alloc(2 * 1024 * 1024, 0xa5),
      ];

      for (const [index, payload] of payloads.entries()) {
        const valueKey = `binary-raw:{item:${index}}:value`;
        expect(await scriptClient.write({ valueKey, cacheTtlMs: 60_000, value: payload })).toBe(true);

        const roundTrip = await scriptClient.read({ valueKey });
        const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);

        expect(Buffer.isBuffer(roundTrip)).toBe(true);
        expect(roundTrip).toEqual(payload);
        expect(stored).not.toBeNull();
        expect(stored?.length).toBe(10 + payload.length);
        expect(stored?.[0]).toBe(1);
        expect(stored?.[9]).toBe(1);
        expect(stored?.subarray(10)).toEqual(payload);
      }

      const trackedValueKey = "binary-raw:{item:tracked}:value";
      const watermarkKey = "binary-raw:{item:tracked}:watermark";
      const trackedPayload = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);
      expect(
        await scriptClient.write({
          valueKey: trackedValueKey,
          watermarkKey,
          cacheTtlMs: 60_000,
          value: trackedPayload,
        }),
      ).toBe(true);
      expect(await scriptClient.read({ valueKey: trackedValueKey, watermarkKey })).toEqual(trackedPayload);
    });

    it("shadow-validates the deserialized tracked value without repairing a mismatch", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const cachedPayload = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);
      const mismatchPayload = Buffer.from([0, 0xff, 0xc3, 0x28, 0x81]);
      const namespace = "real-shadow";
      const useCase = "RealShadowPayload";
      const valueKey = `{${namespace}:item_id:binary}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:binary}#watermark`;
      const storedFrame = encodeFrame(cachedPayload, 1);
      await admin.set(valueKey, storedFrame, { PX: 60_000 });
      await admin.set(watermarkKey, "0", { PX: 60_000 });

      const write = vi.fn(client.adapter.write);
      const invalidate = vi.fn(client.adapter.invalidate);
      const redisClient: DialCacheRedisClient = { ...client.adapter, write, invalidate };
      const matched = deferred<void>();
      const mismatched = deferred<void>();
      const metrics: DialCacheMetricsAdapter = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        shadowValidation: vi.fn(({ outcome }) => {
          if (outcome === "match") {
            matched.resolve();
          } else if (outcome === "mismatch") {
            mismatched.resolve();
          }
        }),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      };
      const serializer: Serializer<Buffer> = {
        dump: vi.fn((value) => value),
        load: vi.fn((value) => {
          if (!Buffer.isBuffer(value)) {
            throw new Error("Expected the binary Redis payload");
          }
          return Buffer.from(value);
        }),
      };
      const shadowRemoteOnly = new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
        shadowRamp: 100,
      });
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        metrics,
      });
      let sourcePayload: Buffer = Buffer.from(cachedPayload);
      let sourceCalls = 0;
      const getPayload = dialcache.cached(
        async (): Promise<Buffer> => {
          sourceCalls += 1;
          return sourcePayload;
        },
        {
          keyType: "item_id",
          useCase,
          cacheKey: () => "binary",
          trackForInvalidation: true,
          defaultConfig: shadowRemoteOnly,
          serializer,
        },
      );

      const matchingHit = await dialcache.enable(async () => await getPayload());
      expect(matchingHit).toEqual(cachedPayload);
      await matched.promise;

      sourcePayload = mismatchPayload;
      const mismatchingHit = await dialcache.enable(async () => await getPayload());
      expect(mismatchingHit).toEqual(cachedPayload);
      await mismatched.promise;

      expect(sourceCalls).toBe(2);
      expect(serializer.load).toHaveBeenCalledTimes(4);
      expect(serializer.dump).not.toHaveBeenCalled();
      expect(metrics.shadowValidation).toHaveBeenNthCalledWith(1, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "match",
      });
      expect(metrics.shadowValidation).toHaveBeenNthCalledWith(2, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "mismatch",
      });
      expect(write).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(await admin.get(commandOptions({ returnBuffers: true }), valueKey)).toEqual(storedFrame);
    });

    it("recovers every Lua script after SCRIPT FLUSH", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "script-recovery:{item:untracked}:value";

      await admin.scriptFlush();
      expect(await scriptClient.write({ valueKey, cacheTtlMs: 60_000, value: "untracked" })).toBe(true);
      await admin.scriptFlush();
      expect(await scriptClient.read({ valueKey })).toBe("untracked");

      const trackedValueKey = "script-recovery:{item:tracked}:value";
      const watermarkKey = "script-recovery:{item:tracked}:watermark";
      await admin.scriptFlush();
      expect(
        await scriptClient.write({
          valueKey: trackedValueKey,
          watermarkKey,
          cacheTtlMs: 60_000,
          value: "tracked",
        }),
      ).toBe(true);
      await admin.scriptFlush();
      expect(await scriptClient.read({ valueKey: trackedValueKey, watermarkKey })).toBe("tracked");
      await admin.scriptFlush();
      await expect(
        scriptClient.invalidate({
          watermarkKey,
          futureBufferMs: 0,
        }),
      ).resolves.toBeUndefined();
    });

    it("treats every invalid read frame and watermark state as a miss", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "read-paths:{item:read}:value";
      const watermarkKey = "read-paths:{item:read}:watermark";

      expect(await scriptClient.read({ valueKey })).toBeNull();

      await admin.set(valueKey, Buffer.alloc(9));
      expect(await scriptClient.read({ valueKey })).toBeNull();

      await admin.set(valueKey, encodeFrame("wrong-version", 0, 1_000, 2));
      expect(await scriptClient.read({ valueKey })).toBeNull();

      await admin.set(valueKey, encodeFrame("tracked", 0, 1_000));
      expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();

      await admin.set(watermarkKey, "not-a-watermark");
      expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();

      await admin.set(watermarkKey, "9".repeat(400));
      expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();

      await admin.set(watermarkKey, "1000");
      expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();

      await admin.set(watermarkKey, "999.5");
      expect(await scriptClient.read({ valueKey, watermarkKey })).toBe("tracked");
    });

    it("rejects invalid raw script arguments before mutating Redis", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "invalid-args:{item:invalid}:value";
      const watermarkKey = "invalid-args:{item:invalid}:watermark";
      const notANumber = "not-a-number" as unknown as number;

      await expect(client.raw.write(valueKey, 0, 0, "value")).rejects.toThrow("invalid DialCache TTL");
      await expect(client.raw.write(valueKey, notANumber, 0, "value")).rejects.toThrow("invalid DialCache TTL");
      await expect(client.raw.write(valueKey, Number.NaN, 0, "value")).rejects.toThrow("invalid DialCache TTL");
      await expect(client.raw.write(valueKey, Number.POSITIVE_INFINITY, 0, "value")).rejects.toThrow("invalid DialCache TTL");
      await expect(client.raw.write(valueKey, Number.NEGATIVE_INFINITY, 0, "value")).rejects.toThrow("invalid DialCache TTL");
      await expect(client.raw.write(valueKey, 1_000, notANumber, "value")).rejects.toThrow("invalid DialCache payload encoding");
      await expect(client.raw.write(valueKey, 1_000, Number.NaN, "value")).rejects.toThrow("invalid DialCache payload encoding");
      await expect(client.raw.write(valueKey, 1_000, 2, "value")).rejects.toThrow("invalid DialCache payload encoding");
      await expect(client.raw.invalidate(watermarkKey, -1)).rejects.toThrow("invalid DialCache future buffer");
      await expect(client.raw.invalidate(watermarkKey, notANumber)).rejects.toThrow("invalid DialCache future buffer");
      await expect(client.raw.invalidate(watermarkKey, Number.NaN)).rejects.toThrow("invalid DialCache future buffer");
      await expect(client.raw.invalidate(watermarkKey, Number.POSITIVE_INFINITY)).rejects.toThrow(
        "invalid DialCache future buffer",
      );
      await expect(client.raw.invalidate(watermarkKey, Number.NEGATIVE_INFINITY)).rejects.toThrow(
        "invalid DialCache future buffer",
      );

      expect(await admin.exists([valueKey, watermarkKey])).toBe(0);
    });

    it("rounds fractional raw protocol durations upward", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "fractional-args:{item:fractional}:value";
      const watermarkKey = "fractional-args:{item:fractional}:watermark";

      expect(await client.raw.write(valueKey, 1_000.1, 0, "value")).toBe(1);
      expect(await admin.pTTL(valueKey)).toBeGreaterThan(900);
      expect(await admin.pTTL(valueKey)).toBeLessThanOrEqual(1_001);

      const trackedValueKey = "fractional-args:{item:tracked}:value";
      const trackedWatermarkKey = "fractional-args:{item:tracked}:watermark";
      expect(
        await client.raw.writeTracked(trackedValueKey, trackedWatermarkKey, 1_000.1, 0, "value"),
      ).toBe(1);
      expect(await admin.get(trackedWatermarkKey)).toBe("0");
      expect(await admin.pTTL(trackedWatermarkKey)).toBeGreaterThan(60_000);
      expect(await admin.pTTL(trackedWatermarkKey)).toBeLessThanOrEqual(61_001);

      const beforeMs = (await admin.time()).getTime();
      expect(await client.raw.invalidate(watermarkKey, 100.1)).toBe(1);
      const watermark = Number(await admin.get(watermarkKey));
      expect(Number.isSafeInteger(watermark)).toBe(true);
      expect(watermark).toBeGreaterThanOrEqual(beforeMs + 101);
      expect(await admin.pTTL(watermarkKey)).toBeGreaterThan(60_000);
      expect(await admin.pTTL(watermarkKey)).toBeLessThanOrEqual(60_101);
    });

    it("invalidates tracked entries and recovers after SCRIPT FLUSH", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient: DialCacheRedisClient = client.adapter;
      const dialcache = new DialCache({ namespace: "tracked", redis: { client: scriptClient, readTimeoutMs: 10_000 } });
      let version = 1;
      let calls = 0;
      const getUser = dialcache.cached(async (id: string) => ({ id, version, calls: ++calls }), {
        keyType: "user_id",
        useCase: "RealTracked",
        cacheKey: (id) => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });

      const first = await dialcache.enable(async () => await getUser("123"));
      version = 2;
      const cached = await dialcache.enable(async () => await getUser("123"));
      await dialcache.invalidateRemote("user_id", "123");
      await new Promise((resolve) => setTimeout(resolve, 2));
      const refreshed = await dialcache.enable(async () => await getUser("123"));
      await admin.scriptFlush();
      const afterScriptFlush = await dialcache.enable(async () => await getUser("123"));

      expect(first).toEqual({ id: "123", version: 1, calls: 1 });
      expect(cached).toEqual(first);
      expect(refreshed).toEqual({ id: "123", version: 2, calls: 2 });
      expect(afterScriptFlush).toEqual(refreshed);
    });

    it("fails open without caching malformed watermark state", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const logger = { debug: () => undefined, warn: () => undefined, error: () => undefined };
      const dialcache = new DialCache({ namespace: "malformed", redis: { client: scriptClient, readTimeoutMs: 10_000 }, logger });
      let calls = 0;
      const getUser = dialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
        keyType: "user_id",
        useCase: "MalformedWatermark",
        cacheKey: (id) => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });
      await admin.set("{malformed:user_id:bad}#watermark", "0x10");

      const first = await dialcache.enable(async () => await getUser("bad"));
      const second = await dialcache.enable(async () => await getUser("bad"));

      expect(first).toEqual({ id: "bad", calls: 1 });
      expect(second).toEqual({ id: "bad", calls: 2 });
    });

    it("rejects malformed tracked watermark writes without overwriting the cached value", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "malformed-write:{item:malformed}:value";
      const watermarkKey = "malformed-write:{item:malformed}:watermark";
      expect(await client.raw.write(valueKey, 60_000, 0, "original")).toBe(1);

      for (const malformed of ["not-a-watermark", "9".repeat(400)]) {
        await admin.set(watermarkKey, malformed, { PX: 60_000 });
        await expect(client.raw.writeTracked(valueKey, watermarkKey, 60_000, 0, "replacement")).rejects.toThrow(
          "invalid DialCache watermark",
        );
        expect(await scriptClient.read({ valueKey })).toBe("original");
      }
    });

    it("labels malformed payload encoding through the production adapter", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const adapter = client.adapter;
      const write = vi.fn(adapter.write);
      const redisClient: DialCacheRedisClient = { ...adapter, write };
      const metrics: DialCacheMetricsAdapter = {
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
      const namespace = "bad-encoding";
      const valueKey = `{${namespace}:user_id:bad}#RealMalformedEncoding:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:user_id:bad}#watermark`;
      await admin.set(valueKey, encodeFrame("malformed", 2), { PX: 60_000 });
      await admin.set(watermarkKey, "0", { PX: 60_000 });

      const dialcache = new DialCache({ namespace, redis: { client: redisClient, readTimeoutMs: 10_000 }, logger, metrics });
      let calls = 0;
      const getUser = dialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
        keyType: "user_id",
        useCase: "RealMalformedEncoding",
        cacheKey: (id) => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });

      const value = await dialcache.enable(async () => await getUser("bad"));

      expect(value).toEqual({ id: "bad", calls: 1 });
      expect(write).not.toHaveBeenCalled();
      expect(metrics.error).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase: "RealMalformedEncoding",
        keyType: "user_id",
        layer: CacheLayer.REMOTE,
        error: "cache_read",
        inFallback: false,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "Error getting value from Redis cache",
        expect.objectContaining({ name: "DialCacheRedisPayloadEncodingError" }),
      );
    });

    it("keeps future fractional watermarks alive without shortening longer TTLs", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const redisNowMs = (await admin.time()).getTime();
      const legacyWatermark = redisNowMs + 30_000.5;
      const shortTtlKey = "legacy:{urn:user_id:short}#watermark";
      await admin.set(shortTtlKey, String(legacyWatermark), { PX: 1_000 });

      await scriptClient.invalidate({
        watermarkKey: shortTtlKey,
        futureBufferMs: 1_000,
      });

      expect(Number(await admin.get(shortTtlKey))).toBeGreaterThanOrEqual(Math.ceil(legacyWatermark));
      expect(await admin.pTTL(shortTtlKey)).toBeGreaterThan(89_000);

      const longTtlKey = "legacy:{urn:user_id:long}#watermark";
      await admin.set(longTtlKey, String(legacyWatermark), { PX: 120_000 });
      const ttlBefore = await admin.pTTL(longTtlKey);

      await scriptClient.invalidate({
        watermarkKey: longTtlKey,
        futureBufferMs: 1_000,
      });

      expect(Number(await admin.get(longTtlKey))).toBeGreaterThanOrEqual(Math.ceil(legacyWatermark));
      const ttlAfter = await admin.pTTL(longTtlKey);
      expect(ttlAfter).toBeGreaterThan(ttlBefore - 1_000);
      expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);
    });

    it("creates missing and repairs malformed invalidation watermarks", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const missingKey = "invalidate-paths:{item:missing}:watermark";
      const beforeMs = (await admin.time()).getTime();

      await scriptClient.invalidate({ watermarkKey: missingKey, futureBufferMs: 100 });

      const created = Number(await admin.get(missingKey));
      expect(Number.isSafeInteger(created)).toBe(true);
      expect(created).toBeGreaterThanOrEqual(beforeMs + 100);
      expect(await admin.pTTL(missingKey)).toBeGreaterThan(60_000);

      for (const [suffix, malformed] of [
        ["syntax", "not-a-watermark"],
        ["overflow", "9".repeat(400)],
      ] as const) {
        const watermarkKey = `invalidate-paths:{item:${suffix}}:watermark`;
        await admin.set(watermarkKey, malformed, { PX: 1_000 });
        await scriptClient.invalidate({ watermarkKey, futureBufferMs: 0 });
        expect(Number.isSafeInteger(Number(await admin.get(watermarkKey)))).toBe(true);
        expect(await admin.pTTL(watermarkKey)).toBeGreaterThan(59_000);
      }
    });

    it("keeps persistent invalidation watermarks persistent", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const watermarkKey = "invalidate-persistent:{item:persistent}:watermark";
      await admin.set(watermarkKey, "1");

      await scriptClient.invalidate({ watermarkKey, futureBufferMs: 0 });

      expect(Number(await admin.get(watermarkKey))).toBeGreaterThan(1);
      expect(await admin.pTTL(watermarkKey)).toBe(-1);
    });

    it("preserves a fractional legacy watermark while extending its TTL", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "legacy-write:{urn:user_id:123}:value";
      const watermarkKey = "legacy-write:{urn:user_id:123}:watermark";
      await admin.set(watermarkKey, "1.75", { PX: 1_000 });

      const wrote = await scriptClient.write({
        valueKey,
        watermarkKey,
        cacheTtlMs: 2_000,
        value: "cached",
      });

      expect(wrote).toBe(true);
      expect(await admin.get(watermarkKey)).toBe("1.75");
      expect(await admin.pTTL(watermarkKey)).toBeGreaterThanOrEqual(61_000);
      expect(await scriptClient.read({ valueKey, watermarkKey })).toBe("cached");
    });

    it("does not rewrite sufficient or persistent watermarks on tracked writes", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const sufficientValueKey = "write-sufficient:{item:sufficient}:value";
      const sufficientWatermarkKey = "write-sufficient:{item:sufficient}:watermark";
      await admin.set(sufficientWatermarkKey, "1.75", { PX: 120_000 });
      const sufficientTtlBefore = await admin.pTTL(sufficientWatermarkKey);

      expect(
        await scriptClient.write({
          valueKey: sufficientValueKey,
          watermarkKey: sufficientWatermarkKey,
          cacheTtlMs: 2_000,
          value: "cached",
        }),
      ).toBe(true);

      expect(await admin.get(sufficientWatermarkKey)).toBe("1.75");
      expect(await admin.pTTL(sufficientWatermarkKey)).toBeGreaterThan(sufficientTtlBefore - 1_000);
      expect(await admin.pTTL(sufficientWatermarkKey)).toBeLessThanOrEqual(sufficientTtlBefore);

      const persistentValueKey = "write-persistent:{item:persistent}:value";
      const persistentWatermarkKey = "write-persistent:{item:persistent}:watermark";
      await admin.set(persistentWatermarkKey, "2.25");

      expect(
        await scriptClient.write({
          valueKey: persistentValueKey,
          watermarkKey: persistentWatermarkKey,
          cacheTtlMs: 2_000,
          value: "cached",
        }),
      ).toBe(true);
      expect(await admin.get(persistentWatermarkKey)).toBe("2.25");
      expect(await admin.pTTL(persistentWatermarkKey)).toBe(-1);
    });

    it("atomically blocks writes during the buffer and extends watermark TTL", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "protocol:{item:ttl}:value";
      const watermarkKey = "protocol:{item:ttl}:watermark";
      const writeRequest = {
        valueKey,
        watermarkKey,
        cacheTtlMs: 2_000,
        value: "cached",
      };

      expect(await scriptClient.write(writeRequest)).toBe(true);
      expect(await admin.get(watermarkKey)).toBe("0");
      const ttlAfterWrite = await admin.pTTL(watermarkKey);
      expect(ttlAfterWrite).toBeGreaterThanOrEqual(61_000);

      await scriptClient.invalidate({ watermarkKey, futureBufferMs: 100 });
      expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();
      expect(await scriptClient.write({ ...writeRequest, value: "blocked" })).toBe(false);
      expect(await scriptClient.read({ valueKey })).toBe("cached");
      const ttlBeforeRead = await admin.pTTL(watermarkKey);
      await scriptClient.read({ valueKey, watermarkKey });
      expect(await admin.pTTL(watermarkKey)).toBeLessThanOrEqual(ttlBeforeRead);

      await new Promise((resolve) => setTimeout(resolve, 110));
      expect(await scriptClient.write({ ...writeRequest, value: "fresh" })).toBe(true);
      expect(await scriptClient.read({ valueKey, watermarkKey })).toBe("fresh");
    });

    it("documents that losing a watermark removes its publication fence", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "watermark-loss:{item:tracked}:value";
      const watermarkKey = "watermark-loss:{item:tracked}:watermark";
      const staleWrite = {
        valueKey,
        watermarkKey,
        cacheTtlMs: 60_000,
        value: "stale",
      };

      await scriptClient.invalidate({ watermarkKey, futureBufferMs: 60_000 });
      expect(await scriptClient.write(staleWrite)).toBe(false);

      await admin.del(watermarkKey);

      expect(await scriptClient.write(staleWrite)).toBe(true);
      expect(await admin.get(watermarkKey)).toBe("0");
      expect(await scriptClient.read({ valueKey, watermarkKey })).toBe("stale");
    });
  });

  it("uses one wire format across node-redis and Valkey GLIDE", async () => {
    if (admin === undefined || harnesses === undefined) {
      throw new Error("Redis test clients did not start");
    }
    await admin.flushAll();
    const nodeRedis = harnesses.nodeRedis.adapter;
    const valkeyGlide = harnesses.valkeyGlide.adapter;
    const binary = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);

    await nodeRedis.write({ valueKey: "interop:node-to-glide", cacheTtlMs: 60_000, value: binary });
    await expect(valkeyGlide.read({ valueKey: "interop:node-to-glide" })).resolves.toEqual(binary);

    await valkeyGlide.write({ valueKey: "interop:glide-to-node", cacheTtlMs: 60_000, value: "hello" });
    await expect(nodeRedis.read({ valueKey: "interop:glide-to-node" })).resolves.toBe("hello");

    const nodeTrackedValueKey = "interop:{node-tracked}:value";
    const nodeTrackedWatermarkKey = "interop:{node-tracked}:watermark";
    await nodeRedis.write({
      valueKey: nodeTrackedValueKey,
      watermarkKey: nodeTrackedWatermarkKey,
      cacheTtlMs: 60_000,
      value: binary,
    });
    await expect(
      valkeyGlide.read({
        valueKey: nodeTrackedValueKey,
        watermarkKey: nodeTrackedWatermarkKey,
      }),
    ).resolves.toEqual(binary);

    const glideTrackedValueKey = "interop:{glide-tracked}:value";
    const glideTrackedWatermarkKey = "interop:{glide-tracked}:watermark";
    await valkeyGlide.write({
      valueKey: glideTrackedValueKey,
      watermarkKey: glideTrackedWatermarkKey,
      cacheTtlMs: 60_000,
      value: "tracked",
    });
    await expect(
      nodeRedis.read({
        valueKey: glideTrackedValueKey,
        watermarkKey: glideTrackedWatermarkKey,
      }),
    ).resolves.toBe("tracked");
  });
});

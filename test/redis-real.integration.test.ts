import * as valkeyGlide from "@valkey/valkey-glide";
import { commandOptions, createClient } from "redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type Serializer,
} from "../src/index.js";
import { MARKER_ESCAPED_RAW, MARKER_ZSTD_UTF8 } from "../src/internal/compression.js";
import { markerCollidingSerializer, type Row } from "./marker-colliding-serializer.js";
import {
  INVALIDATE_CACHE_SCRIPT,
  WRITE_TRACKED_STAMP_SCRIPT,
} from "../src/internal/redis-scripts.js";
import { encodeTrackedRedisPlaceholder } from "../src/redis-protocol.js";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "../src/node-redis.js";
import { createValkeyGlideDialCacheClient } from "../src/valkey-glide.js";

const engines = [
  { name: "Redis 6.2", image: "redis:6.2-alpine" },
  { name: "Valkey 8", image: "valkey/valkey:8-alpine" },
] as const;

const adapterKinds = [
  { kind: "nodeRedis", name: "node-redis" },
  { kind: "valkeyGlide", name: "Valkey GLIDE" },
] as const;
type AdapterKind = (typeof adapterKinds)[number]["kind"];
const MAX_SUPPORTED_DURATION_MS = 31_536_000_000;
const WATERMARK_TTL_MARGIN_MS = 60_000;

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
  /** Invoke only the tracked stamp script, as if its paired placeholder SET was lost. */
  stamp(valueKey: string, watermarkKey: string, cacheTtlMs: number, nonce: Buffer): Promise<number>;
  invalidate(watermarkKey: string, futureBufferMs: number): Promise<number>;
}

interface RedisAdapterHarness {
  readonly adapter: DialCacheRedisClient;
  /** Exercise Lua argument validation and stamp states the semantic adapter cannot represent. */
  readonly raw: RawRedisScriptClient;
  dispose(): void;
}

function createNodeRedisHarness(client: NodeRedisTestClient): RedisAdapterHarness {
  return {
    adapter: createNodeRedisDialCacheClient(client),
    raw: {
      stamp: async (...args) => await client.dialcacheWriteTrackedStamp(...args),
      invalidate: async (...args) => await client.dialcacheInvalidate(...args),
    },
    dispose: () => undefined,
  };
}

function createValkeyGlideHarness(client: valkeyGlide.GlideClient): RedisAdapterHarness {
  const adapter = createValkeyGlideDialCacheClient(client, valkeyGlide);
  const rawScripts = {
    stamp: new valkeyGlide.Script(WRITE_TRACKED_STAMP_SCRIPT),
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
      stamp: async (valueKey, watermarkKey, cacheTtlMs, nonce) =>
        await invoke(rawScripts.stamp, [valueKey, watermarkKey], [String(cacheTtlMs), nonce]),
      invalidate: async (watermarkKey, futureBufferMs) =>
        await invoke(
          rawScripts.invalidate,
          [watermarkKey],
          [String(futureBufferMs)],
        ),
    },
    dispose() {
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

describe.each(engines)("DialCache Redis protocol on $name", ({ image }) => {
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

    it("compresses values above the threshold and stores small values byte-identical", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient: DialCacheRedisClient = client.adapter;
      const dialcache = new DialCache({ namespace: "real", redis: { client: scriptClient, readTimeoutMs: 10_000 } });
      let largeCalls = 0;
      const getLarge = dialcache.cached(
        async (id: string) => ({ id, calls: ++largeCalls, blob: "dialcache payload ".repeat(1_024) }),
        {
          keyType: "item_id",
          useCase: "RealCompressionLarge",
          cacheKey: (id) => id,
          defaultConfig: remoteOnly,
        },
      );
      let smallCalls = 0;
      const getSmall = dialcache.cached(async (id: string) => ({ id, calls: ++smallCalls }), {
        keyType: "item_id",
        useCase: "RealCompressionSmall",
        cacheKey: (id) => id,
        defaultConfig: remoteOnly,
      });

      const firstLarge = await dialcache.enable(async () => await getLarge("big"));
      const secondLarge = await dialcache.enable(async () => await getLarge("big"));
      const firstSmall = await dialcache.enable(async () => await getSmall("tiny"));

      // The remote-only config forces the second read through Redis, so equality proves decompression.
      expect(secondLarge).toEqual(firstLarge);
      expect(largeCalls).toBe(1);

      const largeKey = `${new DialCacheKey({ namespace: "real", keyType: "item_id", id: "big", useCase: "RealCompressionLarge" }).urn}:dialcache-frame-v1`;
      const storedLarge = await admin.get(commandOptions({ returnBuffers: true }), largeKey);
      expect(storedLarge).not.toBeNull();
      expect(storedLarge?.[0]).toBe(1);
      expect(storedLarge?.[9]).toBe(1);
      expect(storedLarge?.[10]).toBe(MARKER_ZSTD_UTF8);
      expect(storedLarge?.length).toBeLessThan(10 + Buffer.byteLength(JSON.stringify(firstLarge)));

      const smallKey = `${new DialCacheKey({ namespace: "real", keyType: "item_id", id: "tiny", useCase: "RealCompressionSmall" }).urn}:dialcache-frame-v1`;
      const storedSmall = await admin.get(commandOptions({ returnBuffers: true }), smallKey);
      expect(storedSmall?.[9]).toBe(0);
      expect(storedSmall?.subarray(10).toString("utf8")).toBe(JSON.stringify(firstSmall));
    });

    it("round-trips compressed payloads through tracked writes and invalidation", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      // Compression envelopes and the tracked placeholder protocol were built
      // in separate branches; this pins their combination: a zstd payload
      // rides an unreadable nonce placeholder, gets promoted by the stamp,
      // and stays fenceable by the watermark.
      const scriptClient: DialCacheRedisClient = client.adapter;
      const namespace = "real-compression-tracked";
      const dialcache = new DialCache({ namespace, redis: { client: scriptClient, readTimeoutMs: 10_000 } });
      let calls = 0;
      const getLarge = dialcache.cached(
        async (id: string) => ({ id, calls: ++calls, blob: "tracked dialcache payload ".repeat(1_024) }),
        {
          keyType: "item_id",
          useCase: "RealCompressionTracked",
          cacheKey: (id) => id,
          trackForInvalidation: true,
          defaultConfig: remoteOnly,
        },
      );

      const first = await dialcache.enable(async () => await getLarge("big"));
      const second = await dialcache.enable(async () => await getLarge("big"));
      expect(second).toEqual(first);
      expect(calls).toBe(1);

      const valueKey = `{${namespace}:item_id:big}#RealCompressionTracked:dialcache-frame-v1`;
      const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
      expect(stored?.[0]).toBe(1);
      expect(stored?.[9]).toBe(1);
      expect(stored?.[10]).toBe(MARKER_ZSTD_UTF8);

      await dialcache.invalidateRemote("item_id", "big");
      // Leave the zero-buffer watermark clearly in the past so the refill's
      // stamp cannot land inside the fence window and blank the entry.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const refreshed = await dialcache.enable(async () => await getLarge("big"));
      expect(refreshed).toEqual({ ...first, calls: 2 });

      // The refill must be a published, servable zstd frame: a third read
      // serves it from Redis without reloading, and the stored bytes carry a
      // promoted version byte with the envelope intact after the stamp.
      const third = await dialcache.enable(async () => await getLarge("big"));
      expect(third).toEqual(refreshed);
      expect(calls).toBe(2);
      const restored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
      expect(restored?.[0]).toBe(1);
      expect(restored?.[9]).toBe(1);
      expect(restored?.[10]).toBe(MARKER_ZSTD_UTF8);
    });

    it("escapes envelope-colliding binary serializer output on the wire and round-trips it", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient: DialCacheRedisClient = client.adapter;
      const dialcache = new DialCache({ namespace: "real", redis: { client: scriptClient, readTimeoutMs: 10_000 } });
      let calls = 0;
      const getRow = dialcache.cached(
        async (id: string): Promise<Row> => {
          calls += 1;
          return { id };
        },
        {
          keyType: "item_id",
          useCase: "RealCompressionEscape",
          cacheKey: (id) => id,
          defaultConfig: remoteOnly,
          serializer: markerCollidingSerializer,
        },
      );

      const first = await dialcache.enable(async () => await getRow("esc"));
      const second = await dialcache.enable(async () => await getRow("esc"));
      expect(first).toEqual({ id: "esc" });
      expect(second).toEqual({ id: "esc" });
      expect(calls).toBe(1);

      const escapeKey = `${new DialCacheKey({ namespace: "real", keyType: "item_id", id: "esc", useCase: "RealCompressionEscape" }).urn}:dialcache-frame-v1`;
      const stored = await admin.get(commandOptions({ returnBuffers: true }), escapeKey);
      expect(stored?.[9]).toBe(1);
      expect(stored?.[10]).toBe(MARKER_ESCAPED_RAW);
      expect(stored?.[11]).toBe(MARKER_ZSTD_UTF8);
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

        expect(Buffer.isBuffer(roundTrip?.payload)).toBe(true);
        expect(roundTrip?.payload).toEqual(payload);
        expect(roundTrip?.createdAtMs).toBeGreaterThan(0);
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
      const trackedRead = await scriptClient.read({ valueKey: trackedValueKey, watermarkKey });
      expect(trackedRead?.payload).toEqual(trackedPayload);
      expect(trackedRead?.createdAtMs).toBeGreaterThan(0);
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

      const read = vi.fn(client.adapter.read);
      const write = vi.fn(client.adapter.write);
      const invalidate = vi.fn(client.adapter.invalidate);
      const redisClient: DialCacheRedisClient = { ...client.adapter, read, write, invalidate };
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
        observeShadowValueAge: vi.fn(),
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
        shadow: { ramp: 100 },
      });
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        metrics,
      });
      let sourcePayload: Buffer = Buffer.from(cachedPayload);
      let sourceMutation: "none" | "watermark" | "payload" | "missing" = "none";
      let mutatedFrame: Buffer | null = null;
      let sourceCalls = 0;
      const getPayload = dialcache.cached(
        async (): Promise<Buffer> => {
          sourceCalls += 1;
          if (sourceMutation === "watermark") {
            await admin!.set(watermarkKey, String(Date.now() + 60_000), { PX: 60_000 });
          } else if (sourceMutation === "payload") {
            mutatedFrame = encodeFrame(sourcePayload, 1);
            await admin!.set(valueKey, mutatedFrame, { PX: 60_000 });
          } else if (sourceMutation === "missing") {
            await admin!.del(valueKey);
          }
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
      expect(read).toHaveBeenCalledTimes(1);

      sourcePayload = mismatchPayload;
      const mismatchingHit = await dialcache.enable(async () => await getPayload());
      expect(mismatchingHit).toEqual(cachedPayload);
      await mismatched.promise;

      sourceMutation = "watermark";
      const invalidatedHit = await dialcache.enable(async () => await getPayload());
      expect(invalidatedHit).toEqual(cachedPayload);
      await vi.waitFor(() => {
        expect(metrics.shadowValidation).toHaveBeenCalledTimes(3);
      });

      await admin.set(valueKey, storedFrame, { PX: 60_000 });
      await admin.set(watermarkKey, "0", { PX: 60_000 });
      sourceMutation = "payload";
      const supersededHit = await dialcache.enable(async () => await getPayload());
      expect(supersededHit).toEqual(cachedPayload);
      await vi.waitFor(() => {
        expect(metrics.shadowValidation).toHaveBeenCalledTimes(4);
      });
      expect(mutatedFrame).not.toBeNull();
      expect(await admin.get(commandOptions({ returnBuffers: true }), valueKey)).toEqual(mutatedFrame);

      await admin.set(valueKey, storedFrame, { PX: 60_000 });
      await admin.set(watermarkKey, "0", { PX: 60_000 });
      sourceMutation = "missing";
      const missingHit = await dialcache.enable(async () => await getPayload());
      expect(missingHit).toEqual(cachedPayload);
      await vi.waitFor(() => {
        expect(metrics.shadowValidation).toHaveBeenCalledTimes(5);
      });

      expect(sourceCalls).toBe(5);
      expect(serializer.load).toHaveBeenCalledTimes(10);
      expect(serializer.dump).not.toHaveBeenCalled();
      expect(metrics.shadowValidation).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "match",
      });
      expect(metrics.shadowValidation).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "mismatch",
      });
      expect(metrics.shadowValidation).toHaveBeenNthCalledWith(3, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "superseded",
      });
      expect(metrics.shadowValidation).toHaveBeenNthCalledWith(4, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "superseded",
      });
      expect(metrics.shadowValidation).toHaveBeenNthCalledWith(5, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "superseded",
      });
      // The stored frame was stamped with createdAtMs=1, so both verdicts see
      // a huge positive age; superseded outcomes record none.
      expect(metrics.observeShadowValueAge).toHaveBeenCalledTimes(2);
      expect(metrics.observeShadowValueAge).toHaveBeenNthCalledWith(
        1,
        { cacheNamespace: namespace, useCase, keyType: "item_id", outcome: "match" },
        expect.any(Number),
      );
      expect(metrics.observeShadowValueAge).toHaveBeenNthCalledWith(
        2,
        { cacheNamespace: namespace, useCase, keyType: "item_id", outcome: "mismatch" },
        expect.any(Number),
      );
      expect(read).toHaveBeenCalledTimes(9);
      expect(read.mock.calls.every(([request]) =>
        request.valueKey === valueKey && request.watermarkKey === watermarkKey
      )).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(await admin.get(commandOptions({ returnBuffers: true }), valueKey)).toBeNull();
    });

    it.each([
      { name: "tracked", tracked: true },
      { name: "untracked", tracked: false },
    ])("shadow-reads $name Redis without serving or repairing a warm hit when the remote ramp is zero", async ({
      name,
      tracked,
    }) => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = `real-dark-shadow-${name}`;
      const useCase = `RealDarkShadowPayload${name}`;
      const rawPrefix = `${namespace}:item_id:dark`;
      const valueKey = tracked
        ? `{${rawPrefix}}#${useCase}:dialcache-frame-v1`
        : `${rawPrefix}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:dark}#watermark`;
      const cachedValue = { id: "dark", version: 1 };
      const sourceValue = { id: "dark", version: 2 };
      const storedFrame = encodeFrame(JSON.stringify(cachedValue), 0);
      await admin.set(valueKey, storedFrame, { PX: 60_000 });
      if (tracked) {
        await admin.set(watermarkKey, "0", { PX: 60_000 });
      }

      const read = vi.fn(client.adapter.read);
      const write = vi.fn(client.adapter.write);
      const invalidate = vi.fn(client.adapter.invalidate);
      const redisClient: DialCacheRedisClient = { ...client.adapter, read, write, invalidate };
      const mismatched = deferred<void>();
      const metrics: DialCacheMetricsAdapter = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        shadowValidation: vi.fn(({ outcome }) => {
          if (outcome === "mismatch") {
            mismatched.resolve();
          }
        }),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      };
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        metrics,
      });
      const source = vi.fn(async () => sourceValue);
      const getPayload = dialcache.cached(source, {
        keyType: "item_id",
        useCase,
        cacheKey: () => "dark",
        trackForInvalidation: tracked,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 0 },
          shadow: { ramp: 100 },
        }),
      });

      const result = await dialcache.enable(async () => await getPayload());
      expect(result).toBe(sourceValue);
      await mismatched.promise;

      expect(source).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls.every(([request]) =>
        request.valueKey === valueKey
        && (tracked
          ? request.watermarkKey === watermarkKey
          : !Object.hasOwn(request, "watermarkKey"))
      )).toBe(true);
      expect(metrics.shadowValidation).toHaveBeenCalledOnce();
      expect(metrics.shadowValidation).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "mismatch",
      });
      expect(metrics.disabled).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: CacheLayer.REMOTE,
        reason: "ramped_down",
      });
      expect(metrics.request).toHaveBeenCalledTimes(2);
      expect(metrics.request).toHaveBeenNthCalledWith(1, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      });
      expect(metrics.request).toHaveBeenNthCalledWith(2, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      });
      expect(metrics.miss).not.toHaveBeenCalled();
      expect(metrics.error).not.toHaveBeenCalled();
      expect(metrics.observeGet).toHaveBeenCalledTimes(2);
      expect(metrics.observeGet).toHaveBeenNthCalledWith(1, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      }, expect.any(Number));
      expect(metrics.observeGet).toHaveBeenNthCalledWith(2, {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      }, expect.any(Number));
      expect(metrics.observeSerialization).toHaveBeenCalledOnce();
      expect(metrics.observeSerialization).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
        operation: "load",
      }, expect.any(Number));
      expect(metrics.observeSize).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(await admin.get(commandOptions({ returnBuffers: true }), valueKey)).toEqual(storedFrame);
    });

    it.each([
      { name: "tracked", tracked: true },
      { name: "untracked", tracked: false },
    ])("fills a clean $name shadow miss asynchronously and serves it after Redis ramps up", async ({
      name,
      tracked,
    }) => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = `real-dark-shadow-fill-${name}`;
      const useCase = `RealDarkShadowFill${name}`;
      const rawPrefix = `${namespace}:item_id:cold`;
      const valueKey = tracked
        ? `{${rawPrefix}}#${useCase}:dialcache-frame-v1`
        : `${rawPrefix}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:cold}#watermark`;
      const sourceValue = { id: "cold", version: 1 };
      const writeStarted = deferred<void>();
      const allowWrite = deferred<void>();
      const filled = deferred<void>();
      let serveFromRedis = false;

      const read = vi.fn(client.adapter.read);
      const write = vi.fn(async (request: Parameters<DialCacheRedisClient["write"]>[0]) => {
        writeStarted.resolve();
        await allowWrite.promise;
        return await client!.adapter.write(request);
      });
      const invalidate = vi.fn(client.adapter.invalidate);
      const redisClient: DialCacheRedisClient = { ...client.adapter, read, write, invalidate };
      const metrics: DialCacheMetricsAdapter = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        shadowValidation: vi.fn(({ outcome }) => {
          if (outcome === "filled") {
            filled.resolve();
          }
        }),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      };
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        metrics,
        cacheConfigProvider: async () => new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: serveFromRedis ? 100 : 0 },
          shadow: { ramp: serveFromRedis ? 0 : 100 },
        }),
      });
      const source = vi.fn(async () => sourceValue);
      const getPayload = dialcache.cached(source, {
        keyType: "item_id",
        useCase,
        cacheKey: () => "cold",
        trackForInvalidation: tracked,
      });

      const result = await dialcache.enable(async () => await getPayload());
      expect(result).toBe(sourceValue);
      expect(source).toHaveBeenCalledOnce();
      await writeStarted.promise;
      expect(await admin.exists(valueKey)).toBe(0);

      allowWrite.resolve();
      await filled.promise;

      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith({
        valueKey,
        cacheTtlMs: 60_000,
        value: JSON.stringify(sourceValue),
        ...(tracked ? { watermarkKey } : {}),
      });
      expect((await client.adapter.read({
        valueKey,
        ...(tracked ? { watermarkKey } : {}),
      }))?.payload).toBe(JSON.stringify(sourceValue));
      expect(await admin.pTTL(valueKey)).toBeGreaterThan(55_000);
      expect(await admin.pTTL(valueKey)).toBeLessThanOrEqual(60_000);
      if (tracked) {
        expect(await admin.get(watermarkKey)).toBe("0");
        expect(await admin.pTTL(watermarkKey)).toBeGreaterThan(115_000);
        expect(await admin.pTTL(watermarkKey)).toBeLessThanOrEqual(120_000);
      } else {
        expect(await admin.exists(watermarkKey)).toBe(0);
      }
      expect(metrics.shadowValidation).toHaveBeenCalledOnce();
      expect(metrics.shadowValidation).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "filled",
      });
      expect(metrics.request).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      });
      expect(metrics.miss).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      });
      expect(metrics.observeSerialization).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
        operation: "dump",
      }, expect.any(Number));
      expect(metrics.observeSize).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: "remote_shadow",
      }, Buffer.byteLength(JSON.stringify(sourceValue)));

      serveFromRedis = true;
      const served = await dialcache.enable(async () => await getPayload());

      expect(served).toEqual(sourceValue);
      expect(source).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("reports a future-watermark-blocked shadow fill without populating Redis", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = "real-dark-shadow-blocked";
      const useCase = "RealDarkShadowBlocked";
      const valueKey = `{${namespace}:item_id:blocked}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:blocked}#watermark`;
      await client.adapter.invalidate({ watermarkKey, futureBufferMs: 60_000 });
      const watermarkBefore = await admin.get(watermarkKey);

      const read = vi.fn(client.adapter.read);
      const write = vi.fn(client.adapter.write);
      const invalidate = vi.fn(client.adapter.invalidate);
      const redisClient: DialCacheRedisClient = { ...client.adapter, read, write, invalidate };
      const fillBlocked = deferred<void>();
      const metrics: DialCacheMetricsAdapter = {
        request: vi.fn(),
        miss: vi.fn(),
        disabled: vi.fn(),
        error: vi.fn(),
        invalidation: vi.fn(),
        coalesced: vi.fn(),
        shadowValidation: vi.fn(({ outcome }) => {
          if (outcome === "fill_blocked") {
            fillBlocked.resolve();
          }
        }),
        observeGet: vi.fn(),
        observeFallback: vi.fn(),
        observeSerialization: vi.fn(),
        observeSize: vi.fn(),
      };
      const dialcache = new DialCache({
        namespace,
        redis: { client: redisClient, readTimeoutMs: 10_000 },
        metrics,
      });
      const sourceValue = { id: "blocked", version: 1 };
      const source = vi.fn(async () => sourceValue);
      const getPayload = dialcache.cached(source, {
        keyType: "item_id",
        useCase,
        cacheKey: () => "blocked",
        trackForInvalidation: true,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 0 },
          shadow: { ramp: 100 },
        }),
      });

      const result = await dialcache.enable(async () => await getPayload());
      expect(result).toBe(sourceValue);
      await fillBlocked.promise;

      expect(source).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      expect(invalidate).not.toHaveBeenCalled();
      expect(await admin.exists(valueKey)).toBe(0);
      expect(await admin.get(watermarkKey)).toBe(watermarkBefore);
      expect(metrics.shadowValidation).toHaveBeenCalledOnce();
      expect(metrics.shadowValidation).toHaveBeenCalledWith({
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        outcome: "fill_blocked",
      });
    });

    it("reloads every mutation script after SCRIPT FLUSH", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "script-recovery:{item:untracked}:value";

      await admin.scriptFlush();
      expect(await scriptClient.write({ valueKey, cacheTtlMs: 60_000, value: "untracked" })).toBe(true);
      expect((await scriptClient.read({ valueKey }))?.payload).toBe("untracked");

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
      expect((await scriptClient.read({ valueKey: trackedValueKey, watermarkKey }))?.payload).toBe("tracked");
      // The recovered write must cache the stamp under sha1(source) — the
      // digest node-redis registers and the GLIDE batch dispatches — so later
      // writes take the single-round-trip path. (The unit suites pin each
      // adapter's dispatched digest to an independently computed sha1.)
      expect(
        await admin.scriptExists(dialcacheRedisScripts.dialcacheWriteTrackedStamp.SHA1),
      ).toEqual([true]);
      await admin.scriptFlush();
      await expect(
        scriptClient.invalidate({
          watermarkKey,
          futureBufferMs: 0,
        }),
      ).resolves.toBeUndefined();
      expect(await scriptClient.read({ valueKey: trackedValueKey, watermarkKey })).toBeNull();
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
      expect((await scriptClient.read({ valueKey, watermarkKey }))?.payload).toBe("tracked");
    });

    it("records a stale tracked frame as a remote miss without a read error", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;

      const namespace = "stale-miss-metrics";
      const useCase = "TrackedStaleMissMetrics";
      const id = "stale";
      const staleValueKey = `{${namespace}:item_id:${id}}#${useCase}:dialcache-frame-v1`;
      const staleWatermarkKey = `{${namespace}:item_id:${id}}#watermark`;
      await admin.set(staleValueKey, encodeFrame("stale", 0, 1_000));
      await admin.set(staleWatermarkKey, "1000");

      const metrics = {
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
      } satisfies DialCacheMetricsAdapter;
      const dialcache = new DialCache({
        namespace,
        redis: { client: scriptClient, readTimeoutMs: 10_000 },
        metrics,
      });
      const fallback = vi.fn(async () => ({ source: "fallback" }));
      const getValue = dialcache.cached(fallback, {
        keyType: "item_id",
        useCase,
        cacheKey: () => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });
      const labels = {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: CacheLayer.REMOTE,
      } as const;

      await expect(dialcache.enable(async () => await getValue())).resolves.toEqual({ source: "fallback" });

      expect(fallback).toHaveBeenCalledOnce();
      expect(metrics.request).toHaveBeenCalledOnce();
      expect(metrics.request).toHaveBeenCalledWith(labels);
      expect(metrics.miss).toHaveBeenCalledOnce();
      expect(metrics.miss).toHaveBeenCalledWith(labels);
      expect(metrics.observeGet).toHaveBeenCalledOnce();
      expect(metrics.observeGet).toHaveBeenCalledWith(labels, expect.any(Number));
      expect(metrics.observeFallback).toHaveBeenCalledOnce();
      expect(metrics.observeFallback).toHaveBeenCalledWith(labels, expect.any(Number));
      expect(metrics.error).not.toHaveBeenCalled();
    });

    it("uses native wrong-type semantics and repairs tracked value keys", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "wrong-type:{item:read}:value";
      const watermarkKey = "wrong-type:{item:read}:watermark";

      await admin.hSet(valueKey, "field", "value");
      await admin.set(watermarkKey, "0");
      await expect(scriptClient.read({ valueKey })).rejects.toThrow(/WRONGTYPE/);
      await expect(scriptClient.read({ valueKey, watermarkKey })).resolves.toBeNull();

      await admin.del([valueKey, watermarkKey]);
      await admin.set(valueKey, encodeFrame("cached", 0, 1_000));
      await admin.hSet(watermarkKey, "field", "value");
      await expect(scriptClient.read({ valueKey, watermarkKey })).resolves.toBeNull();

      const namespace = "wrong-type-repair";
      const repairValueKey = `{${namespace}:item_id:repair}#WrongTypeRepair:dialcache-frame-v1`;
      const repairWatermarkKey = `{${namespace}:item_id:repair}#watermark`;
      await admin.hSet(repairValueKey, "field", "value");
      await admin.set(repairWatermarkKey, "0");

      let sourceCalls = 0;
      const dialcache = new DialCache({
        namespace,
        redis: { client: scriptClient, readTimeoutMs: 10_000 },
      });
      const getValue = dialcache.cached(async (id: string) => ({ id, calls: ++sourceCalls }), {
        keyType: "item_id",
        useCase: "WrongTypeRepair",
        cacheKey: (id) => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });

      const repaired = await dialcache.enable(async () => await getValue("repair"));
      const cached = await dialcache.enable(async () => await getValue("repair"));

      expect(repaired).toEqual({ id: "repair", calls: 1 });
      expect(cached).toEqual(repaired);
      expect(sourceCalls).toBe(1);
      expect(await admin.type(repairValueKey)).toBe("string");
    });

    it("fails open repeatedly when a tracked watermark has the wrong Redis type", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const namespace = "wrong-type-watermark";
      const useCase = "WrongTypeWatermark";
      const id = "broken";
      const valueKey = `{${namespace}:item_id:${id}}#${useCase}:dialcache-frame-v1`;
      const watermarkKey = `{${namespace}:item_id:${id}}#watermark`;
      const frame = encodeFrame("cached", 0, 1_000);
      await admin.set(valueKey, frame, { PX: 60_000 });
      await admin.hSet(watermarkKey, "field", "value");

      const metrics = {
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
      } satisfies DialCacheMetricsAdapter;
      const dialcache = new DialCache({
        namespace,
        redis: { client: client.adapter, readTimeoutMs: 10_000 },
        logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metrics,
      });
      let sourceCalls = 0;
      const getValue = dialcache.cached(async () => ({ source: "fallback", calls: ++sourceCalls }), {
        keyType: "item_id",
        useCase,
        cacheKey: () => id,
        trackForInvalidation: true,
        defaultConfig: remoteOnly,
      });
      const labels = {
        cacheNamespace: namespace,
        useCase,
        keyType: "item_id",
        layer: CacheLayer.REMOTE,
      } as const;

      await expect(dialcache.enable(async () => await getValue())).resolves.toEqual({
        source: "fallback",
        calls: 1,
      });
      await expect(dialcache.enable(async () => await getValue())).resolves.toEqual({
        source: "fallback",
        calls: 2,
      });

      expect(sourceCalls).toBe(2);
      expect(metrics.request).toHaveBeenCalledTimes(2);
      expect(metrics.miss).toHaveBeenCalledTimes(2);
      expect(metrics.error).toHaveBeenCalledTimes(2);
      expect(metrics.error).toHaveBeenNthCalledWith(1, {
        ...labels,
        error: "cache_write",
        inFallback: false,
      });
      expect(metrics.error).toHaveBeenNthCalledWith(2, {
        ...labels,
        error: "cache_write",
        inFallback: false,
      });
      expect(metrics.error).not.toHaveBeenCalledWith(expect.objectContaining({ error: "cache_read" }));
      expect(await admin.type(watermarkKey)).toBe("hash");
      // The paired SET lands before the stamp fails on the wrong-type watermark,
      // so the original frame is replaced by an unreadable version-0 placeholder.
      const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
      expect(stored?.[0]).toBe(0);
      await expect(client.adapter.read({ valueKey, watermarkKey })).resolves.toBeNull();
    });

    it("rejects invalid raw script arguments before mutating Redis", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "invalid-args:{item:invalid}:value";
      const watermarkKey = "invalid-args:{item:invalid}:watermark";
      const notANumber = "not-a-number" as unknown as number;

      const nonce = Buffer.alloc(8, 1);
      await expect(client.raw.stamp(valueKey, watermarkKey, 0, nonce)).rejects.toThrow("invalid DialCache TTL");
      await expect(client.raw.stamp(valueKey, watermarkKey, notANumber, nonce)).rejects.toThrow("invalid DialCache TTL");
      await expect(client.raw.stamp(valueKey, watermarkKey, Number.NaN, nonce)).rejects.toThrow("invalid DialCache TTL");
      await expect(client.raw.stamp(valueKey, watermarkKey, Number.POSITIVE_INFINITY, nonce)).rejects.toThrow(
        "invalid DialCache TTL",
      );
      await expect(client.raw.stamp(valueKey, watermarkKey, Number.NEGATIVE_INFINITY, nonce)).rejects.toThrow(
        "invalid DialCache TTL",
      );
      await expect(
        client.raw.stamp(valueKey, watermarkKey, MAX_SUPPORTED_DURATION_MS + 1, nonce),
      ).rejects.toThrow("invalid DialCache TTL");
      await expect(
        client.raw.stamp(valueKey, watermarkKey, Number.MAX_SAFE_INTEGER, nonce),
      ).rejects.toThrow("invalid DialCache TTL");
      await expect(
        client.raw.stamp(valueKey, watermarkKey, 1_000, Buffer.alloc(7, 1)),
      ).rejects.toThrow("invalid DialCache stamp nonce");
      await expect(
        client.raw.stamp(valueKey, watermarkKey, 1_000, Buffer.alloc(9, 1)),
      ).rejects.toThrow("invalid DialCache stamp nonce");
      // The adapters enforce the same TTL domain before issuing any command.
      for (const badTtl of [0, notANumber, Number.NaN, Number.POSITIVE_INFINITY, MAX_SUPPORTED_DURATION_MS + 1]) {
        await expect(
          client.adapter.write({ valueKey, cacheTtlMs: badTtl, value: "value" }),
        ).rejects.toThrow(RangeError);
        await expect(
          client.adapter.write({ valueKey, watermarkKey, cacheTtlMs: badTtl, value: "value" }),
        ).rejects.toThrow(RangeError);
      }
      await expect(client.raw.invalidate(watermarkKey, -1)).rejects.toThrow("invalid DialCache future buffer");
      await expect(client.raw.invalidate(watermarkKey, notANumber)).rejects.toThrow("invalid DialCache future buffer");
      await expect(client.raw.invalidate(watermarkKey, Number.NaN)).rejects.toThrow("invalid DialCache future buffer");
      await expect(client.raw.invalidate(watermarkKey, Number.POSITIVE_INFINITY)).rejects.toThrow(
        "invalid DialCache future buffer",
      );
      await expect(client.raw.invalidate(watermarkKey, Number.NEGATIVE_INFINITY)).rejects.toThrow(
        "invalid DialCache future buffer",
      );
      await expect(
        client.raw.invalidate(watermarkKey, MAX_SUPPORTED_DURATION_MS + 1),
      ).rejects.toThrow("invalid DialCache future buffer");
      await expect(
        client.raw.invalidate(watermarkKey, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow("invalid DialCache future buffer");

      expect(await admin.exists([valueKey, watermarkKey])).toBe(0);
    });

    it("accepts maximum raw protocol durations and keeps derived TTLs in range", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "maximum-args:{item:untracked}:value";
      expect(
        await client.adapter.write({ valueKey, cacheTtlMs: MAX_SUPPORTED_DURATION_MS, value: "value" }),
      ).toBe(true);
      expect(await admin.pTTL(valueKey)).toBeGreaterThan(
        MAX_SUPPORTED_DURATION_MS - 1_000,
      );
      expect(await admin.pTTL(valueKey)).toBeLessThanOrEqual(
        MAX_SUPPORTED_DURATION_MS,
      );

      const trackedValueKey = "maximum-args:{item:tracked}:value";
      const trackedWatermarkKey = "maximum-args:{item:tracked}:watermark";
      expect(
        await client.adapter.write({
          valueKey: trackedValueKey,
          watermarkKey: trackedWatermarkKey,
          cacheTtlMs: MAX_SUPPORTED_DURATION_MS,
          value: "value",
        }),
      ).toBe(true);
      expect(await admin.pTTL(trackedWatermarkKey)).toBeGreaterThan(
        MAX_SUPPORTED_DURATION_MS + WATERMARK_TTL_MARGIN_MS - 1_000,
      );
      expect(await admin.pTTL(trackedWatermarkKey)).toBeLessThanOrEqual(
        MAX_SUPPORTED_DURATION_MS + WATERMARK_TTL_MARGIN_MS,
      );

      const invalidationKey = "maximum-args:{item:invalidation}:watermark";
      const beforeMs = (await admin.time()).getTime();
      expect(
        await client.raw.invalidate(invalidationKey, MAX_SUPPORTED_DURATION_MS),
      ).toBe(1);
      expect(Number(await admin.get(invalidationKey))).toBeGreaterThanOrEqual(
        beforeMs + MAX_SUPPORTED_DURATION_MS,
      );
      expect(await admin.pTTL(invalidationKey)).toBeGreaterThan(
        MAX_SUPPORTED_DURATION_MS + WATERMARK_TTL_MARGIN_MS - 1_000,
      );
      expect(await admin.pTTL(invalidationKey)).toBeLessThanOrEqual(
        MAX_SUPPORTED_DURATION_MS + WATERMARK_TTL_MARGIN_MS,
      );
    });

    it("rounds fractional raw protocol durations upward", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "fractional-args:{item:fractional}:value";
      const watermarkKey = "fractional-args:{item:fractional}:watermark";

      expect(await client.adapter.write({ valueKey, cacheTtlMs: 1_000.1, value: "value" })).toBe(true);
      expect(await admin.pTTL(valueKey)).toBeGreaterThan(900);
      expect(await admin.pTTL(valueKey)).toBeLessThanOrEqual(1_001);

      const trackedValueKey = "fractional-args:{item:tracked}:value";
      const trackedWatermarkKey = "fractional-args:{item:tracked}:watermark";
      expect(
        await client.adapter.write({
          valueKey: trackedValueKey,
          watermarkKey: trackedWatermarkKey,
          cacheTtlMs: 1_000.1,
          value: "value",
        }),
      ).toBe(true);
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

    it("keeps native reads working after SCRIPT FLUSH", async () => {
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
      // The refill's stamp is fenced unless server time passes the
      // zero-buffer watermark; the afterScriptFlush read needs that write to
      // have been published (calls must stay 2).
      await new Promise((resolve) => setTimeout(resolve, 25));
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

    it("rejects malformed tracked watermark writes and leaves only an unreadable placeholder", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const scriptClient = client.adapter;
      const valueKey = "malformed-write:{item:malformed}:value";
      const watermarkKey = "malformed-write:{item:malformed}:watermark";

      for (const malformed of ["not-a-watermark", "9".repeat(400)]) {
        await admin.set(watermarkKey, malformed, { PX: 60_000 });
        await expect(scriptClient.write({
          valueKey,
          watermarkKey,
          cacheTtlMs: 60_000,
          value: "replacement",
        })).rejects.toThrow("invalid DialCache watermark");
        // The paired SET lands before the stamp validates the watermark, so the
        // tracked path serves nothing and the placeholder stays unpromoted.
        expect(await scriptClient.read({ valueKey, watermarkKey })).toBeNull();
        const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
        expect(stored?.[0]).toBe(0);
        await admin.del(valueKey);
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
      expect((await scriptClient.read({ valueKey, watermarkKey }))?.payload).toBe("cached");
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
      const watermarkBeforeBlockedWrite = await admin.get(watermarkKey);
      const watermarkTtlBeforeBlockedWrite = await admin.pTTL(watermarkKey);
      expect(await scriptClient.write({ ...writeRequest, value: "blocked" })).toBe(false);
      expect(await scriptClient.read({ valueKey })).toBeNull();
      expect(await admin.get(watermarkKey)).toBe(watermarkBeforeBlockedWrite);
      const watermarkTtlAfterBlockedWrite = await admin.pTTL(watermarkKey);
      expect(watermarkTtlAfterBlockedWrite).toBeGreaterThan(watermarkTtlBeforeBlockedWrite - 1_000);
      expect(watermarkTtlAfterBlockedWrite).toBeLessThanOrEqual(watermarkTtlBeforeBlockedWrite);
      const ttlBeforeRead = await admin.pTTL(watermarkKey);
      await scriptClient.read({ valueKey, watermarkKey });
      expect(await admin.pTTL(watermarkKey)).toBeLessThanOrEqual(ttlBeforeRead);

      await new Promise((resolve) => setTimeout(resolve, 110));
      expect(await scriptClient.write({ ...writeRequest, value: "fresh" })).toBe(true);
      expect((await scriptClient.read({ valueKey, watermarkKey }))?.payload).toBe("fresh");
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
      expect((await scriptClient.read({ valueKey, watermarkKey }))?.payload).toBe("stale");
    });

    it("never serves an unstamped placeholder and refuses foreign stamps", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "placeholder:{item:pending}:value";
      const watermarkKey = "placeholder:{item:pending}:watermark";
      const { frame, nonce } = encodeTrackedRedisPlaceholder("pending");
      await admin.set(valueKey, frame, { PX: 60_000 });
      await admin.set(watermarkKey, "0", { PX: 120_000 });

      expect(await client.adapter.read({ valueKey, watermarkKey })).toBeNull();
      expect(await client.adapter.read({ valueKey })).toBeNull();

      // A stamp carrying a different write's nonce must not promote this
      // placeholder: a leftover from a failed write stays unreadable even
      // after later invalidations pass.
      expect(await client.raw.stamp(valueKey, watermarkKey, 2_000, Buffer.alloc(8, 0xab))).toBe(2);
      expect(await client.adapter.read({ valueKey, watermarkKey })).toBeNull();

      // Only the paired nonce promotes it to a served, server-stamped frame.
      expect(await client.raw.stamp(valueKey, watermarkKey, 2_000, nonce)).toBe(1);
      expect((await client.adapter.read({ valueKey, watermarkKey }))?.payload).toBe("pending");
      const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
      expect(stored?.[0]).toBe(1);
      expect(stored?.readBigUInt64BE(1) ?? 0n).toBeGreaterThan(0n);
    });

    it("refuses to restamp an existing frame after its paired SET was lost", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "restamp:{item:fenced}:value";
      const watermarkKey = "restamp:{item:fenced}:watermark";
      // A stale frame fenced by a past invalidation, as left behind when a
      // fallback write's SET fails (for example on OOM) but its stamp still runs.
      await admin.set(valueKey, encodeFrame("stale", 0, 1_000), { PX: 60_000 });
      await admin.set(watermarkKey, "2000", { PX: 120_000 });

      expect(await client.raw.stamp(valueKey, watermarkKey, 2_000, Buffer.alloc(8, 1))).toBe(2);

      const stored = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
      expect(stored?.readBigUInt64BE(1)).toBe(1_000n);
      expect(await client.adapter.read({ valueKey, watermarkKey })).toBeNull();
    });

    it("does not create a value key when stamping after a lost SET", async () => {
      if (client === undefined || admin === undefined) {
        throw new Error("Redis test clients did not start");
      }
      const valueKey = "stamp-missing:{item:lost}:value";
      const watermarkKey = "stamp-missing:{item:lost}:watermark";

      expect(await client.raw.stamp(valueKey, watermarkKey, 2_000, Buffer.alloc(8, 2))).toBe(2);

      expect(await admin.exists(valueKey)).toBe(0);
      expect(await admin.get(watermarkKey)).toBe("0");
      expect(await admin.pTTL(watermarkKey)).toBeGreaterThan(60_000);
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
    expect((await valkeyGlide.read({ valueKey: "interop:node-to-glide" }))?.payload).toEqual(binary);

    await valkeyGlide.write({ valueKey: "interop:glide-to-node", cacheTtlMs: 60_000, value: "hello" });
    expect((await nodeRedis.read({ valueKey: "interop:glide-to-node" }))?.payload).toBe("hello");

    const nodeTrackedValueKey = "interop:{node-tracked}:value";
    const nodeTrackedWatermarkKey = "interop:{node-tracked}:watermark";
    await nodeRedis.write({
      valueKey: nodeTrackedValueKey,
      watermarkKey: nodeTrackedWatermarkKey,
      cacheTtlMs: 60_000,
      value: binary,
    });
    expect((await valkeyGlide.read({
      valueKey: nodeTrackedValueKey,
      watermarkKey: nodeTrackedWatermarkKey,
    }))?.payload).toEqual(binary);

    const glideTrackedValueKey = "interop:{glide-tracked}:value";
    const glideTrackedWatermarkKey = "interop:{glide-tracked}:watermark";
    await valkeyGlide.write({
      valueKey: glideTrackedValueKey,
      watermarkKey: glideTrackedWatermarkKey,
      cacheTtlMs: 60_000,
      value: "tracked",
    });
    expect((await nodeRedis.read({
      valueKey: glideTrackedValueKey,
      watermarkKey: glideTrackedWatermarkKey,
    }))?.payload).toBe("tracked");
  });
});

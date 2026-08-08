import { describe, expect, it } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  type CacheMetricLabels,
  type CompressionMetricLabels,
  type CompressionOperationMetricLabels,
  type DialCacheMetricsAdapter,
  type SerializationMetricLabels,
  type Serializer,
} from "../src/index.js";
import { MARKER_ESCAPED_RAW, MARKER_ZSTD_UTF8 } from "../src/internal/compression.js";
import { decodeFrame, encodeFrame, FakeRedis } from "./fake-redis.js";

const keyFor = (id: string, useCase: string): DialCacheKey =>
  new DialCacheKey({ keyType: "user_id", id, useCase });
const redisKeyFor = (id: string, useCase: string): string =>
  `${keyFor(id, useCase).urn}:dialcache-frame-v1`;

const remoteOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

const largeValue = (userId: string) => ({ userId, blob: "dialcache payload ".repeat(1_024) });

class RecordingMetrics implements DialCacheMetricsAdapter {
  readonly compressionCalls: CompressionMetricLabels[] = [];
  readonly ratioCalls: Array<{ readonly labels: CacheMetricLabels; readonly ratio: number }> = [];
  readonly sizeCalls: Array<{ readonly labels: CacheMetricLabels; readonly bytes: number }> = [];
  readonly durationCalls: CompressionOperationMetricLabels[] = [];

  request(): void {}
  miss(): void {}
  disabled(): void {}
  error(): void {}
  invalidation(): void {}
  observeGet(): void {}
  observeFallback(): void {}
  observeSerialization(_labels: SerializationMetricLabels, _seconds: number): void {}

  compression(labels: CompressionMetricLabels): void {
    this.compressionCalls.push(labels);
  }

  observeSize(labels: CacheMetricLabels, bytes: number): void {
    this.sizeCalls.push({ labels, bytes });
  }

  observeCompressionRatio(labels: CacheMetricLabels, ratio: number): void {
    this.ratioCalls.push({ labels, ratio });
  }

  observeCompression(labels: CompressionOperationMetricLabels, _seconds: number): void {
    this.durationCalls.push(labels);
  }
}

describe("DialCache Redis payload compression", () => {
  it("compresses large values transparently and reads them back across processes", async () => {
    const redis = new FakeRedis();
    const writer = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    const writeUser = writer.cached(async (userId: string) => largeValue(userId), {
      keyType: "user_id",
      useCase: "CompressionRoundTrip",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });

    const written = await writer.enable(async () => await writeUser("123"));

    const frame = decodeFrame(redis.raw(redisKeyFor("123", "CompressionRoundTrip")));
    const serialized = JSON.stringify(largeValue("123"));
    expect(frame.encoding).toBe(1);
    const stored = frame.payload;
    if (!Buffer.isBuffer(stored)) {
      throw new Error("compressed frame payload must be binary");
    }
    expect(stored[0]).toBe(MARKER_ZSTD_UTF8);
    expect(stored.length).toBeLessThan(Buffer.byteLength(serialized));

    const reader = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let readerCalls = 0;
    const readUser = reader.cached(async (userId: string) => ({ userId, calls: ++readerCalls }), {
      keyType: "user_id",
      useCase: "CompressionRoundTrip",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });

    const read = await reader.enable(async () => await readUser("123"));

    expect(written).toEqual(largeValue("123"));
    expect(read).toEqual(largeValue("123"));
    expect(readerCalls).toBe(0);
  });

  it("stores payloads below the threshold byte-identical to the uncompressed format", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    const getUser = dialcache.cached(async (userId: string) => ({ userId, small: true }), {
      keyType: "user_id",
      useCase: "CompressionSmallValue",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });

    await dialcache.enable(async () => await getUser("123"));

    expect(decodeFrame(redis.raw(redisKeyFor("123", "CompressionSmallValue")))).toMatchObject({
      encoding: 0,
      payload: JSON.stringify({ userId: "123", small: true }),
    });
  });

  it("reads legacy uncompressed entries with compression enabled", async () => {
    const redis = new FakeRedis();
    const stale = largeValue("legacy");
    redis.setRaw(redisKeyFor("legacy", "CompressionLegacyRead"), encodeFrame(stale));
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "CompressionLegacyRead",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });

    const value = await dialcache.enable(async () => await getUser("legacy"));

    expect(value).toEqual(stale);
    expect(calls).toBe(0);
  });

  it("still decompresses reads when write-side compression is disabled", async () => {
    const redis = new FakeRedis();
    const writer = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    const writeUser = writer.cached(async (userId: string) => largeValue(userId), {
      keyType: "user_id",
      useCase: "CompressionDisabledReader",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });
    await writer.enable(async () => await writeUser("123"));

    const optedOut = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000, compression: false } });
    let calls = 0;
    const readUser = optedOut.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "CompressionDisabledReader",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });

    const read = await optedOut.enable(async () => await readUser("123"));

    expect(read).toEqual(largeValue("123"));
    expect(calls).toBe(0);

    const writeLarge = optedOut.cached(async (userId: string) => largeValue(userId), {
      keyType: "user_id",
      useCase: "CompressionDisabledWriter",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });
    await optedOut.enable(async () => await writeLarge("456"));

    expect(decodeFrame(redis.raw(redisKeyFor("456", "CompressionDisabledWriter")))).toMatchObject({
      encoding: 0,
      payload: JSON.stringify(largeValue("456")),
    });
  });

  it("treats marker-colliding garbage as a miss, records fallback_raw, and repopulates the entry", async () => {
    const redis = new FakeRedis();
    const redisKey = redisKeyFor("123", "CompressionGarbageMiss");
    redis.setRaw(
      redisKey,
      encodeFrame(Buffer.concat([Buffer.from([MARKER_ZSTD_UTF8]), Buffer.from("not zstd at all")]), Date.now(), 1),
    );
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 }, metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "CompressionGarbageMiss",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });

    const value = await dialcache.enable(async () => await getUser("123"));

    expect(value).toEqual({ userId: "123", calls: 1 });
    expect(decodeFrame(redis.raw(redisKey))).toMatchObject({
      encoding: 0,
      payload: JSON.stringify({ userId: "123", calls: 1 }),
    });
    expect(metrics.compressionCalls).toContainEqual(
      expect.objectContaining({ useCase: "CompressionGarbageMiss", outcome: "fallback_raw" }),
    );
  });

  it("round-trips a custom binary serializer whose output starts with the marker byte", async () => {
    interface Row {
      readonly id: string;
    }
    const serializer: Serializer<Row> = {
      dump: (row) => Buffer.concat([Buffer.from([MARKER_ZSTD_UTF8]), Buffer.from(JSON.stringify(row), "utf8")]),
      load: (payload) => {
        if (!Buffer.isBuffer(payload)) {
          throw new Error("expected binary payload");
        }
        return JSON.parse(payload.subarray(1).toString("utf8")) as Row;
      },
    };
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getRow = dialcache.cached(
      async (id: string): Promise<Row> => {
        calls += 1;
        return { id };
      },
      {
        keyType: "user_id",
        useCase: "CompressionMarkerCollision",
        cacheKey: (id) => id,
        defaultConfig: remoteOnly(),
        serializer,
      },
    );

    const first = await dialcache.enable(async () => await getRow("123"));

    // The stored payload carries the escape prefix, so decoding is exact
    // rather than dependent on zstd rejecting the serializer's bytes.
    const stored = decodeFrame(redis.raw(redisKeyFor("123", "CompressionMarkerCollision"))).payload;
    if (!Buffer.isBuffer(stored)) {
      throw new Error("expected a binary stored payload");
    }
    expect(stored[0]).toBe(MARKER_ESCAPED_RAW);
    expect(stored[1]).toBe(MARKER_ZSTD_UTF8);

    const reader = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    const readRow = reader.cached(
      async (id: string): Promise<Row> => {
        calls += 1;
        return { id };
      },
      {
        keyType: "user_id",
        useCase: "CompressionMarkerCollision",
        cacheKey: (id) => id,
        defaultConfig: remoteOnly(),
        serializer,
      },
    );
    const second = await reader.enable(async () => await readRow("123"));

    expect(first).toEqual({ id: "123" });
    expect(second).toEqual({ id: "123" });
    expect(calls).toBe(1);
  });

  it("reads legacy 0x00-leading binary payloads untouched and escapes new writes of them", async () => {
    interface Tagged {
      readonly id: string;
    }
    // A binary format whose first byte is 0x00, like msgpack's zero or Avro's
    // zigzag zero. Legacy entries predate escaping and must pass through.
    const serializer: Serializer<Tagged> = {
      dump: (row) => Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify(row), "utf8")]),
      load: (payload) => {
        if (!Buffer.isBuffer(payload) || payload[0] !== 0x00) {
          throw new Error("expected a 0x00-tagged binary payload");
        }
        return JSON.parse(payload.subarray(1).toString("utf8")) as Tagged;
      },
    };
    const redis = new FakeRedis();
    const legacyKey = redisKeyFor("legacy", "CompressionZeroLead");
    redis.setRaw(
      legacyKey,
      encodeFrame(Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify({ id: "legacy" }), "utf8")]), Date.now(), 1),
    );
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getRow = dialcache.cached(
      async (id: string): Promise<Tagged> => {
        calls += 1;
        return { id };
      },
      {
        keyType: "user_id",
        useCase: "CompressionZeroLead",
        cacheKey: (id) => id,
        defaultConfig: remoteOnly(),
        serializer,
      },
    );

    // Legacy read: byte 1 is '{' (outside the envelope), so nothing is stripped.
    const legacy = await dialcache.enable(async () => await getRow("legacy"));
    expect(legacy).toEqual({ id: "legacy" });
    expect(calls).toBe(0);

    // Fresh write: escaped on the wire, stripped exactly once on read.
    const fresh = await dialcache.enable(async () => await getRow("fresh"));
    expect(fresh).toEqual({ id: "fresh" });
    const stored = decodeFrame(redis.raw(redisKeyFor("fresh", "CompressionZeroLead"))).payload;
    if (!Buffer.isBuffer(stored)) {
      throw new Error("expected a binary stored payload");
    }
    expect(stored[0]).toBe(MARKER_ESCAPED_RAW);
    expect(stored[1]).toBe(0x00);
    const reread = await dialcache.enable(async () => await getRow("fresh"));
    expect(reread).toEqual({ id: "fresh" });
    expect(calls).toBe(1);
  });

  it("caches undefined values with compression enabled", async () => {
    const redis = new FakeRedis();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 } });
    let calls = 0;
    const getNothing = dialcache.cached(
      async (_userId: string): Promise<undefined> => {
        calls += 1;
        return undefined;
      },
      {
        keyType: "user_id",
        useCase: "CompressionUndefinedValue",
        cacheKey: (userId) => userId,
        defaultConfig: remoteOnly(),
      },
    );

    const first = await dialcache.enable(async () => await getNothing("123"));
    const second = await dialcache.enable(async () => await getNothing("123"));

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("emits compression outcomes, ratio, and stored size through metrics", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 }, metrics });
    const getLarge = dialcache.cached(async (userId: string) => largeValue(userId), {
      keyType: "user_id",
      useCase: "CompressionMetricsLarge",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });
    const getSmall = dialcache.cached(async (userId: string) => ({ userId }), {
      keyType: "user_id",
      useCase: "CompressionMetricsSmall",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });

    await dialcache.enable(async () => await getLarge("123"));
    await dialcache.enable(async () => await getSmall("123"));

    const reader = new DialCache({ redis: { client: redis, readTimeoutMs: 1_000 }, metrics });
    const readLarge = reader.cached(async (userId: string) => largeValue(userId), {
      keyType: "user_id",
      useCase: "CompressionMetricsLarge",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });
    await reader.enable(async () => await readLarge("123"));

    expect(metrics.compressionCalls).toEqual([
      expect.objectContaining({ useCase: "CompressionMetricsLarge", layer: CacheLayer.REMOTE, outcome: "compressed" }),
      expect.objectContaining({ useCase: "CompressionMetricsSmall", layer: CacheLayer.REMOTE, outcome: "below_threshold" }),
      expect.objectContaining({ useCase: "CompressionMetricsLarge", layer: CacheLayer.REMOTE, outcome: "decompressed" }),
    ]);

    expect(metrics.durationCalls).toEqual([
      expect.objectContaining({ useCase: "CompressionMetricsLarge", operation: "compress" }),
      expect.objectContaining({ useCase: "CompressionMetricsLarge", operation: "decompress" }),
    ]);

    expect(metrics.ratioCalls).toHaveLength(1);
    const ratio = metrics.ratioCalls[0];
    expect(ratio?.labels).toMatchObject({ useCase: "CompressionMetricsLarge", layer: CacheLayer.REMOTE });
    expect(ratio?.ratio).toBeGreaterThan(0);
    expect(ratio?.ratio).toBeLessThan(1);

    const storedPayload = decodeFrame(redis.raw(redisKeyFor("123", "CompressionMetricsLarge"))).payload;
    const largeSize = metrics.sizeCalls.find(({ labels }) => labels.useCase === "CompressionMetricsLarge");
    expect(largeSize?.bytes).toBe(Buffer.isBuffer(storedPayload) ? storedPayload.length : -1);
    expect(largeSize?.bytes).toBeLessThan(Buffer.byteLength(JSON.stringify(largeValue("123"))));
  });

  it("rejects invalid compression config at construction", () => {
    const redis = new FakeRedis();
    expect(
      () => new DialCache({ redis: { client: redis, compression: { thresholdBytes: 0 } } }),
    ).toThrowError("RedisConfig.compression.thresholdBytes must be a positive safe integer");
    expect(
      () => new DialCache({ redis: { client: redis, compression: { level: 23 } } }),
    ).toThrowError("RedisConfig.compression.level must be an integer between 1 and 22");
  });
});

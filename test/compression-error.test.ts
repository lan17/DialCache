import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  type DialCacheMetricsAdapter,
  type ErrorMetricLabels,
} from "../src/index.js";
import { FakeRedis } from "./fake-redis.js";

// Simulates zstd failing at runtime (for example an allocation failure under
// memory pressure) while remaining present, so construction succeeds and the
// failure surfaces inside the write path. Deliberately does not import any
// shared test fixture: vi.mock poisons node:zlib for this module graph.
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    zstdCompressSync: () => {
      throw new Error("simulated zstd failure");
    },
  };
});

class ErrorRecordingMetrics implements DialCacheMetricsAdapter {
  readonly errors: ErrorMetricLabels[] = [];

  request(): void {}
  miss(): void {}
  disabled(): void {}
  invalidation(): void {}
  observeGet(): void {}
  observeFallback(): void {}
  observeSerialization(): void {}
  observeSize(): void {}

  error(labels: ErrorMetricLabels): void {
    this.errors.push(labels);
  }
}

describe("write-path compression failure", () => {
  it("records the compression error kind once, fails open, and stores nothing", async () => {
    const redis = new FakeRedis();
    const metrics = new ErrorRecordingMetrics();
    const silentLogger = { debug: () => {}, error: () => {}, warn: () => {} };
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      logger: silentLogger,
    });
    const value = { blob: "dialcache payload ".repeat(1_024) };
    const getLarge = dialcache.cached(async (_userId: string) => value, {
      keyType: "user_id",
      useCase: "CompressionWriteFailure",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
      }),
    });

    const served = await dialcache.enable(async () => await getLarge("123"));

    expect(served).toEqual(value);
    const compressionErrors = metrics.errors.filter(({ error }) => error === "compression");
    expect(compressionErrors).toEqual([
      expect.objectContaining({
        useCase: "CompressionWriteFailure",
        layer: CacheLayer.REMOTE,
        error: "compression",
        inFallback: false,
      }),
    ]);

    const redisKey = `${new DialCacheKey({ keyType: "user_id", id: "123", useCase: "CompressionWriteFailure" }).urn}:dialcache-frame-v1`;
    expect(() => redis.raw(redisKey)).toThrowError(`missing value for ${redisKey}`);
  });
});

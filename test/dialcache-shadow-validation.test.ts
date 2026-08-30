import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  type CacheMetricLabels,
  type DecodedRedisFrame,
  type DialCacheConfig,
  type DialCacheMetricsAdapter,
  type DisabledMetricLabels,
  type ErrorMetricLabels,
  type InvalidationMetricLabels,
  type RedisReadResult,
  type SerializationMetricLabels,
  type Serializer,
  type ShadowValidationMetricLabels,
} from "../src/index.js";
import { deterministicShadowRampSample } from "../src/internal/ramp.js";
import { encodeFrame, FakeRedis } from "./fake-redis.js";

interface ShadowAgeEvent {
  readonly labels: ShadowValidationMetricLabels;
  readonly seconds: number;
}

interface FutureTimestampEvent {
  readonly labels: CacheMetricLabels;
  readonly seconds: number;
}

function isDecodedRedisFrame(result: RedisReadResult): result is DecodedRedisFrame {
  return result !== null && "payload" in result && "createdAtMs" in result;
}

class RecordingMetrics implements DialCacheMetricsAdapter {
  readonly shadowEvents: ShadowValidationMetricLabels[] = [];
  readonly shadowAgeEvents: ShadowAgeEvent[] = [];
  readonly futureTimestampEvents: FutureTimestampEvent[] = [];
  readonly errorEvents: ErrorMetricLabels[] = [];

  request(_labels: CacheMetricLabels): void {}
  miss(_labels: CacheMetricLabels): void {}
  disabled(_labels: DisabledMetricLabels): void {}

  error(labels: ErrorMetricLabels): void {
    this.errorEvents.push({ ...labels });
  }

  invalidation(_labels: InvalidationMetricLabels): void {}

  shadowValidation(labels: ShadowValidationMetricLabels): void {
    this.shadowEvents.push({ ...labels });
  }

  observeShadowValueAge(labels: ShadowValidationMetricLabels, seconds: number): void {
    this.shadowAgeEvents.push({ labels: { ...labels }, seconds });
  }

  observeFutureTimestampOffset(labels: CacheMetricLabels, seconds: number): void {
    this.futureTimestampEvents.push({ labels: { ...labels }, seconds });
  }

  observeGet(_labels: CacheMetricLabels, _seconds: number): void {}
  observeFallback(_labels: CacheMetricLabels, _seconds: number): void {}
  observeSerialization(_labels: SerializationMetricLabels, _seconds: number): void {}
  observeSize(_labels: CacheMetricLabels, _bytes: number): void {}
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function remoteOnly(shadowPercentage?: number, requestLocal = false): DialCacheKeyConfig {
  return new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
    ...(shadowPercentage === undefined ? {} : { shadow: { ramp: shadowPercentage } }),
    ...(requestLocal ? { requestLocal: true } : {}),
  });
}

function localAndRemote(shadowPercentage: number): DialCacheKeyConfig {
  return new DialCacheKeyConfig({
    ttlSec: {
      [CacheLayer.LOCAL]: 60,
      [CacheLayer.REMOTE]: 60,
    },
    ramp: {
      [CacheLayer.LOCAL]: 100,
      [CacheLayer.REMOTE]: 100,
    },
    shadow: { ramp: shadowPercentage },
  });
}

function seedRedis(
  redis: FakeRedis,
  options: {
    readonly id: string;
    readonly useCase: string;
    readonly payload: string | Buffer;
    readonly tracked?: boolean;
    readonly createdAtMs?: number;
  },
): DialCacheKey {
  const key = new DialCacheKey({
    keyType: "user_id",
    id: options.id,
    useCase: options.useCase,
    trackForInvalidation: options.tracked ?? true,
  });
  redis.setRaw(
    `${key.urn}:dialcache-frame-v1`,
    encodeFrame(options.payload, options.createdAtMs ?? Date.now(), Buffer.isBuffer(options.payload) ? 1 : 0),
  );
  if (key.trackForInvalidation) {
    redis.setRaw(`${key.prefix}#watermark`, "0");
  }
  return key;
}

function metricsWithoutShadow(): DialCacheMetricsAdapter {
  return {
    request: () => undefined,
    miss: () => undefined,
    disabled: () => undefined,
    error: () => undefined,
    invalidation: () => undefined,
    observeGet: () => undefined,
    observeFallback: () => undefined,
    observeSerialization: () => undefined,
    observeSize: () => undefined,
  };
}

function createShadowCache(
  redis: FakeRedis,
  metrics: DialCacheMetricsAdapter,
  config: Omit<DialCacheConfig, "metrics" | "redis"> = {},
): DialCache {
  return new DialCache({
    ...config,
    redis: { client: redis, readTimeoutMs: 1_000 },
    metrics,
  });
}

function trackedRemoteDefaults(useCase: string, shadowPercentage = 100) {
  return {
    keyType: "user_id",
    useCase,
    trackForInvalidation: true,
    defaultConfig: remoteOnly(shadowPercentage),
  } as const;
}

const nextImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitForShadowEvents(metrics: RecordingMetrics, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(metrics.shadowEvents).toHaveLength(count);
  }, { timeout: 1_000, interval: 1 });
}

describe("DialCache Redis shadow validation", () => {
  it("returns a Redis hit before starting the detached source read", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowDetached";
    const cachedValue = { id: "123", version: 1 };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const sourceGate = deferred<typeof cachedValue>();
    let sourceCalls = 0;
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async (id: string) => {
      sourceCalls += 1;
      return await sourceGate.promise;
    }, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: (id) => id,
    });

    const result = await dialcache.enable(async () => await getUser("123"));

    expect(result).toEqual(cachedValue);
    expect(sourceCalls).toBe(0);
    expect(metrics.shadowEvents).toHaveLength(0);

    await nextImmediate();
    expect(sourceCalls).toBe(1);
    expect(metrics.shadowEvents).toHaveLength(0);

    sourceGate.resolve(cachedValue);
    await waitForShadowEvents(metrics, 1);
    expect(metrics.shadowEvents[0]).toMatchObject({ useCase, outcome: "match" });
  });

  it("starts a served-hit deadline when detached validation begins", async () => {
    let nowMs = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowDetachedDeadlineStart";
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const source = vi.fn(async () => cachedValue);
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
    });

    try {
      expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
      expect(source).not.toHaveBeenCalled();

      nowMs = 100;
      await waitForShadowEvents(metrics, 1);

      expect(source).toHaveBeenCalledOnce();
      expect(metrics.shadowEvents[0]?.outcome).toBe("match");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("matches deserialized JSON values with different property insertion order", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowSemanticJsonOrder";
    const cachedValue = {
      id: "123",
      profile: { active: true, name: "Ada" },
    };
    const key = seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const originalFrame = Buffer.from(redis.raw(`${key.urn}:dialcache-frame-v1`));
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async () => ({
      profile: { name: "Ada", active: true },
      id: "123",
    }), {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents[0]?.outcome).toBe("match");
    expect(redis.setCalls).toBe(0);
    expect(redis.raw(`${key.urn}:dialcache-frame-v1`)).toEqual(originalFrame);
  });

  it("reports a mismatch for a different deserialized source value", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowSemanticMismatch";
    seedRedis(redis, {
      id: "123",
      useCase,
      payload: JSON.stringify({ id: "123", version: 1 }),
    });
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ id: "123", version: 1 });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents[0]?.outcome).toBe("mismatch");
    expect(redis.setCalls).toBe(0);
  });

  it("records the validated value age alongside a match verdict", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const redis = new FakeRedis();
      const metrics = new RecordingMetrics();
      const useCase = "ShadowValueAgeMatch";
      const cachedValue = { id: "123", version: 1 };
      seedRedis(redis, {
        id: "123",
        useCase,
        payload: JSON.stringify(cachedValue),
        createdAtMs: nowMs - 45_000,
      });
      const dialcache = createShadowCache(redis, metrics);
      const getUser = dialcache.cached(async () => cachedValue, {
        ...trackedRemoteDefaults(useCase),
        cacheKey: () => "123",
      });

      expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents[0]?.outcome).toBe("match");
      expect(metrics.shadowAgeEvents).toHaveLength(1);
      expect(metrics.shadowAgeEvents[0]?.seconds).toBe(45);
      expect(metrics.shadowAgeEvents[0]?.labels).toMatchObject({
        useCase,
        keyType: "user_id",
        outcome: "match",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("records the mismatched value age from the retained frame's creation time", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const redis = new FakeRedis();
      const metrics = new RecordingMetrics();
      const useCase = "ShadowValueAgeMismatch";
      seedRedis(redis, {
        id: "123",
        useCase,
        payload: JSON.stringify({ id: "123", version: 1 }),
        createdAtMs: nowMs - 50_000,
      });
      const dialcache = createShadowCache(redis, metrics);
      const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
        ...trackedRemoteDefaults(useCase),
        cacheKey: () => "123",
      });

      expect(await dialcache.enable(async () => await getUser())).toEqual({ id: "123", version: 1 });
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents[0]?.outcome).toBe("mismatch");
      expect(metrics.shadowAgeEvents).toHaveLength(1);
      expect(metrics.shadowAgeEvents[0]?.seconds).toBe(50);
      expect(metrics.shadowAgeEvents[0]?.labels).toMatchObject({ useCase, outcome: "mismatch" });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("clamps value age to zero when the reader clock steps backward after accepting the frame", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const redis = new FakeRedis();
      const metrics = new RecordingMetrics();
      const useCase = "ShadowValueAgeClockRollback";
      const cachedValue = { id: "123" };
      seedRedis(redis, {
        id: "123",
        useCase,
        payload: JSON.stringify(cachedValue),
        createdAtMs: nowMs,
      });
      const sourceStarted = deferred<void>();
      const sourceGate = deferred<typeof cachedValue>();
      const dialcache = createShadowCache(redis, metrics);
      const getUser = dialcache.cached(async () => {
        sourceStarted.resolve(undefined);
        return await sourceGate.promise;
      }, {
        ...trackedRemoteDefaults(useCase),
        cacheKey: () => "123",
      });

      expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
      await sourceStarted.promise;
      nowSpy.mockReturnValue(nowMs - 60_000);
      sourceGate.resolve(cachedValue);
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents[0]?.outcome).toBe("match");
      expect(metrics.shadowAgeEvents).toHaveLength(1);
      expect(metrics.shadowAgeEvents[0]?.seconds).toBe(0);
      expect(metrics.futureTimestampEvents).toEqual([]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("preserves ordinary shadow fills after a tracked frame is rejected as future-dated", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const redis = new FakeRedis();
      const write = vi.spyOn(redis, "write");
      const metrics = new RecordingMetrics();
      const miss = vi.spyOn(metrics, "miss");
      const useCase = "ShadowFutureFrameOrdinaryRefill";
      const key = seedRedis(redis, {
        id: "123",
        useCase,
        payload: JSON.stringify({ source: "redis" }),
        createdAtMs: nowMs + 2_000,
      });
      redis.setRaw(`${key.prefix}#watermark`, String(nowMs + 1_000));
      const dialcache = createShadowCache(redis, metrics);
      const getUser = dialcache.cached(async () => ({ source: "fallback" }), {
        keyType: "user_id",
        useCase,
        cacheKey: () => "123",
        trackForInvalidation: true,
        defaultConfig: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 0 },
          shadow: { ramp: 100 },
        }),
      });

      await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ source: "fallback" });
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["filled"]);
      expect(miss).toHaveBeenCalledWith(expect.objectContaining({
        layer: "remote_shadow",
        reason: "unclassified",
      }));
      expect(write).toHaveBeenCalledOnce();
      expect(write.mock.calls[0]?.[0]).not.toHaveProperty("createdAtMs");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rejects a non-finite untracked timestamp before shadow validation", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowNonFiniteValueAge";
    const cachedValue = { id: "123", version: 1 };
    seedRedis(redis, {
      id: "123",
      useCase,
      payload: JSON.stringify(cachedValue),
      tracked: false,
    });
    const originalRead = redis.read.bind(redis);
    vi.spyOn(redis, "read").mockImplementation(async (request) => {
      const frame = await originalRead(request);
      return !isDecodedRedisFrame(frame)
        ? frame
        : { ...frame, createdAtMs: Number.POSITIVE_INFINITY };
    });
    const dialcache = createShadowCache(redis, metrics);
    const source = vi.fn(async () => cachedValue);
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: remoteOnly(100),
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
    await nextImmediate();

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents).toEqual([]);
    expect(metrics.shadowAgeEvents).toEqual([]);
    expect(metrics.futureTimestampEvents).toEqual([]);
    expect(redis.setCalls).toBe(1);
  });

  it("re-deserializes the retained payload instead of comparing a caller-mutated hit", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowIsolatedCachedSnapshot";
    const cachedValue = { id: "123", version: 1 };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const sourceGate = deferred<typeof cachedValue>();
    const serializer: Serializer<typeof cachedValue> = {
      dump: vi.fn((value) => JSON.stringify(value)),
      load: vi.fn((payload) =>
        JSON.parse(Buffer.isBuffer(payload) ? payload.toString("utf8") : payload) as typeof cachedValue
      ),
    };
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async () => await sourceGate.promise, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      serializer,
    });

    const returned = await dialcache.enable(async () => await getUser());
    returned.version = 99;
    sourceGate.resolve(cachedValue);
    await waitForShadowEvents(metrics, 1);

    expect(returned.version).toBe(99);
    expect(serializer.load).toHaveBeenCalledTimes(2);
    expect(serializer.dump).not.toHaveBeenCalled();
    expect(metrics.shadowEvents[0]?.outcome).toBe("match");
  });

  it("validates an untracked Redis hit without consulting a watermark", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowUntracked";
    seedRedis(redis, {
      id: "123",
      useCase,
      payload: JSON.stringify({ id: "123", source: "cache" }),
      tracked: false,
    });
    const source = vi.fn(async () => ({ id: "123", source: "truth" }));
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: remoteOnly(100),
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ id: "123", source: "cache" });
    await waitForShadowEvents(metrics, 1);

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(redis.getCalls).toBe(2);
    expect(redis.mGetCalls).toBe(0);
    expect(redis.setCalls).toBe(0);
  });

  it("does not validate a tracked Redis miss", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const source = vi.fn(async () => ({ id: "123", source: "truth" }));
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults("ShadowMiss"),
      cacheKey: () => "123",
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ id: "123", source: "truth" });
    await nextImmediate();

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents).toHaveLength(0);
  });

  it("does not validate a Redis payload that fails to deserialize", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowLoadFailure";
    seedRedis(redis, { id: "123", useCase, payload: "malformed" });
    const source = vi.fn(async () => ({ id: "123", source: "truth" }));
    const serializer: Serializer<{ readonly id: string; readonly source: string }> = {
      load: vi.fn(async () => {
        throw new Error("cannot load");
      }),
      dump: vi.fn(async (value) => JSON.stringify(value)),
    };
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      serializer,
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ id: "123", source: "truth" });
    await nextImmediate();

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents).toHaveLength(0);
  });

  it("does not run an unobservable validation when the metrics adapter omits the hook", async () => {
    const redis = new FakeRedis();
    const useCase = "ShadowNoMetricHook";
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify({ id: "123" }) });
    const source = vi.fn(async () => ({ id: "123" }));
    const error = vi.fn();
    const warn = vi.fn();
    const dialcache = createShadowCache(redis, {
      ...metricsWithoutShadow(),
      error,
    }, {
      cacheConfigProvider: async () => new DialCacheKeyConfig({
        shadow: { logMismatches: "yes" as never },
      }),
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn,
      },
    });
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults(useCase),
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
        shadow: {
          ramp: 100,
          logMismatches: true,
        },
      }),
      cacheKey: () => "123",
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ id: "123" });
    await nextImmediate();

    expect(source).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not validate shadow logging for a key outside the shadow cohort", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowExcludedInvalidLogging";
    const excludedId = Array.from({ length: 1_000 }, (_, index) => `excluded-${index}`)
      .find((id) => deterministicShadowRampSample(new DialCacheKey({
        keyType: "user_id",
        id,
        useCase,
        trackForInvalidation: true,
      })) >= 50);
    if (excludedId === undefined) {
      throw new Error("Could not find a key outside the partial shadow cohort");
    }
    seedRedis(redis, {
      id: excludedId,
      useCase,
      payload: JSON.stringify({ id: excludedId }),
    });
    const source = vi.fn(async (id: string) => ({ id }));
    const dialcache = createShadowCache(redis, metrics, {
      cacheConfigProvider: async () => new DialCacheKeyConfig({
        shadow: { logMismatches: "yes" as never },
      }),
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      trackForInvalidation: true,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
        shadow: { ramp: 50 },
      }),
      cacheKey: (id: string) => id,
    });

    expect(await dialcache.enable(async () => await getUser(excludedId))).toEqual({ id: excludedId });
    await nextImmediate();

    expect(source).not.toHaveBeenCalled();
    expect(metrics.shadowEvents).toHaveLength(0);
    expect(metrics.errorEvents.filter((labels) =>
      labels.layer === CacheLayer.REMOTE
      && labels.error === "config_resolution"
    )).toHaveLength(0);
  });

  it.each([
    { name: "omitted", shadowPercentage: undefined, recordsError: false },
    { name: "zero", shadowPercentage: 0, recordsError: false },
    { name: "a string", shadowPercentage: "100", recordsError: true },
    { name: "NaN", shadowPercentage: Number.NaN, recordsError: true },
    { name: "negative", shadowPercentage: -1, recordsError: true },
    { name: "above one hundred", shadowPercentage: 101, recordsError: true },
  ])("treats runtime shadow.ramp $name as a no-op without disturbing a valid Redis hit", async ({
    name,
    shadowPercentage,
    recordsError,
  }) => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = `ShadowRuntimeRamp${name.replaceAll(" ", "")}`;
    const cachedValue = { id: "123", source: "cache" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const runtimeConfig = new DialCacheKeyConfig({
      ...(shadowPercentage === undefined ? {} : { shadow: { ramp: shadowPercentage as number } }),
    });
    const source = vi.fn(async () => ({ id: "123", source: "truth" }));
    const dialcache = createShadowCache(redis, metrics, {
      cacheConfigProvider: async () => runtimeConfig,
    });
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      defaultConfig: remoteOnly(),
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
    await nextImmediate();

    expect(source).not.toHaveBeenCalled();
    expect(metrics.shadowEvents).toHaveLength(0);
    expect(metrics.errorEvents).toEqual(recordsError
      ? [{
          cacheNamespace: "urn",
          useCase,
          keyType: "user_id",
          layer: CacheLayer.REMOTE,
          error: "config_resolution",
          inFallback: false,
        }]
      : []);
  });

  it.each([
    {
      name: "enables a static policy that omits shadow validation",
      staticShadowRamp: undefined,
      runtimeShadowRamp: 100,
      expectedValidations: 1,
    },
    {
      name: "disables a static one-hundred-percent policy",
      staticShadowRamp: 100,
      runtimeShadowRamp: 0,
      expectedValidations: 0,
    },
  ])("runtime shadow.ramp $name", async ({
    staticShadowRamp,
    runtimeShadowRamp,
    expectedValidations,
  }) => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = `ShadowRuntimeOverlay${runtimeShadowRamp}`;
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const source = vi.fn(async () => cachedValue);
    const dialcache = createShadowCache(redis, metrics, {
      cacheConfigProvider: async () => new DialCacheKeyConfig({ shadow: { ramp: runtimeShadowRamp } }),
    });
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      defaultConfig: remoteOnly(staticShadowRamp),
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
    if (expectedValidations === 1) {
      await waitForShadowEvents(metrics, 1);
    } else {
      await nextImmediate();
    }

    expect(source).toHaveBeenCalledTimes(expectedValidations);
    expect(metrics.shadowEvents).toHaveLength(expectedValidations);
  });

  it("keeps partial shadow-ramp membership stable per exact key", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowStableRamp";
    const sampleFor = (id: string): number => deterministicShadowRampSample(new DialCacheKey({
      keyType: "user_id",
      id,
      useCase,
      trackForInvalidation: true,
    }));
    const selectedId = Array.from({ length: 1_000 }, (_, index) => `selected-${index}`)
      .find((id) => sampleFor(id) < 50);
    const excludedId = Array.from({ length: 1_000 }, (_, index) => `excluded-${index}`)
      .find((id) => sampleFor(id) >= 50);
    expect(selectedId).toBeDefined();
    expect(excludedId).toBeDefined();
    seedRedis(redis, {
      id: selectedId!,
      useCase,
      payload: JSON.stringify({ id: selectedId }),
    });
    seedRedis(redis, {
      id: excludedId!,
      useCase,
      payload: JSON.stringify({ id: excludedId }),
    });
    const sourceIds: string[] = [];
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async (id: string) => {
      sourceIds.push(id);
      return { id };
    }, {
      ...trackedRemoteDefaults(useCase, 50),
      cacheKey: (id) => id,
    });

    await dialcache.enable(async () => await getUser(selectedId!));
    await waitForShadowEvents(metrics, 1);
    await dialcache.enable(async () => await getUser(selectedId!));
    await waitForShadowEvents(metrics, 2);
    await dialcache.enable(async () => await getUser(excludedId!));
    await dialcache.enable(async () => await getUser(excludedId!));
    await nextImmediate();

    expect(sourceIds).toEqual([selectedId, selectedId]);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["match", "match"]);
  });

  it("unrefs both the detached scheduler and its validation deadline", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowUnrefHandles";
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const sourceGate = deferred<typeof cachedValue>();
    const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async () => await sourceGate.promise, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      fallbackTimeoutMs: 10_000,
    });

    try {
      expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);

      const scheduler = setImmediateSpy.mock.results[0]?.value as NodeJS.Immediate | undefined;
      expect(scheduler?.hasRef()).toBe(false);

      await nextImmediate();
      const shadowTimerIndex = setTimeoutSpy.mock.results.findIndex(({ value }) =>
        (value as NodeJS.Timeout | undefined)?.hasRef() === false
      );
      expect(shadowTimerIndex).toBeGreaterThanOrEqual(0);
      const shadowDelayMs = setTimeoutSpy.mock.calls[shadowTimerIndex]?.[1] as number;
      expect(shadowDelayMs).toBeGreaterThan(9_000);
      expect(shadowDelayMs).toBeLessThanOrEqual(10_000);

      sourceGate.resolve(cachedValue);
      await waitForShadowEvents(metrics, 1);
      expect(metrics.shadowEvents[0]?.outcome).toBe("match");
    } finally {
      sourceGate.resolve(cachedValue);
      setImmediateSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("uses a bounded 60-second shadow deadline when the request fallback deadline is disabled", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowNullFallbackDeadline";
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const sourceGate = deferred<typeof cachedValue>();
    const sourceStarted = deferred<void>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async () => {
      sourceStarted.resolve();
      return await sourceGate.promise;
    }, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      fallbackTimeoutMs: null,
    });

    try {
      expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
      await sourceStarted.promise;

      const shadowTimerIndex = setTimeoutSpy.mock.results.findIndex(({ value }) =>
        (value as NodeJS.Timeout | undefined)?.hasRef() === false
      );
      expect(shadowTimerIndex).toBeGreaterThanOrEqual(0);
      const shadowDelayMs = setTimeoutSpy.mock.calls[shadowTimerIndex]?.[1] as number;
      expect(shadowDelayMs).toBeGreaterThan(59_000);
      expect(shadowDelayMs).toBeLessThanOrEqual(60_000);

      sourceGate.resolve(cachedValue);
      await waitForShadowEvents(metrics, 1);
      expect(metrics.shadowEvents[0]?.outcome).toBe("match");
    } finally {
      sourceGate.resolve(cachedValue);
      setTimeoutSpy.mockRestore();
    }
  });

  it("does not start another validation for a process-local hit", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowNoLocalHit";
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify({ id: "123" }) });
    const source = vi.fn(async () => ({ id: "123" }));
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      defaultConfig: localAndRemote(100),
    });

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);
    await dialcache.enable(async () => await getUser());
    await nextImmediate();

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents).toHaveLength(1);
    expect(redis.mGetCalls).toBe(1);
  });

  it("does not start another validation for a request-local hit", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowNoRequestHit";
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify({ id: "123" }) });
    const source = vi.fn(async () => ({ id: "123" }));
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      defaultConfig: remoteOnly(100, true),
    });

    await dialcache.enable(async () => {
      await getUser();
      await waitForShadowEvents(metrics, 1);
      await getUser();
      await nextImmediate();
    });

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents).toHaveLength(1);
    expect(redis.mGetCalls).toBe(1);
  });

  it("reports a source error without affecting the cache hit", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowSourceError";
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify({ id: "123" }) });
    const source = vi.fn(async () => {
      throw new Error("source unavailable");
    });
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ id: "123" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents[0]?.outcome).toBe("source_error");
    expect(redis.setCalls).toBe(0);
  });

  it("reports a detached deserialization error without affecting the cache hit", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowDeserializationError";
    seedRedis(redis, { id: "123", useCase, payload: "cached" });
    let loadCalls = 0;
    const serializer: Serializer<{ readonly source: string }> = {
      load: vi.fn(async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          return { source: "cache" };
        }
        throw new Error("cannot deserialize retained payload");
      }),
      dump: vi.fn(async (value) => JSON.stringify(value)),
    };
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async () => ({ source: "truth" }), {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      serializer,
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ source: "cache" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents[0]?.outcome).toBe("deserialization_error");
    expect(serializer.load).toHaveBeenCalledTimes(2);
    expect(serializer.dump).not.toHaveBeenCalled();
    expect(redis.setCalls).toBe(0);
  });

  it("uses a custom comparator for getOrLoad semantic equality", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowCustomComparator";
    const cachedValue = { id: "123", refreshedAt: 1 };
    const sourceValue = { id: "123", refreshedAt: 2 };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const shadowComparator = vi.fn(
      (cached: typeof cachedValue, source: typeof sourceValue) => cached.id === source.id,
    );
    const dialcache = createShadowCache(redis, metrics);

    const result = await dialcache.enable(async () =>
      await dialcache.getOrLoad(async () => sourceValue, {
        ...trackedRemoteDefaults(useCase),
        key: "123",
        shadowComparator,
      })
    );
    await waitForShadowEvents(metrics, 1);

    expect(result).toEqual(cachedValue);
    expect(shadowComparator).toHaveBeenCalledWith(cachedValue, sourceValue);
    expect(metrics.shadowEvents[0]?.outcome).toBe("match");
  });

  it.each([
    {
      name: "throws",
      comparator: () => {
        throw new Error("cannot compare");
      },
    },
    {
      name: "returns a non-boolean",
      comparator: () => "match" as unknown as boolean,
    },
    {
      name: "returns a rejecting promise",
      comparator: () => Promise.reject(new Error("async comparators are unsupported")) as unknown as boolean,
    },
  ])("reports comparison_error when a custom comparator $name", async ({ name, comparator }) => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = `ShadowComparisonError${name.replaceAll(" ", "")}`;
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async () => cachedValue, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      shadowComparator: comparator,
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
    await waitForShadowEvents(metrics, 1);
    await Promise.resolve();

    expect(metrics.shadowEvents[0]?.outcome).toBe("comparison_error");
  });

  it("reports timeout when synchronous comparison crosses the monotonic deadline", async () => {
    let nowMs = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowSynchronousComparisonTimeout";
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const shadowComparator = vi.fn(() => {
      nowMs = 10;
      return true;
    });
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async () => cachedValue, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      shadowComparator,
    });

    try {
      expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
      await waitForShadowEvents(metrics, 1);

      expect(shadowComparator).toHaveBeenCalledOnce();
      expect(metrics.shadowEvents[0]?.outcome).toBe("timeout");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("retains a timed-out accidental async comparator flight until it settles", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowAsyncComparatorTimeoutRetention";
    seedRedis(redis, { id: "a", useCase, payload: JSON.stringify({ id: "a" }) });
    seedRedis(redis, { id: "b", useCase, payload: JSON.stringify({ id: "b" }) });
    const firstComparisonGate = deferred<boolean>();
    const firstComparisonStarted = deferred<void>();
    const sourceIds: string[] = [];
    let comparisonCalls = 0;
    const shadowComparator = vi.fn((cached: { readonly id: string }, source: { readonly id: string }) => {
      comparisonCalls += 1;
      if (comparisonCalls === 1) {
        firstComparisonStarted.resolve();
        return firstComparisonGate.promise as unknown as boolean;
      }
      return cached.id === source.id;
    });
    const dialcache = createShadowCache(redis, metrics, { shadowMaxInFlight: 1 });
    const getUser = dialcache.cached(async (id: string) => {
      sourceIds.push(id);
      return { id };
    }, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: (id) => id,
      fallbackTimeoutMs: 10,
      shadowComparator,
    });

    expect(await dialcache.enable(async () => await getUser("a"))).toEqual({ id: "a" });
    await firstComparisonStarted.promise;
    await waitForShadowEvents(metrics, 1);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);

    await dialcache.enable(async () => await getUser("b"));
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped"]);
    expect(sourceIds).toEqual(["a"]);

    firstComparisonGate.resolve(true);
    await nextImmediate();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped"]);

    await dialcache.enable(async () => await getUser("b"));
    await waitForShadowEvents(metrics, 3);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped", "match"]);
    expect(sourceIds).toEqual(["a", "b"]);
    expect(shadowComparator).toHaveBeenCalledTimes(2);
  });

  it("drops a duplicate exact-key validation instead of queueing it", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowDuplicateDrop";
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const gate = deferred<typeof cachedValue>();
    const source = vi.fn(async () => await gate.promise);
    const dialcache = createShadowCache(redis, metrics, { shadowMaxInFlight: 2 });
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
    });

    await dialcache.enable(async () => await getUser());
    await dialcache.enable(async () => await getUser());

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["dropped"]);
    await nextImmediate();
    expect(source).toHaveBeenCalledOnce();
    gate.resolve(cachedValue);
    await waitForShadowEvents(metrics, 2);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["dropped", "match"]);
  });

  it("drops a different key when the global shadow-flight cap is full", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowGlobalCapDrop";
    seedRedis(redis, { id: "a", useCase, payload: JSON.stringify({ id: "a" }) });
    seedRedis(redis, { id: "b", useCase, payload: JSON.stringify({ id: "b" }) });
    const firstGate = deferred<{ readonly id: string }>();
    const sourceIds: string[] = [];
    const dialcache = createShadowCache(redis, metrics, {
      shadowMaxInFlight: 1,
      cacheConfigProvider: async (key) => key.id === "b"
        ? new DialCacheKeyConfig({
            shadow: { logMismatches: "yes" as never },
          })
        : null,
    });
    const getUser = dialcache.cached(async (id: string) => {
      sourceIds.push(id);
      return id === "a" ? await firstGate.promise : { id };
    }, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: (id) => id,
    });

    await dialcache.enable(async () => await getUser("a"));
    await dialcache.enable(async () => await getUser("b"));

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["dropped"]);
    await nextImmediate();
    expect(sourceIds).toEqual(["a"]);
    expect(metrics.errorEvents.filter((labels) =>
      labels.layer === CacheLayer.REMOTE
      && labels.error === "config_resolution"
    )).toHaveLength(0);
    firstGate.resolve({ id: "a" });
    await waitForShadowEvents(metrics, 2);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["dropped", "match"]);
  });

  it("retains a timed-out source flight until it settles and skips late deserialization", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowTimeoutRetention";
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const firstSourceGate = deferred<typeof cachedValue>();
    let sourceCalls = 0;
    const serializer: Serializer<typeof cachedValue> = {
      load: vi.fn(async (payload) => JSON.parse(Buffer.isBuffer(payload) ? payload.toString("utf8") : payload) as typeof cachedValue),
      dump: vi.fn(async (value) => JSON.stringify(value)),
    };
    const dialcache = createShadowCache(redis, metrics, { shadowMaxInFlight: 1 });
    const getUser = dialcache.cached(async () => {
      sourceCalls += 1;
      return sourceCalls === 1 ? await firstSourceGate.promise : cachedValue;
    }, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
      fallbackTimeoutMs: 10,
      serializer,
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
    await nextImmediate();
    expect(sourceCalls).toBe(1);
    await waitForShadowEvents(metrics, 1);
    expect(metrics.shadowEvents[0]?.outcome).toBe("timeout");

    await dialcache.enable(async () => await getUser());
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped"]);

    firstSourceGate.resolve(cachedValue);
    await nextImmediate();
    expect(serializer.load).toHaveBeenCalledTimes(2);
    expect(serializer.dump).not.toHaveBeenCalled();

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 3);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped", "match"]);
    expect(sourceCalls).toBe(2);
    expect(serializer.load).toHaveBeenCalledTimes(4);
    expect(serializer.dump).not.toHaveBeenCalled();
  });

  it("retains a timed-out deserialization flight and ignores its late comparison result", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowDeserializationTimeoutRetention";
    seedRedis(redis, { id: "a", useCase, payload: JSON.stringify({ id: "a" }) });
    seedRedis(redis, { id: "b", useCase, payload: JSON.stringify({ id: "b" }) });
    const firstShadowLoadGate = deferred<{ readonly id: string }>();
    const firstShadowLoadStarted = deferred<void>();
    let loadCalls = 0;
    const serializer: Serializer<{ readonly id: string }> = {
      load: vi.fn(async (payload) => {
        loadCalls += 1;
        if (loadCalls === 2) {
          firstShadowLoadStarted.resolve();
          return await firstShadowLoadGate.promise;
        }
        return JSON.parse(
          Buffer.isBuffer(payload) ? payload.toString("utf8") : payload,
        ) as { readonly id: string };
      }),
      dump: vi.fn(async (value) => JSON.stringify(value)),
    };
    const sourceIds: string[] = [];
    const dialcache = createShadowCache(redis, metrics, { shadowMaxInFlight: 1 });
    const getUser = dialcache.cached(async (id: string) => {
      sourceIds.push(id);
      return { id };
    }, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: (id) => id,
      fallbackTimeoutMs: 10,
      serializer,
    });

    expect(await dialcache.enable(async () => await getUser("a"))).toEqual({ id: "a" });
    await firstShadowLoadStarted.promise;
    await waitForShadowEvents(metrics, 1);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);

    await dialcache.enable(async () => await getUser("b"));
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped"]);
    expect(sourceIds).toEqual(["a"]);

    firstShadowLoadGate.resolve({ id: "a" });
    await nextImmediate();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped"]);

    await dialcache.enable(async () => await getUser("b"));
    await waitForShadowEvents(metrics, 3);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped", "match"]);
    expect(sourceIds).toEqual(["a", "b"]);
    expect(serializer.load).toHaveBeenCalledTimes(5);
    expect(serializer.dump).not.toHaveBeenCalled();
  });

  it("starts one validation for coalesced Redis-hit followers", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowCoalescedFollowers";
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const readGate = deferred<void>();
    redis.getGate = readGate.promise;
    const source = vi.fn(async () => cachedValue);
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
    });

    const pending = dialcache.enable(async () => await Promise.all([getUser(), getUser()]));
    await nextImmediate();
    readGate.resolve();

    expect(await pending).toEqual([cachedValue, cachedValue]);
    await waitForShadowEvents(metrics, 1);
    expect(redis.mGetCalls).toBe(1);
    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["match"]);
  });

  it("runs the source loader under a disabled DialCache context", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowDisabledContext";
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const enabledStates: boolean[] = [];
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async () => {
      enabledStates.push(dialcache.isEnabled());
      return cachedValue;
    }, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
    });

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);

    expect(enabledStates).toEqual([false]);
    expect(metrics.shadowEvents[0]?.outcome).toBe("match");
  });

  it("consumes an asynchronously rejecting shadow-metric result", async () => {
    const redis = new FakeRedis();
    const useCase = "ShadowRejectingMetric";
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const shadowValidation = vi.fn(() => Promise.reject(new Error("metric transport unavailable")));
    const metrics: DialCacheMetricsAdapter = {
      ...metricsWithoutShadow(),
      shadowValidation,
    };
    const dialcache = createShadowCache(redis, metrics);
    const getUser = dialcache.cached(async () => cachedValue, {
      ...trackedRemoteDefaults(useCase),
      cacheKey: () => "123",
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
    await vi.waitFor(() => {
      expect(shadowValidation).toHaveBeenCalledOnce();
    }, { timeout: 1_000, interval: 1 });
    await Promise.resolve();
    await nextImmediate();

    expect(shadowValidation).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase,
      keyType: "user_id",
      outcome: "match",
    });
  });
});

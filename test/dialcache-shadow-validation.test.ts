import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  type CacheMetricLabels,
  type DialCacheMetricsAdapter,
  type DisabledMetricLabels,
  type ErrorMetricLabels,
  type InvalidationMetricLabels,
  type SerializationMetricLabels,
  type Serializer,
  type ShadowValidationMetricLabels,
} from "../src/index.js";
import { deterministicShadowRampSample } from "../src/internal/ramp.js";
import { encodeFrame, FakeRedis } from "./fake-redis.js";

class RecordingMetrics implements DialCacheMetricsAdapter {
  readonly shadowEvents: ShadowValidationMetricLabels[] = [];
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

function remoteOnly(shadowRamp?: number, requestLocal = false): DialCacheKeyConfig {
  return new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
    ...(shadowRamp === undefined ? {} : { shadowRamp }),
    ...(requestLocal ? { requestLocal: true } : {}),
  });
}

function localAndRemote(shadowRamp: number): DialCacheKeyConfig {
  return new DialCacheKeyConfig({
    ttlSec: {
      [CacheLayer.LOCAL]: 60,
      [CacheLayer.REMOTE]: 60,
    },
    ramp: {
      [CacheLayer.LOCAL]: 100,
      [CacheLayer.REMOTE]: 100,
    },
    shadowRamp,
  });
}

function seedRedis(
  redis: FakeRedis,
  options: {
    readonly id: string;
    readonly useCase: string;
    readonly payload: string | Buffer;
    readonly tracked?: boolean;
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
    encodeFrame(options.payload, Date.now(), Buffer.isBuffer(options.payload) ? 1 : 0),
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(async (id: string) => {
      sourceCalls += 1;
      return await sourceGate.promise;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
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

  it.each([
    {
      name: "equal strings",
      cachedPayload: "same",
      sourcePayload: "same",
      outcome: "match",
    },
    {
      name: "different strings",
      cachedPayload: "cached",
      sourcePayload: "fresh",
      outcome: "mismatch",
    },
    {
      name: "equal buffers",
      cachedPayload: Buffer.from("same"),
      sourcePayload: Buffer.from("same"),
      outcome: "match",
    },
    {
      name: "different buffers",
      cachedPayload: Buffer.from("cached"),
      sourcePayload: Buffer.from("fresh"),
      outcome: "mismatch",
    },
    {
      name: "identical bytes with mixed representations",
      cachedPayload: "same",
      sourcePayload: Buffer.from("same"),
      outcome: "mismatch",
    },
  ] as const)("compares serialized payloads exactly for $name", async ({
    cachedPayload,
    sourcePayload,
    outcome,
  }) => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = `ShadowPayload${outcome}${Buffer.isBuffer(cachedPayload) ? "Buffer" : "String"}${Buffer.isBuffer(sourcePayload) ? "Buffer" : "String"}`;
    const key = seedRedis(redis, { id: "123", useCase, payload: cachedPayload });
    const originalFrame = Buffer.from(redis.raw(`${key.urn}:dialcache-frame-v1`));
    const serializer: Serializer<{ readonly source: string }> = {
      load: vi.fn(async () => ({ source: "cache" })),
      dump: vi.fn(async () => sourcePayload),
    };
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(async () => ({ source: "truth" }), {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
      serializer,
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ source: "cache" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents[0]?.outcome).toBe(outcome);
    expect(serializer.dump).toHaveBeenCalledWith({ source: "truth" });
    expect(redis.setCalls).toBe(0);
    expect(redis.raw(`${key.urn}:dialcache-frame-v1`)).toEqual(originalFrame);
  });

  it("does not validate an untracked Redis hit", async () => {
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: remoteOnly(100),
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ id: "123", source: "cache" });
    await nextImmediate();

    expect(source).not.toHaveBeenCalled();
    expect(metrics.shadowEvents).toHaveLength(0);
  });

  it("does not validate a tracked Redis miss", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const source = vi.fn(async () => ({ id: "123", source: "truth" }));
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase: "ShadowMiss",
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics: metricsWithoutShadow(),
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ id: "123" });
    await nextImmediate();

    expect(source).not.toHaveBeenCalled();
  });

  it.each([
    { name: "omitted", shadowRamp: undefined, recordsError: false },
    { name: "zero", shadowRamp: 0, recordsError: false },
    { name: "a string", shadowRamp: "100", recordsError: true },
    { name: "NaN", shadowRamp: Number.NaN, recordsError: true },
    { name: "negative", shadowRamp: -1, recordsError: true },
    { name: "above one hundred", shadowRamp: 101, recordsError: true },
  ])("treats runtime shadowRamp $name as a no-op without disturbing a valid Redis hit", async ({
    name,
    shadowRamp,
    recordsError,
  }) => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = `ShadowRuntimeRamp${name.replaceAll(" ", "")}`;
    const cachedValue = { id: "123", source: "cache" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const runtimeConfig = new DialCacheKeyConfig({
      ...(shadowRamp === undefined ? {} : { shadowRamp: shadowRamp as number }),
    });
    const source = vi.fn(async () => ({ id: "123", source: "truth" }));
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      cacheConfigProvider: async () => runtimeConfig,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(async (id: string) => {
      sourceIds.push(id);
      return { id };
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(50),
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(async () => await sourceGate.promise, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
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
      expect(setTimeoutSpy.mock.calls[shadowTimerIndex]?.[1]).toBe(10_000);

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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(async () => {
      sourceStarted.resolve();
      return await sourceGate.promise;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
      fallbackTimeoutMs: null,
    });

    try {
      expect(await dialcache.enable(async () => await getUser())).toEqual(cachedValue);
      await sourceStarted.promise;

      const shadowTimerIndex = setTimeoutSpy.mock.results.findIndex(({ value }) =>
        (value as NodeJS.Timeout | undefined)?.hasRef() === false
      );
      expect(shadowTimerIndex).toBeGreaterThanOrEqual(0);
      expect(setTimeoutSpy.mock.calls[shadowTimerIndex]?.[1]).toBe(60_000);

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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ id: "123" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents[0]?.outcome).toBe("source_error");
    expect(redis.setCalls).toBe(0);
  });

  it("reports a serialization error without affecting the cache hit", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowSerializationError";
    seedRedis(redis, { id: "123", useCase, payload: "cached" });
    const serializer: Serializer<{ readonly source: string }> = {
      load: vi.fn(async () => ({ source: "cache" })),
      dump: vi.fn(async () => {
        throw new Error("cannot serialize source value");
      }),
    };
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(async () => ({ source: "truth" }), {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
      serializer,
    });

    expect(await dialcache.enable(async () => await getUser())).toEqual({ source: "cache" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents[0]?.outcome).toBe("serialization_error");
    expect(redis.setCalls).toBe(0);
  });

  it("drops a duplicate exact-key validation instead of queueing it", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowDuplicateDrop";
    const cachedValue = { id: "123" };
    seedRedis(redis, { id: "123", useCase, payload: JSON.stringify(cachedValue) });
    const gate = deferred<typeof cachedValue>();
    const source = vi.fn(async () => await gate.promise);
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shadowMaxInFlight: 2,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shadowMaxInFlight: 1,
    });
    const getUser = dialcache.cached(async (id: string) => {
      sourceIds.push(id);
      return id === "a" ? await firstGate.promise : { id };
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
    });

    await dialcache.enable(async () => await getUser("a"));
    await dialcache.enable(async () => await getUser("b"));

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["dropped"]);
    await nextImmediate();
    expect(sourceIds).toEqual(["a"]);
    firstGate.resolve({ id: "a" });
    await waitForShadowEvents(metrics, 2);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["dropped", "match"]);
  });

  it("retains a timed-out underlying flight until it settles and skips late serialization", async () => {
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shadowMaxInFlight: 1,
    });
    const getUser = dialcache.cached(async () => {
      sourceCalls += 1;
      return sourceCalls === 1 ? await firstSourceGate.promise : cachedValue;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
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
    expect(serializer.dump).not.toHaveBeenCalled();

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 3);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped", "match"]);
    expect(sourceCalls).toBe(2);
    expect(serializer.dump).toHaveBeenCalledOnce();
  });

  it("retains a timed-out serialization flight and ignores its late comparison result", async () => {
    const redis = new FakeRedis();
    const metrics = new RecordingMetrics();
    const useCase = "ShadowSerializationTimeoutRetention";
    seedRedis(redis, { id: "a", useCase, payload: JSON.stringify({ id: "a" }) });
    seedRedis(redis, { id: "b", useCase, payload: JSON.stringify({ id: "b" }) });
    const firstDumpGate = deferred<string>();
    const firstDumpStarted = deferred<void>();
    let dumpCalls = 0;
    const serializer: Serializer<{ readonly id: string }> = {
      load: vi.fn(async (payload) =>
        JSON.parse(Buffer.isBuffer(payload) ? payload.toString("utf8") : payload) as { readonly id: string }
      ),
      dump: vi.fn(async (value) => {
        dumpCalls += 1;
        if (dumpCalls === 1) {
          firstDumpStarted.resolve();
          return await firstDumpGate.promise;
        }
        return JSON.stringify(value);
      }),
    };
    const sourceIds: string[] = [];
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
      shadowMaxInFlight: 1,
    });
    const getUser = dialcache.cached(async (id: string) => {
      sourceIds.push(id);
      return { id };
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
      fallbackTimeoutMs: 10,
      serializer,
    });

    expect(await dialcache.enable(async () => await getUser("a"))).toEqual({ id: "a" });
    await firstDumpStarted.promise;
    await waitForShadowEvents(metrics, 1);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);

    await dialcache.enable(async () => await getUser("b"));
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped"]);
    expect(sourceIds).toEqual(["a"]);

    firstDumpGate.resolve(JSON.stringify({ id: "a" }));
    await nextImmediate();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped"]);

    await dialcache.enable(async () => await getUser("b"));
    await waitForShadowEvents(metrics, 3);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped", "match"]);
    expect(sourceIds).toEqual(["a", "b"]);
    expect(serializer.dump).toHaveBeenCalledTimes(2);
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(async () => {
      enabledStates.push(dialcache.isEnabled());
      return cachedValue;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
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
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 1_000 },
      metrics,
    });
    const getUser = dialcache.cached(async () => cachedValue, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(100),
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

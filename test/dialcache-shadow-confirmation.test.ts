import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  FallbackTimeoutError,
  type CacheMetricLabels,
  type CoalescedMetricLabels,
  type DialCacheConfig,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type DisabledMetricLabels,
  type ErrorMetricLabels,
  type InvalidationMetricLabels,
  type RedisCachePayload,
  type RedisInvalidationRequest,
  type RedisReadContext,
  type RedisReadRequest,
  type RedisWriteRequest,
  type SerializationMetricLabels,
  type Serializer,
  type ShadowValidationMetricLabels,
} from "../src/index.js";
import {
  deterministicRampSample,
  deterministicShadowRampSample,
} from "../src/internal/ramp.js";

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

type ReadStep = () => RedisCachePayload | null | Promise<RedisCachePayload | null>;

class ScriptedRedis implements DialCacheRedisClient {
  readonly requests: RedisReadRequest[] = [];
  readonly contexts: Array<RedisReadContext | undefined> = [];
  readonly write = vi.fn(async (_request: RedisWriteRequest): Promise<boolean> => true);
  readonly invalidate = vi.fn(async (_request: RedisInvalidationRequest): Promise<void> => undefined);

  constructor(private readonly steps: ReadStep[]) {}

  async read(request: RedisReadRequest, context?: RedisReadContext): Promise<RedisCachePayload | null> {
    this.requests.push(request);
    this.contexts.push(context);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("Unexpected Redis read");
    }
    return await step();
  }
}

type OrdinaryMetricName =
  | "request"
  | "miss"
  | "disabled"
  | "error"
  | "invalidation"
  | "coalesced"
  | "get"
  | "fallback"
  | "serialization"
  | "size";

interface OrdinaryMetricEvent {
  readonly name: OrdinaryMetricName;
  readonly labels: Record<string, unknown>;
}

class RecordingMetrics implements DialCacheMetricsAdapter {
  readonly ordinaryEvents: OrdinaryMetricEvent[] = [];
  readonly shadowEvents: ShadowValidationMetricLabels[] = [];

  request(labels: CacheMetricLabels): void {
    this.record("request", labels);
  }

  miss(labels: CacheMetricLabels): void {
    this.record("miss", labels);
  }

  disabled(labels: DisabledMetricLabels): void {
    this.record("disabled", labels);
  }

  error(labels: ErrorMetricLabels): void {
    this.record("error", labels);
  }

  invalidation(labels: InvalidationMetricLabels): void {
    this.record("invalidation", labels);
  }

  coalesced(labels: CoalescedMetricLabels): void {
    this.record("coalesced", labels);
  }

  shadowValidation(labels: ShadowValidationMetricLabels): void {
    this.shadowEvents.push({ ...labels });
  }

  observeGet(labels: CacheMetricLabels, _seconds: number): void {
    this.record("get", labels);
  }

  observeFallback(labels: CacheMetricLabels, _seconds: number): void {
    this.record("fallback", labels);
  }

  observeSerialization(labels: SerializationMetricLabels, _seconds: number): void {
    this.record("serialization", labels);
  }

  observeSize(labels: CacheMetricLabels, _bytes: number): void {
    this.record("size", labels);
  }

  private record(name: OrdinaryMetricName, labels: object): void {
    this.ordinaryEvents.push({ name, labels: { ...labels } });
  }
}

function remoteConfig(remoteRamp: number, shadowRamp = 100): DialCacheKeyConfig {
  return new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: remoteRamp },
    shadowRamp,
  });
}

function localAndRemoteConfig(): DialCacheKeyConfig {
  return new DialCacheKeyConfig({
    ttlSec: {
      [CacheLayer.LOCAL]: 60,
      [CacheLayer.REMOTE]: 60,
    },
    ramp: {
      [CacheLayer.LOCAL]: 100,
      [CacheLayer.REMOTE]: 0,
    },
    shadowRamp: 100,
  });
}

function createCache(
  redis: DialCacheRedisClient,
  metrics: DialCacheMetricsAdapter,
  config: Omit<DialCacheConfig, "metrics" | "redis"> = {},
): DialCache {
  return new DialCache({
    ...config,
    redis: { client: redis, readTimeoutMs: 1_000 },
    metrics,
  });
}

function trackedOptions(useCase: string, config: DialCacheKeyConfig) {
  return {
    keyType: "user_id",
    useCase,
    trackForInvalidation: true,
    defaultConfig: config,
  } as const;
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
  }, { timeout: 2_000, interval: 1 });
}

function expectTrackedReads(
  redis: ScriptedRedis,
  count: number,
  options: { readonly singleWatermark?: boolean } = { singleWatermark: true },
): void {
  expect(redis.requests).toHaveLength(count);
  expect(redis.requests.every(({ watermarkKey }) => typeof watermarkKey === "string")).toBe(true);
  if (options.singleWatermark !== false) {
    expect(new Set(redis.requests.map(({ watermarkKey }) => watermarkKey)).size).toBe(1);
  }
}

describe("DialCache Redis shadow confirmation", () => {
  it("skips confirmation when the served Redis payload semantically matches SoT", async () => {
    const payload = JSON.stringify({ id: "123", version: 1 });
    const redis = new ScriptedRedis([() => payload]);
    const metrics = new RecordingMetrics();
    const source = vi.fn(async () => ({ id: "123", version: 1 }));
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowConfirmMatch", remoteConfig(100)),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123", version: 1 });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["match"]);
    expectTrackedReads(redis, 1);
    expect(source).toHaveBeenCalledOnce();
  });

  it("confirms a mismatch only when C1 is byte-identical to the served C0", async () => {
    const payload = JSON.stringify({ id: "123", version: 1 });
    const redis = new ScriptedRedis([() => payload, () => payload]);
    const metrics = new RecordingMetrics();
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
      ...trackedOptions("ShadowConfirmMismatch", remoteConfig(100)),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123", version: 1 });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expectTrackedReads(redis, 2);
    expect(redis.write).not.toHaveBeenCalled();
    expect(redis.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing", confirmation: null },
    {
      name: "changed even when the new payload decodes to SoT",
      confirmation: JSON.stringify({ id: "123", version: 2 }),
    },
  ])("reports superseded when C1 is $name", async ({ name, confirmation }) => {
    const payload = JSON.stringify({ id: "123", version: 1 });
    const redis = new ScriptedRedis([() => payload, () => confirmation]);
    const metrics = new RecordingMetrics();
    const serializer: Serializer<{ readonly id: string; readonly version: number }> = {
      dump: vi.fn((value) => JSON.stringify(value)),
      load: vi.fn((value) => JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value)),
    };
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
      ...trackedOptions(`ShadowSuperseded${name}`, remoteConfig(100)),
      cacheKey: () => "123",
      serializer,
    });

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["superseded"]);
    expect(serializer.load).toHaveBeenCalledTimes(2);
    expect(serializer.dump).not.toHaveBeenCalled();
    expectTrackedReads(redis, 2);
  });

  it.each([
    {
      name: "string to string",
      original: '{"value":"café"}',
      confirmation: '{"value":"café"}',
      outcome: "mismatch",
    },
    {
      name: "Buffer to Buffer",
      original: Buffer.from('{"value":"café"}', "utf8"),
      confirmation: Buffer.from('{"value":"café"}', "utf8"),
      outcome: "mismatch",
    },
    {
      name: "string to Buffer",
      original: '{"value":"café"}',
      confirmation: Buffer.from('{"value":"café"}', "utf8"),
      outcome: "mismatch",
    },
    {
      name: "Buffer to string",
      original: Buffer.from('{"value":"café"}', "utf8"),
      confirmation: '{"value":"café"}',
      outcome: "mismatch",
    },
    {
      name: "different UTF-8 bytes",
      original: '{"value":"café"}',
      confirmation: Buffer.from('{"value":"cafe"}', "utf8"),
      outcome: "superseded",
    },
  ] as const)("compares C1 and C0 raw payloads for $name", async ({
    name,
    original,
    confirmation,
    outcome,
  }) => {
    const redis = new ScriptedRedis([() => original, () => confirmation]);
    const metrics = new RecordingMetrics();
    const dialcache = createCache(redis, metrics);
    const getValue = dialcache.cached(async () => ({ value: "source" }), {
      ...trackedOptions(`ShadowRaw${name}`, remoteConfig(100)),
      cacheKey: () => "123",
    });

    await dialcache.enable(async () => await getValue());
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome: actual }) => actual)).toEqual([outcome]);
    expectTrackedReads(redis, 2);
  });

  it("reports confirmation_error without adding ordinary Redis-layer errors", async () => {
    const payload = JSON.stringify({ id: "123", version: 1 });
    const redis = new ScriptedRedis([
      () => payload,
      async () => {
        throw new Error("confirmation unavailable");
      },
    ]);
    const metrics = new RecordingMetrics();
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
      ...trackedOptions("ShadowConfirmationError", remoteConfig(100)),
      cacheKey: () => "123",
    });

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["confirmation_error"]);
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "error")).toHaveLength(0);
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "request")).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "get")).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "serialization")).toHaveLength(1);
  });

  it("returns the ramped-down SoT result without waiting for a dark C0 read", async () => {
    const payloadGate = deferred<RedisCachePayload | null>();
    const redis = new ScriptedRedis([async () => await payloadGate.promise]);
    const metrics = new RecordingMetrics();
    const sourceValue = { id: "123", version: 2 };
    const source = vi.fn(async () => sourceValue);
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkDetached", remoteConfig(0)),
      cacheKey: () => "123",
    });

    const result = await dialcache.enable(async () => await getUser());

    expect(result).toBe(sourceValue);
    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents).toHaveLength(0);

    await nextImmediate();
    expectTrackedReads(redis, 1);
    expect(metrics.shadowEvents).toHaveLength(0);

    payloadGate.resolve(JSON.stringify(sourceValue));
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["match"]);
    expect(redis.write).not.toHaveBeenCalled();
    expect(redis.invalidate).not.toHaveBeenCalled();
    expect(
      metrics.ordinaryEvents.filter(({ name }) =>
        ["request", "miss", "error", "get", "serialization", "size"].includes(name)
      ),
    ).toHaveLength(0);
    expect(
      metrics.ordinaryEvents.filter(({ name, labels }) =>
        name === "disabled"
        && labels.layer === CacheLayer.REMOTE
        && labels.reason === "ramped_down"
      ),
    ).toHaveLength(1);
  });

  it("shares a rejecting ramped-down SoT call and reports source_error", async () => {
    const redis = new ScriptedRedis([() => JSON.stringify({ id: "123", source: "cache" })]);
    const metrics = new RecordingMetrics();
    const sourceError = new Error("source unavailable");
    const source = vi.fn(async () => {
      throw sourceError;
    });
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkSourceError", remoteConfig(0)),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(sourceError);
    await waitForShadowEvents(metrics, 1);

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["source_error"]);
    expectTrackedReads(redis, 1);
  });

  it("shares the ramped-down SoT call while caller and shadow deadlines remain isolated", async () => {
    const sourceGate = deferred<{ readonly id: string }>();
    const redis = new ScriptedRedis([() => JSON.stringify({ id: "123" })]);
    const metrics = new RecordingMetrics();
    const source = vi.fn(async () => await sourceGate.promise);
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkOverallTimeout", remoteConfig(0)),
      cacheKey: () => "123",
      fallbackTimeoutMs: 100,
    });

    await expect(dialcache.enable(async () => await getUser())).rejects.toBeInstanceOf(FallbackTimeoutError);
    await waitForShadowEvents(metrics, 1);

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);
    expectTrackedReads(redis, 1);

    sourceGate.resolve({ id: "123" });
    await nextImmediate();
  });

  it.each([
    {
      name: "miss",
      step: () => null,
      outcome: "redis_miss",
    },
    {
      name: "error",
      step: async () => {
        throw new Error("dark Redis unavailable");
      },
      outcome: "redis_error",
    },
  ] as const)("reports a dark Redis $name only through the shadow outcome", async ({
    name,
    step,
    outcome,
  }) => {
    const redis = new ScriptedRedis([step]);
    const metrics = new RecordingMetrics();
    const source = vi.fn(async () => ({ id: "123" }));
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions(`ShadowDark${name}`, remoteConfig(0)),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome: actual }) => actual)).toEqual([outcome]);
    expect(source).toHaveBeenCalledOnce();
    expect(
      metrics.ordinaryEvents.filter(({ name: metricName }) =>
        ["request", "miss", "error", "get", "serialization", "size"].includes(metricName)
      ),
    ).toHaveLength(0);
  });

  it("dark-reads only an otherwise valid tracked remote policy with observable shadowing", async () => {
    const cases = [
      {
        name: "missing remote policy",
        tracked: true,
        metrics: new RecordingMetrics(),
        config: new DialCacheKeyConfig({ shadowRamp: 100 }),
      },
      {
        name: "untracked",
        tracked: false,
        metrics: new RecordingMetrics(),
        config: remoteConfig(0),
      },
      {
        name: "missing shadow hook",
        tracked: true,
        metrics: metricsWithoutShadow(),
        config: remoteConfig(0),
      },
      {
        name: "omitted shadow ramp",
        tracked: true,
        metrics: new RecordingMetrics(),
        config: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 0 },
        }),
      },
      {
        name: "zero shadow ramp",
        tracked: true,
        metrics: new RecordingMetrics(),
        config: remoteConfig(0, 0),
      },
    ] as const;

    for (const testCase of cases) {
      const redis = new ScriptedRedis([]);
      const dialcache = createCache(redis, testCase.metrics);
      const getUser = dialcache.cached(async () => ({ id: testCase.name }), {
        keyType: "user_id",
        useCase: `ShadowDarkIneligible${testCase.name}`,
        cacheKey: () => "123",
        trackForInvalidation: testCase.tracked,
        defaultConfig: testCase.config,
      });

      await dialcache.enable(async () => await getUser());
      await nextImmediate();
      expect(redis.requests, testCase.name).toHaveLength(0);
    }
  });

  it("does not dark-read through invalid runtime policy or provider failure", async () => {
    const cases = [
      {
        name: "invalid TTL",
        provider: async () => new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 0 },
        }),
      },
      {
        name: "invalid ramp",
        provider: async () => new DialCacheKeyConfig({
          ramp: { [CacheLayer.REMOTE]: Number.NaN },
        }),
      },
      {
        name: "invalid shadow ramp",
        provider: async () => new DialCacheKeyConfig({
          shadowRamp: Number.NaN,
        }),
      },
      {
        name: "provider failure",
        provider: async () => {
          throw new Error("provider unavailable");
        },
      },
    ] as const;

    for (const testCase of cases) {
      const redis = new ScriptedRedis([]);
      const metrics = new RecordingMetrics();
      const dialcache = createCache(redis, metrics, {
        cacheConfigProvider: testCase.provider,
        logger: {
          debug: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      });
      const getUser = dialcache.cached(async () => ({ id: testCase.name }), {
        ...trackedOptions(`ShadowDarkInvalid${testCase.name}`, remoteConfig(0)),
        cacheKey: () => "123",
      });

      await dialcache.enable(async () => await getUser());
      await nextImmediate();
      expect(redis.requests, testCase.name).toHaveLength(0);
      expect(metrics.shadowEvents, testCase.name).toHaveLength(0);
    }
  });

  it("treats DialCacheKeyConfig.disabled() as a complete shadow kill switch", async () => {
    const redis = new ScriptedRedis([]);
    const metrics = new RecordingMetrics();
    const source = vi.fn(async () => ({ id: "123" }));
    const dialcache = createCache(redis, metrics, {
      cacheConfigProvider: async () => DialCacheKeyConfig.disabled(),
    });
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDisabledOverlay", remoteConfig(100)),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
    await nextImmediate();

    expect(source).toHaveBeenCalledOnce();
    expect(redis.requests).toHaveLength(0);
    expect(metrics.shadowEvents).toHaveLength(0);
  });

  it("keeps partial Redis-serving and shadow-observation cohorts independent", async () => {
    const useCase = "ShadowIndependentPartialCohorts";
    const keyFor = (id: string) => new DialCacheKey({
      keyType: "user_id",
      id,
      useCase,
      trackForInvalidation: true,
    });
    const ids = Array.from({ length: 10_000 }, (_, index) => `candidate-${index}`);
    const darkShadowedId = ids.find((id) =>
      deterministicRampSample(keyFor(id), CacheLayer.REMOTE) >= 50
      && deterministicShadowRampSample(keyFor(id)) < 50
    );
    const servedUnshadowedId = ids.find((id) =>
      deterministicRampSample(keyFor(id), CacheLayer.REMOTE) < 50
      && deterministicShadowRampSample(keyFor(id)) >= 50
    );
    const darkUnshadowedId = ids.find((id) =>
      deterministicRampSample(keyFor(id), CacheLayer.REMOTE) >= 50
      && deterministicShadowRampSample(keyFor(id)) >= 50
    );
    expect(darkShadowedId).toBeDefined();
    expect(servedUnshadowedId).toBeDefined();
    expect(darkUnshadowedId).toBeDefined();

    const redis = new ScriptedRedis([
      () => JSON.stringify({ id: darkShadowedId }),
      () => JSON.stringify({ id: servedUnshadowedId }),
    ]);
    const metrics = new RecordingMetrics();
    const source = vi.fn(async (id: string) => ({ id }));
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions(useCase, remoteConfig(50, 50)),
      cacheKey: (id) => id,
    });

    await expect(dialcache.enable(async () => await getUser(darkShadowedId!))).resolves.toEqual({
      id: darkShadowedId,
    });
    await waitForShadowEvents(metrics, 1);
    await expect(dialcache.enable(async () => await getUser(servedUnshadowedId!))).resolves.toEqual({
      id: servedUnshadowedId,
    });
    await expect(dialcache.enable(async () => await getUser(darkUnshadowedId!))).resolves.toEqual({
      id: darkUnshadowedId,
    });
    await nextImmediate();

    expect(source).toHaveBeenCalledTimes(2);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["match"]);
    expectTrackedReads(redis, 2, { singleWatermark: false });
  });

  it("preserves remote-ramp-zero concurrency while deduplicating only shadow work", async () => {
    const payload = JSON.stringify({ id: "123" });
    const redis = new ScriptedRedis([() => payload]);
    const metrics = new RecordingMetrics();
    const source = vi.fn(async () => ({ id: "123" }));
    const dialcache = createCache(redis, metrics, { shadowMaxInFlight: 2 });
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkNoProcessFlight", remoteConfig(0)),
      cacheKey: () => "123",
    });

    await expect(
      dialcache.enable(async () => await Promise.all([getUser(), getUser()])),
    ).resolves.toEqual([{ id: "123" }, { id: "123" }]);
    await waitForShadowEvents(metrics, 2);

    expect(source).toHaveBeenCalledTimes(2);
    expectTrackedReads(redis, 1);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome).sort()).toEqual(["dropped", "match"]);
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "coalesced")).toHaveLength(0);
  });

  it("lets the caller's SoT result populate active local cache, never the dark Redis value", async () => {
    const cachedPayload = JSON.stringify({ id: "123", source: "redis" });
    const redis = new ScriptedRedis([() => cachedPayload, () => cachedPayload]);
    const metrics = new RecordingMetrics();
    const sourceValue = { id: "123", source: "truth" };
    const source = vi.fn(async () => sourceValue);
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkLocalPublication", localAndRemoteConfig()),
      cacheKey: () => "123",
    });

    const first = await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);
    const second = await dialcache.enable(async () => await getUser());
    await nextImmediate();

    expect(first).toBe(sourceValue);
    expect(second).toBe(sourceValue);
    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expectTrackedReads(redis, 2);
    expect(redis.write).not.toHaveBeenCalled();
  });

  it("memoizes only the caller's SoT result in request-local cache", async () => {
    const cachedPayload = JSON.stringify({ id: "123", source: "redis" });
    const redis = new ScriptedRedis([() => cachedPayload, () => cachedPayload]);
    const metrics = new RecordingMetrics();
    const sourceValue = { id: "123", source: "truth" };
    const source = vi.fn(async () => sourceValue);
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkRequestLocalPublication", new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 0 },
        requestLocal: true,
        shadowRamp: 100,
      })),
      cacheKey: () => "123",
    });

    const [first, second] = await dialcache.enable(async () => {
      const firstValue = await getUser();
      const secondValue = await getUser();
      return [firstValue, secondValue] as const;
    });
    await waitForShadowEvents(metrics, 1);

    expect(first).toBe(sourceValue);
    expect(second).toBe(sourceValue);
    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expectTrackedReads(redis, 2);
    expect(redis.write).not.toHaveBeenCalled();
  });

  it("retains capacity after a dark-read deadline until the raw Redis read settles", async () => {
    const firstReadGate = deferred<RedisCachePayload | null>();
    const redis = new ScriptedRedis([
      async () => await firstReadGate.promise,
      () => JSON.stringify({ id: "b" }),
    ]);
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 10 },
      metrics,
      shadowMaxInFlight: 1,
    });
    const getUser = dialcache.cached(async (id: string) => ({ id }), {
      ...trackedOptions("ShadowDarkTimeoutRetention", remoteConfig(0)),
      cacheKey: (id) => id,
      fallbackTimeoutMs: 1_000,
    });

    await dialcache.enable(async () => await getUser("a"));
    await waitForShadowEvents(metrics, 1);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["redis_error"]);
    expect(redis.contexts[0]?.signal.aborted).toBe(true);

    await dialcache.enable(async () => await getUser("b"));
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["redis_error", "dropped"]);
    expect(redis.requests).toHaveLength(1);

    firstReadGate.resolve(JSON.stringify({ id: "a" }));
    await nextImmediate();
    await dialcache.enable(async () => await getUser("b"));
    await waitForShadowEvents(metrics, 3);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["redis_error", "dropped", "match"]);
    expectTrackedReads(redis, 2, { singleWatermark: false });
  });

  it("retains capacity after a confirmation deadline until the raw C1 read settles", async () => {
    const confirmationGate = deferred<RedisCachePayload | null>();
    const cachedA = JSON.stringify({ id: "a", version: 1 });
    const redis = new ScriptedRedis([
      () => cachedA,
      async () => await confirmationGate.promise,
      () => JSON.stringify({ id: "b", version: 2 }),
    ]);
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({
      redis: { client: redis, readTimeoutMs: 10 },
      metrics,
      shadowMaxInFlight: 1,
    });
    const getA = dialcache.cached(async () => ({ id: "a", version: 2 }), {
      ...trackedOptions("ShadowConfirmationTimeoutRetentionA", remoteConfig(100)),
      cacheKey: () => "a",
      fallbackTimeoutMs: 1_000,
    });
    const getB = dialcache.cached(async () => ({ id: "b", version: 2 }), {
      ...trackedOptions("ShadowConfirmationTimeoutRetentionB", remoteConfig(0)),
      cacheKey: () => "b",
      fallbackTimeoutMs: 1_000,
    });

    await expect(dialcache.enable(async () => await getA())).resolves.toEqual({ id: "a", version: 1 });
    await waitForShadowEvents(metrics, 1);
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["confirmation_error"]);

    await dialcache.enable(async () => await getB());
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["confirmation_error", "dropped"]);
    expect(redis.requests).toHaveLength(2);

    confirmationGate.resolve(cachedA);
    await nextImmediate();
    await dialcache.enable(async () => await getB());
    await waitForShadowEvents(metrics, 3);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual([
      "confirmation_error",
      "dropped",
      "match",
    ]);
    expectTrackedReads(redis, 3, { singleWatermark: false });
  });
});

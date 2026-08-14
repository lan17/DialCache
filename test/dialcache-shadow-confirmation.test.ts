import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  FallbackTimeoutError,
  type CacheMetricLabels,
  type CoalescedMetricLabels,
  type DecodedRedisFrame,
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
import {
  SHADOW_LOG_KEY_MAX_BYTES,
  SHADOW_LOG_TRUNCATION_MARKER,
  SHADOW_LOG_VALUE_MAX_BYTES,
} from "../src/internal/shadow-log-json.js";
import { REMOTE_SHADOW_CACHE_LAYER } from "../src/metrics.js";

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

const SCRIPTED_FRAME_CREATED_AT_MS = 1_700_000_000_000;

class ScriptedRedis implements DialCacheRedisClient {
  readonly requests: RedisReadRequest[] = [];
  readonly contexts: Array<RedisReadContext | undefined> = [];
  readonly write = vi.fn(async (_request: RedisWriteRequest): Promise<boolean> => true);
  readonly invalidate = vi.fn(async (_request: RedisInvalidationRequest): Promise<void> => undefined);
  frameCreatedAtMs = SCRIPTED_FRAME_CREATED_AT_MS;

  constructor(private readonly steps: ReadStep[]) {}

  async read(request: RedisReadRequest, context?: RedisReadContext): Promise<DecodedRedisFrame | null> {
    this.requests.push(request);
    this.contexts.push(context);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("Unexpected Redis read");
    }
    const payload = await step();
    return payload === null ? null : { payload, createdAtMs: this.frameCreatedAtMs };
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

interface ShadowAgeEvent {
  readonly labels: ShadowValidationMetricLabels;
  readonly seconds: number;
}

class RecordingMetrics implements DialCacheMetricsAdapter {
  readonly ordinaryEvents: OrdinaryMetricEvent[] = [];
  readonly shadowEvents: ShadowValidationMetricLabels[] = [];
  readonly shadowAgeEvents: ShadowAgeEvent[] = [];

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

  observeShadowValueAge(labels: ShadowValidationMetricLabels, seconds: number): void {
    this.shadowAgeEvents.push({ labels: { ...labels }, seconds });
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

function remoteConfig(
  remoteRamp: number,
  shadowPercentage = 100,
  logging: {
    readonly logMismatches?: boolean;
  } = {},
): DialCacheKeyConfig {
  return new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: remoteRamp },
    shadow: { ramp: shadowPercentage, ...logging },
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
    shadow: { ramp: 100 },
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

function expectUntrackedReads(redis: ScriptedRedis, count: number): void {
  expect(redis.requests).toHaveLength(count);
  expect(redis.requests.every((request) => !Object.hasOwn(request, "watermarkKey"))).toBe(true);
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

  it("does not log confirmed mismatches when logging is omitted", async () => {
    const payload = JSON.stringify({ id: "private-id", version: 1 });
    const redis = new ScriptedRedis([() => payload, () => payload]);
    const metrics = new RecordingMetrics();
    const warn = vi.fn();
    const dialcache = createCache(redis, metrics, {
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn,
      },
    });
    const getUser = dialcache.cached(async () => ({ id: "private-id", version: 2 }), {
      ...trackedOptions(
        "ShadowMismatchLoggingOff",
        remoteConfig(100),
      ),
      cacheKey: () => ({
        id: "private-id",
        args: { tenant: "private-tenant" },
      }),
    });

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs one bounded JSON warning for a served-hit confirmed mismatch", async () => {
    const payload = JSON.stringify({ id: "private-id", version: 1 });
    const redis = new ScriptedRedis([() => payload, () => payload]);
    const metrics = new RecordingMetrics();
    vi.spyOn(metrics, "shadowValidation").mockImplementation((labels) => {
      metrics.shadowEvents.push({ ...labels });
      Object.assign(labels as unknown as Record<string, unknown>, {
        cacheNamespace: "mutated-by-metrics",
        cacheKey: "injected-by-metrics",
      });
    });
    const warn = vi.fn(() => Promise.reject(new Error("logger unavailable")));
    const dialcache = createCache(redis, metrics, {
      namespace: "private-namespace",
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn,
      },
    });
    const getUser = dialcache.cached(async () => ({ id: "private-id", version: 2 }), {
      ...trackedOptions(
        "ShadowMismatchJson",
        remoteConfig(100, 100, { logMismatches: true }),
      ),
      cacheKey: () => ({
        id: "private-id",
        args: { tenant: "private-tenant" },
      }),
    });

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      {
        cacheNamespace: "private-namespace",
        useCase: "ShadowMismatchJson",
        keyType: "user_id",
        outcome: "mismatch",
        cacheKey: "{private-namespace:user_id:private-id}?tenant=private-tenant#ShadowMismatchJson",
        cachedValueJson: '{"id":"private-id","version":1}',
        sourceValueJson: '{"id":"private-id","version":2}',
      },
    );
    await nextImmediate();
  });

  it("logs the logical key and compared values for a ramped-down confirmed mismatch", async () => {
    const cachedValue = { id: "123", version: 1 };
    const sourceValue = { id: "123", version: 2 };
    const payload = JSON.stringify(cachedValue);
    const serializer: Serializer<typeof cachedValue> = {
      dump: vi.fn((value) => JSON.stringify(value)),
      load: vi.fn((value) => JSON.parse(
        Buffer.isBuffer(value) ? value.toString("utf8") : value,
      ) as typeof cachedValue),
    };
    const redis = new ScriptedRedis([() => payload, () => payload]);
    const metrics = new RecordingMetrics();
    const warn = vi.fn();
    const dialcache = createCache(redis, metrics, {
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn,
      },
    });
    const getUser = dialcache.cached(async () => sourceValue, {
      ...trackedOptions(
        "ShadowMismatchRampedDownJson",
        remoteConfig(0, 100, {
          logMismatches: true,
        }),
      ),
      cacheKey: () => ({
        id: "123",
        args: { locale: "en-US" },
      }),
      serializer,
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toBe(sourceValue);
    await waitForShadowEvents(metrics, 1);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      {
        cacheNamespace: "urn",
        useCase: "ShadowMismatchRampedDownJson",
        keyType: "user_id",
        outcome: "mismatch",
        cacheKey: "{urn:user_id:123}?locale=en-US#ShadowMismatchRampedDownJson",
        cachedValueJson: '{"id":"123","version":1}',
        sourceValueJson: '{"id":"123","version":2}',
      },
    );
    expect(serializer.dump).not.toHaveBeenCalled();
  });

  it("falls back to a metadata warning when JSON detail construction throws", async () => {
    const cachedValue = { id: "123", version: 1 };
    const sourceValue = { id: "123", version: 2 };
    const payload = JSON.stringify(cachedValue);
    const redis = new ScriptedRedis([() => payload, () => payload]);
    const metrics = new RecordingMetrics();
    const warn = vi.fn();
    const dialcache = createCache(redis, metrics, {
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn,
      },
    });
    const sourceStarted = deferred<void>();
    const sourceGate = deferred<typeof sourceValue>();
    const getUser = dialcache.cached(async () => {
      sourceStarted.resolve();
      return await sourceGate.promise;
    }, {
      ...trackedOptions(
        "ShadowMismatchJsonFailure",
        remoteConfig(100, 100, {
          logMismatches: true,
        }),
      ),
      cacheKey: () => "123",
    });

    await dialcache.enable(async () => await getUser());
    await sourceStarted.promise;
    const encodeInto = vi.spyOn(TextEncoder.prototype, "encodeInto").mockImplementationOnce(() => {
      throw new Error("preview unavailable");
    });
    try {
      sourceGate.resolve(sourceValue);
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "DialCache shadow validation mismatch",
        {
          cacheNamespace: "urn",
          useCase: "ShadowMismatchJsonFailure",
          keyType: "user_id",
          outcome: "mismatch",
        },
      );
    } finally {
      sourceGate.resolve(sourceValue);
      encodeInto.mockRestore();
    }
  });

  it("clamps the logical key and both JSON strings before handing details to the logger", async () => {
    const id = "k".repeat(SHADOW_LOG_KEY_MAX_BYTES + 100);
    const cachedValue = { id, content: "🙂".repeat(SHADOW_LOG_VALUE_MAX_BYTES) };
    const sourceValue = { id, content: "s".repeat(SHADOW_LOG_VALUE_MAX_BYTES + 1) };
    const payload = JSON.stringify(cachedValue);
    const redis = new ScriptedRedis([() => payload, () => payload]);
    const metrics = new RecordingMetrics();
    const warn = vi.fn();
    const dialcache = createCache(redis, metrics, {
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn,
      },
    });
    const getUser = dialcache.cached(async () => sourceValue, {
      ...trackedOptions(
        "ShadowMismatchClampedJson",
        remoteConfig(100, 100, {
          logMismatches: true,
        }),
      ),
      cacheKey: () => id,
    });

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(warning).not.toHaveProperty("cachedValue");
    expect(warning).not.toHaveProperty("sourceValue");
    for (const [field, maxBytes] of [
      ["cacheKey", SHADOW_LOG_KEY_MAX_BYTES],
      ["cachedValueJson", SHADOW_LOG_VALUE_MAX_BYTES],
      ["sourceValueJson", SHADOW_LOG_VALUE_MAX_BYTES],
    ] as const) {
      const preview = warning[field];
      expect(typeof preview).toBe("string");
      expect(Buffer.byteLength(preview as string)).toBeLessThanOrEqual(maxBytes);
      expect((preview as string).endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
      expect(preview).not.toContain("\uFFFD");
    }
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
    expect(metrics.shadowAgeEvents).toEqual([]);
    expect(serializer.load).toHaveBeenCalledTimes(2);
    expect(serializer.dump).not.toHaveBeenCalled();
    expectTrackedReads(redis, 2);
  });

  it("records the validated value age only for a confirmed mismatch verdict", async () => {
    const nowMs = 1_700_000_090_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const payload = JSON.stringify({ id: "123", version: 1 });
      const redis = new ScriptedRedis([() => payload, () => payload]);
      redis.frameCreatedAtMs = nowMs - 90_000;
      const metrics = new RecordingMetrics();
      const dialcache = createCache(redis, metrics);
      const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
        ...trackedOptions("ShadowMismatchValueAge", remoteConfig(100)),
        cacheKey: () => "123",
      });

      await dialcache.enable(async () => await getUser());
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
      expect(metrics.shadowAgeEvents).toHaveLength(1);
      expect(metrics.shadowAgeEvents[0]?.seconds).toBe(90);
      expect(metrics.shadowAgeEvents[0]?.labels).toMatchObject({
        useCase: "ShadowMismatchValueAge",
        keyType: "user_id",
        outcome: "mismatch",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not log a mismatch candidate when C1 is superseded", async () => {
    const original = JSON.stringify({ id: "123", version: 1 });
    const confirmation = JSON.stringify({ id: "123", version: 3 });
    const redis = new ScriptedRedis([() => original, () => confirmation]);
    const metrics = new RecordingMetrics();
    const warn = vi.fn();
    const dialcache = createCache(redis, metrics, {
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn,
      },
    });
    const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
      ...trackedOptions(
        "ShadowMismatchSuperseded",
        remoteConfig(100, 100, {
          logMismatches: true,
        }),
      ),
      cacheKey: () => "123",
    });

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["superseded"]);
    expect(warn).not.toHaveBeenCalled();
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

  it("reports confirmation_error with its Redis work attributed to remote_shadow", async () => {
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
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "error"
      && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      && labels.error === "cache_read"
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "request" && labels.layer === CacheLayer.REMOTE
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "request" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "get" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "serialization"
      && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      && labels.operation === "load"
    )).toHaveLength(1);
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
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "request" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "get" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "serialization"
      && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      && labels.operation === "load"
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      labels.layer === REMOTE_SHADOW_CACHE_LAYER
      && ["miss", "error", "size"].includes(name)
    )).toHaveLength(0);
    expect(
      metrics.ordinaryEvents.filter(({ name, labels }) =>
        name === "disabled"
        && labels.layer === CacheLayer.REMOTE
        && labels.reason === "ramped_down"
      ),
    ).toHaveLength(1);
  });

  it("unrefs ramp-zero shadow C0 and C1 Redis read-deadline timers", async () => {
    const cachedPayload = JSON.stringify({ id: "123", version: 1 });
    const c0Started = deferred<void>();
    const c0Gate = deferred<RedisCachePayload | null>();
    const c1Started = deferred<void>();
    const c1Gate = deferred<RedisCachePayload | null>();
    const redis = new ScriptedRedis([
      async () => {
        c0Started.resolve(undefined);
        return await c0Gate.promise;
      },
      async () => {
        c1Started.resolve(undefined);
        return await c1Gate.promise;
      },
    ]);
    const metrics = new RecordingMetrics();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
      ...trackedOptions("ShadowDarkUnrefRedisDeadlines", remoteConfig(0)),
      cacheKey: () => "123",
    });
    const shortUnrefTimers = (): NodeJS.Timeout[] =>
      setTimeoutSpy.mock.results.flatMap(({ value }, index) => {
        const delayMs = setTimeoutSpy.mock.calls[index]?.[1];
        const timer = value as NodeJS.Timeout | undefined;
        return typeof delayMs === "number"
          && delayMs > 0
          && delayMs <= 1_000
          && timer?.hasRef() === false
          ? [timer]
          : [];
      });

    try {
      await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({
        id: "123",
        version: 2,
      });
      await nextImmediate();
      await c0Started.promise;
      expect(shortUnrefTimers()).toHaveLength(1);

      c0Gate.resolve(cachedPayload);
      await c1Started.promise;
      expect(shortUnrefTimers()).toHaveLength(2);

      c1Gate.resolve(cachedPayload);
      await waitForShadowEvents(metrics, 1);
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    } finally {
      c0Gate.resolve(cachedPayload);
      c1Gate.resolve(cachedPayload);
      setTimeoutSpy.mockRestore();
    }
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

  it("does not misclassify a source-propagated FallbackTimeoutError as its own timeout", async () => {
    const redis = new ScriptedRedis([() => JSON.stringify({ id: "123", source: "cache" })]);
    const metrics = new RecordingMetrics();
    const nestedTimeout = new FallbackTimeoutError("NestedUseCase", 25);
    const source = vi.fn(async () => {
      throw nestedTimeout;
    });
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkNestedTimeout", remoteConfig(0)),
      cacheKey: () => "123",
      fallbackTimeoutMs: 1_000,
    });

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(nestedTimeout);
    await waitForShadowEvents(metrics, 1);

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["source_error"]);
    expectTrackedReads(redis, 1);
    expect(redis.write).not.toHaveBeenCalled();
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

    const pending = dialcache.enable(async () => await getUser());
    await nextImmediate();
    await expect(pending).rejects.toBeInstanceOf(FallbackTimeoutError);
    await waitForShadowEvents(metrics, 1);

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);
    expectTrackedReads(redis, 1);

    sourceGate.resolve({ id: "123" });
    await nextImmediate();
  });

  it("includes synchronous SoT work in the null-timeout shadow budget", async () => {
    let nowMs = 0;
    const performanceSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const redis = new ScriptedRedis([]);
    const metrics = new RecordingMetrics();
    const source = vi.fn(async () => {
      nowMs = 60_001;
      return { id: "123" };
    });
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkSynchronousSourceBudget", remoteConfig(0)),
      cacheKey: () => "123",
      fallbackTimeoutMs: null,
    });

    try {
      await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
      await waitForShadowEvents(metrics, 1);

      expect(source).toHaveBeenCalledOnce();
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);
      expect(redis.requests).toHaveLength(0);
      expect(redis.write).not.toHaveBeenCalled();
    } finally {
      performanceSpy.mockRestore();
    }
  });

  it("releases a ramped-down null-timeout source slot at the shadow deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let nowMs = 0;
    const performanceSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const sourceGate = deferred<{ readonly id: string }>();
    const firstReadStarted = deferred<void>();
    const redis = new ScriptedRedis([
      () => {
        firstReadStarted.resolve(undefined);
        return null;
      },
      () => null,
    ]);
    const metrics = new RecordingMetrics();
    const source = vi.fn(async (id: string) =>
      id === "a" ? await sourceGate.promise : { id }
    );
    const dialcache = createCache(redis, metrics, { shadowMaxInFlight: 1 });
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkNullSourceCapacity", remoteConfig(0)),
      cacheKey: (id) => id,
      fallbackTimeoutMs: null,
    });
    const pendingA = dialcache.enable(async () => await getUser("a"));

    try {
      await firstReadStarted.promise;
      expect(source).toHaveBeenCalledWith("a");
      expectTrackedReads(redis, 1);

      nowMs = 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await nextImmediate();
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);

      await expect(dialcache.enable(async () => await getUser("b"))).resolves.toEqual({ id: "b" });
      await nextImmediate();
      await nextImmediate();

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "filled"]);
      expect(redis.write).toHaveBeenCalledOnce();
      expectTrackedReads(redis, 2, { singleWatermark: false });

      sourceGate.resolve({ id: "a" });
      await expect(pendingA).resolves.toEqual({ id: "a" });
      await nextImmediate();

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "filled"]);
      expect(redis.write).toHaveBeenCalledOnce();
    } finally {
      sourceGate.resolve({ id: "a" });
      await pendingA.catch(() => undefined);
      performanceSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "tracked", tracked: true },
    { name: "untracked", tracked: false },
  ])("fills a clean $name dark Redis miss and attributes the read and write to remote_shadow", async ({
    name,
    tracked,
  }) => {
    const redis = new ScriptedRedis([() => null]);
    const metrics = new RecordingMetrics();
    const source = vi.fn(async () => ({ id: "123" }));
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase: `ShadowDarkMissFill${name}`,
      cacheKey: () => "123",
      trackForInvalidation: tracked,
      defaultConfig: remoteConfig(0),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["filled"]);
    expect(metrics.shadowAgeEvents).toEqual([]);
    expect(source).toHaveBeenCalledOnce();
    if (tracked) {
      expectTrackedReads(redis, 1);
    } else {
      expectUntrackedReads(redis, 1);
    }
    expect(redis.write).toHaveBeenCalledOnce();
    expect(redis.write).toHaveBeenCalledWith(expect.objectContaining({
      cacheTtlMs: 60_000,
      value: JSON.stringify({ id: "123" }),
    }));
    expect(Object.hasOwn(redis.write.mock.calls[0]?.[0] ?? {}, "watermarkKey")).toBe(tracked);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "request" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "miss" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "get" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "serialization"
      && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      && labels.operation === "dump"
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "size" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
  });

  it("reports fill_blocked when tracked invalidation rejects a detached fill", async () => {
    const redis = new ScriptedRedis([() => null]);
    redis.write.mockImplementationOnce(async () => false);
    const metrics = new RecordingMetrics();
    const sourceValue = { id: "123", version: 2 };
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(async () => sourceValue, {
      ...trackedOptions("ShadowDarkFillBlocked", remoteConfig(0)),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toBe(sourceValue);
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["fill_blocked"]);
    expect(redis.write).toHaveBeenCalledOnce();
    expect(redis.write).toHaveBeenCalledWith(expect.objectContaining({
      cacheTtlMs: 60_000,
      watermarkKey: expect.any(String),
    }));
    expect(redis.invalidate).not.toHaveBeenCalled();
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "error"
      && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(0);
  });

  it("reports a detached serializer dump failure as fill_error with an exact remote_shadow error", async () => {
    const redis = new ScriptedRedis([() => null]);
    const metrics = new RecordingMetrics();
    const serializer: Serializer<{ readonly id: string }> = {
      dump: vi.fn(async () => {
        throw new Error("cannot serialize shadow fill");
      }),
      load: vi.fn(async () => ({ id: "cached" })),
    };
    const dialcache = createCache(redis, metrics, {
      logger: {
        debug: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    const getUser = dialcache.cached(async () => ({ id: "123" }), {
      ...trackedOptions("ShadowDarkFillDumpError", remoteConfig(0)),
      cacheKey: () => "123",
      serializer,
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["fill_error"]);
    expect(serializer.dump).toHaveBeenCalledOnce();
    expect(serializer.load).not.toHaveBeenCalled();
    expect(redis.write).not.toHaveBeenCalled();
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "error").map(({ labels }) => labels)).toEqual([
      {
        cacheNamespace: "urn",
        useCase: "ShadowDarkFillDumpError",
        keyType: "user_id",
        layer: REMOTE_SHADOW_CACHE_LAYER,
        error: "serialization_dump",
        inFallback: false,
      },
    ]);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "size" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(0);
  });

  it("reports a dispatched Redis write failure as fill_error with an exact remote_shadow error", async () => {
    const redis = new ScriptedRedis([() => null]);
    redis.write.mockImplementationOnce(async () => {
      throw new Error("shadow write unavailable");
    });
    const metrics = new RecordingMetrics();
    const warn = vi.fn(async () => {
      throw new Error("logger transport unavailable");
    });
    const dialcache = createCache(redis, metrics, {
      logger: {
        debug: () => undefined,
        warn,
        error: () => undefined,
      },
    });
    const getUser = dialcache.cached(async () => ({ id: "123" }), {
      ...trackedOptions("ShadowDarkFillWriteError", remoteConfig(0)),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
    await waitForShadowEvents(metrics, 1);
    await nextImmediate();

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["fill_error"]);
    expect(redis.write).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "error").map(({ labels }) => labels)).toEqual([
      {
        cacheNamespace: "urn",
        useCase: "ShadowDarkFillWriteError",
        keyType: "user_id",
        layer: REMOTE_SHADOW_CACHE_LAYER,
        error: "cache_write",
        inFallback: false,
      },
    ]);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "serialization"
      && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      && labels.operation === "dump"
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "size" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
  });

  it("never repairs a non-null C0 whose detached deserialization fails", async () => {
    const redis = new ScriptedRedis([() => "present-but-undecodable"]);
    const metrics = new RecordingMetrics();
    const serializer: Serializer<{ readonly id: string }> = {
      dump: vi.fn((value) => JSON.stringify(value)),
      load: vi.fn(async () => {
        throw new Error("cannot decode existing payload");
      }),
    };
    const sourceValue = { id: "123" };
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(async () => sourceValue, {
      ...trackedOptions("ShadowDarkExistingDecodeError", remoteConfig(0)),
      cacheKey: () => "123",
      serializer,
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toBe(sourceValue);
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["deserialization_error"]);
    expect(serializer.load).toHaveBeenCalledOnce();
    expect(serializer.dump).not.toHaveBeenCalled();
    expect(redis.write).not.toHaveBeenCalled();
    expect(redis.invalidate).not.toHaveBeenCalled();
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "error").map(({ labels }) => labels)).toEqual([
      {
        cacheNamespace: "urn",
        useCase: "ShadowDarkExistingDecodeError",
        keyType: "user_id",
        layer: REMOTE_SHADOW_CACHE_LAYER,
        error: "serialization_load",
        inFallback: false,
      },
    ]);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "miss" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(0);
  });

  it("returns the caller's SoT result without awaiting detached dump or write work", async () => {
    const dumpStarted = deferred<void>();
    const dumpGate = deferred<void>();
    const writeStarted = deferred<void>();
    const writeGate = deferred<boolean>();
    const redis = new ScriptedRedis([() => null]);
    redis.write.mockImplementationOnce(async () => {
      writeStarted.resolve(undefined);
      return await writeGate.promise;
    });
    const metrics = new RecordingMetrics();
    const sourceValue = { id: "123" };
    const serializer: Serializer<typeof sourceValue> = {
      dump: vi.fn(async (value) => {
        dumpStarted.resolve(undefined);
        await dumpGate.promise;
        return JSON.stringify(value);
      }),
      load: vi.fn(async () => sourceValue),
    };
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(async () => sourceValue, {
      ...trackedOptions("ShadowDarkDetachedFill", remoteConfig(0)),
      cacheKey: () => "123",
      serializer,
    });

    try {
      await expect(dialcache.enable(async () => await getUser())).resolves.toBe(sourceValue);
      expect(serializer.dump).not.toHaveBeenCalled();
      expect(redis.write).not.toHaveBeenCalled();

      await nextImmediate();
      await dumpStarted.promise;
      expect(metrics.shadowEvents).toHaveLength(0);
      expect(redis.write).not.toHaveBeenCalled();

      dumpGate.resolve(undefined);
      await writeStarted.promise;
      expect(metrics.shadowEvents).toHaveLength(0);

      writeGate.resolve(true);
      await waitForShadowEvents(metrics, 1);
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["filled"]);
    } finally {
      dumpGate.resolve(undefined);
      writeGate.resolve(true);
    }
  });

  it("never fills after the shared bounded SoT times out and its raw work resolves late", async () => {
    const sourceGate = deferred<{ readonly id: string }>();
    const redis = new ScriptedRedis([() => null]);
    const metrics = new RecordingMetrics();
    const serializer: Serializer<{ readonly id: string }> = {
      dump: vi.fn((value) => JSON.stringify(value)),
      load: vi.fn(async () => ({ id: "cached" })),
    };
    const source = vi.fn(async () => await sourceGate.promise);
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkLateSourceNoFill", remoteConfig(0)),
      cacheKey: () => "123",
      serializer,
      fallbackTimeoutMs: 100,
    });

    const pending = dialcache.enable(async () => await getUser());
    await nextImmediate();
    await expect(pending).rejects.toBeInstanceOf(FallbackTimeoutError);
    await waitForShadowEvents(metrics, 1);

    expect(source).toHaveBeenCalledOnce();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);
    expect(serializer.dump).not.toHaveBeenCalled();
    expect(redis.write).not.toHaveBeenCalled();

    sourceGate.resolve({ id: "123" });
    await nextImmediate();

    expect(serializer.dump).not.toHaveBeenCalled();
    expect(redis.write).not.toHaveBeenCalled();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);
  });

  it("uses the invocation's runtime TTL snapshot without refetching config for a detached fill", async () => {
    const redis = new ScriptedRedis([() => null]);
    const metrics = new RecordingMetrics();
    let runtimeTtlSec = 17;
    const cacheConfigProvider = vi.fn(async () => new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: runtimeTtlSec },
      ramp: { [CacheLayer.REMOTE]: 0 },
      shadow: { ramp: 100 },
      remoteReadTimeoutMs: 321,
    }));
    const dialcache = createCache(redis, metrics, { cacheConfigProvider });
    const getUser = dialcache.cached(async () => {
      runtimeTtlSec = 99;
      return { id: "123" };
    }, {
      ...trackedOptions("ShadowDarkRuntimeTtlSnapshot", remoteConfig(100, 0)),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["filled"]);
    expect(cacheConfigProvider).toHaveBeenCalledOnce();
    expect(redis.contexts).toHaveLength(1);
    expect(redis.contexts[0]?.timeoutMs).toBe(321);
    expect(redis.write).toHaveBeenCalledOnce();
    expect(redis.write).toHaveBeenCalledWith(expect.objectContaining({
      cacheTtlMs: 17_000,
      watermarkKey: expect.any(String),
    }));
  });

  it("reports a dark Redis error with remote_shadow read telemetry and never writes", async () => {
    const redis = new ScriptedRedis([
      async () => {
        throw new Error("dark Redis unavailable");
      },
    ]);
    const metrics = new RecordingMetrics();
    const source = vi.fn(async () => ({ id: "123" }));
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkError", remoteConfig(0)),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["redis_error"]);
    expect(source).toHaveBeenCalledOnce();
    expect(redis.write).not.toHaveBeenCalled();
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "request" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "error"
      && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      && labels.error === "cache_read"
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "get" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      labels.layer === REMOTE_SHADOW_CACHE_LAYER
      && ["miss", "serialization", "size"].includes(name)
    )).toHaveLength(0);
  });

  it("dark-reads only an otherwise valid remote policy with observable shadowing", async () => {
    const cases = [
      {
        name: "missing remote policy",
        tracked: true,
        metrics: new RecordingMetrics(),
        config: new DialCacheKeyConfig({ shadow: { ramp: 100 } }),
      },
      {
        name: "untracked omitted shadow ramp",
        tracked: false,
        metrics: new RecordingMetrics(),
        config: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 60 },
          ramp: { [CacheLayer.REMOTE]: 0 },
        }),
      },
      {
        name: "untracked zero shadow ramp",
        tracked: false,
        metrics: new RecordingMetrics(),
        config: remoteConfig(0, 0),
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
      const source = vi.fn(async () => ({ id: testCase.name }));
      const dialcache = createCache(redis, testCase.metrics);
      const getUser = dialcache.cached(source, {
        keyType: "user_id",
        useCase: `ShadowDarkIneligible${testCase.name}`,
        cacheKey: () => "123",
        trackForInvalidation: testCase.tracked,
        defaultConfig: testCase.config,
      });

      await dialcache.enable(async () => await getUser());
      await nextImmediate();
      expect(source, testCase.name).toHaveBeenCalledOnce();
      expect(redis.requests, testCase.name).toHaveLength(0);
      expect(redis.write, testCase.name).not.toHaveBeenCalled();
      expect(redis.invalidate, testCase.name).not.toHaveBeenCalled();
      if (testCase.metrics instanceof RecordingMetrics) {
        expect(testCase.metrics.shadowEvents, testCase.name).toHaveLength(0);
      }
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
        name: "non-finite ramp",
        provider: async () => new DialCacheKeyConfig({
          ramp: { [CacheLayer.REMOTE]: Number.NaN },
        }),
      },
      {
        name: "negative ramp",
        provider: async () => new DialCacheKeyConfig({
          ramp: { [CacheLayer.REMOTE]: -1 },
        }),
      },
      {
        name: "over-100 ramp",
        provider: async () => new DialCacheKeyConfig({
          ramp: { [CacheLayer.REMOTE]: 101 },
        }),
      },
      {
        name: "invalid shadow ramp",
        provider: async () => new DialCacheKeyConfig({
          shadow: { ramp: Number.NaN },
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

  it("fails closed for invalid runtime mismatch logging without suppressing the metric", async () => {
    const useCase = "ShadowInvalidLogging";
    const cachedValue = { id: "123", version: 1 };
    const sourceValue = { id: "123", version: 2 };
    const payload = JSON.stringify(cachedValue);
    const redis = new ScriptedRedis([() => payload, () => payload]);
    const metrics = new RecordingMetrics();
    const warn = vi.fn();
    const dialcache = createCache(redis, metrics, {
      cacheConfigProvider: async () => new DialCacheKeyConfig({
        shadow: { logMismatches: "yes" as never },
      }),
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn,
      },
    });
    const getUser = dialcache.cached(async () => sourceValue, {
      ...trackedOptions(
        useCase,
        remoteConfig(100, 100, {
          logMismatches: true,
        }),
      ),
      cacheKey: () => "123",
    });

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(metrics.ordinaryEvents.filter(({ name: metricName, labels }) =>
      metricName === "error"
      && labels.layer === CacheLayer.REMOTE
      && labels.error === "config_resolution"
    )).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
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
        shadow: { ramp: 100 },
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

  it.each([
    { name: "successful", result: true },
    { name: "watermark-blocked", result: false },
  ])("retains capacity after an overall timeout until an already-dispatched $name write settles", async ({
    result,
  }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let nowMs = 0;
    const performanceSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const writeStarted = deferred<void>();
    const writeGate = deferred<boolean>();
    const redis = new ScriptedRedis([
      () => null,
      () => JSON.stringify({ id: "b" }),
    ]);
    redis.write.mockImplementationOnce(async () => {
      writeStarted.resolve(undefined);
      return await writeGate.promise;
    });
    const metrics = new RecordingMetrics();
    const dialcache = createCache(redis, metrics, { shadowMaxInFlight: 1 });
    const getUser = dialcache.cached(async (id: string) => ({ id }), {
      ...trackedOptions("ShadowDarkWriteTimeoutRetention", remoteConfig(0)),
      cacheKey: (id) => id,
      fallbackTimeoutMs: 50,
    });

    try {
      await expect(dialcache.enable(async () => await getUser("a"))).resolves.toEqual({ id: "a" });
      await nextImmediate();
      await writeStarted.promise;
      nowMs = 50;
      await vi.advanceTimersByTimeAsync(50);
      await waitForShadowEvents(metrics, 1);
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);

      await expect(dialcache.enable(async () => await getUser("b"))).resolves.toEqual({ id: "b" });
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped"]);
      expect(redis.requests).toHaveLength(1);

      writeGate.resolve(result);
      await nextImmediate();

      await expect(dialcache.enable(async () => await getUser("b"))).resolves.toEqual({ id: "b" });
      await waitForShadowEvents(metrics, 3);
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual([
        "timeout",
        "dropped",
        "match",
      ]);
      expect(redis.write).toHaveBeenCalledOnce();
      expectTrackedReads(redis, 2, { singleWatermark: false });
    } finally {
      writeGate.resolve(result);
      performanceSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("prevents a Redis write when serialization settles after the shadow deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let nowMs = 0;
    const performanceSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const dumpStarted = deferred<void>();
    const dumpGate = deferred<void>();
    const redis = new ScriptedRedis([
      () => null,
      () => JSON.stringify({ id: "b" }),
    ]);
    const metrics = new RecordingMetrics();
    const serializer: Serializer<{ readonly id: string }> = {
      dump: vi.fn(async (value) => {
        dumpStarted.resolve(undefined);
        await dumpGate.promise;
        return JSON.stringify(value);
      }),
      load: vi.fn(async (payload) => JSON.parse(payload.toString()) as { readonly id: string }),
    };
    const dialcache = createCache(redis, metrics, { shadowMaxInFlight: 1 });
    const getUser = dialcache.cached(async (id: string) => ({ id }), {
      ...trackedOptions("ShadowDarkDumpTimeoutRetention", remoteConfig(0)),
      cacheKey: (id) => id,
      fallbackTimeoutMs: 50,
      serializer,
    });

    try {
      await expect(dialcache.enable(async () => await getUser("a"))).resolves.toEqual({ id: "a" });
      await nextImmediate();
      await dumpStarted.promise;
      nowMs = 50;
      await vi.advanceTimersByTimeAsync(50);
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout"]);

      await expect(dialcache.enable(async () => await getUser("b"))).resolves.toEqual({ id: "b" });
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["timeout", "dropped"]);
      expect(redis.requests).toHaveLength(1);
      expect(redis.write).not.toHaveBeenCalled();

      dumpGate.resolve(undefined);
      await nextImmediate();
      expect(redis.write).not.toHaveBeenCalled();

      await expect(dialcache.enable(async () => await getUser("b"))).resolves.toEqual({ id: "b" });
      await waitForShadowEvents(metrics, 3);
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual([
        "timeout",
        "dropped",
        "match",
      ]);
      expect(redis.write).not.toHaveBeenCalled();
      expectTrackedReads(redis, 2, { singleWatermark: false });
    } finally {
      dumpGate.resolve(undefined);
      performanceSpy.mockRestore();
      vi.useRealTimers();
    }
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

import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  FallbackTimeoutError,
  type CacheConfigProvider,
  type CacheMetricLabels,
  type CoalescedMetricLabels,
  type DialCacheConfig,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type DisabledMetricLabels,
  type ErrorMetricLabels,
  type InvalidationMetricLabels,
  type Logger,
  type RedisCachePayload,
  type RedisInvalidationRequest,
  type RedisReadContext,
  type RedisReadMiss,
  type RedisReadResult,
  type RedisReadRequest,
  type RedisWriteRequest,
  type SerializationMetricLabels,
  type Serializer,
  type ShadowMismatchDiff,
  type ShadowMismatchEntry,
  type ShadowMismatchLoggingConfig,
  type ShadowMismatchLoggingMetricLabels,
  type ShadowMismatchLoggingOutcome,
  type ShadowValidationMetricLabels,
} from "../src/index.js";
import {
  deterministicRampSample,
  deterministicShadowRampSample,
} from "../src/internal/ramp.js";
import {
  SHADOW_LOG_DIFF_MAX_BYTES,
  SHADOW_LOG_KEY_MAX_BYTES,
  SHADOW_LOG_TRUNCATION_MARKER,
  SHADOW_LOG_VALUE_MAX_BYTES,
  SHADOW_MISMATCH_SIDE_MAX_BYTES,
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

type ScriptedReadResult = RedisCachePayload | RedisReadMiss | null;
type ReadStep = () => ScriptedReadResult | Promise<ScriptedReadResult>;

const MAX_TRACKED_REDIS_VALUE_TTL_MS = 60 * 60 * 1_000;

class ScriptedRedis implements DialCacheRedisClient {
  readonly requests: RedisReadRequest[] = [];
  readonly contexts: Array<RedisReadContext | undefined> = [];
  readonly write = vi.fn(async (_request: RedisWriteRequest): Promise<void> => undefined);
  readonly invalidate = vi.fn(async (_request: RedisInvalidationRequest): Promise<void> => undefined);
  frameCreatedAtMs = Date.now();

  constructor(private readonly steps: ReadStep[]) {}

  async read(request: RedisReadRequest, context?: RedisReadContext): Promise<RedisReadResult> {
    this.requests.push(request);
    this.contexts.push(context);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("Unexpected Redis read");
    }
    const result = await step();
    if (result === null) {
      // Legacy `null` is not a legal result; the core must treat it as an unfenced unclassified miss.
      return result as unknown as RedisReadResult;
    }
    if (isScriptedReadMiss(result)) {
      return result;
    }
    return { payload: result, createdAtMs: this.frameCreatedAtMs };
  }
}

function isScriptedReadMiss(result: ScriptedReadResult): result is RedisReadMiss {
  return typeof result === "object"
    && !Buffer.isBuffer(result)
    && result !== null;
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

interface FutureTimestampEvent {
  readonly labels: CacheMetricLabels;
  readonly seconds: number;
}

class RecordingMetrics implements DialCacheMetricsAdapter {
  readonly ordinaryEvents: OrdinaryMetricEvent[] = [];
  readonly shadowEvents: ShadowValidationMetricLabels[] = [];
  readonly shadowAgeEvents: ShadowAgeEvent[] = [];
  readonly shadowMismatchLoggingEvents: ShadowMismatchLoggingMetricLabels[] = [];
  readonly futureTimestampEvents: FutureTimestampEvent[] = [];

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

  shadowMismatchLogging(labels: ShadowMismatchLoggingMetricLabels): void {
    this.shadowMismatchLoggingEvents.push({ ...labels });
  }

  observeFutureTimestampOffset(labels: CacheMetricLabels, seconds: number): void {
    this.futureTimestampEvents.push({ labels: { ...labels }, seconds });
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
    readonly mismatchLogging?: ShadowMismatchLoggingConfig;
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

async function waitForMismatchLoggingEvents(metrics: RecordingMetrics, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(metrics.shadowMismatchLoggingEvents).toHaveLength(count);
  }, { timeout: 2_000, interval: 1 });
}

async function expectNoUnhandledRejection(run: () => Promise<void>): Promise<void> {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    await run();
    await nextImmediate();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
  expect(unhandled).not.toHaveBeenCalled();
}

interface MismatchRecord {
  readonly id: string;
  readonly version: number;
  readonly tags: readonly string[];
  readonly extra?: boolean;
}

const mismatchCachedRecord: MismatchRecord = { id: "123", version: 1, tags: ["a"] };
const mismatchSourceRecord: MismatchRecord = { id: "123", version: 2, tags: ["a", "b"], extra: true };
const MISMATCH_PATH_FIELDS = {
  mismatchPaths: ["/extra", "/tags", "/version"],
  mismatchPathCount: 3,
} as const;
const MISMATCH_DIFF_JSON = '[{"path":"/extra","source":true},'
  + '{"path":"/tags","cached":["a"],"source":["a","b"]},'
  + '{"path":"/version","cached":1,"source":2}]';
const MISMATCH_VALUE_FIELDS = {
  cachedValueJson: '{"id":"123","version":1,"tags":["a"]}',
  sourceValueJson: '{"id":"123","version":2,"tags":["a","b"],"extra":true}',
} as const;

interface ConfirmedMismatchOptions {
  readonly warn: Logger["warn"];
  readonly metrics?: RecordingMetrics;
  readonly cacheConfigProvider?: CacheConfigProvider;
  readonly shadowMismatchDiff?: ShadowMismatchDiff<MismatchRecord>;
  readonly api?: "cached" | "getOrLoad";
}

/**
 * Serves `mismatchCachedRecord` from Redis under key "123", loads
 * `mismatchSourceRecord` from the source, confirms the unchanged C1, and
 * waits for the verdict.
 */
async function runConfirmedMismatch(
  useCase: string,
  defaultConfig: DialCacheKeyConfig,
  options: ConfirmedMismatchOptions,
): Promise<{ readonly metrics: RecordingMetrics; readonly result: MismatchRecord }> {
  const payload = JSON.stringify(mismatchCachedRecord);
  const redis = new ScriptedRedis([() => payload, () => payload]);
  const metrics = options.metrics ?? new RecordingMetrics();
  const dialcache = createCache(redis, metrics, {
    ...(options.cacheConfigProvider === undefined ? {} : { cacheConfigProvider: options.cacheConfigProvider }),
    logger: {
      debug: () => undefined,
      error: () => undefined,
      warn: options.warn,
    },
  });
  const load = async (): Promise<MismatchRecord> => mismatchSourceRecord;
  const hook = options.shadowMismatchDiff === undefined ? {} : { shadowMismatchDiff: options.shadowMismatchDiff };
  const result = await dialcache.enable(async () => options.api === "getOrLoad"
    ? await dialcache.getOrLoad(load, { ...trackedOptions(useCase, defaultConfig), key: "123", ...hook })
    : await dialcache.cached(load, { ...trackedOptions(useCase, defaultConfig), cacheKey: () => "123", ...hook })());
  await waitForShadowEvents(metrics, 1);
  return { metrics, result };
}

/** The always-present warning fields for key "123", with the verdict's observed value age. */
function mismatchWarning(
  useCase: string,
  metrics: RecordingMetrics,
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  expect(metrics.shadowAgeEvents).toHaveLength(1);
  return {
    cacheNamespace: "urn",
    useCase,
    keyType: "user_id",
    outcome: "mismatch",
    cachedValueAgeSeconds: metrics.shadowAgeEvents[0]!.seconds,
    cacheKey: `{urn:user_id:123}#${useCase}`,
    ...fields,
  };
}

interface BigintRecord {
  readonly id: string;
  readonly version: number | bigint;
}

const bigintRecordSerializer: Serializer<BigintRecord> = {
  dump: (value) => JSON.stringify({ ...value, version: Number(value.version) }),
  load: (value) => JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value) as BigintRecord,
};

function mismatchLoggingEvent(
  useCase: string,
  outcome: ShadowMismatchLoggingOutcome,
): ShadowMismatchLoggingMetricLabels {
  return { cacheNamespace: "urn", useCase, keyType: "user_id", outcome };
}

function configResolutionErrors(metrics: RecordingMetrics): Array<Record<string, unknown>> {
  return metrics.ordinaryEvents
    .filter(({ name, labels }) => name === "error" && labels.error === "config_resolution")
    .map(({ labels }) => labels);
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

  it("confirms identical C1 bytes after the served C0 crosses its freshness age", async () => {
    const nowMs = 1_700_000_000_000;
    let readerNowMs = nowMs;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => readerNowMs);
    try {
      const payload = JSON.stringify({ id: "123", version: 1 });
      const redis = new ScriptedRedis([() => payload, () => payload]);
      redis.frameCreatedAtMs = nowMs - 999;
      const metrics = new RecordingMetrics();
      const dialcache = createCache(redis, metrics);
      const getUser = dialcache.cached(async () => {
        readerNowMs = nowMs + 2;
        return { id: "123", version: 2 };
      }, {
        ...trackedOptions(
          "ShadowConfirmationCrossesFreshAge",
          new DialCacheKeyConfig({
            ttlSec: { [CacheLayer.REMOTE]: 1 },
            ramp: { [CacheLayer.REMOTE]: 100 },
            staleOnErrorMaxAgeSec: 10,
            shadow: { ramp: 100 },
          }),
        ),
        cacheKey: () => "123",
      });

      await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({
        id: "123",
        version: 1,
      });
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
      expectTrackedReads(redis, 2);
    } finally {
      nowSpy.mockRestore();
    }
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

    await nextImmediate();

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(warn).not.toHaveBeenCalled();
    expect(metrics.shadowMismatchLoggingEvents).toEqual([]);
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
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(metrics.shadowAgeEvents).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      {
        cacheNamespace: "private-namespace",
        useCase: "ShadowMismatchJson",
        keyType: "user_id",
        outcome: "mismatch",
        cachedValueAgeSeconds: metrics.shadowAgeEvents[0]!.seconds,
        cacheKey: "{private-namespace:user_id:private-id}?tenant=private-tenant#ShadowMismatchJson",
        mismatchPaths: ["/version"],
        mismatchPathCount: 1,
        diffJson: '[{"path":"/version","cached":1,"source":2}]',
        cachedValueJson: '{"id":"private-id","version":1}',
        sourceValueJson: '{"id":"private-id","version":2}',
      },
    );
    expect(Object.keys((warn.mock.calls[0] as unknown as [string, object])[1])).toEqual([
      "cacheNamespace",
      "useCase",
      "keyType",
      "outcome",
      "cachedValueAgeSeconds",
      "cacheKey",
      "mismatchPaths",
      "mismatchPathCount",
      "diffJson",
      "cachedValueJson",
      "sourceValueJson",
    ]);
    // Labels come from the key, not from the mutated verdict labels, and a
    // rejected logger promise counts as logger_error.
    expect(metrics.shadowMismatchLoggingEvents).toEqual([
      {
        cacheNamespace: "private-namespace",
        useCase: "ShadowMismatchJson",
        keyType: "user_id",
        outcome: "logger_error",
      },
    ]);
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
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(metrics.shadowAgeEvents).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      {
        cacheNamespace: "urn",
        useCase: "ShadowMismatchRampedDownJson",
        keyType: "user_id",
        outcome: "mismatch",
        cachedValueAgeSeconds: metrics.shadowAgeEvents[0]!.seconds,
        cacheKey: "{urn:user_id:123}?locale=en-US#ShadowMismatchRampedDownJson",
        mismatchPaths: ["/version"],
        mismatchPathCount: 1,
        diffJson: '[{"path":"/version","cached":1,"source":2}]',
        cachedValueJson: '{"id":"123","version":1}',
        sourceValueJson: '{"id":"123","version":2}',
      },
    );
    expect(metrics.shadowMismatchLoggingEvents).toEqual([
      mismatchLoggingEvent("ShadowMismatchRampedDownJson", "logged"),
    ]);
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
      await waitForMismatchLoggingEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
      expect(metrics.shadowAgeEvents).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "DialCache shadow validation mismatch",
        {
          cacheNamespace: "urn",
          useCase: "ShadowMismatchJsonFailure",
          keyType: "user_id",
          outcome: "mismatch",
          cachedValueAgeSeconds: metrics.shadowAgeEvents[0]!.seconds,
          loggingOutcome: "render_error",
        },
      );
      expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("cacheKey");
      expect(metrics.shadowMismatchLoggingEvents).toEqual([
        mismatchLoggingEvent("ShadowMismatchJsonFailure", "render_error"),
      ]);
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
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(warning).not.toHaveProperty("cachedValue");
    expect(warning).not.toHaveProperty("sourceValue");
    expect(warning).not.toHaveProperty("loggingOutcome");
    expect(warning.cachedValueAgeSeconds).toBe(metrics.shadowAgeEvents[0]?.seconds);
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

    // The ids are equal, so the one differing member carries both sides,
    // each clamped to its JSON text.
    expect(warning.mismatchPaths).toEqual(["/content"]);
    expect(warning.mismatchPathCount).toBe(1);
    expect(typeof warning.diffJson).toBe("string");
    expect(Buffer.byteLength(warning.diffJson as string)).toBeLessThanOrEqual(SHADOW_LOG_DIFF_MAX_BYTES);
    const entries = JSON.parse(warning.diffJson as string) as Array<Record<string, unknown>>;
    expect(entries.map((entry) => Object.keys(entry))).toEqual([["path", "cached", "source"]]);
    for (const side of [entries[0]!.cached, entries[0]!.source]) {
      expect(typeof side).toBe("string");
      expect(Buffer.byteLength(side as string)).toBeLessThanOrEqual(SHADOW_MISMATCH_SIDE_MAX_BYTES);
      expect((side as string).startsWith('"')).toBe(true);
      expect((side as string).endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
      expect(side).not.toContain("\uFFFD");
    }
    expect(metrics.shadowMismatchLoggingEvents).toEqual([
      mismatchLoggingEvent("ShadowMismatchClampedJson", "logged"),
    ]);
  });

  it("logs only the paths and their count at diff paths", async () => {
    const useCase = "ShadowMismatchPathsOnly";
    const warn = vi.fn();
    const { metrics } = await runConfirmedMismatch(
      useCase,
      remoteConfig(100, 100, { mismatchLogging: { diff: "paths" } }),
      { warn },
    );
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      mismatchWarning(useCase, metrics, MISMATCH_PATH_FIELDS),
    );
    expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "logged")]);
  });

  it("logs the paths and diffJson without whole-value JSON at diff values with value false", async () => {
    const useCase = "ShadowMismatchValuesDiffOnly";
    const warn = vi.fn();
    const { metrics } = await runConfirmedMismatch(
      useCase,
      remoteConfig(100, 100, { mismatchLogging: { diff: "values", value: false } }),
      { warn },
    );
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      mismatchWarning(useCase, metrics, { ...MISMATCH_PATH_FIELDS, diffJson: MISMATCH_DIFF_JSON }),
    );
    expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "logged")]);
  });

  it("logs only the whole-value JSON and never runs the diff hook at value true alone", async () => {
    const useCase = "ShadowMismatchValueOnly";
    const warn = vi.fn();
    const shadowMismatchDiff = vi.fn((): readonly ShadowMismatchEntry[] => [{ path: "/hook" }]);
    const { metrics } = await runConfirmedMismatch(
      useCase,
      remoteConfig(100, 100, { mismatchLogging: { value: true } }),
      { warn, shadowMismatchDiff },
    );
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      mismatchWarning(useCase, metrics, MISMATCH_VALUE_FIELDS),
    );
    expect(shadowMismatchDiff).not.toHaveBeenCalled();
    expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "logged")]);
  });

  it("logs the exact value age the verdict observed as cachedValueAgeSeconds", async () => {
    const nowMs = 1_700_000_090_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const useCase = "ShadowMismatchWarningAge";
      const payload = JSON.stringify(mismatchCachedRecord);
      const redis = new ScriptedRedis([() => payload, () => payload]);
      redis.frameCreatedAtMs = nowMs - 30_500;
      const metrics = new RecordingMetrics();
      const warn = vi.fn();
      const dialcache = createCache(redis, metrics, {
        logger: {
          debug: () => undefined,
          error: () => undefined,
          warn,
        },
      });
      const getUser = dialcache.cached(async () => mismatchSourceRecord, {
        ...trackedOptions(useCase, remoteConfig(100, 100, { mismatchLogging: { diff: "paths" } })),
        cacheKey: () => "123",
      });

      await dialcache.enable(async () => await getUser());
      await waitForMismatchLoggingEvents(metrics, 1);

      expect(metrics.shadowAgeEvents.map(({ seconds }) => seconds)).toEqual([30.5]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ cachedValueAgeSeconds: 30.5 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([
    {
      diff: "paths" as const,
      fields: {
        mismatchPaths: ["/plan", "/profile/locale", "/profile/timezone", "/roles"],
        mismatchPathCount: 4,
      },
    },
    {
      diff: "values" as const,
      fields: {
        mismatchPaths: ["/plan", "/profile/locale", "/profile/timezone", "/roles"],
        mismatchPathCount: 4,
        diffJson: '[{"path":"/plan","cached":"free","source":"pro"},'
          + '{"path":"/profile/locale","cached":"en-US","source":"en-GB"},'
          + '{"path":"/profile/timezone","source":"Europe/London"},'
          + '{"path":"/roles","cached":["viewer"],"source":["viewer","editor"]}]',
      },
    },
  ])("logs the documented GetUser example at diff $diff", async ({ diff, fields }) => {
    // docs/shadow-validation.md shows these exact warnings; keep them in step.
    const cached = {
      id: "u_123",
      email: "ana@example.com",
      plan: "free",
      roles: ["viewer"],
      profile: { name: "Ana", locale: "en-US" },
    };
    const source = {
      id: "u_123",
      email: "ana@example.com",
      plan: "pro",
      roles: ["viewer", "editor"],
      profile: { name: "Ana", locale: "en-GB", timezone: "Europe/London" },
    };
    const payload = JSON.stringify(cached);
    const redis = new ScriptedRedis([() => payload, () => payload]);
    const metrics = new RecordingMetrics();
    const warn = vi.fn();
    const dialcache = createCache(redis, metrics, {
      namespace: "users-api",
      logger: { debug: () => undefined, error: () => undefined, warn },
    });
    const getUser = dialcache.cached(async (_userId: string) => source, {
      keyType: "user_id",
      useCase: "GetUser",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteConfig(100, 100, { mismatchLogging: { diff } }),
    });

    await expect(dialcache.enable(async () => await getUser("u_123"))).resolves.toEqual(cached);
    await waitForMismatchLoggingEvents(metrics, 1);

    const warning = {
      cacheNamespace: "users-api",
      useCase: "GetUser",
      keyType: "user_id",
      outcome: "mismatch",
      cachedValueAgeSeconds: metrics.shadowAgeEvents[0]!.seconds,
      cacheKey: "{users-api:user_id:u_123}#GetUser",
      ...fields,
    };
    expect(warn).toHaveBeenCalledExactlyOnceWith("DialCache shadow validation mismatch", warning);
    // The page shows the fields in this order.
    expect(Object.keys(warn.mock.calls[0]![1] as object)).toEqual(Object.keys(warning));
  });

  it("emits one logged event per confirmed mismatch after its verdict and none for a match", async () => {
    const useCase = "ShadowMismatchLoggingOrder";
    const matching = JSON.stringify({ id: "a", version: 1 });
    const redis = new ScriptedRedis([
      () => matching,
      () => JSON.stringify({ id: "b", version: 1 }),
      () => JSON.stringify({ id: "b", version: 1 }),
      () => JSON.stringify({ id: "c", version: 1 }),
      () => JSON.stringify({ id: "c", version: 1 }),
    ]);
    const metrics = new RecordingMetrics();
    const shadowValidation = vi.spyOn(metrics, "shadowValidation");
    const observeShadowValueAge = vi.spyOn(metrics, "observeShadowValueAge");
    const shadowMismatchLogging = vi.spyOn(metrics, "shadowMismatchLogging");
    const warn = vi.fn();
    const dialcache = createCache(redis, metrics, {
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn,
      },
    });
    const getUser = dialcache.cached(async (id: string) => ({ id, version: id === "a" ? 1 : 2 }), {
      ...trackedOptions(useCase, remoteConfig(100, 100, { mismatchLogging: { diff: "paths" } })),
      cacheKey: (id) => id,
    });

    await dialcache.enable(async () => await getUser("a"));
    await waitForShadowEvents(metrics, 1);
    await nextImmediate();
    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["match"]);
    expect(metrics.shadowMismatchLoggingEvents).toEqual([]);

    await dialcache.enable(async () => await getUser("b"));
    await waitForMismatchLoggingEvents(metrics, 1);
    await dialcache.enable(async () => await getUser("c"));
    await waitForMismatchLoggingEvents(metrics, 2);
    await nextImmediate();

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["match", "mismatch", "mismatch"]);
    expect(metrics.shadowMismatchLoggingEvents).toEqual([
      mismatchLoggingEvent(useCase, "logged"),
      mismatchLoggingEvent(useCase, "logged"),
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    // The match verdict observes its value age too, so both verdict streams
    // are offset by one against the warning streams.
    expect(observeShadowValueAge).toHaveBeenCalledTimes(3);
    for (const attempt of [0, 1]) {
      const sequence = [
        shadowValidation.mock.invocationCallOrder[attempt + 1]!,
        observeShadowValueAge.mock.invocationCallOrder[attempt + 1]!,
        warn.mock.invocationCallOrder[attempt]!,
        shadowMismatchLogging.mock.invocationCallOrder[attempt]!,
      ];
      expect(sequence).toEqual([...sequence].sort((left, right) => left - right));
    }
  });

  it.each([
    ["null", null],
    ["a string", "paths"],
    ["an object", { path: "/version" }],
  ])("rejects %s as shadowMismatchDiff where each API captures it", async (_label, hook) => {
    const dialcache = new DialCache();
    const invalidHook = hook as unknown as ShadowMismatchDiff<MismatchRecord>;
    const source = async (): Promise<MismatchRecord> => mismatchSourceRecord;
    const getOrLoadOptions = {
      keyType: "user_id",
      useCase: "InvalidGetOrLoadShadowMismatchDiff",
      key: "123",
      shadowMismatchDiff: invalidHook,
    } as const;

    expect(() =>
      dialcache.cached(source, {
        keyType: "user_id",
        useCase: "InvalidCachedShadowMismatchDiff",
        cacheKey: () => "123",
        shadowMismatchDiff: invalidHook,
      }),
    ).toThrow(new TypeError("DialCache shadowMismatchDiff must be a function"));
    // The rejected registration leaves the use case free for a valid one.
    expect(() =>
      dialcache.cached(source, {
        keyType: "user_id",
        useCase: "InvalidCachedShadowMismatchDiff",
        cacheKey: () => "123",
        shadowMismatchDiff: () => [],
      }),
    ).not.toThrow();
    expect(() => dialcache.getOrLoad(source, getOrLoadOptions)).toThrow(TypeError);
    await expect(dialcache.enable(async () => await dialcache.getOrLoad(source, getOrLoadOptions)))
      .rejects.toThrow(TypeError);
  });

  it.each(["cached", "getOrLoad"] as const)(
    "logs shadowMismatchDiff entries in place of the built-in walk through %s()",
    async (api) => {
      const useCase = `ShadowMismatchDiffHook${api}`;
      const warn = vi.fn();
      const shadowMismatchDiff = vi.fn((): readonly ShadowMismatchEntry[] => [
        { path: "/custom", cached: "c", source: "s" },
        { path: "/only-path" },
        { path: "/one-side", source: { nested: true } },
      ]);
      const { metrics, result } = await runConfirmedMismatch(
        useCase,
        remoteConfig(100, 100, { logMismatches: true }),
        { warn, shadowMismatchDiff, api },
      );
      await waitForMismatchLoggingEvents(metrics, 1);

      expect(result).toEqual(mismatchCachedRecord);
      expect(shadowMismatchDiff).toHaveBeenCalledOnce();
      expect(shadowMismatchDiff).toHaveBeenCalledWith(mismatchCachedRecord, mismatchSourceRecord);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "DialCache shadow validation mismatch",
        mismatchWarning(useCase, metrics, {
          mismatchPaths: ["/custom", "/only-path", "/one-side"],
          mismatchPathCount: 3,
          diffJson: '[{"path":"/custom","cached":"c","source":"s"},'
            + '{"path":"/only-path"},'
            + '{"path":"/one-side","source":{"nested":true}}]',
          ...MISMATCH_VALUE_FIELDS,
        }),
      );
      expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "logged")]);
    },
  );

  it.each([
    {
      name: "throws",
      useCase: "ShadowMismatchDiffHookThrows",
      hook: (): readonly ShadowMismatchEntry[] => {
        throw new Error("diff hook unavailable");
      },
    },
    {
      name: "returns a rejecting promise",
      useCase: "ShadowMismatchDiffHookPromise",
      hook: (): readonly ShadowMismatchEntry[] =>
        Promise.reject(new Error("async diff hooks are unsupported")) as unknown as readonly ShadowMismatchEntry[],
    },
  ])("logs null diff fields and hook_error without touching the verdict when the hook $name", async ({
    useCase,
    hook,
  }) => {
    const warn = vi.fn();
    await expectNoUnhandledRejection(async () => {
      const { metrics, result } = await runConfirmedMismatch(
        useCase,
        remoteConfig(100, 100, { logMismatches: true }),
        { warn, shadowMismatchDiff: hook },
      );
      await waitForMismatchLoggingEvents(metrics, 1);

      expect(result).toEqual(mismatchCachedRecord);
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "DialCache shadow validation mismatch",
        mismatchWarning(useCase, metrics, {
          mismatchPaths: null,
          mismatchPathCount: null,
          diffJson: null,
          ...MISMATCH_VALUE_FIELDS,
          loggingOutcome: "hook_error",
        }),
      );
      expect(Object.keys(warn.mock.calls[0]![1] as object).at(-1)).toBe("loggingOutcome");
      expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "hook_error")]);
    });
  });

  it.each([
    { name: "the default deep equality", useCase: "ShadowMismatchBigintDefaultEquality", comparator: undefined },
    {
      name: "a comparator",
      useCase: "ShadowMismatchBigintComparator",
      comparator: (cached: BigintRecord, source: BigintRecord) => cached.version === source.version,
    },
  ])("logs render_error with null source and diff fields for a bigint source value under $name", async ({
    useCase,
    comparator,
  }) => {
    const payload = JSON.stringify({ id: "123", version: 1 });
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
    const getUser = dialcache.cached(async (): Promise<BigintRecord> => ({ id: "123", version: 1n }), {
      ...trackedOptions(useCase, remoteConfig(100, 100, { logMismatches: true })),
      cacheKey: () => "123",
      serializer: bigintRecordSerializer,
      ...(comparator === undefined ? {} : { shadowComparator: comparator }),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123", version: 1 });
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      mismatchWarning(useCase, metrics, {
        mismatchPaths: null,
        mismatchPathCount: null,
        diffJson: null,
        cachedValueJson: '{"id":"123","version":1}',
        sourceValueJson: null,
        loggingOutcome: "render_error",
      }),
    );
    expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "render_error")]);
  });

  it("logs a cached undefined negative-cache entry as an absent side, not a render failure", async () => {
    const useCase = "ShadowMismatchAbsentCachedValue";
    // The default JSON serializer's stored form of a top-level undefined.
    const payload = "__dialcache_json_undefined_v1__";
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
    const getUser = dialcache.cached(async (): Promise<{ id: string } | undefined> => ({ id: "123" }), {
      ...trackedOptions(useCase, remoteConfig(100, 100, { logMismatches: true })),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toBeUndefined();
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      mismatchWarning(useCase, metrics, {
        mismatchPaths: [""],
        mismatchPathCount: 1,
        diffJson: '[{"path":"","source":{"id":"123"}}]',
        cachedValueJson: null,
        sourceValueJson: '{"id":"123"}',
      }),
    );
    expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "logged")]);
  });

  it("logs hook paths without rendering values at diff paths, even for a bigint source value", async () => {
    const useCase = "ShadowMismatchBigintHookPaths";
    const payload = JSON.stringify({ id: "123", version: 1 });
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
    const getUser = dialcache.cached(async (): Promise<BigintRecord> => ({ id: "123", version: 1n }), {
      ...trackedOptions(useCase, remoteConfig(100, 100, { mismatchLogging: { diff: "paths" } })),
      cacheKey: () => "123",
      serializer: bigintRecordSerializer,
      shadowMismatchDiff: () => [{ path: "/version" }],
    });

    await dialcache.enable(async () => await getUser());
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      mismatchWarning(useCase, metrics, { mismatchPaths: ["/version"], mismatchPathCount: 1 }),
    );
    expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "logged")]);
  });

  it.each<{
    readonly name: string;
    readonly useCase: string;
    readonly warn: () => unknown;
    readonly outcome: ShadowMismatchLoggingOutcome;
  }>([
    {
      name: "throws synchronously",
      useCase: "ShadowMismatchLoggerThrows",
      warn: () => {
        throw new Error("logger unavailable");
      },
      outcome: "logger_error",
    },
    {
      name: "returns a rejected promise",
      useCase: "ShadowMismatchLoggerRejects",
      warn: () => Promise.reject(new Error("logger transport unavailable")),
      outcome: "logger_error",
    },
    {
      name: "returns a resolved promise",
      useCase: "ShadowMismatchLoggerResolves",
      warn: () => Promise.resolve(),
      outcome: "logged",
    },
    {
      name: "returns a rejected promise whose own then is replaced",
      useCase: "ShadowMismatchLoggerReplacedThen",
      warn: () => {
        const rejected = Promise.reject(new Error("logger transport unavailable"));
        Object.defineProperty(rejected, "then", { value: () => undefined });
        return rejected;
      },
      outcome: "logger_error",
    },
    {
      name: "returns a thenable that rejects",
      useCase: "ShadowMismatchLoggerThenableRejects",
      warn: () => ({
        then(_resolve: unknown, reject: (reason: unknown) => void): void {
          reject(new Error("logger transport unavailable"));
        },
      }),
      outcome: "logger_error",
    },
  ])("records $outcome and leaves the caller unaffected when the logger $name", async ({
    useCase,
    warn: warnImplementation,
    outcome,
  }) => {
    // A plain function rather than vi.fn: a spy attaches its own handlers to a
    // returned promise, which would hide a rejection DialCache left unconsumed.
    const calls: unknown[][] = [];
    const warn = (...args: unknown[]): unknown => {
      calls.push(args);
      return warnImplementation();
    };
    await expectNoUnhandledRejection(async () => {
      const { metrics, result } = await runConfirmedMismatch(
        useCase,
        remoteConfig(100, 100, { logMismatches: true }),
        { warn },
      );
      await waitForMismatchLoggingEvents(metrics, 1);

      expect(result).toEqual(mismatchCachedRecord);
      expect(metrics.shadowEvents.map(({ outcome: verdict }) => verdict)).toEqual(["mismatch"]);
      expect(calls).toEqual([[
        "DialCache shadow validation mismatch",
        mismatchWarning(useCase, metrics, {
          ...MISMATCH_PATH_FIELDS,
          diffJson: MISMATCH_DIFF_JSON,
          ...MISMATCH_VALUE_FIELDS,
        }),
      ]]);
      expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, outcome)]);
    });
  });

  it.each(([
    {
      name: "the hook throws",
      useCase: "ShadowMismatchHookAndLoggerThrow",
      shadowMismatchDiff: () => {
        throw new Error("hook failed");
      },
      fields: { mismatchPaths: null, mismatchPathCount: null, diffJson: null },
      outcome: "hook_error",
    },
    {
      name: "a hook side has no JSON rendering",
      useCase: "ShadowMismatchRenderAndLoggerThrow",
      shadowMismatchDiff: () => [{ path: "/version", cached: 1n }],
      fields: { mismatchPaths: ["/version"], mismatchPathCount: 1, diffJson: null },
      outcome: "render_error",
    },
  ] as const satisfies readonly {
    readonly name: string;
    readonly useCase: string;
    readonly shadowMismatchDiff: ShadowMismatchDiff<MismatchRecord>;
    readonly fields: Record<string, unknown>;
    readonly outcome: ShadowMismatchLoggingOutcome;
  }[]).flatMap((failure) => (["throws", "rejects"] as const).map((loggerFailure) => ({
    ...failure,
    useCase: `${failure.useCase}${loggerFailure}`,
    loggerFailure,
  }))))("records $outcome rather than logger_error when $name and the logger $loggerFailure", async ({
    useCase,
    shadowMismatchDiff,
    fields,
    outcome,
    loggerFailure,
  }) => {
    const calls: unknown[][] = [];
    const warn = (...args: unknown[]): unknown => {
      calls.push(args);
      if (loggerFailure === "rejects") {
        return Promise.reject(new Error("logger transport unavailable"));
      }
      throw new Error("logger unavailable");
    };
    await expectNoUnhandledRejection(async () => {
      const { metrics, result } = await runConfirmedMismatch(
        useCase,
        remoteConfig(100, 100, { mismatchLogging: { diff: "values" } }),
        { warn, shadowMismatchDiff },
      );
      await waitForMismatchLoggingEvents(metrics, 1);

      expect(result).toEqual(mismatchCachedRecord);
      expect(calls).toEqual([[
        "DialCache shadow validation mismatch",
        mismatchWarning(useCase, metrics, { ...fields, loggingOutcome: outcome }),
      ]]);
      expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, outcome)]);
    });
  });

  it.each([
    {
      name: "the hook throws",
      useCase: "ShadowMismatchHookFailsLoggerPending",
      shadowMismatchDiff: (): never => {
        throw new Error("hook failed");
      },
      outcome: "hook_error",
    },
    {
      name: "a hook side has no JSON rendering",
      useCase: "ShadowMismatchRenderFailsLoggerPending",
      shadowMismatchDiff: () => [{ path: "/version", cached: 1n }],
      outcome: "render_error",
    },
  ] as const)("records $outcome at once when $name while the logger's promise is still pending", async ({
    useCase,
    shadowMismatchDiff,
    outcome,
  }) => {
    let warnings = 0;
    const warn = (): Promise<never> => {
      warnings += 1;
      return new Promise<never>(() => undefined);
    };
    const { metrics } = await runConfirmedMismatch(
      useCase,
      remoteConfig(100, 100, { mismatchLogging: { diff: "values" } }),
      { warn, shadowMismatchDiff: shadowMismatchDiff as ShadowMismatchDiff<MismatchRecord> },
    );
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(warnings).toBe(1);
    expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, outcome)]);
  });

  it("records no logging outcome while a logger's promise never settles", async () => {
    let warnings = 0;
    const warn = (): Promise<never> => {
      warnings += 1;
      return new Promise<never>(() => undefined);
    };
    const { metrics } = await runConfirmedMismatch(
      "ShadowMismatchLoggerPending",
      remoteConfig(100, 100, { logMismatches: true }),
      { warn },
    );
    for (let turn = 0; turn < 5; turn += 1) {
      await nextImmediate();
    }

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(warnings).toBe(1);
    expect(metrics.shadowMismatchLoggingEvents).toEqual([]);
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

  it("reports superseded when C1 becomes a typed watermark miss", async () => {
    const payload = JSON.stringify({ id: "123", version: 1 });
    const frameCreatedAtMs = Date.now();
    const redis = new ScriptedRedis([
      () => payload,
      (): RedisReadMiss => ({
        kind: "miss",
        reason: "watermark_fenced",
        observedWatermarkMs: frameCreatedAtMs + 1,
      }),
    ]);
    redis.frameCreatedAtMs = frameCreatedAtMs;
    const metrics = new RecordingMetrics();
    const serializer: Serializer<{ readonly id: string; readonly version: number }> = {
      dump: vi.fn((value) => JSON.stringify(value)),
      load: vi.fn((value) => JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value)),
    };
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
      ...trackedOptions("ShadowSupersededWatermarkMiss", remoteConfig(100)),
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

  it("retains a future-dated C1 for payload confirmation and attributes its offset to remote_shadow", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const payload = JSON.stringify({ id: "123", version: 1 });
      const redis = new ScriptedRedis([
        () => payload,
        () => {
          redis.frameCreatedAtMs = nowMs + 3_000;
          return payload;
        },
      ]);
      redis.frameCreatedAtMs = nowMs - 1_000;
      const metrics = new RecordingMetrics();
      const serializer: Serializer<{ readonly id: string; readonly version: number }> = {
        dump: vi.fn((value) => JSON.stringify(value)),
        load: vi.fn((value) => JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value)),
      };
      const dialcache = createCache(redis, metrics);
      const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
        ...trackedOptions("ShadowFutureConfirmation", remoteConfig(100)),
        cacheKey: () => "123",
        serializer,
      });

      await dialcache.enable(async () => await getUser());
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
      expect(metrics.shadowAgeEvents).toEqual([
        {
          labels: {
            cacheNamespace: "urn",
            useCase: "ShadowFutureConfirmation",
            keyType: "user_id",
            outcome: "mismatch",
          },
          seconds: 1,
        },
      ]);
      expect(metrics.futureTimestampEvents).toEqual([
        {
          labels: {
            cacheNamespace: "urn",
            useCase: "ShadowFutureConfirmation",
            keyType: "user_id",
            layer: REMOTE_SHADOW_CACHE_LAYER,
          },
          seconds: 3,
        },
      ]);
      expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
        name === "miss" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      )).toHaveLength(0);
      expect(serializer.load).toHaveBeenCalledTimes(2);
      expect(serializer.dump).not.toHaveBeenCalled();
      expectTrackedReads(redis, 2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("confirms the same C1 payload when the reader clock steps backward after accepting C0", async () => {
    const nowMs = 1_700_000_000_000;
    const payload = JSON.stringify({ id: "123", version: 1 });
    const redis = new ScriptedRedis([() => payload, () => payload]);
    redis.frameCreatedAtMs = nowMs - 1_000;
    const nowSpy = vi.spyOn(Date, "now")
      .mockReturnValueOnce(nowMs)
      .mockReturnValue(nowMs - 2_000);
    try {
      const metrics = new RecordingMetrics();
      const dialcache = createCache(redis, metrics);
      const getUser = dialcache.cached(async () => ({ id: "123", version: 2 }), {
        ...trackedOptions("ShadowConfirmationClockStepBack", remoteConfig(100)),
        cacheKey: () => "123",
      });

      await dialcache.enable(async () => await getUser());
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
      expect(metrics.shadowAgeEvents).toEqual([
        {
          labels: {
            cacheNamespace: "urn",
            useCase: "ShadowConfirmationClockStepBack",
            keyType: "user_id",
            outcome: "mismatch",
          },
          seconds: 0,
        },
      ]);
      expect(metrics.futureTimestampEvents).toEqual([
        {
          labels: {
            cacheNamespace: "urn",
            useCase: "ShadowConfirmationClockStepBack",
            keyType: "user_id",
            layer: REMOTE_SHADOW_CACHE_LAYER,
          },
          seconds: 1,
        },
      ]);
      expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
        name === "miss" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      )).toHaveLength(0);
      expectTrackedReads(redis, 2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("records the validated value age only for a confirmed mismatch verdict", async () => {
    const nowMs = 1_700_000_090_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const payload = JSON.stringify({ id: "123", version: 1 });
      const redis = new ScriptedRedis([
        () => payload,
        () => {
          // A concurrent writer republished identical bytes with a fresh
          // stamp; the confirmation still holds and the reported age must
          // come from the original frame, not this one.
          redis.frameCreatedAtMs = nowMs - 1_000;
          return payload;
        },
      ]);
      redis.frameCreatedAtMs = nowMs - 30_000;
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
      expect(metrics.shadowAgeEvents[0]?.seconds).toBe(30);
      expect(metrics.shadowAgeEvents[0]?.labels).toMatchObject({
        useCase: "ShadowMismatchValueAge",
        keyType: "user_id",
        outcome: "mismatch",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("treats a non-finite tracked dark frame timestamp as a miss without observing an offset", async () => {
    const payload = JSON.stringify({ id: "123", version: 1 });
    const redis = new ScriptedRedis([() => payload]);
    redis.frameCreatedAtMs = Number.NaN;
    const metrics = new RecordingMetrics();
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(async () => ({ id: "123", version: 1 }), {
      ...trackedOptions("ShadowValueAgeNonFinite", remoteConfig(0)),
      cacheKey: () => "123",
    });

    await dialcache.enable(async () => await getUser());
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["filled"]);
    expect(metrics.shadowAgeEvents).toEqual([]);
    expect(metrics.futureTimestampEvents).toEqual([]);
    expect(redis.write).toHaveBeenCalledOnce();
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "miss").map(({ labels }) => labels)).toEqual([
      {
        cacheNamespace: "urn",
        useCase: "ShadowValueAgeNonFinite",
        keyType: "user_id",
        layer: REMOTE_SHADOW_CACHE_LAYER,
        reason: "unclassified",
      },
    ]);
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

    await nextImmediate();

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["superseded"]);
    expect(warn).not.toHaveBeenCalled();
    expect(metrics.shadowMismatchLoggingEvents).toEqual([]);
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

  it("reports a tracked TTL clamp when a dark fill is actually dispatched", async () => {
    const redis = new ScriptedRedis([() => null]);
    const metrics = new RecordingMetrics();
    const config = new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 2 * MAX_TRACKED_REDIS_VALUE_TTL_MS / 1_000 },
      ramp: { [CacheLayer.REMOTE]: 0 },
      shadow: { ramp: 100 },
    });
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(async () => ({ id: "123" }), {
      ...trackedOptions("ShadowDarkTrackedTtlClamp", config),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
    await waitForShadowEvents(metrics, 1);

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["filled"]);
    expect(redis.write).toHaveBeenCalledWith(expect.objectContaining({
      cacheTtlMs: MAX_TRACKED_REDIS_VALUE_TTL_MS,
    }));
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "error").map(({ labels }) => labels)).toEqual([
      {
        cacheNamespace: "urn",
        useCase: "ShadowDarkTrackedTtlClamp",
        keyType: "user_id",
        layer: REMOTE_SHADOW_CACHE_LAYER,
        error: "tracked_ttl_clamped",
        inFallback: false,
      },
    ]);
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

  it("treats a future-dated dark C0 as a miss before deserialization and fills from SoT", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const redis = new ScriptedRedis([() => JSON.stringify({ id: "123", source: "redis" })]);
      redis.frameCreatedAtMs = nowMs + 2_000;
      const metrics = new RecordingMetrics();
      const sourceValue = { id: "123", source: "source" };
      const serializer: Serializer<typeof sourceValue> = {
        dump: vi.fn((value) => JSON.stringify(value)),
        load: vi.fn(() => {
          throw new Error("future dark reads must not be deserialized");
        }),
      };
      const source = vi.fn(async () => sourceValue);
      const dialcache = createCache(redis, metrics);
      const getUser = dialcache.cached(source, {
        ...trackedOptions("ShadowDarkFutureFrame", remoteConfig(0)),
        cacheKey: () => "123",
        serializer,
      });

      await expect(dialcache.enable(async () => await getUser())).resolves.toBe(sourceValue);
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["filled"]);
      expect(metrics.shadowAgeEvents).toEqual([]);
      expect(metrics.futureTimestampEvents).toEqual([
        {
          labels: {
            cacheNamespace: "urn",
            useCase: "ShadowDarkFutureFrame",
            keyType: "user_id",
            layer: REMOTE_SHADOW_CACHE_LAYER,
          },
          seconds: 2,
        },
      ]);
      expect(serializer.load).not.toHaveBeenCalled();
      expect(serializer.dump).toHaveBeenCalledOnce();
      expect(source).toHaveBeenCalledOnce();
      expect(redis.write).toHaveBeenCalledOnce();
      expectTrackedReads(redis, 1);
      expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
        name === "miss"
        && labels.layer === REMOTE_SHADOW_CACHE_LAYER
        && labels.reason === "unclassified"
      )).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
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

  it("never serves retained stale data when remote serving is ramped down", async () => {
    const stalePayload = JSON.stringify({ id: "123", source: "stale-cache" });
    const redis = new ScriptedRedis([() => stalePayload]);
    redis.frameCreatedAtMs = Date.now() - 120_000;
    const metrics = new RecordingMetrics();
    const sourceError = Object.freeze({ code: "SOURCE_UNAVAILABLE" });
    const source = vi.fn(async () => {
      throw sourceError;
    });
    const dialcache = createCache(redis, metrics);
    const getUser = dialcache.cached(source, {
      ...trackedOptions("ShadowDarkRetainedStale", new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 0 },
        staleOnErrorMaxAgeSec: 3_600,
        shadow: { ramp: 100 },
      })),
      cacheKey: () => "123",
    });

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(sourceError);
    await waitForShadowEvents(metrics, 1);

    expect(source).toHaveBeenCalledOnce();
    expectTrackedReads(redis, 1);
    expect(redis.write).not.toHaveBeenCalled();
    expect(redis.invalidate).not.toHaveBeenCalled();
    expect(metrics.shadowEvents).toEqual([{
      cacheNamespace: "urn",
      useCase: "ShadowDarkRetainedStale",
      keyType: "user_id",
      outcome: "source_error",
    }]);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "request" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "get" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "disabled"
      && labels.layer === CacheLayer.REMOTE
      && labels.reason === "ramped_down"
    )).toHaveLength(1);
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
  ])("retains a clean $name dark Redis miss through M and attributes the work to remote_shadow", async ({
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
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 0 },
        staleOnErrorMaxAgeSec: 3_600,
        shadow: { ramp: 100 },
      }),
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
      cacheTtlMs: 3_600_000,
      value: JSON.stringify({ id: "123" }),
    }));
    expect(Object.hasOwn(redis.write.mock.calls[0]?.[0] ?? {}, "watermarkKey")).toBe(false);
    expect(Object.hasOwn(redis.write.mock.calls[0]?.[0] ?? {}, "createdAtMs")).toBe(false);
    expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
      name === "request" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
    )).toHaveLength(1);
    expect(metrics.ordinaryEvents.filter(({ name }) => name === "miss").map(({ labels }) => labels)).toEqual([
      {
        cacheNamespace: "urn",
        useCase: `ShadowDarkMissFill${name}`,
        keyType: "user_id",
        layer: REMOTE_SHADOW_CACHE_LAYER,
        reason: "unclassified",
      },
    ]);
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

  it("reports fill_fenced and skips shadow serialization when the candidate cannot clear the observed watermark", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const redis = new ScriptedRedis([
        (): RedisReadMiss => ({ kind: "miss", reason: "value_absent", observedWatermarkMs: nowMs }),
      ]);
      const metrics = new RecordingMetrics();
      const serializer: Serializer<{ readonly id: string }> = {
        dump: vi.fn(() => {
          throw new Error("fenced shadow fill must not serialize");
        }),
        load: vi.fn(() => {
          throw new Error("watermark miss must not deserialize");
        }),
      };
      const dialcache = createCache(redis, metrics);
      const getUser = dialcache.cached(async () => ({ id: "123" }), {
        ...trackedOptions("ShadowDarkFillFenced", remoteConfig(0)),
        cacheKey: () => "123",
        serializer,
      });

      await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["fill_fenced"]);
      expect(serializer.dump).not.toHaveBeenCalled();
      expect(serializer.load).not.toHaveBeenCalled();
      expect(redis.write).not.toHaveBeenCalled();
      expectTrackedReads(redis, 1);
      expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
        name === "request" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      )).toHaveLength(1);
      expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
        name === "miss"
        && labels.layer === REMOTE_SHADOW_CACHE_LAYER
        && labels.reason === "value_absent"
      )).toHaveLength(1);
      expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
        name === "get" && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      )).toHaveLength(1);
      expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
        (name === "serialization" || name === "size") && labels.layer === REMOTE_SHADOW_CACHE_LAYER
      )).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("records value_absent for a valid-watermark dark miss even when its refill is fenced", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const redis = new ScriptedRedis([
        (): RedisReadMiss => ({
          kind: "miss",
          reason: "value_absent",
          observedWatermarkMs: nowMs,
        }),
      ]);
      const metrics = new RecordingMetrics();
      const dialcache = createCache(redis, metrics);
      const getUser = dialcache.cached(async () => ({ id: "123" }), {
        ...trackedOptions("ShadowDarkValueAbsentFillFenced", remoteConfig(0)),
        cacheKey: () => "123",
      });

      await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["fill_fenced"]);
      expect(redis.write).not.toHaveBeenCalled();
      expectTrackedReads(redis, 1);
      expect(metrics.ordinaryEvents
        .filter(({ name, labels }) => name === "miss" && labels.layer === REMOTE_SHADOW_CACHE_LAYER)
        .map(({ labels }) => labels.reason)).toEqual(["value_absent"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("records watermark_fenced for a fenced dark frame that admits a later refill", async () => {
    const nowMs = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const redis = new ScriptedRedis([
        (): RedisReadMiss => ({
          kind: "miss",
          reason: "watermark_fenced",
          observedWatermarkMs: nowMs - 1,
        }),
      ]);
      const metrics = new RecordingMetrics();
      const serializer: Serializer<{ readonly id: string }> = {
        dump: vi.fn((value) => JSON.stringify(value)),
        load: vi.fn(() => {
          throw new Error("watermark miss must not deserialize");
        }),
      };
      const source = vi.fn(async () => ({ id: "123" }));
      const dialcache = createCache(redis, metrics);
      const getUser = dialcache.cached(source, {
        ...trackedOptions("ShadowDarkWatermarkFencedFill", remoteConfig(0)),
        cacheKey: () => "123",
        serializer,
      });

      await expect(dialcache.enable(async () => await getUser())).resolves.toEqual({ id: "123" });
      await waitForShadowEvents(metrics, 1);

      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["filled"]);
      expect(source).toHaveBeenCalledOnce();
      expect(serializer.dump).toHaveBeenCalledOnce();
      expect(serializer.load).not.toHaveBeenCalled();
      expect(redis.write).toHaveBeenCalledOnce();
      expect(redis.write).toHaveBeenCalledWith(expect.objectContaining({
        value: JSON.stringify({ id: "123" }),
        createdAtMs: nowMs,
      }));
      expectTrackedReads(redis, 1);
      expect(metrics.ordinaryEvents
        .filter(({ name, labels }) => name === "miss" && labels.layer === REMOTE_SHADOW_CACHE_LAYER)
        .map(({ labels }) => labels.reason)).toEqual(["watermark_fenced"]);
    } finally {
      nowSpy.mockRestore();
    }
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
    const writeGate = deferred<void>();
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

      writeGate.resolve(undefined);
      await waitForShadowEvents(metrics, 1);
      expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["filled"]);
    } finally {
      dumpGate.resolve(undefined);
      writeGate.resolve(undefined);
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
    }));
    expect(Object.hasOwn(redis.write.mock.calls[0]?.[0] ?? {}, "watermarkKey")).toBe(false);
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
    expect(metrics.shadowMismatchLoggingEvents).toEqual([]);
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

  it("keeps the valid default leaf and records one config_resolution for an invalid runtime leaf", async () => {
    const useCase = "ShadowMismatchInvalidRuntimeLeaf";
    const warn = vi.fn();
    const { metrics } = await runConfirmedMismatch(
      useCase,
      remoteConfig(100, 100, { mismatchLogging: { value: true } }),
      {
        warn,
        cacheConfigProvider: async () => new DialCacheKeyConfig({
          shadow: { mismatchLogging: { diff: "everything" as never } },
        }),
      },
    );
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(configResolutionErrors(metrics)).toEqual([
      {
        cacheNamespace: "urn",
        useCase,
        keyType: "user_id",
        layer: CacheLayer.REMOTE,
        error: "config_resolution",
        inFallback: false,
      },
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      mismatchWarning(useCase, metrics, MISMATCH_VALUE_FIELDS),
    );
    expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "logged")]);
  });

  it("records one config_resolution for a malformed runtime shorthand and logs the leaves beside it", async () => {
    const useCase = "ShadowMismatchMalformedShorthandLeaves";
    const warn = vi.fn();
    const { metrics } = await runConfirmedMismatch(
      useCase,
      remoteConfig(100, 100, { logMismatches: true }),
      {
        warn,
        cacheConfigProvider: async () => new DialCacheKeyConfig({
          shadow: {
            logMismatches: "yes" as never,
            mismatchLogging: { value: false, diff: "paths" },
          },
        }),
      },
    );
    await waitForMismatchLoggingEvents(metrics, 1);

    expect(configResolutionErrors(metrics)).toEqual([
      {
        cacheNamespace: "urn",
        useCase,
        keyType: "user_id",
        layer: CacheLayer.REMOTE,
        error: "config_resolution",
        inFallback: false,
      },
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      mismatchWarning(useCase, metrics, MISMATCH_PATH_FIELDS),
    );
    expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "logged")]);
  });

  it.each([
    {
      name: "every field but whole-value JSON for logMismatches true beside value false",
      useCase: "ShadowMismatchRowShorthandTrueValueFalse",
      defaults: { logMismatches: true, mismatchLogging: { value: false } },
      runtime: undefined,
      fields: { ...MISMATCH_PATH_FIELDS, diffJson: MISMATCH_DIFF_JSON },
    },
    {
      name: "only the paths for logMismatches false beside diff paths",
      useCase: "ShadowMismatchRowShorthandFalseDiffPaths",
      defaults: { logMismatches: false, mismatchLogging: { diff: "paths" } },
      runtime: undefined,
      fields: MISMATCH_PATH_FIELDS,
    },
    {
      name: "nothing for a runtime logMismatches false over a default diff paths",
      useCase: "ShadowMismatchRowRuntimeFalseOverPaths",
      defaults: { mismatchLogging: { diff: "paths" } },
      runtime: { logMismatches: false },
      fields: null,
    },
    {
      name: "every field for a runtime logMismatches true over a default value false",
      useCase: "ShadowMismatchRowRuntimeTrueOverValueFalse",
      defaults: { mismatchLogging: { value: false } },
      runtime: { logMismatches: true },
      fields: { ...MISMATCH_PATH_FIELDS, diffJson: MISMATCH_DIFF_JSON, ...MISMATCH_VALUE_FIELDS },
    },
  ] as const)("logs $name", async ({ useCase, defaults, runtime, fields }) => {
    const warn = vi.fn();
    const { metrics } = await runConfirmedMismatch(
      useCase,
      remoteConfig(100, 100, defaults),
      {
        warn,
        ...(runtime === undefined
          ? {}
          : { cacheConfigProvider: async () => new DialCacheKeyConfig({ shadow: runtime }) }),
      },
    );

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(configResolutionErrors(metrics)).toEqual([]);
    if (fields === null) {
      await nextImmediate();
      expect(warn).not.toHaveBeenCalled();
      expect(metrics.shadowMismatchLoggingEvents).toEqual([]);
      return;
    }
    await waitForMismatchLoggingEvents(metrics, 1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "DialCache shadow validation mismatch",
      mismatchWarning(useCase, metrics, fields),
    );
    expect(metrics.shadowMismatchLoggingEvents).toEqual([mismatchLoggingEvent(useCase, "logged")]);
  });

  it("lets DialCacheKeyConfig.disabled() override every inherited mismatch-logging leaf", async () => {
    const defaults = remoteConfig(100, 100, {
      logMismatches: true,
      mismatchLogging: { value: true, diff: "values" },
    });
    const disabledShadow = DialCacheKeyConfig.disabled().shadow;
    expect(disabledShadow).toEqual({ ramp: 0, mismatchLogging: { value: false, diff: "off" } });

    const killedRedis = new ScriptedRedis([]);
    const killedMetrics = new RecordingMetrics();
    const killedWarn = vi.fn();
    const killedCache = createCache(killedRedis, killedMetrics, {
      cacheConfigProvider: async () => DialCacheKeyConfig.disabled(),
      logger: {
        debug: () => undefined,
        error: () => undefined,
        warn: killedWarn,
      },
    });
    const getUser = killedCache.cached(async () => mismatchSourceRecord, {
      ...trackedOptions("ShadowMismatchDisabledOverlay", defaults),
      cacheKey: () => "123",
    });
    await expect(killedCache.enable(async () => await getUser())).resolves.toEqual(mismatchSourceRecord);
    await nextImmediate();

    expect(killedRedis.requests).toHaveLength(0);
    expect(killedMetrics.shadowEvents).toHaveLength(0);
    expect(killedWarn).not.toHaveBeenCalled();
    expect(killedMetrics.shadowMismatchLoggingEvents).toEqual([]);

    // With only the shadow ramp restored, the verdict still runs, but the
    // overlay's leaves replace both inherited ones.
    const warn = vi.fn();
    const { metrics } = await runConfirmedMismatch("ShadowMismatchDisabledLeaves", defaults, {
      warn,
      cacheConfigProvider: async () => new DialCacheKeyConfig({ shadow: { ...disabledShadow, ramp: 100 } }),
    });
    await nextImmediate();

    expect(metrics.shadowEvents.map(({ outcome }) => outcome)).toEqual(["mismatch"]);
    expect(warn).not.toHaveBeenCalled();
    expect(metrics.shadowMismatchLoggingEvents).toEqual([]);
    expect(configResolutionErrors(metrics)).toEqual([]);
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

  it("retains capacity after an overall timeout until an already-dispatched write settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let nowMs = 0;
    const performanceSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const writeStarted = deferred<void>();
    const writeGate = deferred<void>();
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

      writeGate.resolve(undefined);
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
      writeGate.resolve(undefined);
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
    const config = new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 2 * MAX_TRACKED_REDIS_VALUE_TTL_MS / 1_000 },
      ramp: { [CacheLayer.REMOTE]: 0 },
      shadow: { ramp: 100 },
    });
    const getUser = dialcache.cached(async (id: string) => ({ id }), {
      ...trackedOptions("ShadowDarkDumpTimeoutRetention", config),
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
      expect(metrics.ordinaryEvents.filter(({ name, labels }) =>
        name === "error" && labels.error === "tracked_ttl_clamped"
      )).toHaveLength(0);

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

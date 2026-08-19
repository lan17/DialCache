import StatsD from "hot-shots";
import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  type CompressionOutcome,
  type DisabledReason,
  type DialCacheRedisClient,
  type MetricErrorKind,
  type MetricLayer,
  type ShadowValidationOutcome,
  type StaleRecoveryOutcome,
} from "../src/index.js";
import {
  NO_CACHE_LAYER,
  REMOTE_SHADOW_CACHE_LAYER,
  REQUEST_LOCAL_CACHE_LAYER,
} from "../src/metrics.js";
import {
  DatadogDialCacheMetrics,
  createDatadogDialCacheMetrics,
  type DatadogDogStatsDClient,
  type DatadogMetricsOptions,
  type DatadogObservationMetricType,
} from "../src/datadog.js";

type DatadogMethod = "increment" | "histogram" | "distribution";

interface DatadogCall {
  readonly method: DatadogMethod;
  readonly name: string;
  readonly value: number;
  readonly tags: Record<string, string>;
}

class RecordingDogStatsDClient implements DatadogDogStatsDClient {
  readonly calls: DatadogCall[] = [];
  readonly flush = vi.fn();
  readonly close = vi.fn();

  increment(name: string, value: number, tags?: Record<string, string>): void {
    this.record("increment", name, value, tags);
  }

  histogram(name: string, value: number, tags?: Record<string, string>): void {
    this.record("histogram", name, value, tags);
  }

  distribution(name: string, value: number, tags?: Record<string, string>): void {
    this.record("distribution", name, value, tags);
  }

  private record(
    method: DatadogMethod,
    name: string,
    value: number,
    tags: Record<string, string> | undefined,
  ): void {
    this.calls.push({ method, name, value, tags: { ...tags } });
  }
}

const cacheLabels = {
  cacheNamespace: "users",
  useCase: "LoadUser",
  keyType: "user_id",
  layer: CacheLayer.LOCAL,
} as const;

const localOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
    ramp: { [CacheLayer.LOCAL]: 100 },
  });

const remoteOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

const observationMetricTypes: readonly DatadogObservationMetricType[] = ["histogram", "distribution"];
const DISABLED_REASONS: Readonly<Record<DisabledReason, true>> = {
  context: true,
  policy_disabled: true,
  invalid_ttl: true,
  invalid_ramp: true,
  ramped_down: true,
  config_error: true,
};
const disabledReasons = Object.keys(DISABLED_REASONS) as DisabledReason[];
const ERROR_KINDS: Readonly<Record<MetricErrorKind, true>> = {
  key_construction: true,
  config_resolution: true,
  cache_read: true,
  cache_read_timeout: true,
  cache_write: true,
  serialization_load: true,
  serialization_dump: true,
  compression: true,
  invalidation: true,
  fallback: true,
  unknown: true,
};
const errorKinds = Object.keys(ERROR_KINDS) as MetricErrorKind[];
const SHADOW_VALIDATION_OUTCOMES: Readonly<Record<ShadowValidationOutcome, true>> = {
  match: true,
  mismatch: true,
  superseded: true,
  filled: true,
  fill_blocked: true,
  fill_error: true,
  redis_error: true,
  source_error: true,
  deserialization_error: true,
  comparison_error: true,
  confirmation_error: true,
  timeout: true,
  dropped: true,
};
const shadowValidationOutcomes = Object.keys(SHADOW_VALIDATION_OUTCOMES) as ShadowValidationOutcome[];
const STALE_RECOVERY_OUTCOMES: Readonly<Record<StaleRecoveryOutcome, true>> = {
  served: true,
  miss: true,
  read_error: true,
  read_timeout: true,
  deserialization_error: true,
};
const staleRecoveryOutcomes = Object.keys(STALE_RECOVERY_OUTCOMES) as StaleRecoveryOutcome[];
const COMPRESSION_OUTCOMES: Readonly<Record<CompressionOutcome, true>> = {
  compressed: true,
  below_threshold: true,
  not_smaller: true,
  write_over_limit: true,
  decompressed: true,
  fallback_raw: true,
  read_over_limit: true,
};
const compressionOutcomes = Object.keys(COMPRESSION_OUTCOMES) as CompressionOutcome[];
const metricLayers: readonly MetricLayer[] = [
  CacheLayer.LOCAL,
  CacheLayer.REMOTE,
  REMOTE_SHADOW_CACHE_LAYER,
  REQUEST_LOCAL_CACHE_LAYER,
  NO_CACHE_LAYER,
];

describe("Datadog metrics adapter", () => {
  it("maps every DialCache metric to the default metric namespace with exact names, values, and tags", () => {
    const client = new RecordingDogStatsDClient();
    const metrics = new DatadogDialCacheMetrics({ client, observationMetricType: "distribution" });

    metrics.request(cacheLabels);
    metrics.miss(cacheLabels);
    metrics.disabled({ ...cacheLabels, reason: "ramped_down" });
    metrics.error({ ...cacheLabels, error: "cache_read", inFallback: true });
    metrics.invalidation({ cacheNamespace: cacheLabels.cacheNamespace, keyType: "user_id", layer: CacheLayer.REMOTE });
    metrics.coalesced({
      cacheNamespace: cacheLabels.cacheNamespace,
      useCase: "LoadUser",
      keyType: "user_id",
      scope: "process",
    });
    metrics.shadowValidation({
      cacheNamespace: cacheLabels.cacheNamespace,
      useCase: "LoadUser",
      keyType: "user_id",
      outcome: "match",
    });
    metrics.staleRecovery({
      cacheNamespace: cacheLabels.cacheNamespace,
      useCase: "LoadUser",
      keyType: "user_id",
      outcome: "served",
    });
    metrics.observeShadowValueAge(
      {
        cacheNamespace: cacheLabels.cacheNamespace,
        useCase: "LoadUser",
        keyType: "user_id",
        outcome: "mismatch",
      },
      42.5,
    );
    metrics.compression({ ...cacheLabels, outcome: "compressed" });
    metrics.observeGet(cacheLabels, 0.125);
    metrics.observeFallback(cacheLabels, 0.5);
    metrics.observeSerialization({ ...cacheLabels, operation: "dump" }, 0.25);
    metrics.observeSize(cacheLabels, 4_096);
    metrics.observeStoredSize(cacheLabels, 2_048);
    metrics.observeCompressionRatio(cacheLabels, 0.35);
    metrics.observeCompression({ ...cacheLabels, operation: "compress" }, 0.002);

    const baseTags = { cache_namespace: "users", use_case: "LoadUser", key_type: "user_id", layer: "local" };
    expect(client.calls).toEqual([
      { method: "increment", name: "dialcache.request.count", value: 1, tags: baseTags },
      { method: "increment", name: "dialcache.miss.count", value: 1, tags: baseTags },
      {
        method: "increment",
        name: "dialcache.disabled.count",
        value: 1,
        tags: { ...baseTags, reason: "ramped_down" },
      },
      {
        method: "increment",
        name: "dialcache.error.count",
        value: 1,
        tags: { ...baseTags, error: "cache_read", in_fallback: "true" },
      },
      {
        method: "increment",
        name: "dialcache.invalidation.count",
        value: 1,
        tags: { cache_namespace: "users", key_type: "user_id", layer: "remote" },
      },
      {
        method: "increment",
        name: "dialcache.coalesced.count",
        value: 1,
        tags: { cache_namespace: "users", use_case: "LoadUser", key_type: "user_id", scope: "process" },
      },
      {
        method: "increment",
        name: "dialcache.shadow.count",
        value: 1,
        tags: { cache_namespace: "users", use_case: "LoadUser", key_type: "user_id", outcome: "match" },
      },
      {
        method: "increment",
        name: "dialcache.stale_recovery.count",
        value: 1,
        tags: { cache_namespace: "users", use_case: "LoadUser", key_type: "user_id", outcome: "served" },
      },
      {
        method: "distribution",
        name: "dialcache.shadow.value_age",
        value: 42.5,
        tags: { cache_namespace: "users", use_case: "LoadUser", key_type: "user_id", outcome: "mismatch" },
      },
      {
        method: "increment",
        name: "dialcache.compression.count",
        value: 1,
        tags: { ...baseTags, outcome: "compressed" },
      },
      { method: "distribution", name: "dialcache.get.duration", value: 0.125, tags: baseTags },
      { method: "distribution", name: "dialcache.fallback.duration", value: 0.5, tags: baseTags },
      {
        method: "distribution",
        name: "dialcache.serialization.duration",
        value: 0.25,
        tags: { ...baseTags, operation: "dump" },
      },
      { method: "distribution", name: "dialcache.serialization.size", value: 4_096, tags: baseTags },
      { method: "distribution", name: "dialcache.stored.size", value: 2_048, tags: baseTags },
      { method: "distribution", name: "dialcache.compression.ratio", value: 0.35, tags: baseTags },
      {
        method: "distribution",
        name: "dialcache.compression.duration",
        value: 0.002,
        tags: { ...baseTags, operation: "compress" },
      },
    ]);
    expect(client.flush).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });

  for (const observationMetricType of observationMetricTypes) {
    it(`uses ${observationMetricType} for every observation, so switching modes requires a new namespace`, () => {
      const client = new RecordingDogStatsDClient();
      const metrics = new DatadogDialCacheMetrics({
        client,
        namespace: "service.cache",
        observationMetricType,
      });

      metrics.observeGet(cacheLabels, 0.01);
      metrics.observeFallback(cacheLabels, 0.02);
      metrics.observeSerialization({ ...cacheLabels, operation: "load" }, 0.03);
      metrics.observeSize(cacheLabels, 128);
      metrics.observeStoredSize(cacheLabels, 96);
      metrics.observeCompressionRatio(cacheLabels, 0.04);
      metrics.observeCompression({ ...cacheLabels, operation: "decompress" }, 0.05);
      metrics.observeShadowValueAge(
        {
          cacheNamespace: cacheLabels.cacheNamespace,
          useCase: cacheLabels.useCase,
          keyType: cacheLabels.keyType,
          outcome: "match",
        },
        60,
      );

      expect(client.calls.map(({ method, name, value }) => ({ method, name, value }))).toEqual([
        { method: observationMetricType, name: "service.cache.get.duration", value: 0.01 },
        { method: observationMetricType, name: "service.cache.fallback.duration", value: 0.02 },
        { method: observationMetricType, name: "service.cache.serialization.duration", value: 0.03 },
        { method: observationMetricType, name: "service.cache.serialization.size", value: 128 },
        { method: observationMetricType, name: "service.cache.stored.size", value: 96 },
        { method: observationMetricType, name: "service.cache.compression.ratio", value: 0.04 },
        { method: observationMetricType, name: "service.cache.compression.duration", value: 0.05 },
        { method: observationMetricType, name: "service.cache.shadow.value_age", value: 60 },
      ]);
    });
  }

  it("forwards every bounded label value without rewriting it", () => {
    const client = new RecordingDogStatsDClient();
    const metrics = new DatadogDialCacheMetrics({ client, observationMetricType: "distribution" });

    for (const layer of metricLayers) {
      metrics.request({ ...cacheLabels, layer });
    }
    for (const reason of disabledReasons) {
      metrics.disabled({ ...cacheLabels, reason });
    }
    for (const error of errorKinds) {
      metrics.error({ ...cacheLabels, error, inFallback: false });
      metrics.error({ ...cacheLabels, error, inFallback: true });
    }
    for (const operation of ["dump", "load"] as const) {
      metrics.observeSerialization({ ...cacheLabels, operation }, 1);
    }
    for (const scope of ["request_local", "process"] as const) {
      metrics.coalesced({
        cacheNamespace: cacheLabels.cacheNamespace,
        useCase: cacheLabels.useCase,
        keyType: cacheLabels.keyType,
        scope,
      });
    }
    for (const outcome of shadowValidationOutcomes) {
      metrics.shadowValidation({
        cacheNamespace: cacheLabels.cacheNamespace,
        useCase: cacheLabels.useCase,
        keyType: cacheLabels.keyType,
        outcome,
      });
    }
    for (const outcome of staleRecoveryOutcomes) {
      metrics.staleRecovery({
        cacheNamespace: cacheLabels.cacheNamespace,
        useCase: cacheLabels.useCase,
        keyType: cacheLabels.keyType,
        outcome,
      });
    }
    for (const outcome of compressionOutcomes) {
      metrics.compression({ ...cacheLabels, outcome });
    }

    expect(client.calls.slice(0, metricLayers.length).map(({ tags }) => tags.layer)).toEqual(metricLayers);
    expect(
      client.calls
        .filter(({ name }) => name === "dialcache.disabled.count")
        .map(({ tags }) => tags.reason),
    ).toEqual(disabledReasons);
    expect(
      client.calls
        .filter(({ name }) => name === "dialcache.error.count")
        .map(({ tags }) => [tags.error, tags.in_fallback]),
    ).toEqual(errorKinds.flatMap((error) => [[error, "false"], [error, "true"]]));
    expect(
      client.calls
        .filter(({ name }) => name === "dialcache.serialization.duration")
        .map(({ tags }) => tags.operation),
    ).toEqual(["dump", "load"]);
    expect(
      client.calls
        .filter(({ name }) => name === "dialcache.coalesced.count")
        .map(({ tags }) => tags.scope),
    ).toEqual(["request_local", "process"]);
    expect(
      client.calls
        .filter(({ name }) => name === "dialcache.shadow.count")
        .map(({ tags }) => tags),
    ).toEqual(
      shadowValidationOutcomes.map((outcome) => ({
        cache_namespace: cacheLabels.cacheNamespace,
        use_case: cacheLabels.useCase,
        key_type: cacheLabels.keyType,
        outcome,
      })),
    );
    expect(
      client.calls
        .filter(({ name }) => name === "dialcache.stale_recovery.count")
        .map(({ tags }) => tags),
    ).toEqual(
      staleRecoveryOutcomes.map((outcome) => ({
        cache_namespace: cacheLabels.cacheNamespace,
        use_case: cacheLabels.useCase,
        key_type: cacheLabels.keyType,
        outcome,
      })),
    );
    expect(
      client.calls
        .filter(({ name }) => name === "dialcache.compression.count")
        .map(({ tags }) => tags.outcome),
    ).toEqual(compressionOutcomes);
  });

  it("accepts hot-shots directly and emits DogStatsD distribution datagrams", () => {
    const client = new StatsD({ mock: true, includeDataDogTags: false });
    const compatibleClient: DatadogDogStatsDClient = client;
    const metrics = createDatadogDialCacheMetrics({
      client: compatibleClient,
      observationMetricType: "distribution",
    });

    metrics.request(cacheLabels);
    metrics.observeGet(cacheLabels, 0.25);

    expect(client.mockBuffer).toEqual([
      "dialcache.request.count:1|c|#cache_namespace:users,use_case:LoadUser,key_type:user_id,layer:local",
      "dialcache.get.duration:0.25|d|#cache_namespace:users,use_case:LoadUser,key_type:user_id,layer:local",
    ]);
  });

  it("emits hot-shots histogram datagrams when explicitly selected", () => {
    const client = new StatsD({ mock: true, includeDataDogTags: false });
    const metrics = new DatadogDialCacheMetrics({ client, observationMetricType: "histogram" });

    metrics.observeSize(cacheLabels, 256);

    expect(client.mockBuffer).toEqual([
      "dialcache.serialization.size:256|h|#cache_namespace:users,use_case:LoadUser,key_type:user_id,layer:local",
    ]);
  });

  it("creates the public class through the factory", () => {
    const client = new RecordingDogStatsDClient();

    const metrics = createDatadogDialCacheMetrics({ client, observationMetricType: "distribution" });

    expect(metrics).toBeInstanceOf(DatadogDialCacheMetrics);
  });

  it("fails open when the DogStatsD client throws synchronously", async () => {
    const unavailable = (): never => {
      throw new Error("DogStatsD unavailable");
    };
    const client: DatadogDogStatsDClient = {
      increment: unavailable,
      histogram: unavailable,
      distribution: unavailable,
    };
    const dialcache = new DialCache({
      metrics: createDatadogDialCacheMetrics({ client, observationMetricType: "distribution" }),
    });
    let calls = 0;
    const load = dialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
      keyType: "id",
      useCase: "DatadogFailOpen",
      cacheKey: (id) => id,
      defaultConfig: localOnly(),
    });

    const first = await dialcache.enable(async () => await load("123"));
    const second = await dialcache.enable(async () => await load("123"));

    expect(first).toEqual({ id: "123", calls: 1 });
    expect(second).toEqual({ id: "123", calls: 1 });
  });

  it("propagates a shadow metric thenable at runtime for DialCache to consume", async () => {
    const metricError = new Error("DogStatsD async failure");
    const client = {
      increment: async () => {
        throw metricError;
      },
      histogram: () => undefined,
      distribution: () => undefined,
    } satisfies DatadogDogStatsDClient;
    const metrics = new DatadogDialCacheMetrics({ client, observationMetricType: "distribution" });

    const returned = metrics.shadowValidation({
      cacheNamespace: "users",
      useCase: "AsyncShadowMetric",
      keyType: "user_id",
      outcome: "match",
    }) as unknown as Promise<void>;

    await expect(returned).rejects.toBe(metricError);
  });

  it("never emits cache ids, arguments, Redis keys, or raw errors as Datadog tags", async () => {
    const client = new RecordingDogStatsDClient();
    const metrics = createDatadogDialCacheMetrics({ client, observationMetricType: "distribution" });
    const cacheId = "tenant-secret-123";
    const argument = "private-filter-456";
    const rawErrorName = "TenantSecretRedisError";
    const rawErrorMessage = "Redis failed for a private cache key";
    let redisValueKey = "";
    const redis: DialCacheRedisClient = {
      enforcesMaxAge: true,
      read: async ({ valueKey }) => {
        redisValueKey = valueKey;
        const error = new Error(`${rawErrorMessage}: ${valueKey}`);
        error.name = rawErrorName;
        throw error;
      },
      write: async () => true,
      invalidate: async () => undefined,
    };
    const dialcache = new DialCache({
      namespace: "private-cache",
      metrics,
      redis: { client: redis, readTimeoutMs: 1_000 },
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const load = dialcache.cached(async (id: string, filter: string) => ({ id, filter }), {
      keyType: "user_id",
      useCase: "DatadogBoundedTags",
      cacheKey: (id, filter) => ({ id, args: { filter } }),
      defaultConfig: remoteOnly(),
    });

    await expect(dialcache.enable(async () => await load(cacheId, argument))).resolves.toEqual({
      id: cacheId,
      filter: argument,
    });

    const emitted = JSON.stringify(client.calls);
    expect(redisValueKey).not.toBe("");
    for (const sensitiveValue of [cacheId, argument, redisValueKey, rawErrorName, rawErrorMessage]) {
      expect(emitted).not.toContain(sensitiveValue);
    }
    expect(client.calls).toContainEqual({
      method: "increment",
      name: "dialcache.error.count",
      value: 1,
      tags: {
        cache_namespace: "private-cache",
        use_case: "DatadogBoundedTags",
        key_type: "user_id",
        layer: "remote",
        error: "cache_read",
        in_fallback: "false",
      },
    });
  });

  it("requires an explicit observation metric type", () => {
    const client = new RecordingDogStatsDClient();

    for (const observationMetricType of [undefined, "timer"] as const) {
      expect(
        () =>
          new DatadogDialCacheMetrics({
            client,
            observationMetricType,
          } as unknown as DatadogMetricsOptions),
      ).toThrowError('Datadog observationMetricType must be either "histogram" or "distribution".');
    }
  });

  it("validates every required DogStatsD method before emitting metrics", () => {
    const methods = ["increment", "histogram", "distribution"] as const;

    expect(
      () =>
        new DatadogDialCacheMetrics({
          client: null,
          observationMetricType: "distribution",
        } as unknown as DatadogMetricsOptions),
    ).toThrowError("Datadog metrics client must be an object.");

    for (const missing of methods) {
      const client = new RecordingDogStatsDClient() as unknown as Record<string, unknown>;
      client[missing] = undefined;

      expect(
        () =>
          new DatadogDialCacheMetrics({
            client,
            observationMetricType: "distribution",
          } as unknown as DatadogMetricsOptions),
      ).toThrowError(`Datadog metrics client must implement ${missing}().`);
    }
  });

  it("rejects invalid options and namespaces instead of rewriting them", () => {
    const client = new RecordingDogStatsDClient();
    const invalidNamespaces = [
      "",
      "1dialcache",
      "dial-cache",
      ".dialcache",
      "dialcache.",
      "dialcache..prod",
      "dialcache/prod",
      null,
      123,
    ] as const;

    expect(() => new DatadogDialCacheMetrics(null as unknown as DatadogMetricsOptions)).toThrowError(
      "Datadog metrics options must be an object.",
    );
    for (const namespace of invalidNamespaces) {
      expect(
        () =>
          new DatadogDialCacheMetrics({
            client,
            namespace,
            observationMetricType: "distribution",
          } as unknown as DatadogMetricsOptions),
      ).toThrowError(
        "Datadog namespace must start with a letter and contain only letters, numbers, underscores, " +
          "and dot-separated non-empty segments.",
      );
    }
  });

  it("enforces Datadog's 200-character final metric-name limit", () => {
    const client = new RecordingDogStatsDClient();
    const longestValidNamespace = "a".repeat(177);
    const tooLongNamespace = "a".repeat(178);
    const metrics = new DatadogDialCacheMetrics({
      client,
      namespace: longestValidNamespace,
      observationMetricType: "distribution",
    });

    metrics.observeSerialization({ ...cacheLabels, operation: "dump" }, 1);

    expect(client.calls[0]?.name).toHaveLength(200);
    expect(
      () =>
        new DatadogDialCacheMetrics({
          client,
          namespace: tooLongNamespace,
          observationMetricType: "distribution",
        }),
    ).toThrowError(RangeError);
  });
});

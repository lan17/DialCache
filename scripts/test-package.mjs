import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = await mkdtemp(join(tmpdir(), "dialcache-package-"));
const fallbackTimeoutMarker = "dialcache-fallback-timeout-delivered";
const observerIsolationMarker = "dialcache-observer-rejections-isolated";
const shadowPayloadReleaseMarker = "dialcache-shadow-payload-released";
const rootConsumer = `import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  DialCacheRedisProtocolError,
  FallbackTimeoutError,
  JsonSerializer,
  RedisReadTimeoutError,
  type CacheMetricLabels,
  type CacheConfigProvider,
  type CachedOptions,
  type CoalescedMetricLabels,
  type CoalescingScope,
  type CoalescingState,
  type DialCacheConfig,
  type DialCacheKeyInit,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type DisabledReason,
  type GetOrLoadOptions,
  type InvalidationMetricLabels,
  type MetricErrorKind,
  type MetricLayer,
  type ProcessCoalescingState,
  type RedisConfig,
  type RedisInvalidationRequest,
  type RedisReadContext,
  type RedisWriteRequest,
  type Serializer,
  type ShadowComparator,
  type ShadowConfig,
  type ShadowValidationMetricLabels,
  type ShadowValidationOutcome,
} from "dialcache";
// @ts-expect-error The unused MissingKeyConfigError class was removed instead of deprecated.
import { MissingKeyConfigError } from "dialcache";
import { DialCacheRedisPlaceholderLostError } from "dialcache";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "dialcache/node-redis";
import {
  decodeRedisFrame,
  decodeTrackedRedisFrame,
  encodeRedisFrame,
  encodeTrackedRedisPlaceholder,
  resolveTrackedRedisWriteReply,
  validateRedisSetReply,
  WRITE_TRACKED_STAMP_SCRIPT,
  type TrackedRedisPlaceholder,
} from "dialcache/redis-protocol";
// @ts-expect-error The codec functions replaced the frame-version wire constant.
import { REDIS_FRAME_VERSION } from "dialcache/redis-protocol";
// @ts-expect-error The codec functions replaced the UTF-8 encoding wire constant.
import { REDIS_ENCODING_UTF8 } from "dialcache/redis-protocol";
// @ts-expect-error The codec functions replaced the binary encoding wire constant.
import { REDIS_ENCODING_BINARY } from "dialcache/redis-protocol";
// @ts-expect-error Read Lua sources were removed from the mutation-only Redis protocol.
import { READ_CACHE_SCRIPT } from "dialcache/redis-protocol";
// @ts-expect-error Tracked read Lua was removed from the mutation-only Redis protocol.
import { READ_TRACKED_CACHE_SCRIPT } from "dialcache/redis-protocol";
// @ts-expect-error The untracked write Lua was replaced by a native client-framed SET.
import { WRITE_CACHE_SCRIPT } from "dialcache/redis-protocol";
// @ts-expect-error The tracked write Lua was replaced by a native SET plus the stamp script.
import { WRITE_TRACKED_CACHE_SCRIPT } from "dialcache/redis-protocol";
import {
  DatadogDialCacheMetrics,
  createDatadogDialCacheMetrics,
  type DatadogDogStatsDClient,
  type DatadogMetricsOptions,
  type DatadogObservationMetricType,
} from "dialcache/datadog";

const optionsFor = (useCase: string) => ({
  keyType: "id",
  useCase,
  cacheKey: (id: string) => id,
});
const inlineOptionsFor = (useCase: string, key = "1") => ({
  keyType: "id",
  useCase,
  key,
});
const metrics: DialCacheMetricsAdapter = {
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
const shadowMetrics: DialCacheMetricsAdapter = {
  ...metrics,
  shadowValidation: (labels: ShadowValidationMetricLabels) => {
    const outcome: ShadowValidationOutcome = labels.outcome;
    void outcome;
  },
};
const shadowOutcomes: Readonly<Record<ShadowValidationOutcome, true>> = {
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
void shadowOutcomes;
const metricLayers: Readonly<Record<MetricLayer, true>> = {
  [CacheLayer.LOCAL]: true,
  [CacheLayer.REMOTE]: true,
  remote_shadow: true,
  request_local: true,
  noop: true,
};
void metricLayers;
const shadowCacheConfig: DialCacheConfig = {
  namespace: "consumer-shadow-cache",
  metrics: shadowMetrics,
  shadowMaxInFlight: 2,
};
const shadowCache = new DialCache(shadowCacheConfig);
const shadowConfig: ShadowConfig = {
  ramp: 50,
  logMismatches: true,
};
const shadowKeyConfig = new DialCacheKeyConfig({ shadow: shadowConfig });
const dogStatsDClient: DatadogDogStatsDClient = {
  increment: () => undefined,
  histogram: () => undefined,
  distribution: () => undefined,
};
const datadogObservationMetricType: DatadogObservationMetricType = "distribution";
const datadogOptions: DatadogMetricsOptions = {
  client: dogStatsDClient,
  observationMetricType: datadogObservationMetricType,
};
const datadogMetrics = createDatadogDialCacheMetrics(datadogOptions);
const datadogClassAdapter = new DatadogDialCacheMetrics(datadogOptions);
// @ts-expect-error The observation type is an explicit, required choice.
const missingObservationType: DatadogMetricsOptions = { client: dogStatsDClient };
const cache = new DialCache({ namespace: "consumer-cache", metrics });
const redisProtocolError = new DialCacheRedisProtocolError("Invalid DialCache Redis write reply");
const emptyRedisFrame = Buffer.alloc(10);
emptyRedisFrame[0] = 1;
emptyRedisFrame.writeBigUInt64BE(1n, 1);
const decodedEmptyRedisPayload: string | Buffer | null = decodeRedisFrame(emptyRedisFrame);
const decodedStaleRedisPayload: string | Buffer | null = decodeTrackedRedisFrame(
  emptyRedisFrame,
  Buffer.from("1"),
);
const placeholderRedisFrame: Buffer = encodeRedisFrame("pending", 0);
const trackedRedisPlaceholder: TrackedRedisPlaceholder = encodeTrackedRedisPlaceholder("pending");
const stampReplyResolution: boolean = resolveTrackedRedisWriteReply(1);
const setReplyValidation: void = validateRedisSetReply("OK");
const placeholderLostError = new DialCacheRedisPlaceholderLostError("lost");
const stampScriptSource: string = WRITE_TRACKED_STAMP_SCRIPT;
const stampArguments: Array<string | Buffer> = dialcacheRedisScripts.dialcacheWriteTrackedStamp.transformArguments(
  "tracked:{id}:value",
  "tracked:{id}:watermark",
  1_000,
  trackedRedisPlaceholder.nonce,
);
const fallbackTimeoutError = new FallbackTimeoutError("Load", 1_000);
const redisReadTimeoutError = new RedisReadTimeoutError("Load", 100);
const coalescingState: CoalescingState = cache.getCoalescingState();
const processCoalescingState: ProcessCoalescingState = coalescingState.process;
const disabledOverlay: DialCacheKeyConfig = DialCacheKeyConfig.disabled();
const stringShadowComparator: ShadowComparator<string> = (cachedValue, sourceValue) =>
  cachedValue === sourceValue;
const load = cache.cached(async (id: string) => id, {
  keyType: "id",
  useCase: "Load",
  cacheKey: (id) => id,
  fallbackTimeoutMs: 1_000,
  shadowComparator: stringShadowComparator,
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 100 },
    remoteReadTimeoutMs: 100,
  }),
});
const loadWithoutFallbackDeadline = cache.cached(async (id: string) => id, {
  keyType: "id",
  useCase: "LoadWithoutFallbackDeadline",
  cacheKey: (id) => id,
  fallbackTimeoutMs: null,
});
const inlineSync: Promise<{ readonly id: string }> = cache.getOrLoad(
  () => ({ id: "sync" as const }),
  inlineOptionsFor("InlineSync"),
);
const inlineAsync: Promise<{ readonly id: string }> = cache.getOrLoad(
  async () => ({ id: "async" as const }),
  {
    ...inlineOptionsFor("InlineAsync"),
    shadowComparator: (cachedValue, sourceValue) => cachedValue.id === sourceValue.id,
  },
);

interface JsonCompatibleRecord {
  readonly id: string;
  readonly nested: { readonly enabled: boolean; readonly scores: readonly number[] };
  readonly nickname?: string;
}

const loadJsonRecord = cache.cached(
  async (id: string): Promise<JsonCompatibleRecord> => ({ id, nested: { enabled: true, scores: [1, 2] } }),
  optionsFor("JsonCompatibleRecord"),
);
const loadEmptyObject = cache.cached(async (_id: string) => ({}), optionsFor("EmptyObject"));
const loadUndefined = cache.cached(async (_id: string) => undefined, optionsFor("TopLevelUndefined"));
const loadVoid = cache.cached(async (_id: string): Promise<void> => undefined, optionsFor("TopLevelVoid"));

const dateSerializer: Serializer<Date> = {
  dump: (value) => value.toISOString(),
  load: (value) => new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value),
};
const loadDate = cache.cached(async (_id: string) => new Date(0), {
  ...optionsFor("DateWithSerializer"),
  serializer: dateSerializer,
});
const loadDateWithTrustedJsonAssertion = cache.cached(async (_id: string) => new Date(0), {
  ...optionsFor("DateWithTrustedJsonAssertion"),
  serializer: new JsonSerializer<Date>(),
});
type DateLoader = (id: string) => Promise<Date>;
const dateOptions: CachedOptions<DateLoader> = {
  ...optionsFor("TypedDateOptions"),
  serializer: dateSerializer,
};
const inlineDateOptions: GetOrLoadOptions<Date> = {
  ...inlineOptionsFor("InlineDateWithSerializer"),
  serializer: dateSerializer,
};
const inlineDate: Promise<Date> = cache.getOrLoad(async () => new Date(0), inlineDateOptions);

class MethodBearingValue {
  constructor(readonly id: string) {}
  label(): string {
    return this.id;
  }
}

// @ts-expect-error Date needs an explicit serializer.
cache.cached(async (_id: string) => new Date(0), optionsFor("DateWithoutSerializer"));
// @ts-expect-error Map needs an explicit serializer.
cache.cached(async (_id: string) => new Map<string, string>(), optionsFor("MapWithoutSerializer"));
// @ts-expect-error Set needs an explicit serializer.
cache.cached(async (_id: string) => new Set<string>(), optionsFor("SetWithoutSerializer"));
// @ts-expect-error bigint needs an explicit serializer.
cache.cached(async (_id: string) => 1n, optionsFor("BigIntWithoutSerializer"));
// @ts-expect-error Functions need an explicit serializer.
cache.cached(async (_id: string) => (value: string) => value, optionsFor("FunctionWithoutSerializer"));
// @ts-expect-error Symbols need an explicit serializer.
cache.cached(async (_id: string) => Symbol("value"), optionsFor("SymbolWithoutSerializer"));
// @ts-expect-error Required nested undefined is not preserved by JSON.
cache.cached(async (_id: string): Promise<{ value: string | undefined }> => ({ value: undefined }), optionsFor("NestedUndefinedWithoutSerializer"));
// @ts-expect-error unknown cannot establish JSON compatibility.
cache.cached(async (_id: string): Promise<unknown> => ({ id: "unknown" }), optionsFor("UnknownWithoutSerializer"));
// @ts-expect-error any cannot establish JSON compatibility.
cache.cached(async (_id: string): Promise<any> => ({ id: "any" }), optionsFor("AnyWithoutSerializer"));
// @ts-expect-error Buffer needs an explicit serializer.
cache.cached(async (_id: string) => Buffer.from("value"), optionsFor("BufferWithoutSerializer"));
// @ts-expect-error Typed arrays need an explicit serializer.
cache.cached(async (_id: string) => new Uint8Array([1, 2]), optionsFor("TypedArrayWithoutSerializer"));
// @ts-expect-error Method-bearing class instances need an explicit serializer.
cache.cached(async (id: string) => new MethodBearingValue(id), optionsFor("ClassWithoutSerializer"));
// @ts-expect-error CachedOptions itself requires a serializer for Date values.
const missingDateSerializer: CachedOptions<DateLoader> = optionsFor("TypedDateOptionsWithoutSerializer");
// @ts-expect-error getOrLoad requires an explicit serializer for an inferred Date value.
cache.getOrLoad(async () => new Date(0), inlineOptionsFor("InlineDateWithoutSerializer"));
// @ts-expect-error GetOrLoadOptions itself requires a serializer for Date values.
const missingInlineDateSerializer: GetOrLoadOptions<Date> = inlineOptionsFor("TypedInlineDateWithoutSerializer");
cache.cached(async (id: string) => id, {
  ...optionsFor("InvalidShadowComparatorValueType"),
  // @ts-expect-error Shadow comparators receive the cached function's resolved value type.
  shadowComparator: (cachedValue: number, sourceValue: number) => cachedValue === sourceValue,
});
cache.cached(async (id: string) => id, {
  ...optionsFor("InvalidAsyncShadowComparator"),
  // @ts-expect-error Shadow comparators must return a boolean synchronously.
  shadowComparator: async (cachedValue, sourceValue) => cachedValue === sourceValue,
});

const requestLocalConfig = new DialCacheKeyConfig({ requestLocal: true });
const uncoalescedConfig = new DialCacheKeyConfig({ coalesce: false });
const coalesceFlag: boolean | undefined = uncoalescedConfig.coalesce;
const structuralConfigProvider: CacheConfigProvider = () => ({
  ttlSec: { [CacheLayer.LOCAL]: 60 },
  ramp: { [CacheLayer.LOCAL]: 100 },
});
const requestLocalCoalescingLabels: CoalescedMetricLabels = {
  cacheNamespace: "consumer-cache",
  useCase: "Load",
  keyType: "id",
  scope: "request_local",
};
const cacheMetricLabels: CacheMetricLabels = {
  cacheNamespace: "consumer-cache",
  useCase: "Load",
  keyType: "id",
  layer: CacheLayer.LOCAL,
};
const invalidationMetricLabels: InvalidationMetricLabels = {
  cacheNamespace: "consumer-cache",
  keyType: "id",
  layer: CacheLayer.REMOTE,
};
const keyInit: DialCacheKeyInit = {
  namespace: "consumer-cache",
  keyType: "id",
  id: "123",
  useCase: "Load",
};
const keyInitHasNoUrnPrefix: "urnPrefix" extends keyof DialCacheKeyInit ? false : true = true;
// @ts-expect-error DialCacheKeyInit.urnPrefix was renamed to namespace.
const legacyKeyInit: DialCacheKeyInit = { keyType: "id", id: "123", useCase: "Load", urnPrefix: "consumer-cache" };
const namespacedKey = new DialCacheKey(keyInit);
const requestLocalCoalescingScope: CoalescingScope = "request_local";
const boundedErrorKind: MetricErrorKind = "cache_read_timeout";
const disabledReasons: Readonly<Record<DisabledReason, true>> = {
  context: true,
  policy_disabled: true,
  invalid_ttl: true,
  invalid_ramp: true,
  ramped_down: true,
  config_error: true,
};
// @ts-expect-error Missing configuration now means the documented disabled policy, not a separate reason.
const legacyMissingConfigReason: DisabledReason = "missing_config";
const metricErrorKinds: Readonly<Record<MetricErrorKind, true>> = {
  key_construction: true,
  config_resolution: true,
  cache_read: true,
  cache_read_timeout: true,
  cache_write: true,
  serialization_load: true,
  serialization_dump: true,
  invalidation: true,
  fallback: true,
  unknown: true,
};
// @ts-expect-error Arbitrary exception names are not DialCache metric error categories.
const unboundedErrorKind: MetricErrorKind = "Tenant123Error";

const customRedisClient: DialCacheRedisClient = {
  // The optional second read argument preserves one-argument custom clients.
  read: async () => Buffer.from([0, 255]),
  write: async ({ value }) => typeof value === "string" || Buffer.isBuffer(value),
  invalidate: async () => undefined,
};
const redisClientMethods: Readonly<Record<keyof DialCacheRedisClient, true>> = {
  read: true,
  write: true,
  invalidate: true,
};
void redisClientMethods;
const cacheHasNoFlushAll: "flushAll" extends keyof DialCache ? false : true = true;
const cacheHasNoClose: "close" extends keyof DialCache ? false : true = true;
const clientHasNoFlushAll: "flushAll" extends keyof DialCacheRedisClient ? false : true = true;
type TrackedRedisWriteRequest = Extract<RedisWriteRequest, { readonly watermarkKey: string }>;
const trackedWriteHasNoWatermarkTtlFloor: "watermarkTtlFloorMs" extends keyof TrackedRedisWriteRequest
  ? false
  : true = true;
const invalidationHasNoWatermarkTtlFloor: "watermarkTtlFloorMs" extends keyof RedisInvalidationRequest
  ? false
  : true = true;
const legacyTrackedWriteRequest: RedisWriteRequest = {
  valueKey: "tracked:{id}:value",
  watermarkKey: "tracked:{id}:watermark",
  cacheTtlMs: 1_000,
  value: "tracked",
  // @ts-expect-error Watermark lifetime is derived by the Redis invalidation protocol.
  watermarkTtlFloorMs: 1_000,
};
const legacyInvalidationRequest: RedisInvalidationRequest = {
  watermarkKey: "tracked:{id}:watermark",
  futureBufferMs: 0,
  // @ts-expect-error Watermark lifetime is derived by the Redis invalidation protocol.
  watermarkTtlFloorMs: 1_000,
};
const configHasNoMetricsRegistry: "metricsRegistry" extends keyof DialCacheConfig ? false : true = true;
const configHasNoMetricsPrefix: "metricsPrefix" extends keyof DialCacheConfig ? false : true = true;
const configRejectsFalseMetrics: false extends NonNullable<DialCacheConfig["metrics"]> ? false : true = true;
const configHasNamespace: "namespace" extends keyof DialCacheConfig ? true : false = true;
const configHasNoUrnPrefix: "urnPrefix" extends keyof DialCacheConfig ? false : true = true;
// @ts-expect-error urnPrefix was renamed to namespace.
const legacyNamespaceConfig: DialCacheConfig = { urnPrefix: "consumer-cache" };
const configHasNoRampSampler: "rampSampler" extends keyof DialCacheConfig ? false : true = true;
// @ts-expect-error Ramp assignment is owned internally by DialCache.
const legacyRampSamplerConfig: DialCacheConfig = { rampSampler: () => 0 };
const redisConfigHasNoKeyPrefix: "keyPrefix" extends keyof RedisConfig ? false : true = true;
// @ts-expect-error keyPrefix was removed in favor of DialCacheConfig.namespace.
const legacyKeyPrefixConfig: RedisConfig = { client: customRedisClient, readTimeoutMs: 100, keyPrefix: "legacy:" };
const redisConfigRequiresClient: {} extends Pick<RedisConfig, "client"> ? false : true = true;
const redisConfigAllowsDefaultReadTimeout: {} extends Pick<RedisConfig, "readTimeoutMs"> ? true : false = true;
const redisConfigHasNoCreateClient: "createClient" extends keyof RedisConfig ? false : true = true;
const redisConfigHasNoWatermarkTtlSec: "watermarkTtlSec" extends keyof RedisConfig ? false : true = true;
// @ts-expect-error Redis requires a caller-owned client.
const missingRedisClientConfig: RedisConfig = {};
const defaultRedisReadTimeoutConfig: RedisConfig = { client: customRedisClient };
// @ts-expect-error createClient was removed; construct and pass RedisConfig.client instead.
const legacyRedisFactoryConfig: RedisConfig = { createClient: () => customRedisClient };
// @ts-expect-error Watermark lifetime is derived internally by DialCache.
const legacyWatermarkTtlConfig: RedisConfig = { client: customRedisClient, watermarkTtlSec: 60 };
const redisReadContext: RedisReadContext = {
  timeoutMs: 100,
  signal: new AbortController().signal,
};
// @ts-expect-error RedisClientFactory was removed with RedisConfig.createClient.
type LegacyRedisClientFactory = import("dialcache").RedisClientFactory;
// @ts-expect-error CacheRampSampler was removed with the public sampler override.
type LegacyCacheRampSampler = import("dialcache").CacheRampSampler;
// @ts-expect-error CacheRampSample was removed with the public sampler override.
type LegacyCacheRampSample = import("dialcache").CacheRampSample;
type DialCacheRoot = typeof import("dialcache");
const rootHasNoDefaultWatermarkTtlSec: "DEFAULT_WATERMARK_TTL_SEC" extends keyof DialCacheRoot ? false : true = true;
const rootHasNoPrometheusFactory: "createPrometheusDialCacheMetrics" extends keyof DialCacheRoot ? false : true = true;
const rootHasNoDatadogFactory: "createDatadogDialCacheMetrics" extends keyof DialCacheRoot ? false : true = true;
const rootHasNoDeterministicRampSampler: "deterministicRampSampler" extends keyof DialCacheRoot ? false : true = true;
const rootHasNoRandomRampSampler: "randomRampSampler" extends keyof DialCacheRoot ? false : true = true;

void load;
void loadWithoutFallbackDeadline;
void inlineSync;
void inlineAsync;
void loadJsonRecord;
void loadEmptyObject;
void loadUndefined;
void loadVoid;
void loadDate;
void loadDateWithTrustedJsonAssertion;
void dateOptions;
void inlineDateOptions;
void inlineDate;
void missingDateSerializer;
void missingInlineDateSerializer;
void requestLocalConfig;
void uncoalescedConfig;
void coalesceFlag;
void structuralConfigProvider;
void shadowCache;
void shadowKeyConfig;
void requestLocalCoalescingLabels;
void cacheMetricLabels;
void invalidationMetricLabels;
void keyInitHasNoUrnPrefix;
void legacyKeyInit;
void namespacedKey.namespace;
void redisProtocolError.name;
void fallbackTimeoutError.timeoutMs;
void redisReadTimeoutError.timeoutMs;
void coalescingState.process;
void processCoalescingState.activeLeaders;
void requestLocalCoalescingScope;
void boundedErrorKind;
void disabledReasons;
void legacyMissingConfigReason;
void MissingKeyConfigError;
void disabledOverlay;
void metricErrorKinds;
void unboundedErrorKind;
void createNodeRedisDialCacheClient;
void decodedEmptyRedisPayload;
void decodedStaleRedisPayload;
// @ts-expect-error Native reads removed the legacy node-redis registration.
void dialcacheRedisScripts.dialcacheRead;
// @ts-expect-error Native tracked reads removed the legacy node-redis registration.
void dialcacheRedisScripts.dialcacheReadTracked;
// @ts-expect-error Native SET writes removed the legacy node-redis registration.
void dialcacheRedisScripts.dialcacheWrite;
// @ts-expect-error The stamp protocol removed the legacy tracked-write registration.
void dialcacheRedisScripts.dialcacheWriteTracked;
void dialcacheRedisScripts.dialcacheWriteTrackedStamp;
void READ_CACHE_SCRIPT;
void READ_TRACKED_CACHE_SCRIPT;
void WRITE_CACHE_SCRIPT;
void WRITE_TRACKED_CACHE_SCRIPT;
void placeholderRedisFrame;
void trackedRedisPlaceholder;
void stampReplyResolution;
void setReplyValidation;
void placeholderLostError;
void REDIS_FRAME_VERSION;
void REDIS_ENCODING_UTF8;
void REDIS_ENCODING_BINARY;
void stampScriptSource;
void stampArguments;
void customRedisClient;
const globalSerializer: Serializer<unknown> = {
  dump: () => "global",
  load: () => ({ source: "global" }),
};
const cacheWithGlobalSerializer = new DialCache({
  redis: { client: customRedisClient, readTimeoutMs: 1_000, serializer: globalSerializer },
});
// @ts-expect-error A global serializer cannot establish per-function Date compatibility.
cacheWithGlobalSerializer.cached(async (_id: string) => new Date(0), optionsFor("GlobalSerializerNeedsTypedOverride"));
// @ts-expect-error A global serializer cannot establish per-invocation Date compatibility.
cacheWithGlobalSerializer.getOrLoad(async () => new Date(0), inlineOptionsFor("GlobalSerializerNeedsInlineTypedOverride"));
void cacheHasNoFlushAll;
void cacheHasNoClose;
void clientHasNoFlushAll;
void trackedWriteHasNoWatermarkTtlFloor;
void invalidationHasNoWatermarkTtlFloor;
void legacyTrackedWriteRequest;
void legacyInvalidationRequest;
void configHasNoMetricsRegistry;
void configHasNoMetricsPrefix;
void configRejectsFalseMetrics;
void configHasNamespace;
void configHasNoUrnPrefix;
void legacyNamespaceConfig;
void configHasNoRampSampler;
void legacyRampSamplerConfig;
void redisConfigHasNoKeyPrefix;
void legacyKeyPrefixConfig;
void redisConfigRequiresClient;
void redisConfigAllowsDefaultReadTimeout;
void redisConfigHasNoCreateClient;
void missingRedisClientConfig;
void defaultRedisReadTimeoutConfig;
void legacyRedisFactoryConfig;
void redisReadContext.signal;
void rootHasNoPrometheusFactory;
void rootHasNoDatadogFactory;
void rootHasNoDeterministicRampSampler;
void rootHasNoRandomRampSampler;
void datadogMetrics;
void datadogClassAdapter;
void missingObservationType;
`;
const integrationConsumer = `import * as valkeyGlide from "@valkey/valkey-glide";
import { DialCache } from "dialcache";
import StatsD from "hot-shots";
import { createClient as createRedisClient, createCluster as createRedisCluster } from "redis";
import {
  DatadogDialCacheMetrics,
  createDatadogDialCacheMetrics,
  type DatadogDogStatsDClient,
  type DatadogMetricsOptions,
  type DatadogObservationMetricType,
} from "dialcache/datadog";
import {
  PrometheusDialCacheMetrics,
  createPrometheusDialCacheMetrics,
  type PrometheusMetricsOptions,
} from "dialcache/prometheus";
import {
  createValkeyGlideDialCacheClient,
  type ValkeyGlideDialCacheClient,
  type ValkeyGlideRuntime,
} from "dialcache/valkey-glide";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "dialcache/node-redis";
import { Registry, type OpenMetricsContentType } from "prom-client";

const registry = new Registry();
const options: PrometheusMetricsOptions = { registry, prefix: "consumer_" };
const metrics = createPrometheusDialCacheMetrics(options);
const cache = new DialCache({ metrics });
const classAdapter = new PrometheusDialCacheMetrics({ registry, prefix: "class_" });
const openMetricsRegistry = new Registry<OpenMetricsContentType>();
openMetricsRegistry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
const openMetricsAdapter = new PrometheusDialCacheMetrics({ registry: openMetricsRegistry, prefix: "open_" });
const registryIsRequired: {} extends Pick<PrometheusMetricsOptions, "registry"> ? false : true = true;
const glideRedisClient: ValkeyGlideDialCacheClient | undefined = undefined;
const standaloneNodeRedisClient = createRedisClient({ scripts: dialcacheRedisScripts });
const clusterNodeRedisClient = createRedisCluster({
  rootNodes: [{ url: "redis://127.0.0.1:6379" }],
  scripts: dialcacheRedisScripts,
});
const standaloneNodeRedisAdapter = createNodeRedisDialCacheClient(standaloneNodeRedisClient);
const clusterNodeRedisAdapter = createNodeRedisDialCacheClient(clusterNodeRedisClient);
const glideRuntime: ValkeyGlideRuntime<valkeyGlide.Script, valkeyGlide.Decoder> = valkeyGlide;
declare const standaloneGlideClient: valkeyGlide.GlideClient;
declare const clusterGlideClient: valkeyGlide.GlideClusterClient;
const standaloneGlideAdapter = createValkeyGlideDialCacheClient(standaloneGlideClient, glideRuntime);
const clusterGlideAdapter = createValkeyGlideDialCacheClient(clusterGlideClient, glideRuntime);
// @ts-expect-error The caller's GLIDE runtime is required for native Script ownership.
createValkeyGlideDialCacheClient(standaloneGlideClient);
const dogStatsD = new StatsD({ mock: true });
const compatibleDogStatsD: DatadogDogStatsDClient = dogStatsD;
const observationMetricType: DatadogObservationMetricType = "distribution";
const datadogOptions: DatadogMetricsOptions = {
  client: compatibleDogStatsD,
  observationMetricType,
};
const datadogMetrics = createDatadogDialCacheMetrics(datadogOptions);
const datadogClassAdapter = new DatadogDialCacheMetrics({
  client: dogStatsD,
  observationMetricType: "histogram",
});
const datadogCache = new DialCache({ metrics: datadogMetrics });
const observationMetricTypeIsRequired: {} extends Pick<DatadogMetricsOptions, "observationMetricType">
  ? false
  : true = true;

void cache;
void classAdapter;
void openMetricsAdapter;
void registryIsRequired;
void glideRedisClient;
void standaloneNodeRedisAdapter;
void clusterNodeRedisAdapter;
void standaloneGlideAdapter;
void clusterGlideAdapter;
void datadogClassAdapter;
void datadogCache;
void observationMetricTypeIsRequired;
`;

try {
  await exec("corepack", ["pnpm", "pack", "--pack-destination", workspace], { cwd: root });
  const tarball = (await readdir(workspace)).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error("pnpm pack did not produce a tarball");
  }
  const packageTarball = join(workspace, tarball);

  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      packageTarball,
      "redis@~4.7.1",
      "typescript@5.9.3",
    ],
    { cwd: workspace },
  );

  for (const integrationDependency of ["prom-client", "@valkey/valkey-glide", "hot-shots"]) {
    if (await isResolvable(integrationDependency, workspace)) {
      throw new Error(`The ${integrationDependency} integration dependency was installed automatically`);
    }
  }

  await Promise.all([
    writeFile(join(workspace, "root-consumer.mts"), rootConsumer),
    writeFile(join(workspace, "root-consumer.cts"), rootConsumer),
    writeFile(
      join(workspace, "tsconfig.root.json"),
      typescriptConfig(["root-consumer.mts", "root-consumer.cts"]),
    ),
  ]);

  const { stdout: esmRootRuntimeOutput } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const root = await import("dialcache");
const nodeRedis = await import("dialcache/node-redis");
await import("dialcache/valkey-glide");
await import("dialcache/datadog");
const redisProtocol = await import("dialcache/redis-protocol");
const fallbackTimeoutError = new root.FallbackTimeoutError("PackageRuntime", 1000);
if (!(fallbackTimeoutError instanceof root.DialCacheError) || fallbackTimeoutError.timeoutMs !== 1000) {
  throw new Error("The root ESM fallback-timeout error export is invalid");
}
const redisReadTimeoutError = new root.RedisReadTimeoutError("PackageRuntime", 100);
if (!(redisReadTimeoutError instanceof root.DialCacheError) || redisReadTimeoutError.timeoutMs !== 100) {
  throw new Error("The root ESM Redis-read-timeout error export is invalid");
}
const coalescingState = new root.DialCache().getCoalescingState();
const idleCoalescingState = { process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null } };
if (JSON.stringify(coalescingState) !== JSON.stringify(idleCoalescingState)) {
  throw new Error("The root ESM coalescing snapshot export is invalid");
}
const timeoutCache = new root.DialCache();
const neverSettles = timeoutCache.cached(async () => await new Promise(() => undefined), {
  keyType: "id",
  useCase: "PackageOnlyHandleTimeout",
  cacheKey: () => "1",
  defaultConfig: root.DialCacheKeyConfig.enabled(60),
  fallbackTimeoutMs: 20,
});
try {
  await timeoutCache.enable(() => neverSettles());
  throw new Error("Expected the packaged ESM fallback to time out");
} catch (error) {
  if (!(error instanceof root.FallbackTimeoutError) || error.timeoutMs !== 20) {
    throw new Error("The packaged ESM fallback timeout was not delivered");
  }
  console.log("${fallbackTimeoutMarker}");
}
try {
  nodeRedis.dialcacheRedisScripts.dialcacheWriteTrackedStamp.transformReply(3);
  throw new Error("Expected an invalid node-redis script reply to fail");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisProtocolError)) {
    throw new Error("The node-redis protocol error does not match the root ESM export");
  }
}
if ("MissingKeyConfigError" in root) {
  throw new Error("The removed MissingKeyConfigError class must not be exported from the root ESM entry");
}
if (
  "dialcacheRead" in nodeRedis.dialcacheRedisScripts
  || "dialcacheReadTracked" in nodeRedis.dialcacheRedisScripts
) {
  throw new Error("The removed read scripts must not be registered by the packed ESM node-redis entry");
}
if (
  "READ_CACHE_SCRIPT" in redisProtocol
  || "READ_TRACKED_CACHE_SCRIPT" in redisProtocol
) {
  throw new Error("The removed read scripts must not be exported by the packed ESM Redis protocol entry");
}
if (
  "dialcacheWrite" in nodeRedis.dialcacheRedisScripts
  || "dialcacheWriteTracked" in nodeRedis.dialcacheRedisScripts
) {
  throw new Error("The removed write scripts must not be registered by the packed ESM node-redis entry");
}
if (
  "WRITE_CACHE_SCRIPT" in redisProtocol
  || "WRITE_TRACKED_CACHE_SCRIPT" in redisProtocol
) {
  throw new Error("The removed write scripts must not be exported by the packed ESM Redis protocol entry");
}
if (typeof redisProtocol.WRITE_TRACKED_STAMP_SCRIPT !== "string") {
  throw new Error("The packed ESM Redis protocol entry must export the tracked stamp script source");
}
if (redisProtocol.decodeRedisFrame(redisProtocol.encodeRedisFrame("value", 1)) !== "value") {
  throw new Error("The packed ESM Redis protocol encoder did not round-trip through the decoder");
}
if (redisProtocol.decodeTrackedRedisFrame(redisProtocol.encodeRedisFrame("pending", 0), Buffer.from("0")) !== null) {
  throw new Error("The packed ESM Redis protocol encoder did not produce a fenced placeholder frame");
}
const esmPlaceholder = redisProtocol.encodeTrackedRedisPlaceholder("pending");
if (
  esmPlaceholder.frame[0] !== 0
  || esmPlaceholder.nonce.byteLength !== 8
  || redisProtocol.decodeRedisFrame(esmPlaceholder.frame) !== null
  || redisProtocol.decodeTrackedRedisFrame(esmPlaceholder.frame, Buffer.from("0")) !== null
) {
  throw new Error("The packed ESM tracked placeholder must be unreadable until stamped");
}
if (
  "REDIS_FRAME_VERSION" in redisProtocol
  || "REDIS_ENCODING_UTF8" in redisProtocol
  || "REDIS_ENCODING_BINARY" in redisProtocol
) {
  throw new Error("The removed wire constants must not be exported by the packed ESM Redis protocol entry");
}
if (
  redisProtocol.resolveTrackedRedisWriteReply(1) !== true
  || redisProtocol.resolveTrackedRedisWriteReply(0) !== false
) {
  throw new Error("The packed ESM stamp reply resolver did not map replies 0 and 1");
}
try {
  redisProtocol.resolveTrackedRedisWriteReply(2);
  throw new Error("Expected a lost-placeholder stamp reply to fail");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisPlaceholderLostError)) {
    throw new Error("The lost-placeholder error does not match the root ESM export");
  }
}
const esmEmptyFrame = Buffer.alloc(10);
esmEmptyFrame[0] = 1;
esmEmptyFrame.writeBigUInt64BE(1n, 1);
if (redisProtocol.decodeRedisFrame(esmEmptyFrame) !== "") {
  throw new Error("The packed ESM Redis protocol decoder did not preserve an empty UTF-8 payload");
}
if (redisProtocol.decodeTrackedRedisFrame(esmEmptyFrame, Buffer.from("1")) !== null) {
  throw new Error("The packed ESM Redis protocol decoder did not reject a stale tracked frame");
}
try {
  redisProtocol.decodeRedisFrame("not binary");
  throw new Error("Expected the packed ESM Redis protocol decoder to reject a non-binary reply");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisPayloadError)) {
    throw new Error("The Redis protocol payload error does not match the root ESM export");
  }
}
const esmInvalidEncodingFrame = Buffer.from(esmEmptyFrame);
esmInvalidEncodingFrame[9] = 2;
try {
  redisProtocol.decodeRedisFrame(esmInvalidEncodingFrame);
  throw new Error("Expected the packed ESM Redis protocol decoder to reject an unsupported encoding");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisPayloadEncodingError)) {
    throw new Error("The Redis protocol encoding error does not match the root ESM export");
  }
}
const esmDisabledOverlay = root.DialCacheKeyConfig.disabled();
if (
  esmDisabledOverlay.requestLocal !== false
  || esmDisabledOverlay.coalesce !== undefined
  || esmDisabledOverlay.shadow?.ramp !== 0
  || esmDisabledOverlay.shadow.logMismatches !== false
  || esmDisabledOverlay.ramp[root.CacheLayer.LOCAL] !== 0
  || esmDisabledOverlay.ramp[root.CacheLayer.REMOTE] !== 0
) {
  throw new Error("The packed ESM runtime did not build the disabled() kill-switch overlay");
}
let calls = 0;
const overlayCache = new root.DialCache({
  cacheConfigProvider: () => new root.DialCacheKeyConfig({
    ramp: { [root.CacheLayer.LOCAL]: 100 },
  }),
});
const load = overlayCache.cached(async (id) => ({ id, calls: ++calls }), {
  keyType: "id",
  useCase: "PackedRuntimeOverlay",
  cacheKey: (id) => id,
  defaultConfig: new root.DialCacheKeyConfig({
    ttlSec: { [root.CacheLayer.LOCAL]: 60 },
  }),
});
const first = await overlayCache.enable(() => load("123"));
const second = await overlayCache.enable(() => load("123"));
if (calls !== 1 || second !== first) {
  throw new Error("The packed ESM runtime did not inherit the default local TTL through a sparse overlay");
}
let inlineCalls = 0;
const inlineOptions = {
  keyType: "id",
  useCase: "PackedRuntimeGetOrLoad",
  key: "123",
  defaultConfig: root.DialCacheKeyConfig.enabled(60),
};
const inlineFirst = await overlayCache.enable(() =>
  overlayCache.getOrLoad(() => ({ source: "inline", calls: ++inlineCalls }), inlineOptions),
);
const inlineSecond = await overlayCache.enable(() =>
  overlayCache.getOrLoad(() => ({ source: "unexpected", calls: ++inlineCalls }), inlineOptions),
);
if (inlineCalls !== 1 || inlineSecond !== inlineFirst) {
  throw new Error("The packed ESM runtime did not execute getOrLoad through the cache chain");
}`,
    ],
    { cwd: workspace },
  );
  if (!esmRootRuntimeOutput.includes(fallbackTimeoutMarker)) {
    throw new Error("The packaged ESM only-handle fallback timeout marker is missing");
  }

  const { stdout: observerIsolationOutput } = await exec(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "--input-type=module",
      "--eval",
      `const root = await import("dialcache");
const rejectObserver = () => Promise.reject(new Error("observer transport failed"));
const metrics = {
  request: rejectObserver,
  miss: rejectObserver,
  disabled: rejectObserver,
  error: rejectObserver,
  invalidation: rejectObserver,
  observeGet: rejectObserver,
  observeFallback: rejectObserver,
  observeSerialization: rejectObserver,
  observeSize: rejectObserver,
};
const cache = new root.DialCache({
  logger: {
    debug: rejectObserver,
    error: rejectObserver,
    warn: rejectObserver,
  },
  metrics,
});
const load = cache.cached(async () => "fallback", {
  keyType: "id",
  useCase: "PackageObserverIsolation",
  cacheKey: () => {
    throw new Error("key construction failed");
  },
  defaultConfig: root.DialCacheKeyConfig.enabled(60),
});
const value = await cache.enable(() => load());
if (value !== "fallback") {
  throw new Error("Observer rejection changed the packaged fallback result");
}
await new Promise((resolve) => setImmediate(resolve));
console.log("${observerIsolationMarker}");`,
    ],
    { cwd: workspace },
  );
  if (!observerIsolationOutput.includes(observerIsolationMarker)) {
    throw new Error("The packaged observer-rejection isolation marker is missing");
  }

  const { stdout: shadowPayloadReleaseOutput } = await exec(
    process.execPath,
    [
      "--expose-gc",
      "--input-type=module",
      "--eval",
      `const root = await import("dialcache");
let payload = Buffer.alloc(4 * 1024 * 1024, 1);
const payloadReference = new WeakRef(payload);
const redis = {
  read: async () => payload,
  write: async () => true,
  invalidate: async () => undefined,
};
let resolveTimeout;
const timeoutObserved = new Promise((resolve) => {
  resolveTimeout = resolve;
});
const metrics = {
  request: () => undefined,
  miss: () => undefined,
  disabled: () => undefined,
  error: () => undefined,
  invalidation: () => undefined,
  observeGet: () => undefined,
  observeFallback: () => undefined,
  observeSerialization: () => undefined,
  observeSize: () => undefined,
  shadowValidation: ({ outcome }) => {
    if (outcome === "timeout") {
      resolveTimeout();
    }
  },
};
const cache = new root.DialCache({
  redis: { client: redis, serializer: {
    dump: () => "unused",
    load: () => ({ id: "123" }),
  } },
  metrics,
});
const load = cache.cached(async () => await new Promise(() => undefined), {
  keyType: "id",
  useCase: "PackageShadowPayloadRelease",
  cacheKey: () => "123",
  trackForInvalidation: true,
  fallbackTimeoutMs: 20,
  defaultConfig: new root.DialCacheKeyConfig({
    ttlSec: { [root.CacheLayer.REMOTE]: 60 },
    ramp: { [root.CacheLayer.REMOTE]: 100 },
    shadow: { ramp: 100 },
  }),
});
let value = await cache.enable(() => load());
if (value.id !== "123") {
  throw new Error("The packaged shadow payload setup did not produce a served hit");
}
value = null;
payload = null;
let shadowTimeoutGuard;
const missingShadowTimeout = new Promise((_, reject) => {
  shadowTimeoutGuard = setTimeout(() => {
    reject(new Error("The packaged shadow payload test did not observe timeout delivery"));
  }, 2_000);
});
try {
  await Promise.race([timeoutObserved, missingShadowTimeout]);
  for (let attempt = 0; attempt < 40 && payloadReference.deref() !== undefined; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    Buffer.alloc(4 * 1024 * 1024);
    globalThis.gc();
  }
  if (payloadReference.deref() !== undefined) {
    throw new Error("A timed-out shadow operation retained its original Redis payload");
  }
} finally {
  clearTimeout(shadowTimeoutGuard);
}
console.log("${shadowPayloadReleaseMarker}");`,
    ],
    { cwd: workspace, timeout: 10_000 },
  );
  if (!shadowPayloadReleaseOutput.includes(shadowPayloadReleaseMarker)) {
    throw new Error("The packaged shadow-payload release marker is missing");
  }

  const { stdout: cjsRootRuntimeOutput } = await exec(
    process.execPath,
    [
      "--eval",
      `const root = require("dialcache");
const nodeRedis = require("dialcache/node-redis");
require("dialcache/valkey-glide");
require("dialcache/datadog");
const redisProtocol = require("dialcache/redis-protocol");
const fallbackTimeoutError = new root.FallbackTimeoutError("PackageRuntime", 1000);
if (!(fallbackTimeoutError instanceof root.DialCacheError) || fallbackTimeoutError.timeoutMs !== 1000) {
  throw new Error("The root CommonJS fallback-timeout error export is invalid");
}
const redisReadTimeoutError = new root.RedisReadTimeoutError("PackageRuntime", 100);
if (!(redisReadTimeoutError instanceof root.DialCacheError) || redisReadTimeoutError.timeoutMs !== 100) {
  throw new Error("The root CommonJS Redis-read-timeout error export is invalid");
}
const coalescingState = new root.DialCache().getCoalescingState();
const idleCoalescingState = { process: { activeLeaders: 0, activeFollowers: 0, oldestLeaderAgeMs: null } };
if (JSON.stringify(coalescingState) !== JSON.stringify(idleCoalescingState)) {
  throw new Error("The root CommonJS coalescing snapshot export is invalid");
}
const timeoutCache = new root.DialCache();
const neverSettles = timeoutCache.cached(async () => await new Promise(() => undefined), {
  keyType: "id",
  useCase: "PackageOnlyHandleTimeout",
  cacheKey: () => "1",
  defaultConfig: root.DialCacheKeyConfig.enabled(60),
  fallbackTimeoutMs: 20,
});
void (async () => {
  try {
    await timeoutCache.enable(() => neverSettles());
    throw new Error("Expected the packaged CommonJS fallback to time out");
  } catch (error) {
    if (!(error instanceof root.FallbackTimeoutError) || error.timeoutMs !== 20) {
      throw new Error("The packaged CommonJS fallback timeout was not delivered");
    }
    console.log("${fallbackTimeoutMarker}");
  }
})();
try {
  nodeRedis.dialcacheRedisScripts.dialcacheWriteTrackedStamp.transformReply(3);
  throw new Error("Expected an invalid node-redis script reply to fail");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisProtocolError)) {
    throw new Error("The node-redis protocol error does not match the root CommonJS export");
  }
}
if ("MissingKeyConfigError" in root) {
  throw new Error("The removed MissingKeyConfigError class must not be exported from the root CommonJS entry");
}
if (
  "dialcacheRead" in nodeRedis.dialcacheRedisScripts
  || "dialcacheReadTracked" in nodeRedis.dialcacheRedisScripts
) {
  throw new Error("The removed read scripts must not be registered by the packed CommonJS node-redis entry");
}
if (
  "READ_CACHE_SCRIPT" in redisProtocol
  || "READ_TRACKED_CACHE_SCRIPT" in redisProtocol
) {
  throw new Error("The removed read scripts must not be exported by the packed CommonJS Redis protocol entry");
}
if (
  "dialcacheWrite" in nodeRedis.dialcacheRedisScripts
  || "dialcacheWriteTracked" in nodeRedis.dialcacheRedisScripts
) {
  throw new Error("The removed write scripts must not be registered by the packed CommonJS node-redis entry");
}
if (
  "WRITE_CACHE_SCRIPT" in redisProtocol
  || "WRITE_TRACKED_CACHE_SCRIPT" in redisProtocol
) {
  throw new Error("The removed write scripts must not be exported by the packed CommonJS Redis protocol entry");
}
if (typeof redisProtocol.WRITE_TRACKED_STAMP_SCRIPT !== "string") {
  throw new Error("The packed CommonJS Redis protocol entry must export the tracked stamp script source");
}
if (redisProtocol.decodeRedisFrame(redisProtocol.encodeRedisFrame("value", 1)) !== "value") {
  throw new Error("The packed CommonJS Redis protocol encoder did not round-trip through the decoder");
}
if (redisProtocol.decodeTrackedRedisFrame(redisProtocol.encodeRedisFrame("pending", 0), Buffer.from("0")) !== null) {
  throw new Error("The packed CommonJS Redis protocol encoder did not produce a fenced placeholder frame");
}
const cjsPlaceholder = redisProtocol.encodeTrackedRedisPlaceholder("pending");
if (
  cjsPlaceholder.frame[0] !== 0
  || cjsPlaceholder.nonce.byteLength !== 8
  || redisProtocol.decodeRedisFrame(cjsPlaceholder.frame) !== null
  || redisProtocol.decodeTrackedRedisFrame(cjsPlaceholder.frame, Buffer.from("0")) !== null
) {
  throw new Error("The packed CommonJS tracked placeholder must be unreadable until stamped");
}
if (
  "REDIS_FRAME_VERSION" in redisProtocol
  || "REDIS_ENCODING_UTF8" in redisProtocol
  || "REDIS_ENCODING_BINARY" in redisProtocol
) {
  throw new Error("The removed wire constants must not be exported by the packed CommonJS Redis protocol entry");
}
if (
  redisProtocol.resolveTrackedRedisWriteReply(1) !== true
  || redisProtocol.resolveTrackedRedisWriteReply(0) !== false
) {
  throw new Error("The packed CommonJS stamp reply resolver did not map replies 0 and 1");
}
try {
  redisProtocol.resolveTrackedRedisWriteReply(2);
  throw new Error("Expected a lost-placeholder stamp reply to fail");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisPlaceholderLostError)) {
    throw new Error("The lost-placeholder error does not match the root CommonJS export");
  }
}
const cjsEmptyFrame = Buffer.alloc(10);
cjsEmptyFrame[0] = 1;
cjsEmptyFrame.writeBigUInt64BE(1n, 1);
if (redisProtocol.decodeRedisFrame(cjsEmptyFrame) !== "") {
  throw new Error("The packed CommonJS Redis protocol decoder did not preserve an empty UTF-8 payload");
}
if (redisProtocol.decodeTrackedRedisFrame(cjsEmptyFrame, Buffer.from("1")) !== null) {
  throw new Error("The packed CommonJS Redis protocol decoder did not reject a stale tracked frame");
}
try {
  redisProtocol.decodeRedisFrame("not binary");
  throw new Error("Expected the packed CommonJS Redis protocol decoder to reject a non-binary reply");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisPayloadError)) {
    throw new Error("The Redis protocol payload error does not match the root CommonJS export");
  }
}
const cjsInvalidEncodingFrame = Buffer.from(cjsEmptyFrame);
cjsInvalidEncodingFrame[9] = 2;
try {
  redisProtocol.decodeRedisFrame(cjsInvalidEncodingFrame);
  throw new Error("Expected the packed CommonJS Redis protocol decoder to reject an unsupported encoding");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisPayloadEncodingError)) {
    throw new Error("The Redis protocol encoding error does not match the root CommonJS export");
  }
}
const cjsDisabledOverlay = root.DialCacheKeyConfig.disabled();
if (
  cjsDisabledOverlay.requestLocal !== false
  || cjsDisabledOverlay.coalesce !== undefined
  || cjsDisabledOverlay.shadow?.ramp !== 0
  || cjsDisabledOverlay.shadow.logMismatches !== false
  || cjsDisabledOverlay.ramp[root.CacheLayer.LOCAL] !== 0
  || cjsDisabledOverlay.ramp[root.CacheLayer.REMOTE] !== 0
) {
  throw new Error("The packed CommonJS runtime did not build the disabled() kill-switch overlay");
}
void (async () => {
  let calls = 0;
  const overlayCache = new root.DialCache({
    cacheConfigProvider: () => new root.DialCacheKeyConfig({
      ramp: { [root.CacheLayer.LOCAL]: 100 },
    }),
  });
  const load = overlayCache.cached(async (id) => ({ id, calls: ++calls }), {
    keyType: "id",
    useCase: "PackedRuntimeOverlay",
    cacheKey: (id) => id,
    defaultConfig: new root.DialCacheKeyConfig({
      ttlSec: { [root.CacheLayer.LOCAL]: 60 },
    }),
  });
  const first = await overlayCache.enable(() => load("123"));
  const second = await overlayCache.enable(() => load("123"));
  if (calls !== 1 || second !== first) {
    throw new Error("The packed CommonJS runtime did not inherit the default local TTL through a sparse overlay");
  }
  let inlineCalls = 0;
  const inlineOptions = {
    keyType: "id",
    useCase: "PackedRuntimeGetOrLoad",
    key: "123",
    defaultConfig: root.DialCacheKeyConfig.enabled(60),
  };
  const inlineFirst = await overlayCache.enable(() =>
    overlayCache.getOrLoad(() => ({ source: "inline", calls: ++inlineCalls }), inlineOptions),
  );
  const inlineSecond = await overlayCache.enable(() =>
    overlayCache.getOrLoad(() => ({ source: "unexpected", calls: ++inlineCalls }), inlineOptions),
  );
  if (inlineCalls !== 1 || inlineSecond !== inlineFirst) {
    throw new Error("The packed CommonJS runtime did not execute getOrLoad through the cache chain");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`,
    ],
    { cwd: workspace },
  );
  if (!cjsRootRuntimeOutput.includes(fallbackTimeoutMarker)) {
    throw new Error("The packaged CommonJS only-handle fallback timeout marker is missing");
  }
  await exec(
    join(workspace, "node_modules", ".bin", "tsc"),
    ["--project", join(workspace, "tsconfig.root.json")],
    { cwd: workspace },
  );

  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      packageTarball,
      "redis@~4.7.1",
      "typescript@5.9.3",
      "prom-client@^15.1.3",
      "@valkey/valkey-glide@2.0.0",
      "dialcache-test-glide@npm:@valkey/valkey-glide@2.4.2",
      "hot-shots@^17.0.0",
    ],
    { cwd: workspace },
  );

  await Promise.all([
    writeFile(join(workspace, "consumer.mts"), integrationConsumer),
    writeFile(join(workspace, "consumer.cts"), integrationConsumer),
    writeFile(join(workspace, "tsconfig.json"), typescriptConfig(["consumer.mts", "consumer.cts"])),
  ]);

  await exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const root = await import("dialcache");
const glide = await import("dialcache/valkey-glide");
const appGlide = await import("@valkey/valkey-glide");
const otherGlide = await import("dialcache-test-glide");
await import("dialcache/datadog");
await import("dialcache/prometheus");
await import("dialcache/redis-protocol");
await import("dialcache/node-redis");
if (appGlide.Script === otherGlide.Script) {
  throw new Error("The package test requires two distinct GLIDE module instances");
}
const esmFakeGlideClient = {
  exec: async (batch, _raiseOnError, options) => {
    if (!(batch instanceof appGlide.Batch) || batch instanceof otherGlide.Batch) {
      throw new Error("The ESM adapter did not use the caller-supplied GLIDE Batch constructor");
    }
    if (options.decoder !== appGlide.Decoder.Bytes) {
      throw new Error("The ESM adapter did not use the caller-supplied GLIDE byte decoder");
    }
    return ["OK", new Error("NOSCRIPT No matching script. Please use EVAL.")];
  },
  invokeScript: async (script, options) => {
    if (!(script instanceof appGlide.Script) || script instanceof otherGlide.Script) {
      throw new Error("The ESM adapter did not use the caller-supplied GLIDE Script constructor");
    }
    if (options.decoder !== appGlide.Decoder.Bytes) {
      throw new Error("The ESM adapter did not use the caller-supplied GLIDE byte decoder");
    }
    return 3;
  },
};
const esmGlideRuntime = {
  ...appGlide,
  GlideClient: { [Symbol.hasInstance]: (value) => value === esmFakeGlideClient },
  GlideClusterClient: { [Symbol.hasInstance]: () => false },
};
const adapter = glide.createValkeyGlideDialCacheClient(esmFakeGlideClient, esmGlideRuntime);
try {
  await adapter.write({
    valueKey: "tracked:{id}:value",
    watermarkKey: "tracked:{id}:watermark",
    cacheTtlMs: 1_000,
    value: "payload",
  });
  throw new Error("Expected an invalid GLIDE script reply to fail");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisProtocolError)) {
    throw new Error("The GLIDE protocol error does not match the root ESM export");
  }
} finally {
  adapter.dispose();
}`,
    ],
    { cwd: workspace },
  );
  await exec(
    process.execPath,
    [
      "--eval",
      `const root = require("dialcache");
const glide = require("dialcache/valkey-glide");
const appGlide = require("@valkey/valkey-glide");
const otherGlide = require("dialcache-test-glide");
require("dialcache/datadog");
require("dialcache/prometheus");
require("dialcache/redis-protocol");
require("dialcache/node-redis");
void (async () => {
  if (appGlide.Script === otherGlide.Script) {
    throw new Error("The package test requires two distinct GLIDE module instances");
  }
  const cjsFakeGlideClient = {
    exec: async (batch, _raiseOnError, options) => {
      if (!(batch instanceof appGlide.Batch) || batch instanceof otherGlide.Batch) {
        throw new Error("The CommonJS adapter did not use the caller-supplied GLIDE Batch constructor");
      }
      if (options.decoder !== appGlide.Decoder.Bytes) {
        throw new Error("The CommonJS adapter did not use the caller-supplied GLIDE byte decoder");
      }
      return ["OK", new Error("NOSCRIPT No matching script. Please use EVAL.")];
    },
    invokeScript: async (script, options) => {
      if (!(script instanceof appGlide.Script) || script instanceof otherGlide.Script) {
        throw new Error("The CommonJS adapter did not use the caller-supplied GLIDE Script constructor");
      }
      if (options.decoder !== appGlide.Decoder.Bytes) {
        throw new Error("The CommonJS adapter did not use the caller-supplied GLIDE byte decoder");
      }
      return 3;
    },
  };
  const cjsGlideRuntime = {
    ...appGlide,
    GlideClient: { [Symbol.hasInstance]: (value) => value === cjsFakeGlideClient },
    GlideClusterClient: { [Symbol.hasInstance]: () => false },
  };
  const adapter = glide.createValkeyGlideDialCacheClient(cjsFakeGlideClient, cjsGlideRuntime);
  try {
    await adapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "payload",
    });
    throw new Error("Expected an invalid GLIDE script reply to fail");
  } catch (error) {
    if (!(error instanceof root.DialCacheRedisProtocolError)) {
      throw new Error("The GLIDE protocol error does not match the root CommonJS export");
    }
  } finally {
    adapter.dispose();
  }
})();`,
    ],
    { cwd: workspace },
  );
  await exec(
    join(workspace, "node_modules", ".bin", "tsc"),
    ["--project", join(workspace, "tsconfig.json")],
    { cwd: workspace },
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function isResolvable(specifier, cwd) {
  try {
    await exec(process.execPath, ["--eval", `require.resolve(${JSON.stringify(specifier)})`], { cwd });
    return true;
  } catch {
    return false;
  }
}

function typescriptConfig(include) {
  return `${JSON.stringify(
    {
      compilerOptions: {
        module: "Node16",
        moduleResolution: "Node16",
        noEmit: true,
        strict: true,
      },
      include,
    },
    null,
    2,
  )}\n`;
}

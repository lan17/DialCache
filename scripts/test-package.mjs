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
  type CoordinatedRedisConfig,
  type DialCacheConfig,
  type DialCacheCoordinatedRedisClient,
  type DialCacheInvalidationCoordinator,
  type DialCacheInvalidationCoordinatorListener,
  type DialCacheInvalidationCoordinatorState,
  type DialCacheInvalidationEventV1,
  type DialCacheInvalidationIdentity,
  type DialCacheKeyInit,
  type DialCacheLocalInvalidation,
  type DialCacheLocalInvalidationSource,
  type DialCacheMetricsAdapter,
  type DialCacheRedisConfig,
  type DialCacheRedisClient,
  type DisabledReason,
  type GetOrLoadOptions,
  type InvalidationMetricLabels,
  type MetricErrorKind,
  type ProcessCoalescingState,
  type RedisConfig,
  type RedisCoordinatedInvalidationRequest,
  type RedisInvalidationRequest,
  type RedisReadContext,
  type RedisWriteRequest,
  type Serializer,
} from "dialcache";
// @ts-expect-error The unused MissingKeyConfigError class was removed instead of deprecated.
import { MissingKeyConfigError } from "dialcache";
import { createClient } from "redis";
import {
  createNodeRedisDialCacheClient,
  createNodeRedisDialCacheInvalidationCoordinator,
  dialcacheRedisScripts,
  type DialCacheNodeRedisInvalidationCoordinator,
  type DialCacheNodeRedisSubscriberClient,
} from "dialcache/node-redis";
import {
  INVALIDATE_AND_PUBLISH_CACHE_SCRIPT,
  MAX_REDIS_INVALIDATION_EVENT_BYTES,
  READ_CACHE_SCRIPT,
  REDIS_INVALIDATION_EVENT_VERSION,
  decodeRedisInvalidationEvent,
  redisInvalidationChannel,
} from "dialcache/redis-protocol";
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
const fallbackTimeoutError = new FallbackTimeoutError("Load", 1_000);
const redisReadTimeoutError = new RedisReadTimeoutError("Load", 100);
const coalescingState: CoalescingState = cache.getCoalescingState();
const processCoalescingState: ProcessCoalescingState = coalescingState.process;
const disabledOverlay: DialCacheKeyConfig = DialCacheKeyConfig.disabled();
const load = cache.cached(async (id: string) => id, {
  keyType: "id",
  useCase: "Load",
  cacheKey: (id) => id,
  fallbackTimeoutMs: 1_000,
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
  inlineOptionsFor("InlineAsync"),
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

const requestLocalConfig = new DialCacheKeyConfig({ requestLocal: true });
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
const coordinatedIdentity: DialCacheInvalidationIdentity = {
  namespace: "consumer-cache",
  keyType: "id",
  id: "123",
};
const coordinatedSource: DialCacheLocalInvalidationSource = "event";
const coordinatedLocalInvalidation: DialCacheLocalInvalidation = {
  ...coordinatedIdentity,
  remainingMs: 1_000,
  source: coordinatedSource,
};
const coordinatedEvent: DialCacheInvalidationEventV1 = {
  version: 1,
  ...coordinatedIdentity,
  effectiveWatermarkMs: String(Date.now() + 1_000),
  redisNowMs: String(Date.now()),
};
const coordinatedState: DialCacheInvalidationCoordinatorState = "ready";
const coordinatorListeners = new Set<DialCacheInvalidationCoordinatorListener>();
const coordinatedInvalidationCoordinator: DialCacheInvalidationCoordinator = {
  namespace: coordinatedIdentity.namespace,
  state: coordinatedState,
  addListener(listener) {
    coordinatorListeners.add(listener);
    listener.onStateChange(coordinatedState);
    return () => coordinatorListeners.delete(listener);
  },
  invalidate(invalidation) {
    for (const listener of coordinatorListeners) {
      listener.onInvalidation(invalidation);
    }
  },
};
const coordinatedRedisClient: DialCacheCoordinatedRedisClient = {
  ...customRedisClient,
  async invalidateAndPublish(request: RedisCoordinatedInvalidationRequest) {
    return {
      version: REDIS_INVALIDATION_EVENT_VERSION,
      namespace: request.namespace,
      keyType: request.keyType,
      id: request.id,
      effectiveWatermarkMs: String(Date.now() + request.futureBufferMs),
      redisNowMs: String(Date.now()),
    };
  },
};
const coordinatedRedisConfig: CoordinatedRedisConfig = {
  client: coordinatedRedisClient,
  coordinator: coordinatedInvalidationCoordinator,
};
const dialcacheRedisConfig: DialCacheRedisConfig = coordinatedRedisConfig;
// A coordinated-capable client remains usable without opting into local coordination.
const coordinatedClientWithoutCoordinator: RedisConfig = { client: coordinatedRedisClient };
// @ts-expect-error A coordinator requires the atomic invalidate-and-publish client extension.
const legacyClientWithCoordinator: DialCacheRedisConfig = {
  client: customRedisClient,
  coordinator: coordinatedInvalidationCoordinator,
};
interface ExtendedRedisConfig extends RedisConfig {
  readonly applicationName: string;
}
class ImplementedRedisConfig implements RedisConfig {
  readonly client = customRedisClient;
}
const extendedRedisConfig: ExtendedRedisConfig = {
  client: customRedisClient,
  applicationName: "consumer",
};
const implementedRedisConfig: RedisConfig = new ImplementedRedisConfig();
const coordinatedInvalidationRequest: RedisCoordinatedInvalidationRequest = {
  ...coordinatedIdentity,
  watermarkKey: "{consumer-cache:id:123}#watermark",
  futureBufferMs: 1_000,
  channel: redisInvalidationChannel(coordinatedIdentity.namespace),
};
const decodedCoordinatedEvent: DialCacheInvalidationEventV1 = decodeRedisInvalidationEvent(
  JSON.stringify(coordinatedEvent),
  coordinatedIdentity,
);
const nodeRedisCommandClient = createClient({ scripts: dialcacheRedisScripts });
const nodeRedisCoordinatedAdapter: DialCacheCoordinatedRedisClient =
  createNodeRedisDialCacheClient(nodeRedisCommandClient);
const nodeRedisSubscriber = createClient();
const nodeRedisSubscriberSurface: DialCacheNodeRedisSubscriberClient = nodeRedisSubscriber;
const nodeRedisCoordinatorPromise: Promise<DialCacheNodeRedisInvalidationCoordinator> =
  createNodeRedisDialCacheInvalidationCoordinator(nodeRedisSubscriber, {
    namespace: coordinatedIdentity.namespace,
  });
const legacyStructuralNodeScriptClient = {
  dialcacheRead: async () => null,
  dialcacheReadTracked: async () => null,
  dialcacheWrite: async () => 1,
  dialcacheWriteTracked: async () => 1,
  dialcacheInvalidate: async () => 1,
};
const legacyStructuralNodeAdapter: DialCacheRedisClient =
  createNodeRedisDialCacheClient(legacyStructuralNodeScriptClient);
const cacheHasNoFlushAll: "flushAll" extends keyof DialCache ? false : true = true;
const cacheHasNoClose: "close" extends keyof DialCache ? false : true = true;
const cacheHasDispose: "dispose" extends keyof DialCache ? true : false = true;
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
void structuralConfigProvider;
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
void createNodeRedisDialCacheInvalidationCoordinator;
void dialcacheRedisScripts.dialcacheInvalidateAndPublish;
void nodeRedisCommandClient;
void nodeRedisCoordinatedAdapter.invalidateAndPublish;
void nodeRedisSubscriberSurface.isReady;
void nodeRedisCoordinatorPromise;
void legacyStructuralNodeAdapter.invalidate;
void READ_CACHE_SCRIPT;
void INVALIDATE_AND_PUBLISH_CACHE_SCRIPT;
void MAX_REDIS_INVALIDATION_EVENT_BYTES;
void coordinatedIdentity;
void coordinatedLocalInvalidation;
void coordinatedEvent;
void coordinatedInvalidationCoordinator;
void coordinatedRedisConfig;
void dialcacheRedisConfig;
void coordinatedClientWithoutCoordinator;
void legacyClientWithCoordinator;
void extendedRedisConfig;
void implementedRedisConfig;
void coordinatedInvalidationRequest;
void decodedCoordinatedEvent;
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
void cacheHasDispose;
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
  nodeRedis.dialcacheRedisScripts.dialcacheWrite.transformReply(2);
  throw new Error("Expected an invalid node-redis script reply to fail");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisProtocolError)) {
    throw new Error("The node-redis protocol error does not match the root ESM export");
  }
}
if (
  typeof nodeRedis.createNodeRedisDialCacheInvalidationCoordinator !== "function"
  || typeof nodeRedis.dialcacheRedisScripts.dialcacheInvalidateAndPublish?.SCRIPT !== "string"
  || redisProtocol.INVALIDATE_AND_PUBLISH_CACHE_SCRIPT
    !== nodeRedis.dialcacheRedisScripts.dialcacheInvalidateAndPublish.SCRIPT
  || redisProtocol.REDIS_INVALIDATION_EVENT_VERSION !== 1
  || redisProtocol.MAX_REDIS_INVALIDATION_EVENT_BYTES !== 16 * 1024
) {
  throw new Error("The packed ESM coordinated invalidation exports are invalid");
}
const protocolNamespace = "packed-esm";
const protocolEvent = redisProtocol.decodeRedisInvalidationEvent(JSON.stringify({
  version: redisProtocol.REDIS_INVALIDATION_EVENT_VERSION,
  namespace: protocolNamespace,
  keyType: "id",
  id: "123",
  effectiveWatermarkMs: "1001",
  redisNowMs: "1",
}));
if (
  protocolEvent.id !== "123"
  || redisProtocol.redisInvalidationChannel(protocolNamespace)
    !== "dialcache:invalidation:v1:packed-esm"
) {
  throw new Error("The packed ESM invalidation event helpers are invalid");
}
let coordinatedListenerRemoved = false;
const packageCoordinator = {
  namespace: protocolNamespace,
  state: "ready",
  addListener(listener) {
    listener.onStateChange("ready");
    return () => {
      coordinatedListenerRemoved = true;
    };
  },
  invalidate() {},
};
const packageLegacyClient = {
  async read() { return null; },
  async write() { return true; },
  async invalidate() {},
};
new root.DialCache({ namespace: "packed-legacy", redis: { client: packageLegacyClient } });
const packageCoordinatedCache = new root.DialCache({
  namespace: protocolNamespace,
  redis: {
    client: {
      ...packageLegacyClient,
      async invalidateAndPublish(request) {
        return {
          version: 1,
          namespace: request.namespace,
          keyType: request.keyType,
          id: request.id,
          effectiveWatermarkMs: "1",
          redisNowMs: "1",
        };
      },
    },
    coordinator: packageCoordinator,
  },
});
packageCoordinatedCache.dispose();
if (!coordinatedListenerRemoved) {
  throw new Error("The packed ESM DialCache did not detach from its invalidation coordinator");
}
if ("MissingKeyConfigError" in root) {
  throw new Error("The removed MissingKeyConfigError class must not be exported from the root ESM entry");
}
const esmDisabledOverlay = root.DialCacheKeyConfig.disabled();
if (esmDisabledOverlay.requestLocal !== false || esmDisabledOverlay.ramp[root.CacheLayer.LOCAL] !== 0 || esmDisabledOverlay.ramp[root.CacheLayer.REMOTE] !== 0) {
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
  nodeRedis.dialcacheRedisScripts.dialcacheWrite.transformReply(2);
  throw new Error("Expected an invalid node-redis script reply to fail");
} catch (error) {
  if (!(error instanceof root.DialCacheRedisProtocolError)) {
    throw new Error("The node-redis protocol error does not match the root CommonJS export");
  }
}
if (
  typeof nodeRedis.createNodeRedisDialCacheInvalidationCoordinator !== "function"
  || typeof nodeRedis.dialcacheRedisScripts.dialcacheInvalidateAndPublish?.SCRIPT !== "string"
  || redisProtocol.INVALIDATE_AND_PUBLISH_CACHE_SCRIPT
    !== nodeRedis.dialcacheRedisScripts.dialcacheInvalidateAndPublish.SCRIPT
  || redisProtocol.REDIS_INVALIDATION_EVENT_VERSION !== 1
  || redisProtocol.MAX_REDIS_INVALIDATION_EVENT_BYTES !== 16 * 1024
) {
  throw new Error("The packed CommonJS coordinated invalidation exports are invalid");
}
const protocolNamespace = "packed-cjs";
const protocolEvent = redisProtocol.decodeRedisInvalidationEvent(JSON.stringify({
  version: redisProtocol.REDIS_INVALIDATION_EVENT_VERSION,
  namespace: protocolNamespace,
  keyType: "id",
  id: "123",
  effectiveWatermarkMs: "1001",
  redisNowMs: "1",
}));
if (
  protocolEvent.id !== "123"
  || redisProtocol.redisInvalidationChannel(protocolNamespace)
    !== "dialcache:invalidation:v1:packed-cjs"
) {
  throw new Error("The packed CommonJS invalidation event helpers are invalid");
}
let coordinatedListenerRemoved = false;
const packageCoordinator = {
  namespace: protocolNamespace,
  state: "ready",
  addListener(listener) {
    listener.onStateChange("ready");
    return () => {
      coordinatedListenerRemoved = true;
    };
  },
  invalidate() {},
};
const packageLegacyClient = {
  async read() { return null; },
  async write() { return true; },
  async invalidate() {},
};
new root.DialCache({ namespace: "packed-legacy", redis: { client: packageLegacyClient } });
const packageCoordinatedCache = new root.DialCache({
  namespace: protocolNamespace,
  redis: {
    client: {
      ...packageLegacyClient,
      async invalidateAndPublish(request) {
        return {
          version: 1,
          namespace: request.namespace,
          keyType: request.keyType,
          id: request.id,
          effectiveWatermarkMs: "1",
          redisNowMs: "1",
        };
      },
    },
    coordinator: packageCoordinator,
  },
});
packageCoordinatedCache.dispose();
if (!coordinatedListenerRemoved) {
  throw new Error("The packed CommonJS DialCache did not detach from its invalidation coordinator");
}
if ("MissingKeyConfigError" in root) {
  throw new Error("The removed MissingKeyConfigError class must not be exported from the root CommonJS entry");
}
const cjsDisabledOverlay = root.DialCacheKeyConfig.disabled();
if (cjsDisabledOverlay.requestLocal !== false || cjsDisabledOverlay.ramp[root.CacheLayer.LOCAL] !== 0 || cjsDisabledOverlay.ramp[root.CacheLayer.REMOTE] !== 0) {
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
      "@valkey/valkey-glide@2.2.10",
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
const adapter = glide.createValkeyGlideDialCacheClient({
  invokeScript: async (script, options) => {
    if (!(script instanceof appGlide.Script) || script instanceof otherGlide.Script) {
      throw new Error("The ESM adapter did not use the caller-supplied GLIDE Script constructor");
    }
    if (options.decoder !== appGlide.Decoder.Bytes) {
      throw new Error("The ESM adapter did not use the caller-supplied GLIDE byte decoder");
    }
    return 2;
  },
}, appGlide);
try {
  await adapter.write({ valueKey: "value", cacheTtlMs: 1_000, value: "payload" });
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
  const adapter = glide.createValkeyGlideDialCacheClient({
    invokeScript: async (script, options) => {
      if (!(script instanceof appGlide.Script) || script instanceof otherGlide.Script) {
        throw new Error("The CommonJS adapter did not use the caller-supplied GLIDE Script constructor");
      }
      if (options.decoder !== appGlide.Decoder.Bytes) {
        throw new Error("The CommonJS adapter did not use the caller-supplied GLIDE byte decoder");
      }
      return 2;
    },
  }, appGlide);
  try {
    await adapter.write({ valueKey: "value", cacheTtlMs: 1_000, value: "payload" });
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

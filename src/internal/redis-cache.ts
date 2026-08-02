import { performance } from "node:perf_hooks";

import { CacheLayer, type CacheConfigProvider, type DialCacheKeyConfig } from "../config.js";
import { RedisReadTimeoutError } from "../errors.js";
import { invalidationPrefix, redisClusterHashTag, type DialCacheKey } from "../key.js";
import {
  labelsFor,
  REMOTE_SHADOW_CACHE_LAYER,
  type DialCacheMetricsAdapter,
  type MetricErrorKind,
  type MetricLayer,
  type StaleRecoveryOutcome,
} from "../metrics.js";
import type { DialCacheRedisClient, RedisCachePayload } from "../redis-client.js";
import { JsonSerializer, type Serializer } from "../serializer.js";
import type { RedisCacheGetResult } from "./cache-result.js";
import { assertValidDeadlineMs, withMonotonicDeadline } from "./deadline.js";
import { cacheTtlSecToMs } from "./duration.js";
import {
  fetchKeyConfig,
  resolveRemoteLayerConfigResult,
  type ResolvedRemoteLayerConfig,
} from "./runtime-config.js";

export interface RedisConfig {
  /**
   * Caller-created, connected, and lifecycle-owned semantic Redis client.
   * DialCache borrows it and never drains, disposes, or closes it.
   */
  readonly client: DialCacheRedisClient;
  /**
   * Instance-level remote-read deadline in milliseconds. Per-use-case runtime
   * config can override it. Defaults to 50 ms.
   */
  readonly readTimeoutMs?: number;
  readonly serializer?: Serializer<unknown>;
}

interface RedisCacheOptions {
  readonly configProvider: CacheConfigProvider;
  readonly redis: RedisConfig;
  readonly metrics: DialCacheMetricsAdapter | null;
}

interface StartedRedisRead {
  /** Result bounded by the effective Redis read deadline. */
  readonly result: Promise<RedisCachePayload | null>;
  /** Fulfills only after the underlying semantic Redis read settles. */
  readonly settled: Promise<void>;
}

type RedisStaleRecoveryResult<T> =
  | { readonly status: "hit"; readonly value: T }
  | { readonly status: "miss" }
  | { readonly status: "error"; readonly error: unknown };

const defaultSerializer = new JsonSerializer<unknown>();
const REDIS_FRAME_KEY_SUFFIX = ":dialcache-frame-v1";
const DEFAULT_REMOTE_READ_TIMEOUT_MS = 50;

export class RedisCache {
  private readonly configProvider: CacheConfigProvider;
  private readonly defaultSerializer: Serializer<unknown>;
  private readonly client: DialCacheRedisClient;
  private readonly metrics: DialCacheMetricsAdapter | null;
  readonly readTimeoutMs: number;

  constructor(options: RedisCacheOptions) {
    if (Object.hasOwn(options.redis, "keyPrefix")) {
      throw new TypeError("RedisConfig.keyPrefix was removed; use DialCacheConfig.namespace for cache identity");
    }
    if (Object.hasOwn(options.redis, "createClient")) {
      throw new TypeError(
        "RedisConfig.createClient was removed; create and connect a client, then pass it as RedisConfig.client",
      );
    }
    if (Object.hasOwn(options.redis, "watermarkTtlSec")) {
      throw new TypeError("RedisConfig.watermarkTtlSec was removed; watermark lifetime is derived by DialCache");
    }

    this.configProvider = options.configProvider;
    this.defaultSerializer = options.redis.serializer ?? defaultSerializer;
    this.metrics = options.metrics;
    this.readTimeoutMs = options.redis.readTimeoutMs === undefined
      ? DEFAULT_REMOTE_READ_TIMEOUT_MS
      : options.redis.readTimeoutMs;
    assertValidDeadlineMs(this.readTimeoutMs, "Redis readTimeoutMs");

    if (options.redis.client === undefined) {
      throw new TypeError("Redis config requires client");
    }
    if (options.redis.client.enforcesMaxAge !== true) {
      throw new TypeError("DialCache Redis client must declare enforcesMaxAge: true");
    }

    this.client = options.redis.client;
  }

  async get<T>(key: DialCacheKey): Promise<T | undefined> {
    const result = await this.getResult<T>(key);
    return result.status === "hit" ? result.value : undefined;
  }

  async getResult<T>(key: DialCacheKey, keyConfig?: DialCacheKeyConfig | null): Promise<RedisCacheGetResult<T>> {
    const layerConfig = await this.resolveRemoteLayerConfig(key, keyConfig);
    if (layerConfig.status === "disabled") {
      return layerConfig;
    }

    return await this.getWithResolvedConfig(
      key,
      layerConfig.config,
      keyConfig?.remoteReadTimeoutMs ?? this.readTimeoutMs,
    );
  }

  async getWithResolvedConfig<T>(
    key: DialCacheKey,
    layerConfig: ResolvedRemoteLayerConfig,
    readTimeoutMs = this.readTimeoutMs,
  ): Promise<RedisCacheGetResult<T>> {
    const metricLayer = CacheLayer.REMOTE;
    const start = performance.now();
    this.recordMetric((metrics) => metrics.request(labelsFor(key, metricLayer)));
    try {
      let payload: RedisCachePayload | null;
      try {
        payload = await this.startPayloadRead(
          key,
          cacheTtlSecToMs(layerConfig.ttlSec),
          readTimeoutMs,
          false,
        ).result;
      } catch (error) {
        this.recordError(
          key,
          metricLayer,
          error instanceof RedisReadTimeoutError ? "cache_read_timeout" : "cache_read",
        );
        throw error;
      }
      if (payload === null) {
        this.recordMetric((metrics) => metrics.miss(labelsFor(key, metricLayer)));
        return { status: "miss", config: layerConfig };
      }

      try {
        const value = await this.deserializePayload<T>(key, payload, metricLayer);
        return { status: "hit", value, payload };
      } catch {
        this.recordMetric((metrics) => metrics.miss(labelsFor(key, metricLayer)));
        return { status: "miss", config: layerConfig, skipStaleRecovery: true };
      }
    } finally {
      // Preserve the established caller-serving boundary: Redis read plus load.
      this.recordMetric((metrics) => metrics.observeGet(labelsFor(key, metricLayer), elapsedSeconds(start)));
    }
  }

  /**
   * Reread a definitive normal miss after the source rejects, using the
   * configured absolute recovery age. Every failure is contained so it cannot
   * replace the original source rejection held by the caller.
   */
  async recoverWithResolvedConfig<T>(
    key: DialCacheKey,
    layerConfig: ResolvedRemoteLayerConfig,
    readTimeoutMs: number,
  ): Promise<RedisStaleRecoveryResult<T>> {
    const metricLayer = CacheLayer.REMOTE;
    const maxAgeSec = layerConfig.staleOnErrorMaxAgeSec;
    if (maxAgeSec === null) {
      throw new Error("DialCache stale recovery requires an enabled maximum age");
    }

    const start = performance.now();
    this.recordMetric((metrics) => metrics.request(labelsFor(key, metricLayer)));
    try {
      let payload: RedisCachePayload | null;
      try {
        payload = await this.startPayloadRead(
          key,
          cacheTtlSecToMs(maxAgeSec),
          readTimeoutMs,
          false,
        ).result;
      } catch (error) {
        const outcome = error instanceof RedisReadTimeoutError ? "read_timeout" : "read_error";
        this.recordError(
          key,
          metricLayer,
          error instanceof RedisReadTimeoutError ? "cache_read_timeout" : "cache_read",
        );
        this.recordStaleRecovery(key, outcome);
        return { status: "error", error };
      }

      if (payload === null) {
        this.recordMetric((metrics) => metrics.miss(labelsFor(key, metricLayer)));
        this.recordStaleRecovery(key, "miss");
        return { status: "miss" };
      }

      try {
        const value = await this.deserializePayload<T>(key, payload, metricLayer);
        this.recordStaleRecovery(key, "served");
        return { status: "hit", value };
      } catch {
        this.recordMetric((metrics) => metrics.miss(labelsFor(key, metricLayer)));
        this.recordStaleRecovery(key, "deserialization_error");
        return { status: "miss" };
      }
    } finally {
      this.recordMetric((metrics) => metrics.observeGet(labelsFor(key, metricLayer), elapsedSeconds(start)));
    }
  }

  /**
   * Decode the retained Redis payload again for detached semantic comparison,
   * recording it separately from caller-serving Redis work.
   */
  async deserializeForShadow<T>(key: DialCacheKey, payload: RedisCachePayload): Promise<T> {
    return await this.deserializePayload<T>(key, payload, REMOTE_SHADOW_CACHE_LAYER);
  }

  /**
   * Start a measured tracked Redis read for detached shadow work.
   *
   * The bounded result may reject before the semantic client operation settles,
   * so callers must retain shadow capacity until `settled` fulfills.
   */
  startTrackedPayloadReadForShadow(
    key: DialCacheKey,
    maxAgeSec: number,
    readTimeoutMs: number,
  ): StartedRedisRead {
    if (!key.trackForInvalidation) {
      throw new Error("DialCache shadow Redis reads require tracked keys");
    }
    return this.startMeasuredPayloadRead(
      key,
      cacheTtlSecToMs(maxAgeSec),
      readTimeoutMs,
      REMOTE_SHADOW_CACHE_LAYER,
      true,
    );
  }

  async put<T>(key: DialCacheKey, value: T, config?: ResolvedRemoteLayerConfig): Promise<boolean> {
    const retentionTtlSec = config === undefined
      ? await this.resolveRemoteRetentionTtlSec(key)
      : retentionTtlSecFor(config);
    if (retentionTtlSec === null) {
      return true;
    }
    return await this.putWithLayer(key, value, retentionTtlSec, CacheLayer.REMOTE);
  }

  /** Populate a definitive detached tracked miss using the caller's resolved policy snapshot. */
  async putForShadow<T>(
    key: DialCacheKey,
    value: T,
    config: ResolvedRemoteLayerConfig,
    shouldWrite: () => boolean,
  ): Promise<boolean | null> {
    if (!key.trackForInvalidation) {
      throw new Error("DialCache shadow Redis writes require tracked keys");
    }
    return await this.putWithLayer(
      key,
      value,
      retentionTtlSecFor(config),
      REMOTE_SHADOW_CACHE_LAYER,
      shouldWrite,
    );
  }

  private putWithLayer<T>(
    key: DialCacheKey,
    value: T,
    ttlSec: number,
    metricLayer: MetricLayer,
  ): Promise<boolean>;
  private putWithLayer<T>(
    key: DialCacheKey,
    value: T,
    ttlSec: number,
    metricLayer: MetricLayer,
    shouldWrite: () => boolean,
  ): Promise<boolean | null>;
  private async putWithLayer<T>(
    key: DialCacheKey,
    value: T,
    ttlSec: number,
    metricLayer: MetricLayer,
    shouldWrite?: () => boolean,
  ): Promise<boolean | null> {
    const cacheTtlMs = cacheTtlSecToMs(ttlSec);

    const start = performance.now();
    let serialized: string | Buffer;
    try {
      serialized = await this.serializerFor(key).dump(value);
    } catch (error) {
      this.recordError(key, metricLayer, "serialization_dump");
      throw error;
    } finally {
      this.recordMetric((metrics) => metrics.observeSerialization({ ...labelsFor(key, metricLayer), operation: "dump" }, elapsedSeconds(start)));
    }
    this.recordMetric((metrics) => metrics.observeSize(labelsFor(key, metricLayer), payloadSize(serialized)));
    if (shouldWrite !== undefined && !shouldWrite()) {
      return null;
    }

    try {
      const request = {
        valueKey: this.redisKey(key),
        cacheTtlMs,
        value: serialized,
      } as const;
      return key.trackForInvalidation
        ? await this.client.write({
            ...request,
            watermarkKey: this.redisWatermarkKeyFromKey(key),
          })
        : await this.client.write(request);
    } catch (error) {
      this.recordError(key, metricLayer, "cache_write");
      throw error;
    }
  }

  async invalidate(keyType: string, id: string, futureBufferMs = 0, namespace = "urn"): Promise<void> {
    await this.client.invalidate({
      watermarkKey: this.redisWatermarkKey(namespace, keyType, id),
      futureBufferMs,
    });
  }

  redisKey(key: DialCacheKey): string {
    return `${key.urn}${REDIS_FRAME_KEY_SUFFIX}`;
  }

  redisWatermarkKey(namespace: string, keyType: string, id: string): string {
    return `${redisClusterHashTag(invalidationPrefix(namespace, keyType, id))}#watermark`;
  }

  private redisWatermarkKeyFromKey(key: DialCacheKey): string {
    return this.redisWatermarkKey(key.namespace, key.keyType, key.id);
  }

  private startPayloadRead(
    key: DialCacheKey,
    maxAgeMs: number,
    readTimeoutMs: number,
    unrefTimer: boolean,
  ): StartedRedisRead {
    const abortController = new AbortController();
    const pending = Promise.resolve().then(() =>
      this.client.read(
        {
          valueKey: this.redisKey(key),
          ...(key.trackForInvalidation ? { watermarkKey: this.redisWatermarkKeyFromKey(key) } : {}),
          maxAgeMs,
        },
        { timeoutMs: readTimeoutMs, signal: abortController.signal },
      )
    );
    const result = withMonotonicDeadline({
      timeoutMs: readTimeoutMs,
      operation: () => pending,
      onTimeout: () => abortController.abort(),
      timeoutError: () => new RedisReadTimeoutError(key.useCase, readTimeoutMs),
      unrefTimer,
    });
    return {
      result,
      settled: pending.then(
        () => undefined,
        () => undefined,
      ),
    };
  }

  private startMeasuredPayloadRead(
    key: DialCacheKey,
    maxAgeMs: number,
    readTimeoutMs: number,
    metricLayer: MetricLayer,
    unrefTimer: boolean,
  ): StartedRedisRead {
    const start = performance.now();
    this.recordMetric((metrics) => metrics.request(labelsFor(key, metricLayer)));
    const read = this.startPayloadRead(key, maxAgeMs, readTimeoutMs, unrefTimer);
    const result = read.result.then(
      (payload) => {
        if (payload === null) {
          this.recordMetric((metrics) => metrics.miss(labelsFor(key, metricLayer)));
        }
        return payload;
      },
      (error: unknown) => {
        this.recordError(
          key,
          metricLayer,
          error instanceof RedisReadTimeoutError ? "cache_read_timeout" : "cache_read",
        );
        throw error;
      },
    ).finally(() => {
      this.recordMetric((metrics) => metrics.observeGet(labelsFor(key, metricLayer), elapsedSeconds(start)));
    });
    return { result, settled: read.settled };
  }

  private async deserializePayload<T>(
    key: DialCacheKey,
    payload: RedisCachePayload,
    metricLayer: MetricLayer,
  ): Promise<T> {
    const start = performance.now();
    try {
      return await this.serializerFor(key).load(payload) as T;
    } catch (error) {
      this.recordError(key, metricLayer, "serialization_load");
      throw error;
    } finally {
      this.recordMetric((metrics) => metrics.observeSerialization(
        { ...labelsFor(key, metricLayer), operation: "load" },
        elapsedSeconds(start),
      ));
    }
  }

  private serializerFor(key: DialCacheKey): Serializer<unknown> {
    return key.serializer ?? this.defaultSerializer;
  }

  private async resolveRemoteLayerConfig(key: DialCacheKey, keyConfig?: DialCacheKeyConfig | null) {
    const config = keyConfig === undefined ? await fetchKeyConfig(this.configProvider, key) : keyConfig;
    return resolveRemoteLayerConfigResult({
      config,
      key,
    });
  }

  private async resolveRemoteRetentionTtlSec(key: DialCacheKey): Promise<number | null> {
    const layerConfig = await this.resolveRemoteLayerConfig(key);
    return layerConfig.status === "enabled" ? retentionTtlSecFor(layerConfig.config) : null;
  }

  private recordMetric(record: (metrics: DialCacheMetricsAdapter) => void): void {
    if (this.metrics === null) {
      return;
    }
    try {
      record(this.metrics);
    } catch {
      // Metrics adapters must not affect cache correctness or application fallbacks.
    }
  }

  private recordError(key: DialCacheKey, layer: MetricLayer, kind: MetricErrorKind): void {
    this.recordMetric((metrics) => metrics.error({ ...labelsFor(key, layer), error: kind, inFallback: false }));
  }

  private recordStaleRecovery(key: DialCacheKey, outcome: StaleRecoveryOutcome): void {
    this.recordMetric((metrics) => metrics.staleRecovery?.({
      cacheNamespace: key.namespace,
      useCase: key.useCase,
      keyType: key.keyType,
      outcome,
    }));
  }
}

function retentionTtlSecFor(config: ResolvedRemoteLayerConfig): number {
  return config.staleOnErrorMaxAgeSec ?? config.ttlSec;
}

function payloadSize(payload: string | Buffer): number {
  return Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload);
}

function elapsedSeconds(startMs: number): number {
  return Math.max((performance.now() - startMs) / 1000, 0);
}

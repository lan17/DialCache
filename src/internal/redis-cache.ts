import { performance } from "node:perf_hooks";

import { CacheLayer, DEFAULT_WATERMARK_TTL_SEC, type CacheConfigProvider, type CacheRampSampler, type DialCacheKeyConfig } from "../config.js";
import { RedisReadTimeoutError } from "../errors.js";
import { invalidationPrefix, redisClusterHashTag, type DialCacheKey } from "../key.js";
import { labelsFor, type DialCacheMetricsAdapter, type MetricErrorKind } from "../metrics.js";
import type { DialCacheRedisClient, RedisCachePayload } from "../redis-client.js";
import { JsonSerializer, type Serializer } from "../serializer.js";
import type { CacheGetResult } from "./cache-result.js";
import { assertValidDeadlineMs, withMonotonicDeadline } from "./deadline.js";
import { fetchKeyConfig, resolveLayerConfigResult, type ResolvedLayerConfig } from "./runtime-config.js";

export interface RedisConfig {
  /**
   * Caller-created, connected, and lifecycle-owned semantic Redis client.
   * DialCache borrows it and never drains, disposes, or closes it. The client
   * still needs finite native budgets to bound work that outlives DialCache's
   * read wait deadline.
   */
  readonly client: DialCacheRedisClient;
  /**
   * Required application-selected default for how long DialCache waits for a
   * semantic Redis read. Individual cached use cases may override it.
   */
  readonly readTimeoutMs: number;
  readonly serializer?: Serializer<unknown>;
  readonly watermarkTtlSec?: number;
}

interface RedisCacheOptions {
  readonly configProvider: CacheConfigProvider;
  readonly rampSampler: CacheRampSampler;
  readonly redis: RedisConfig;
  readonly metrics: DialCacheMetricsAdapter | null;
}

const defaultSerializer = new JsonSerializer<unknown>();
const REDIS_FRAME_KEY_SUFFIX = ":dialcache-frame-v1";

export class RedisCache {
  private readonly configProvider: CacheConfigProvider;
  private readonly rampSampler: CacheRampSampler;
  private readonly defaultSerializer: Serializer<unknown>;
  private readonly watermarkTtlMs: number;
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

    if (options.redis.client === undefined) {
      throw new TypeError("Redis config requires client");
    }
    if (options.redis.readTimeoutMs === undefined) {
      throw new TypeError("Redis config requires readTimeoutMs");
    }
    assertValidDeadlineMs(options.redis.readTimeoutMs, "Redis readTimeoutMs");

    this.configProvider = options.configProvider;
    this.rampSampler = options.rampSampler;
    this.defaultSerializer = options.redis.serializer ?? defaultSerializer;
    const watermarkTtlSec = options.redis.watermarkTtlSec ?? DEFAULT_WATERMARK_TTL_SEC;
    if (!Number.isSafeInteger(watermarkTtlSec) || watermarkTtlSec <= 0) {
      throw new RangeError("Redis watermarkTtlSec must be a positive safe integer");
    }
    this.watermarkTtlMs = watermarkTtlSec * 1000;
    if (!Number.isSafeInteger(this.watermarkTtlMs)) {
      throw new RangeError("Redis watermarkTtlSec is too large");
    }
    this.metrics = options.metrics;
    this.client = options.redis.client;
    this.readTimeoutMs = options.redis.readTimeoutMs;
  }

  async get<T>(key: DialCacheKey): Promise<T | undefined> {
    const result = await this.getResult<T>(key);
    return result.status === "hit" ? result.value : undefined;
  }

  async getResult<T>(key: DialCacheKey, keyConfig?: DialCacheKeyConfig | null): Promise<CacheGetResult<T>> {
    const layerConfig = await this.resolveRemoteLayerConfig(key, keyConfig);
    if (layerConfig.status === "disabled") {
      return layerConfig;
    }

    return await this.getWithResolvedConfig(key, layerConfig.config);
  }

  async getWithResolvedConfig<T>(
    key: DialCacheKey,
    layerConfig: ResolvedLayerConfig,
    readTimeoutMs = this.readTimeoutMs,
  ): Promise<CacheGetResult<T>> {
    let payload: RedisCachePayload | null;
    try {
      const redisKey = this.redisKey(key);
      const request = {
        valueKey: redisKey,
        ...(key.trackForInvalidation ? { watermarkKey: this.redisWatermarkKeyFromKey(key) } : {}),
      };
      const controller = new AbortController();
      payload = await withMonotonicDeadline({
        operation: () => this.client.read(request, {
          timeoutMs: readTimeoutMs,
          signal: controller.signal,
        }),
        timeoutMs: readTimeoutMs,
        timeoutError: () => new RedisReadTimeoutError(key.useCase, readTimeoutMs),
        onTimeout: () => controller.abort(),
      });
    } catch (error) {
      this.recordError(key, "cache_read");
      throw error;
    }
    if (payload === null) {
      return { status: "miss", config: layerConfig };
    }

    const start = performance.now();
    try {
      const value = (await this.serializerFor(key).load(payload)) as T;
      return { status: "hit", value };
    } catch {
      this.recordError(key, "serialization_load");
      return { status: "miss", config: layerConfig };
    } finally {
      this.recordMetric((metrics) => metrics.observeSerialization({ ...labelsFor(key, CacheLayer.REMOTE), operation: "load" }, elapsedSeconds(start)));
    }
  }

  async put<T>(key: DialCacheKey, value: T, config?: { readonly ttlSec: number }): Promise<boolean> {
    const ttlSec = config?.ttlSec ?? await this.resolveRemoteTtlSec(key);
    if (ttlSec === null) {
      return true;
    }

    const start = performance.now();
    let serialized: string | Buffer;
    try {
      serialized = await this.serializerFor(key).dump(value);
    } catch (error) {
      this.recordError(key, "serialization_dump");
      throw error;
    } finally {
      this.recordMetric((metrics) => metrics.observeSerialization({ ...labelsFor(key, CacheLayer.REMOTE), operation: "dump" }, elapsedSeconds(start)));
    }
    this.recordMetric((metrics) => metrics.observeSize(labelsFor(key, CacheLayer.REMOTE), payloadSize(serialized)));

    try {
      const cacheTtlMs = ttlSec * 1000;
      if (!Number.isSafeInteger(cacheTtlMs)) {
        throw new RangeError("Redis cache TTL is too large");
      }
      const request = {
        valueKey: this.redisKey(key),
        cacheTtlMs,
        value: serialized,
      } as const;
      return key.trackForInvalidation
        ? await this.client.write({
            ...request,
            watermarkKey: this.redisWatermarkKeyFromKey(key),
            watermarkTtlFloorMs: this.watermarkTtlMs,
          })
        : await this.client.write(request);
    } catch (error) {
      this.recordError(key, "cache_write");
      throw error;
    }
  }

  async invalidate(keyType: string, id: string, futureBufferMs = 0, namespace = "urn"): Promise<void> {
    await this.client.invalidate({
      watermarkKey: this.redisWatermarkKey(namespace, keyType, id),
      futureBufferMs,
      watermarkTtlFloorMs: this.watermarkTtlMs,
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

  private serializerFor(key: DialCacheKey): Serializer<unknown> {
    return key.serializer ?? this.defaultSerializer;
  }

  private async resolveRemoteLayerConfig(key: DialCacheKey, keyConfig?: DialCacheKeyConfig | null) {
    const config = keyConfig === undefined ? await fetchKeyConfig(this.configProvider, key) : keyConfig;
    return await resolveLayerConfigResult({
      config,
      key,
      layer: CacheLayer.REMOTE,
      rampSampler: this.rampSampler,
    });
  }

  private async resolveRemoteTtlSec(key: DialCacheKey): Promise<number | null> {
    const layerConfig = await this.resolveRemoteLayerConfig(key);
    return layerConfig.status === "enabled" ? layerConfig.config.ttlSec : null;
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

  private recordError(key: DialCacheKey, kind: MetricErrorKind): void {
    this.recordMetric((metrics) => metrics.error({ ...labelsFor(key, CacheLayer.REMOTE), error: kind, inFallback: false }));
  }
}

function payloadSize(payload: string | Buffer): number {
  return Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload);
}

function elapsedSeconds(startMs: number): number {
  return Math.max((performance.now() - startMs) / 1000, 0);
}

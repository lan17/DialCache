import { performance } from "node:perf_hooks";

import { CacheLayer, type CacheConfigProvider, type DialCacheKeyConfig } from "../config.js";
import { RedisReadTimeoutError } from "../errors.js";
import { invalidationPrefix, redisClusterHashTag, type DialCacheKey } from "../key.js";
import { labelsFor, type DialCacheMetricsAdapter, type MetricErrorKind } from "../metrics.js";
import type { DialCacheRedisClient, RedisCachePayload } from "../redis-client.js";
import { JsonSerializer, type Serializer } from "../serializer.js";
import type { RedisCacheGetResult } from "./cache-result.js";
import { assertValidDeadlineMs, withMonotonicDeadline } from "./deadline.js";
import { fetchKeyConfig, resolveLayerConfigResult, type ResolvedLayerConfig } from "./runtime-config.js";

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
    layerConfig: ResolvedLayerConfig,
    readTimeoutMs = this.readTimeoutMs,
  ): Promise<RedisCacheGetResult<T>> {
    let payload: RedisCachePayload | null;
    const abortController = new AbortController();
    try {
      const redisKey = this.redisKey(key);
      payload = await withMonotonicDeadline({
        timeoutMs: readTimeoutMs,
        operation: () => this.client.read(
          {
            valueKey: redisKey,
            ...(key.trackForInvalidation ? { watermarkKey: this.redisWatermarkKeyFromKey(key) } : {}),
          },
          { timeoutMs: readTimeoutMs, signal: abortController.signal },
        ),
        onTimeout: () => abortController.abort(),
        timeoutError: () => new RedisReadTimeoutError(key.useCase, readTimeoutMs),
      });
    } catch (error) {
      this.recordError(key, error instanceof RedisReadTimeoutError ? "cache_read_timeout" : "cache_read");
      throw error;
    }
    if (payload === null) {
      return { status: "miss", config: layerConfig };
    }

    const start = performance.now();
    try {
      const value = (await this.serializerFor(key).load(payload)) as T;
      return { status: "hit", value, payload };
    } catch {
      this.recordError(key, "serialization_load");
      return { status: "miss", config: layerConfig };
    } finally {
      this.recordMetric((metrics) => metrics.observeSerialization({ ...labelsFor(key, CacheLayer.REMOTE), operation: "load" }, elapsedSeconds(start)));
    }
  }

  /**
   * Serialize a source-of-truth value with the same effective serializer as
   * the Redis entry, without recording ordinary cache-write telemetry.
   */
  async serializeForShadow<T>(key: DialCacheKey, value: T): Promise<RedisCachePayload> {
    return await this.serializerFor(key).dump(value);
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
    return resolveLayerConfigResult({
      config,
      key,
      layer: CacheLayer.REMOTE,
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

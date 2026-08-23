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
} from "../metrics.js";
import type { DecodedRedisFrame, DialCacheRedisClient, RedisCachePayload } from "../redis-client.js";
import { JsonSerializer, type Serializer } from "../serializer.js";
import type { RedisCacheGetResult } from "./cache-result.js";
import {
  compressPayload,
  decompressPayload,
  escapeRawPayload,
  resolveCompressionConfig,
  type CompressionConfig,
} from "./compression.js";
import { assertValidDeadlineMs, withMonotonicDeadline } from "./deadline.js";
import { cacheTtlSecToMs } from "./duration.js";
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
  /**
   * Write-side compression policy for serialized payloads. Enabled by default
   * with a 4096-byte threshold; pass false to store every payload
   * uncompressed. Reads always decompress marked payloads regardless of this
   * setting, so disabling compression never orphans existing entries.
   */
  readonly compression?: CompressionConfig | false;
}

interface RedisCacheOptions {
  readonly configProvider: CacheConfigProvider;
  readonly redis: RedisConfig;
  readonly metrics: DialCacheMetricsAdapter | null;
}

interface StartedRedisRead {
  /** Result bounded by the effective Redis read deadline. */
  readonly result: Promise<DecodedRedisFrame | null>;
  /** Fulfills only after the underlying semantic Redis read settles. */
  readonly settled: Promise<void>;
}

const defaultSerializer = new JsonSerializer<unknown>();
const REDIS_FRAME_KEY_SUFFIX = ":dialcache-frame-v1";
const DEFAULT_REMOTE_READ_TIMEOUT_MS = 50;

export class RedisCache {
  private readonly configProvider: CacheConfigProvider;
  private readonly defaultSerializer: Serializer<unknown>;
  private readonly compression: Required<CompressionConfig> | null;
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
    this.compression = resolveCompressionConfig(options.redis.compression);
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
    const metricLayer = CacheLayer.REMOTE;
    const start = performance.now();
    this.recordMetric((metrics) => metrics.request(labelsFor(key, metricLayer)));
    try {
      let frame: DecodedRedisFrame | null;
      try {
        frame = await this.startPayloadRead(key, readTimeoutMs, metricLayer, false).result;
      } catch (error) {
        this.recordError(
          key,
          metricLayer,
          error instanceof RedisReadTimeoutError ? "cache_read_timeout" : "cache_read",
        );
        throw error;
      }
      if (frame === null) {
        this.recordMetric((metrics) => metrics.miss(labelsFor(key, metricLayer)));
        return { status: "miss", config: layerConfig };
      }

      try {
        const value = await this.deserializePayload<T>(key, frame.payload, metricLayer);
        return { status: "hit", value, frame };
      } catch {
        this.recordMetric((metrics) => metrics.miss(labelsFor(key, metricLayer)));
        return { status: "miss", config: layerConfig };
      }
    } finally {
      // Preserve the established caller-serving boundary: Redis read plus load.
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
   * Start a measured Redis read for detached shadow work.
   *
   * The bounded result may reject before the semantic client operation settles,
   * so callers must retain shadow capacity until `settled` fulfills.
   */
  startPayloadReadForShadow(
    key: DialCacheKey,
    readTimeoutMs: number,
  ): StartedRedisRead {
    return this.startMeasuredPayloadRead(
      key,
      readTimeoutMs,
      REMOTE_SHADOW_CACHE_LAYER,
      true,
    );
  }

  async put<T>(key: DialCacheKey, value: T, config?: { readonly ttlSec: number }): Promise<boolean> {
    const ttlSec = config?.ttlSec ?? await this.resolveRemoteTtlSec(key);
    if (ttlSec === null) {
      return true;
    }
    return await this.putWithLayer(key, value, ttlSec, CacheLayer.REMOTE);
  }

  /** Populate a clean detached Redis miss using the caller's resolved policy snapshot. */
  async putForShadow<T>(
    key: DialCacheKey,
    value: T,
    config: { readonly ttlSec: number },
    shouldWrite: () => boolean,
  ): Promise<boolean | null> {
    return await this.putWithLayer(
      key,
      value,
      config.ttlSec,
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
    if (this.compression !== null) {
      const compressStart = performance.now();
      let compression;
      try {
        compression = compressPayload(serialized, this.compression);
      } catch (error) {
        this.recordError(key, metricLayer, "compression");
        throw error;
      }
      serialized = compression.payload;
      this.recordMetric((metrics) => metrics.compression?.({ ...labelsFor(key, metricLayer), outcome: compression.outcome }));
      if (compression.outcome === "compressed" || compression.outcome === "not_smaller") {
        this.recordMetric((metrics) => metrics.observeCompression?.(
          { ...labelsFor(key, metricLayer), operation: "compress" },
          elapsedSeconds(compressStart),
        ));
      }
      if (compression.outcome === "compressed") {
        this.recordMetric((metrics) =>
          metrics.observeCompressionRatio?.(labelsFor(key, metricLayer), compression.storedBytes / compression.originalBytes));
      }
    } else {
      serialized = escapeRawPayload(serialized);
    }
    this.recordMetric((metrics) => metrics.observeStoredSize?.(labelsFor(key, metricLayer), payloadSize(serialized)));
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
    readTimeoutMs: number,
    metricLayer: MetricLayer,
    unrefTimer: boolean,
  ): StartedRedisRead {
    const abortController = new AbortController();
    const pending = Promise.resolve().then(() =>
      this.client.read(
        {
          valueKey: this.redisKey(key),
          ...(key.trackForInvalidation ? { watermarkKey: this.redisWatermarkKeyFromKey(key) } : {}),
        },
        { timeoutMs: readTimeoutMs, signal: abortController.signal },
      )
    );
    const bounded = withMonotonicDeadline({
      timeoutMs: readTimeoutMs,
      operation: () => pending,
      onTimeout: () => abortController.abort(),
      timeoutError: () => new RedisReadTimeoutError(key.useCase, readTimeoutMs),
      unrefTimer,
    });
    const result = bounded.then((frame) => this.rejectFutureFrame(key, frame, metricLayer));
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
    readTimeoutMs: number,
    metricLayer: MetricLayer,
    unrefTimer: boolean,
  ): StartedRedisRead {
    const start = performance.now();
    this.recordMetric((metrics) => metrics.request(labelsFor(key, metricLayer)));
    const read = this.startPayloadRead(key, readTimeoutMs, metricLayer, unrefTimer);
    const result = read.result.then(
      (frame) => {
        if (frame === null) {
          this.recordMetric((metrics) => metrics.miss(labelsFor(key, metricLayer)));
        }
        return frame;
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

  private rejectFutureFrame(
    key: DialCacheKey,
    frame: DecodedRedisFrame | null,
    metricLayer: MetricLayer,
  ): DecodedRedisFrame | null {
    if (frame === null) {
      return null;
    }

    const readerNowMs = Date.now();
    if (frame.createdAtMs > readerNowMs) {
      this.recordMetric((metrics) => metrics.observeFutureTimestampOffset?.(
        labelsFor(key, metricLayer),
        (frame.createdAtMs - readerNowMs) / 1_000,
      ));
      return null;
    }
    return frame;
  }

  private async deserializePayload<T>(
    key: DialCacheKey,
    payload: RedisCachePayload,
    metricLayer: MetricLayer,
  ): Promise<T> {
    const decompressStart = performance.now();
    const { payload: decompressed, outcome } = decompressPayload(payload);
    if (outcome !== "passthrough") {
      this.recordMetric((metrics) => metrics.compression?.({ ...labelsFor(key, metricLayer), outcome }));
      this.recordMetric((metrics) => metrics.observeCompression?.(
        { ...labelsFor(key, metricLayer), operation: "decompress" },
        elapsedSeconds(decompressStart),
      ));
    }
    const start = performance.now();
    try {
      return await this.serializerFor(key).load(decompressed) as T;
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

  private recordError(key: DialCacheKey, layer: MetricLayer, kind: MetricErrorKind): void {
    this.recordMetric((metrics) => metrics.error({ ...labelsFor(key, layer), error: kind, inFallback: false }));
  }
}

function payloadSize(payload: string | Buffer): number {
  return Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload);
}

function elapsedSeconds(startMs: number): number {
  return Math.max((performance.now() - startMs) / 1000, 0);
}

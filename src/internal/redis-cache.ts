import { performance } from "node:perf_hooks";

import { CacheLayer } from "../config.js";
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
import type { DecodedRedisFrame, DialCacheRedisClient, RedisCachePayload } from "../redis-client.js";
import { JsonSerializer, type Serializer } from "../serializer.js";
import type { RedisCacheGetResult, RedisCacheMissReason } from "./cache-result.js";
import {
  compressPayload,
  decompressPayload,
  escapeRawPayload,
  resolveCompressionConfig,
  type CompressionConfig,
} from "./compression.js";
import { assertValidDeadlineMs, withMonotonicDeadline } from "./deadline.js";
import { cacheTtlSecToMs, MAX_TRACKED_REDIS_VALUE_TTL_MS } from "./duration.js";
import type { ResolvedRemoteLayerConfig } from "./runtime-config.js";

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
  readonly redis: RedisConfig;
  readonly metrics: DialCacheMetricsAdapter | null;
}

interface StartedRedisRead {
  /** Result bounded by the effective Redis read deadline. */
  readonly result: Promise<DecodedRedisFrame | null>;
  /** Fulfills only after the underlying semantic Redis read settles. */
  readonly settled: Promise<void>;
}

export type FutureFramePolicy = "reject" | "retain";

type RedisStaleRecoveryResult<T> =
  | { readonly status: "hit"; readonly value: T }
  | { readonly status: "miss" };

type RedisValueReadResult<T> =
  | { readonly status: "hit"; readonly value: T; readonly frame: DecodedRedisFrame }
  | { readonly status: "miss"; readonly reason: RedisCacheMissReason };

const defaultSerializer = new JsonSerializer<unknown>();
const REDIS_FRAME_KEY_SUFFIX = ":dialcache-frame-v1";
const DEFAULT_REMOTE_READ_TIMEOUT_MS = 50;
const staleRecoveryOutcomeForMiss = {
  cache_miss: "miss",
  deserialization_error: "deserialization_error",
} as const satisfies Readonly<Record<RedisCacheMissReason, StaleRecoveryOutcome>>;

export class RedisCache {
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

  async getWithResolvedConfig<T>(
    key: DialCacheKey,
    layerConfig: ResolvedRemoteLayerConfig,
    readTimeoutMs = this.readTimeoutMs,
  ): Promise<RedisCacheGetResult<T>> {
    const result = await this.readValueWithinAge<T>(
      key,
      cacheTtlSecToMs(layerConfig.ttlSec),
      readTimeoutMs,
    );
    if (result.status === "hit") {
      return result;
    }
    return {
      status: "miss",
      config: layerConfig,
      reason: result.reason,
    };
  }

  /**
   * Reread a definitive normal miss after the source rejects, using the
   * configured absolute recovery age. Failures are classified here and
   * contained by the caller so they cannot replace the source rejection.
   */
  async recoverWithinAge<T>(
    key: DialCacheKey,
    maxAgeSec: number,
    readTimeoutMs: number,
  ): Promise<RedisStaleRecoveryResult<T>> {
    let result: RedisValueReadResult<T>;
    try {
      result = await this.readValueWithinAge<T>(key, cacheTtlSecToMs(maxAgeSec), readTimeoutMs);
    } catch (error) {
      this.recordStaleRecovery(
        key,
        error instanceof RedisReadTimeoutError ? "read_timeout" : "read_error",
      );
      throw error;
    }
    if (result.status === "hit") {
      this.recordStaleRecovery(key, "served");
      return { status: "hit", value: result.value };
    }
    this.recordStaleRecovery(key, staleRecoveryOutcomeForMiss[result.reason]);
    return { status: "miss" };
  }

  private async readValueWithinAge<T>(
    key: DialCacheKey,
    maxAgeMs: number,
    readTimeoutMs: number,
  ): Promise<RedisValueReadResult<T>> {
    const metricLayer = CacheLayer.REMOTE;
    const start = performance.now();
    this.recordMetric((metrics) => metrics.request(labelsFor(key, metricLayer)));
    try {
      let frame: DecodedRedisFrame | null;
      try {
        frame = await this.startPayloadRead(
          key,
          maxAgeMs,
          readTimeoutMs,
          metricLayer,
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
      if (frame === null) {
        this.recordMetric((metrics) => metrics.miss(labelsFor(key, metricLayer)));
        return { status: "miss", reason: "cache_miss" };
      }

      try {
        const value = await this.deserializePayload<T>(key, frame.payload, metricLayer);
        return { status: "hit", value, frame };
      } catch {
        this.recordMetric((metrics) => metrics.miss(labelsFor(key, metricLayer)));
        return { status: "miss", reason: "deserialization_error" };
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
    maxAgeSec: number | null,
    readTimeoutMs: number,
    futureFramePolicy: FutureFramePolicy,
  ): StartedRedisRead {
    return this.startMeasuredPayloadRead(
      key,
      maxAgeSec === null ? null : cacheTtlSecToMs(maxAgeSec),
      readTimeoutMs,
      REMOTE_SHADOW_CACHE_LAYER,
      true,
      futureFramePolicy,
    );
  }

  async put<T>(key: DialCacheKey, value: T, config: ResolvedRemoteLayerConfig): Promise<void> {
    await this.putWithLayer(key, value, retentionTtlSecFor(config), CacheLayer.REMOTE);
  }

  /** Populate a detached Redis miss using the caller's resolved policy snapshot. */
  async putForShadow<T>(
    key: DialCacheKey,
    value: T,
    config: ResolvedRemoteLayerConfig,
    shouldWrite: () => boolean,
  ): Promise<void> {
    await this.putWithLayer(
      key,
      value,
      retentionTtlSecFor(config),
      REMOTE_SHADOW_CACHE_LAYER,
      shouldWrite,
    );
  }

  private async putWithLayer<T>(
    key: DialCacheKey,
    value: T,
    ttlSec: number,
    metricLayer: MetricLayer,
    shouldWrite?: () => boolean,
  ): Promise<void> {
    const configuredTtlMs = cacheTtlSecToMs(ttlSec);
    const cacheTtlMs = key.trackForInvalidation
      ? Math.min(configuredTtlMs, MAX_TRACKED_REDIS_VALUE_TTL_MS)
      : configuredTtlMs;

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
      return;
    }
    if (cacheTtlMs < configuredTtlMs) {
      this.recordError(key, metricLayer, "tracked_ttl_clamped");
    }

    try {
      await this.client.write({
        valueKey: this.redisKey(key),
        cacheTtlMs,
        value: serialized,
      });
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
    maxAgeMs: number | null,
    readTimeoutMs: number,
    metricLayer: MetricLayer,
    unrefTimer: boolean,
    futureFramePolicy: FutureFramePolicy = "reject",
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
    const result = bounded.then((frame) =>
      this.validateFrameAge(key, frame, maxAgeMs, metricLayer, futureFramePolicy));
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
    maxAgeMs: number | null,
    readTimeoutMs: number,
    metricLayer: MetricLayer,
    unrefTimer: boolean,
    futureFramePolicy: FutureFramePolicy,
  ): StartedRedisRead {
    const start = performance.now();
    this.recordMetric((metrics) => metrics.request(labelsFor(key, metricLayer)));
    const read = this.startPayloadRead(
      key,
      maxAgeMs,
      readTimeoutMs,
      metricLayer,
      unrefTimer,
      futureFramePolicy,
    );
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

  private validateFrameAge(
    key: DialCacheKey,
    frame: DecodedRedisFrame | null,
    maxAgeMs: number | null,
    metricLayer: MetricLayer,
    futureFramePolicy: FutureFramePolicy,
  ): DecodedRedisFrame | null {
    if (frame === null) {
      return null;
    }
    if (!Number.isSafeInteger(frame.createdAtMs) || frame.createdAtMs < 0) {
      return null;
    }

    const readerNowMs = Date.now();
    if (frame.createdAtMs > readerNowMs) {
      const offsetSeconds = (frame.createdAtMs - readerNowMs) / 1_000;
      if (Number.isFinite(offsetSeconds)) {
        this.recordMetric((metrics) => metrics.observeFutureTimestampOffset?.(
          labelsFor(key, metricLayer),
          offsetSeconds,
        ));
      }
      return futureFramePolicy === "reject" ? null : frame;
    }
    return maxAgeMs === null || readerNowMs - frame.createdAtMs < maxAgeMs ? frame : null;
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

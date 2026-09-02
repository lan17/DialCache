import { performance } from "node:perf_hooks";

import { CacheLayer } from "../config.js";
import { RedisReadTimeoutError } from "../errors.js";
import { invalidationPrefix, redisClusterHashTag, type DialCacheKey } from "../key.js";
import {
  labelsFor,
  REMOTE_SHADOW_CACHE_LAYER,
  type CacheMissReason,
  type DialCacheMetricsAdapter,
  type MetricErrorKind,
  type MetricLayer,
  type StaleRecoveryOutcome,
} from "../metrics.js";
import {
  isRedisReadMiss,
  isRedisWatermarkMiss,
  type DecodedRedisFrame,
  type DialCacheRedisClient,
  type RedisCachePayload,
  type RedisReadMiss,
  type RedisReadResult,
  type RedisWatermarkMiss,
} from "../redis-client.js";
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
import { cacheTtlSecToMs, MAX_TRACKED_REDIS_VALUE_TTL_MS } from "./duration.js";
import { assertValidRedisTimestampMs } from "./redis-payload.js";
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
  readonly result: Promise<RedisReadResult>;
  /** Fulfills only after the underlying semantic Redis read settles. */
  readonly settled: Promise<void>;
}

export type FutureFramePolicy = "reject" | "retain";

type RedisStaleRecoveryResult<T> =
  | { readonly status: "hit"; readonly value: T }
  | { readonly status: "miss" };

type FrameAgeResult =
  | { readonly status: "valid"; readonly ageMs: number }
  | { readonly status: "future" }
  | { readonly status: "invalid" };

const defaultSerializer = new JsonSerializer<unknown>();
const REDIS_FRAME_KEY_SUFFIX = ":dialcache-frame-v1";
const DEFAULT_REMOTE_READ_TIMEOUT_MS = 50;

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
    const freshAgeMs = cacheTtlSecToMs(layerConfig.ttlSec);
    const maximumAgeMs = cacheTtlSecToMs(
      layerConfig.staleOnErrorMaxAgeSec ?? layerConfig.ttlSec,
    );
    const metricLayer = CacheLayer.REMOTE;
    const start = performance.now();
    this.recordMetric((metrics) => metrics.request(labelsFor(key, metricLayer)));
    try {
      let result: RedisReadResult;
      try {
        result = await this.startRawPayloadRead(
          key,
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
      if (isRedisReadMiss(result)) {
        this.recordMiss(key, metricLayer, missReason(result));
        return isRedisWatermarkMiss(result)
          ? { status: "miss", config: layerConfig, reason: "cache_miss", watermarkMiss: result }
          : { status: "miss", config: layerConfig, reason: "cache_miss" };
      }
      if (result === null) {
        this.recordMiss(key, metricLayer, "unclassified");
        return { status: "miss", config: layerConfig, reason: "cache_miss" };
      }

      // Classify the raw value/watermark snapshot from one application-clock
      // sample after the bounded read settles. M is the absolute ceiling and F
      // remains the ordinary serving boundary.
      const frameAge = this.frameAge(key, result, metricLayer);
      if (frameAge.status !== "valid") {
        this.recordMiss(key, metricLayer, "unclassified");
        return { status: "miss", config: layerConfig, reason: "cache_miss" };
      }
      if (frameAge.ageMs >= maximumAgeMs) {
        this.recordMiss(key, metricLayer, "expired");
        return { status: "miss", config: layerConfig, reason: "cache_miss" };
      }
      if (frameAge.ageMs >= freshAgeMs) {
        this.recordMiss(key, metricLayer, "expired");
        return { status: "retained", config: layerConfig, frame: result };
      }

      try {
        const value = await this.deserializePayload<T>(key, result.payload, metricLayer);
        return { status: "hit", value, frame: result };
      } catch {
        this.recordMiss(key, metricLayer, "unclassified");
        return { status: "miss", config: layerConfig, reason: "deserialization_error" };
      }
    } finally {
      // Preserve the caller-serving boundary: Redis read plus any ordinary
      // fresh-value load. A retained candidate is loaded only after the source
      // rejects and is not another Redis operation.
      this.recordMetric((metrics) => metrics.observeGet(labelsFor(key, metricLayer), elapsedSeconds(start)));
    }
  }

  /**
   * Use the raw F..M frame retained by the initial read. No Redis command is
   * issued here. The age is checked both before and after the potentially
   * asynchronous serializer so the value is below M when it actually serves.
   */
  async recoverRetainedCandidate<T>(
    key: DialCacheKey,
    frame: DecodedRedisFrame | null,
    maxAgeSec: number,
  ): Promise<RedisStaleRecoveryResult<T>> {
    if (frame === null) {
      this.recordStaleRecovery(key, "miss");
      return { status: "miss" };
    }

    const maximumAgeMs = cacheTtlSecToMs(maxAgeSec);
    const initialAge = this.frameAge(key, frame, CacheLayer.REMOTE);
    if (initialAge.status !== "valid" || initialAge.ageMs >= maximumAgeMs) {
      this.recordStaleRecovery(key, "miss");
      return { status: "miss" };
    }

    let value: T;
    try {
      value = await this.deserializePayload<T>(key, frame.payload, CacheLayer.REMOTE);
    } catch {
      this.recordStaleRecovery(key, "deserialization_error");
      return { status: "miss" };
    }

    const servingAge = this.frameAge(key, frame, CacheLayer.REMOTE);
    if (servingAge.status !== "valid" || servingAge.ageMs >= maximumAgeMs) {
      this.recordStaleRecovery(key, "miss");
      return { status: "miss" };
    }
    this.recordStaleRecovery(key, "served", servingAge.ageMs / 1_000);
    return { status: "hit", value };
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

  async put<T>(
    key: DialCacheKey,
    value: T,
    config: ResolvedRemoteLayerConfig,
    watermarkMiss?: RedisWatermarkMiss,
  ): Promise<void> {
    await this.putWithLayer(
      key,
      value,
      retentionTtlSecFor(config),
      CacheLayer.REMOTE,
      undefined,
      watermarkMiss,
    );
  }

  /** Populate a detached Redis miss using the caller's resolved policy snapshot. */
  async putForShadow<T>(
    key: DialCacheKey,
    value: T,
    config: ResolvedRemoteLayerConfig,
    shouldWrite: () => boolean,
    watermarkMiss?: RedisWatermarkMiss,
  ): Promise<boolean> {
    return await this.putWithLayer(
      key,
      value,
      retentionTtlSecFor(config),
      REMOTE_SHADOW_CACHE_LAYER,
      shouldWrite,
      watermarkMiss,
    );
  }

  private async putWithLayer<T>(
    key: DialCacheKey,
    value: T,
    ttlSec: number,
    metricLayer: MetricLayer,
    shouldWrite?: () => boolean,
    watermarkMiss?: RedisWatermarkMiss,
  ): Promise<boolean> {
    const configuredTtlMs = cacheTtlSecToMs(ttlSec);
    const cacheTtlMs = key.trackForInvalidation
      ? Math.min(configuredTtlMs, MAX_TRACKED_REDIS_VALUE_TTL_MS)
      : configuredTtlMs;
    const observedWatermarkMs = key.trackForInvalidation
      ? watermarkMiss?.observedWatermarkMs
      : undefined;
    if (
      observedWatermarkMs !== undefined
      && this.sampleWriteTimestamp(key, metricLayer) <= observedWatermarkMs
    ) {
      return false;
    }

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
      return false;
    }
    let createdAtMs: number | undefined;
    if (observedWatermarkMs !== undefined) {
      createdAtMs = this.sampleWriteTimestamp(key, metricLayer);
      if (createdAtMs <= observedWatermarkMs) {
        return false;
      }
    }
    if (cacheTtlMs < configuredTtlMs) {
      this.recordError(key, metricLayer, "tracked_ttl_clamped");
    }

    try {
      await this.client.write({
        valueKey: this.redisKey(key),
        cacheTtlMs,
        value: serialized,
        ...(createdAtMs === undefined ? {} : { createdAtMs }),
      });
    } catch (error) {
      this.recordError(key, metricLayer, "cache_write");
      throw error;
    }
    return true;
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
    const read = this.startRawPayloadRead(key, readTimeoutMs, unrefTimer);
    return {
      result: read.result.then((frame) =>
        this.validateFrameAge(key, frame, maxAgeMs, metricLayer, futureFramePolicy)),
      settled: read.settled,
    };
  }

  private startRawPayloadRead(
    key: DialCacheKey,
    readTimeoutMs: number,
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
    return {
      result: bounded.then((result) => this.validateReadResult(key, result)),
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
      (result) => {
        if (isRedisReadMiss(result)) {
          this.recordMiss(key, metricLayer, missReason(result));
        } else if (result === null) {
          this.recordMiss(key, metricLayer, "unclassified");
        }
        return result;
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
    result: RedisReadResult,
    maxAgeMs: number | null,
    metricLayer: MetricLayer,
    futureFramePolicy: FutureFramePolicy,
  ): RedisReadResult {
    if (result === null || isRedisReadMiss(result)) {
      return result;
    }
    // Core-side rejections never carry a refill fence. Logical age is a
    // decisive expiry; future and invalid timestamps have no attributable cause.
    const age = this.frameAge(key, result, metricLayer);
    if (age.status === "future") {
      return futureFramePolicy === "reject" ? { reason: "unclassified" } : result;
    }
    if (age.status === "invalid") {
      return { reason: "unclassified" };
    }
    return maxAgeMs === null || age.ageMs < maxAgeMs ? result : { reason: "expired" };
  }

  private validateReadResult(key: DialCacheKey, result: RedisReadResult): RedisReadResult {
    try {
      if (!isRedisReadMiss(result)) {
        return result;
      }
      const observedWatermarkMs = key.trackForInvalidation && isRedisWatermarkMiss(result)
        ? validObservedWatermarkMs(result.observedWatermarkMs)
        : undefined;
      const reason = missReason(result);
      return classifiedRedisReadMiss(
        reason === "watermark_fenced" && observedWatermarkMs === undefined
          ? "unclassified"
          : reason,
        observedWatermarkMs,
      );
    } catch {
      return null;
    }
  }

  private frameAge(
    key: DialCacheKey,
    frame: DecodedRedisFrame,
    metricLayer: MetricLayer,
  ): FrameAgeResult {
    if (!Number.isSafeInteger(frame.createdAtMs) || frame.createdAtMs < 0) {
      return { status: "invalid" };
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
      return { status: "future" };
    }
    return { status: "valid", ageMs: readerNowMs - frame.createdAtMs };
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

  private sampleWriteTimestamp(key: DialCacheKey, layer: MetricLayer): number {
    const createdAtMs = Date.now();
    try {
      assertValidRedisTimestampMs(createdAtMs);
    } catch (error) {
      this.recordError(key, layer, "cache_write");
      throw error;
    }
    return createdAtMs;
  }

  private recordMiss(key: DialCacheKey, layer: MetricLayer, reason: CacheMissReason): void {
    this.recordMetric((metrics) => metrics.miss({ ...labelsFor(key, layer), reason }));
  }

  private recordStaleRecovery(
    key: DialCacheKey,
    outcome: StaleRecoveryOutcome,
    valueAgeSeconds?: number,
  ): void {
    const labels = {
      cacheNamespace: key.namespace,
      useCase: key.useCase,
      keyType: key.keyType,
      outcome,
    } as const;
    this.recordMetric((metrics) => metrics.staleRecovery?.(labels));
    if (valueAgeSeconds !== undefined) {
      this.recordMetric((metrics) => metrics.observeStaleRecoveryValueAge?.(
        labels,
        valueAgeSeconds,
      ));
    }
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

function missReason(result: RedisReadMiss | RedisWatermarkMiss): CacheMissReason {
  return isCacheMissReason(result.reason) ? result.reason : "unclassified";
}

function classifiedRedisReadMiss(
  reason: CacheMissReason,
  observedWatermarkMs: unknown,
): RedisReadMiss | RedisWatermarkMiss {
  const observed = validObservedWatermarkMs(observedWatermarkMs);
  return observed === undefined
    ? { reason }
    : { kind: "watermark_miss", reason, observedWatermarkMs: observed };
}

function validObservedWatermarkMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function isCacheMissReason(value: unknown): value is CacheMissReason {
  return value === "value_absent"
    || value === "expired"
    || value === "watermark_fenced"
    || value === "unclassified";
}

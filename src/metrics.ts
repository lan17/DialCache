import type { CacheLayer } from "./config.js";
import type { DialCacheKey } from "./key.js";

export const NO_CACHE_LAYER = "noop";
export const REMOTE_SHADOW_CACHE_LAYER = "remote_shadow";
export const REQUEST_LOCAL_CACHE_LAYER = "request_local";

type NoCacheLayer = typeof NO_CACHE_LAYER;
type RemoteShadowCacheLayer = typeof REMOTE_SHADOW_CACHE_LAYER;
type RequestLocalCacheLayer = typeof REQUEST_LOCAL_CACHE_LAYER;
export type MetricLayer = CacheLayer | RequestLocalCacheLayer | RemoteShadowCacheLayer | NoCacheLayer;
export type CoalescingScope = "request_local" | "process";
/** Bounded terminal outcomes for sampled Redis shadow validation. */
export type ShadowValidationOutcome =
  | "match"
  | "mismatch"
  | "superseded"
  | "filled"
  | "fill_error"
  | "redis_error"
  | "source_error"
  | "deserialization_error"
  | "comparison_error"
  | "confirmation_error"
  | "timeout"
  | "dropped";
/**
 * Bounded compression outcomes. Writes record compressed, below_threshold,
 * not_smaller, or write_over_limit (serialized form exceeds the decompression
 * cap, stored raw — a capacity signal); reads record decompressed,
 * fallback_raw (a marked payload zstd rejected and handed through untouched),
 * or read_over_limit (decompression would exceed the cap; handed through
 * untouched — a corruption/integrity signal).
 */
export type CompressionOutcome =
  | "compressed"
  | "below_threshold"
  | "not_smaller"
  | "write_over_limit"
  | "decompressed"
  | "fallback_raw"
  | "read_over_limit";
/** Bounded reasons for skipping cache work; policy_disabled means a shared layer has no effective TTL. */
export type DisabledReason = "context" | "policy_disabled" | "invalid_ttl" | "invalid_ramp" | "ramped_down" | "config_error";
/** Stable failure sites used instead of backend- or application-defined error names. */
export type MetricErrorKind =
  | "key_construction"
  | "config_resolution"
  | "cache_read"
  | "cache_read_timeout"
  | "cache_write"
  | "serialization_load"
  | "serialization_dump"
  | "compression"
  | "invalidation"
  | "fallback"
  | "unknown";

export interface CacheMetricLabels {
  /** Logical DialCache namespace, independent of backend metric-name namespaces. */
  readonly cacheNamespace: string;
  readonly useCase: string;
  readonly keyType: string;
  readonly layer: MetricLayer;
}

export interface DisabledMetricLabels extends CacheMetricLabels {
  readonly reason: DisabledReason;
}

export interface ErrorMetricLabels extends CacheMetricLabels {
  readonly error: MetricErrorKind;
  readonly inFallback: boolean;
}

export interface SerializationMetricLabels extends CacheMetricLabels {
  readonly operation: "dump" | "load";
}

export interface CompressionMetricLabels extends CacheMetricLabels {
  readonly outcome: CompressionOutcome;
}

export interface CompressionOperationMetricLabels extends CacheMetricLabels {
  readonly operation: "compress" | "decompress";
}

export interface InvalidationMetricLabels {
  readonly cacheNamespace: string;
  readonly keyType: string;
  readonly layer: CacheLayer;
}

export interface CoalescedMetricLabels {
  readonly cacheNamespace: string;
  readonly useCase: string;
  readonly keyType: string;
  readonly scope: CoalescingScope;
}

export interface ShadowValidationMetricLabels {
  readonly cacheNamespace: string;
  readonly useCase: string;
  readonly keyType: string;
  readonly outcome: ShadowValidationOutcome;
}

export interface DialCacheMetricsAdapter {
  request(labels: CacheMetricLabels): void;
  miss(labels: CacheMetricLabels): void;
  disabled(labels: DisabledMetricLabels): void;
  error(labels: ErrorMetricLabels): void;
  invalidation(labels: InvalidationMetricLabels): void;
  // Optional so existing custom adapters keep compiling without changes.
  coalesced?(labels: CoalescedMetricLabels): void;
  // Optional so existing custom adapters keep compiling without changes.
  shadowValidation?(labels: ShadowValidationMetricLabels): void;
  /**
   * Age in seconds of the validated Redis value at shadow verdict time (for
   * a mismatch, after the confirming re-read): the observing process's epoch
   * clock minus the validated frame's `createdAtMs`, clamped at zero.
   * Emitted only alongside terminal `match` and `mismatch` outcomes; other
   * outcomes deliver no verdict on a retained value. Frames are stamped with
   * the writer application's epoch clock, so cross-process skew still makes
   * this coarse operational evidence rather than a precise measurement.
   * Optional so existing custom adapters keep compiling without changes.
   */
  observeShadowValueAge?(labels: ShadowValidationMetricLabels, seconds: number): void;
  /**
   * Positive offset in seconds when a decoded Redis frame is dated after the
   * observing process's epoch clock. Such frames fail closed as cache misses.
   * This is a workload-shaped diagnostic, not proof of clock skew. Optional
   * so existing custom adapters keep compiling without changes.
   */
  observeFutureTimestampOffset?(labels: CacheMetricLabels, seconds: number): void;
  // Optional so existing custom adapters keep compiling without changes.
  compression?(labels: CompressionMetricLabels): void;
  observeGet(labels: CacheMetricLabels, seconds: number): void;
  observeFallback(labels: CacheMetricLabels, seconds: number): void;
  observeSerialization(labels: SerializationMetricLabels, seconds: number): void;
  /** Serialized payload size in bytes, before compression or escaping. */
  observeSize(labels: CacheMetricLabels, bytes: number): void;
  /**
   * Stored payload size in bytes as written to Redis, after compression and
   * escaping. Optional so existing custom adapters keep compiling.
   */
  observeStoredSize?(labels: CacheMetricLabels, bytes: number): void;
  // Optional so existing custom adapters keep compiling without changes.
  observeCompressionRatio?(labels: CacheMetricLabels, ratio: number): void;
  // Optional so existing custom adapters keep compiling without changes.
  observeCompression?(labels: CompressionOperationMetricLabels, seconds: number): void;
}

export function labelsFor(key: DialCacheKey, layer: MetricLayer): CacheMetricLabels {
  return { cacheNamespace: key.namespace, useCase: key.useCase, keyType: key.keyType, layer };
}

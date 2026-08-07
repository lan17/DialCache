import type { CacheLayer } from "./config.js";
import type { DialCacheKey } from "./key.js";
import type { RedisReadMissReason } from "./redis-client.js";

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
  | "fill_blocked"
  | "fill_error"
  | "redis_error"
  | "source_error"
  | "deserialization_error"
  | "comparison_error"
  | "confirmation_error"
  | "timeout"
  | "dropped";
/** Bounded reasons for skipping cache work; policy_disabled means a shared layer has no effective TTL. */
export type DisabledReason = "context" | "policy_disabled" | "invalid_ttl" | "invalid_ramp" | "ramped_down" | "config_error";
/** Bounded reasons a cache read counted as a miss; local layers always use not_found. */
export type MissReason = RedisReadMissReason | "deserialization_failed";
/** Stable failure sites used instead of backend- or application-defined error names. */
export type MetricErrorKind =
  | "key_construction"
  | "config_resolution"
  | "cache_read"
  | "cache_read_timeout"
  | "cache_write"
  | "serialization_load"
  | "serialization_dump"
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

export interface MissMetricLabels extends CacheMetricLabels {
  readonly reason: MissReason;
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
  miss(labels: MissMetricLabels): void;
  disabled(labels: DisabledMetricLabels): void;
  error(labels: ErrorMetricLabels): void;
  invalidation(labels: InvalidationMetricLabels): void;
  // Optional so existing custom adapters keep compiling without changes.
  coalesced?(labels: CoalescedMetricLabels): void;
  // Optional so existing custom adapters keep compiling without changes.
  shadowValidation?(labels: ShadowValidationMetricLabels): void;
  observeGet(labels: CacheMetricLabels, seconds: number): void;
  observeFallback(labels: CacheMetricLabels, seconds: number): void;
  observeSerialization(labels: SerializationMetricLabels, seconds: number): void;
  observeSize(labels: CacheMetricLabels, bytes: number): void;
}

export function labelsFor(key: DialCacheKey, layer: MetricLayer): CacheMetricLabels {
  return { cacheNamespace: key.namespace, useCase: key.useCase, keyType: key.keyType, layer };
}

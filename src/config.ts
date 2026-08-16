import type { DialCacheKey } from "./key.js";
import type { DialCacheMetricsAdapter } from "./metrics.js";
import type { RedisConfig } from "./internal/redis-cache.js";
import { assertValidDeadlineMs } from "./internal/deadline.js";

export enum CacheLayer {
  LOCAL = "local",
  REMOTE = "remote",
}

export type Awaitable<T> = T | Promise<T>;
export type LayerConfig = Partial<Record<CacheLayer, number>>;

/**
 * Content controls for the one warning emitted per confirmed shadow mismatch.
 * Every field defaults to false; the warning is emitted only when at least one
 * field is true. Fields merge independently at runtime, like cache-layer leaves.
 */
export interface ShadowMismatchLoggingConfig {
  /** Include the logical cache key (the DialCache URN, byte-capped). */
  readonly key?: boolean;
  /**
   * Include bounded native-JSON strings for the compared values. Values pass
   * through the use case's `shadowMismatchLogValue` projection when one is
   * defined and are logged raw otherwise.
   */
  readonly value?: boolean;
  /**
   * Include a bounded JSON diff of the compared values: the use case's
   * `shadowMismatchLogDiff` result when defined, and otherwise a structural
   * diff of the same loggable forms `value` uses.
   */
  readonly diff?: boolean;
}

/** Per-use-case runtime policy for detached Redis shadow work. */
export interface ShadowConfig {
  /** Independent stable cohort percentage. Omitted and zero disable shadow work. */
  readonly ramp?: number;
  /** Confirmed-mismatch warning content. Omitted, empty, and all-false disable the warning. */
  readonly mismatchLogging?: ShadowMismatchLoggingConfig;
}

interface DialCacheKeyConfigInput {
  readonly ttlSec?: LayerConfig;
  readonly ramp?: LayerConfig;
  readonly shadow?: ShadowConfig;
  readonly requestLocal?: boolean;
  readonly coalesce?: boolean;
  readonly remoteReadTimeoutMs?: number;
}

// `satisfies Record<keyof …, true>` fails to compile when the interface gains
// a field this set is missing, so every leaf loop stays exhaustive.
const SHADOW_MISMATCH_LOGGING_LEAF_SET = {
  key: true,
  value: true,
  diff: true,
} as const satisfies Record<keyof ShadowMismatchLoggingConfig, true>;

/** Internal: the exhaustive `ShadowMismatchLoggingConfig` field list. */
export const SHADOW_MISMATCH_LOGGING_LEAVES = Object.keys(
  SHADOW_MISMATCH_LOGGING_LEAF_SET,
) as readonly (keyof ShadowMismatchLoggingConfig)[];

const KEY_CONFIG_FIELD_SET = {
  ttlSec: true,
  ramp: true,
  shadow: true,
  requestLocal: true,
  coalesce: true,
  remoteReadTimeoutMs: true,
} as const satisfies Record<keyof DialCacheKeyConfigInput, true>;
const KEY_CONFIG_FIELDS = Object.keys(KEY_CONFIG_FIELD_SET);
const SHADOW_CONFIG_FIELD_SET = {
  ramp: true,
  mismatchLogging: true,
} as const satisfies Record<keyof ShadowConfig, true>;
const SHADOW_CONFIG_FIELDS = Object.keys(SHADOW_CONFIG_FIELD_SET);
const UNKNOWN_KEY_CONFIG_FIELDS = Symbol("DialCacheKeyConfig.unknownFields");

interface UnknownFieldMarkedConfig {
  readonly [UNKNOWN_KEY_CONFIG_FIELDS]?: true;
}

/** Internal: reports unknown own string fields without exposing their names. */
export function hasUnknownKeyConfigFields(config: unknown): boolean {
  if (!isConfigObject(config)) {
    return false;
  }
  if (
    Object.hasOwn(config, UNKNOWN_KEY_CONFIG_FIELDS)
    && (config as UnknownFieldMarkedConfig)[UNKNOWN_KEY_CONFIG_FIELDS] === true
  ) {
    return true;
  }
  if (hasUnknownOwnFields(config, KEY_CONFIG_FIELDS)) {
    return true;
  }

  const ttlSec = readOwnUnknown(config, "ttlSec");
  const ramp = readOwnUnknown(config, "ramp");
  const shadow = readOwnUnknown(config, "shadow");
  if (
    hasUnknownOwnFields(ttlSec, Object.values(CacheLayer))
    || hasUnknownOwnFields(ramp, Object.values(CacheLayer))
    || hasUnknownOwnFields(shadow, SHADOW_CONFIG_FIELDS)
  ) {
    return true;
  }

  const mismatchLogging = isConfigObject(shadow)
    ? readOwnUnknown(shadow, "mismatchLogging")
    : undefined;
  return hasUnknownOwnFields(mismatchLogging, SHADOW_MISMATCH_LOGGING_LEAVES);
}

export class DialCacheKeyConfig {
  /** Per-layer TTLs in seconds, from 1 through 31,536,000 (365 days). */
  readonly ttlSec: LayerConfig;
  readonly ramp: LayerConfig;
  /** Per-use-case runtime policy for detached Redis shadow work. */
  readonly shadow?: ShadowConfig;
  /**
   * Memoize successful values for the lifetime of the outermost enabled scope.
   * Request-local caching is disabled by default and has no TTL or ramp.
   */
  readonly requestLocal?: boolean;
  /**
   * Share one in-flight execution across concurrent same-key callers, in both
   * the request-local and process coalescing scopes. Defaults to true. When
   * false, each caller performs its own layer reads, its own fallback with an
   * independent fallback deadline, and its own cache writes.
   */
  readonly coalesce?: boolean;
  /**
   * Maximum time DialCache waits for a remote read before failing open to the
   * source of truth. Overrides the instance default for this use case.
   */
  readonly remoteReadTimeoutMs?: number;

  constructor(config: DialCacheKeyConfigInput) {
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError("DialCache key config must be an object");
    }
    const hasUnknownFields = hasUnknownKeyConfigFields(config);
    this.ttlSec = cloneLayerConfig(config.ttlSec, "ttlSec");
    this.ramp = cloneLayerConfig(config.ramp, "ramp");
    // Own-property read: `shadow` carries the log-content controls, so a
    // prototype-inherited group must not activate policy (its leaves would
    // all be own properties and pass every later gate).
    const shadow = cloneShadowConfig(Object.hasOwn(config, "shadow") ? config.shadow : undefined);
    if (shadow !== undefined) {
      this.shadow = shadow;
    }
    if (config.requestLocal !== undefined && typeof config.requestLocal !== "boolean") {
      throw new TypeError("DialCache requestLocal config must be a boolean");
    }
    if (config.requestLocal !== undefined) {
      this.requestLocal = config.requestLocal;
    }
    if (config.coalesce !== undefined && typeof config.coalesce !== "boolean") {
      throw new TypeError("DialCache coalesce config must be a boolean");
    }
    if (config.coalesce !== undefined) {
      this.coalesce = config.coalesce;
    }
    if (config.remoteReadTimeoutMs !== undefined) {
      assertValidDeadlineMs(config.remoteReadTimeoutMs, "DialCache remoteReadTimeoutMs");
      this.remoteReadTimeoutMs = config.remoteReadTimeoutMs;
    }
    if (hasUnknownFields) {
      Object.defineProperty(this, UNKNOWN_KEY_CONFIG_FIELDS, { value: true });
    }
  }

  static enabled(ttlSec: number): DialCacheKeyConfig {
    return new DialCacheKeyConfig({
      ttlSec: {
        [CacheLayer.LOCAL]: ttlSec,
        [CacheLayer.REMOTE]: ttlSec,
      },
      ramp: {
        [CacheLayer.LOCAL]: 100,
        [CacheLayer.REMOTE]: 100,
      },
    });
  }

  /**
   * The explicit cache-invocation kill switch: request-local caching and
   * shadow work off, with both shared layers ramped to 0. As a provider
   * overlay it disables every inherited path instead of relying on field
   * omission. It does not cancel admitted work or disable explicit
   * maintenance operations.
   */
  static disabled(): DialCacheKeyConfig {
    return new DialCacheKeyConfig({
      requestLocal: false,
      shadow: {
        ramp: 0,
        // `Required` keeps this kill-switch overlay exhaustive: leaves merge
        // independently, so an omitted leaf would let an inherited `true`
        // survive disabled().
        mismatchLogging: {
          key: false,
          value: false,
          diff: false,
        } satisfies Required<ShadowMismatchLoggingConfig>,
      },
      ramp: {
        [CacheLayer.LOCAL]: 0,
        [CacheLayer.REMOTE]: 0,
      },
    });
  }
}

function cloneLayerConfig(config: LayerConfig | undefined, name: "ttlSec" | "ramp"): LayerConfig {
  if (config === undefined) {
    return {};
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError(`DialCache ${name} config must be a layer map`);
  }
  const clone: LayerConfig = {};
  for (const layer of Object.values(CacheLayer)) {
    const value = Object.hasOwn(config, layer) ? config[layer] : undefined;
    if (value !== undefined) {
      clone[layer] = value;
    }
  }
  return clone;
}

function cloneShadowConfig(config: ShadowConfig | undefined): ShadowConfig | undefined {
  if (config === undefined) {
    return undefined;
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("DialCache shadow config must be an object");
  }
  const ramp = Object.hasOwn(config, "ramp") ? config.ramp : undefined;
  const mismatchLogging = Object.hasOwn(config, "mismatchLogging") ? config.mismatchLogging : undefined;
  if (mismatchLogging === undefined) {
    return ramp === undefined ? {} : { ramp };
  }
  if (mismatchLogging === null || typeof mismatchLogging !== "object" || Array.isArray(mismatchLogging)) {
    throw new TypeError("DialCache shadow mismatchLogging config must be an object");
  }
  const clonedLogging: Record<string, unknown> = {};
  for (const leaf of SHADOW_MISMATCH_LOGGING_LEAVES) {
    if (Object.hasOwn(mismatchLogging, leaf)) {
      clonedLogging[leaf] = mismatchLogging[leaf];
    }
  }
  return {
    ...(ramp === undefined ? {} : { ramp }),
    mismatchLogging: clonedLogging as ShadowMismatchLoggingConfig,
  };
}

function isConfigObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnknownOwnFields(value: unknown, knownFields: readonly string[]): boolean {
  return isConfigObject(value)
    && Object.keys(value).some((name) => !knownFields.includes(name));
}

function readOwnUnknown(source: Record<PropertyKey, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Resolves runtime cache policy. Async implementations must settle within a
 * finite application-defined deadline; DialCache does not add one.
 */
export type CacheConfigProvider = (key: DialCacheKey) => Awaitable<DialCacheKeyConfig | null>;

export type Logger = Pick<Console, "debug" | "error" | "warn">;

export interface DialCacheConfig {
  readonly cacheConfigProvider?: CacheConfigProvider;
  /**
   * Logical namespace used in cache keys, invalidation identity, ramp sampling,
   * and metrics. Defaults to "urn". May not contain `{` or `}`.
   */
  readonly namespace?: string;
  readonly logger?: Logger;
  /**
   * Maximum local entries across every use case in this DialCache instance.
   * Must be a nonnegative safe integer.
   * Zero disables local storage. Defaults to 10,000.
   */
  readonly localMaxSize?: number;
  readonly redis?: RedisConfig;
  readonly metrics?: DialCacheMetricsAdapter;
  /**
   * Maximum number of scheduled or running shadow jobs per DialCache instance,
   * including shadow-owned work that outlives a DialCache deadline. There is no
   * queue; excess jobs are dropped and measured. Must be a
   * positive safe integer. Defaults to 1.
   */
  readonly shadowMaxInFlight?: number;
}

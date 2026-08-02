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

/** Per-use-case runtime policy for detached Redis shadow work. */
export interface ShadowConfig {
  /** Independent stable cohort percentage. Omitted and zero disable shadow work. */
  readonly ramp?: number;
  /**
   * Emit one warning with the logical key and bounded native-JSON strings for
   * the compared values for each confirmed mismatch. Defaults to false.
   */
  readonly logMismatches?: boolean;
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
   * Absolute Redis-frame age in seconds through which a retained value may be
   * returned after the source of truth rejects. Omission disables recovery by
   * default and inherits in runtime overlays; zero explicitly disables an
   * inherited policy. A positive value requires a smaller positive remote TTL
   * and may not exceed 31,536,000 seconds (365 days).
   */
  readonly staleOnErrorMaxAgeSec?: number;
  /**
   * Maximum time DialCache waits for a remote read before failing open to the
   * source of truth. Overrides the instance default for this use case.
   */
  readonly remoteReadTimeoutMs?: number;

  constructor(config: {
    ttlSec?: LayerConfig;
    ramp?: LayerConfig;
    shadow?: ShadowConfig;
    requestLocal?: boolean;
    staleOnErrorMaxAgeSec?: number;
    remoteReadTimeoutMs?: number;
  }) {
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError("DialCache key config must be an object");
    }
    if (Object.hasOwn(config, "shadowRamp")) {
      throw new TypeError('DialCacheKeyConfig.shadowRamp was replaced by "shadow.ramp"');
    }
    this.ttlSec = cloneLayerConfig(config.ttlSec, "ttlSec");
    this.ramp = cloneLayerConfig(config.ramp, "ramp");
    const shadow = cloneShadowConfig(config.shadow);
    if (shadow !== undefined) {
      this.shadow = shadow;
    }
    if (config.requestLocal !== undefined && typeof config.requestLocal !== "boolean") {
      throw new TypeError("DialCache requestLocal config must be a boolean");
    }
    if (config.requestLocal !== undefined) {
      this.requestLocal = config.requestLocal;
    }
    // Like ttlSec/ramp leaves, validation is deferred to static-default capture
    // or runtime resolution so malformed runtime policy can fail open narrowly.
    if (config.staleOnErrorMaxAgeSec !== undefined) {
      this.staleOnErrorMaxAgeSec = config.staleOnErrorMaxAgeSec;
    }
    if (config.remoteReadTimeoutMs !== undefined) {
      assertValidDeadlineMs(config.remoteReadTimeoutMs, "DialCache remoteReadTimeoutMs");
      this.remoteReadTimeoutMs = config.remoteReadTimeoutMs;
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
      staleOnErrorMaxAgeSec: 0,
      shadow: {
        ramp: 0,
        logMismatches: false,
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
  return { ...config };
}

function cloneShadowConfig(config: ShadowConfig | undefined): ShadowConfig | undefined {
  if (config === undefined) {
    return undefined;
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("DialCache shadow config must be an object");
  }
  return { ...config };
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

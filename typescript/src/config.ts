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
/** Synchronously classifies whether one source rejection may use a retained Redis candidate. */
export type StaleRecoveryPredicate = (error: unknown) => boolean;

/**
 * How much of the structural difference a confirmed-mismatch warning logs:
 * `"off"` nothing, `"paths"` the JSON Pointers of the differing fields, and
 * `"values"` those pointers with the cached and source values at each one.
 */
export type ShadowMismatchDiffLevel = "off" | "paths" | "values";

/**
 * Content of the one warning emitted per confirmed shadow mismatch. Both
 * leaves default off, and the warning is emitted only when `value` is true or
 * `diff` is above `"off"`. Leaves merge independently at runtime, like
 * cache-layer leaves.
 */
export interface ShadowMismatchLoggingConfig {
  /** Include bounded native-JSON strings for both compared values. */
  readonly value?: boolean;
  /** Include the differing fields at this level. */
  readonly diff?: ShadowMismatchDiffLevel;
}

/** Per-use-case runtime policy for detached Redis shadow work. */
export interface ShadowConfig {
  /** Independent stable cohort percentage. Omitted and zero disable shadow work. */
  readonly ramp?: number;
  /**
   * Shorthand for the whole `mismatchLogging` group: `true` stands for
   * `{ value: true, diff: "values" }` and `false` for
   * `{ value: false, diff: "off" }`. Leaves written in this same object's
   * `mismatchLogging` override the expanded values before runtime overlays
   * merge.
   */
  readonly logMismatches?: boolean;
  /** Confirmed-mismatch warning content. Omitted leaves default off. */
  readonly mismatchLogging?: ShadowMismatchLoggingConfig;
}

interface DialCacheKeyConfigInput {
  readonly ttlSec?: LayerConfig;
  readonly ramp?: LayerConfig;
  readonly shadow?: ShadowConfig;
  readonly requestLocal?: boolean;
  readonly coalesce?: boolean;
  readonly staleOnErrorMaxAgeSec?: number;
  readonly remoteReadTimeoutMs?: number;
}

// `satisfies Record<keyof …, true>` fails to compile when an interface gains
// a field its set is missing, so unknown-field detection stays exhaustive.
const KEY_CONFIG_FIELDS: readonly string[] = Object.keys({
  ttlSec: true,
  ramp: true,
  shadow: true,
  requestLocal: true,
  coalesce: true,
  staleOnErrorMaxAgeSec: true,
  remoteReadTimeoutMs: true,
} as const satisfies Record<keyof DialCacheKeyConfigInput, true>);
const SHADOW_CONFIG_FIELDS: readonly string[] = Object.keys({
  ramp: true,
  logMismatches: true,
  mismatchLogging: true,
} as const satisfies Record<keyof ShadowConfig, true>);
const MISMATCH_LOGGING_FIELDS: readonly string[] = Object.keys({
  value: true,
  diff: true,
} as const satisfies Record<keyof ShadowMismatchLoggingConfig, true>);
// The removed shadowRamp field fails construction and runtime merging with its
// own migration error, so it is never also reported as unknown.
const SCANNED_KEY_CONFIG_FIELDS: readonly string[] = [...KEY_CONFIG_FIELDS, "shadowRamp"];
const LAYER_FIELDS: readonly string[] = Object.values(CacheLayer);

// A base constructor that returns its argument makes `new` on a subclass add
// the subclass's private field to that object. Stamping through this
// module-private pair keeps the answer off every enumeration and out of the
// public class type, which stays structural.
class Stamped {
  constructor(target: object) {
    return target;
  }
}

class UnknownFieldsStamp extends Stamped {
  readonly #unknownFields: boolean;

  constructor(target: DialCacheKeyConfig, unknownFields: boolean) {
    super(target);
    this.#unknownFields = unknownFields;
  }

  /** The stamped answer, or `undefined` for an object no construction stamped. */
  static read(config: object): boolean | undefined {
    return #unknownFields in config ? config.#unknownFields : undefined;
  }
}

// Set only for the next construction, which clears it before anything else.
let constructingAssembledConfig = false;

/**
 * Internal: whether a key config carries own fields DialCache does not know,
 * at the top level, in a layer map, in `shadow` or in `mismatchLogging`. A
 * constructed config answers what construction found in its input, because
 * construction drops unknown top-level and shadow fields; one DialCache
 * assembled itself answers false. Any other object, including a Proxy of a
 * constructed config, is scanned.
 */
export function hasUnknownKeyConfigFields(config: unknown): boolean {
  if (!isConfigObject(config)) {
    return false;
  }
  const stamped = UnknownFieldsStamp.read(config);
  if (stamped !== undefined) {
    return stamped;
  }
  const shadow = readOwnField(config, "shadow");
  return hasUnknownOwnFields(config, SCANNED_KEY_CONFIG_FIELDS)
    || hasUnknownOwnFields(readOwnField(config, "ttlSec"), LAYER_FIELDS)
    || hasUnknownOwnFields(readOwnField(config, "ramp"), LAYER_FIELDS)
    || hasUnknownOwnFields(shadow, SHADOW_CONFIG_FIELDS)
    || (isConfigObject(shadow)
      && hasUnknownOwnFields(readOwnField(shadow, "mismatchLogging"), MISMATCH_LOGGING_FIELDS));
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
   * Exclusive logical Redis-frame age ceiling in seconds. A value retained by
   * the initial read may be returned after an eligible source rejection only
   * while its age is less than this value; an age exactly at the ceiling is a
   * miss. Omission disables recovery by default and inherits in runtime
   * overlays; zero explicitly disables an inherited policy. A positive value
   * requires a smaller positive remote TTL and may not exceed 31,536,000
   * seconds (365 days). Tracked values retain their separate one-hour physical
   * TTL cap.
   */
  readonly staleOnErrorMaxAgeSec?: number;
  /**
   * Maximum time DialCache waits for a remote read before failing open to the
   * source of truth. Overrides the instance default for this use case.
   */
  readonly remoteReadTimeoutMs?: number;

  constructor(config: DialCacheKeyConfigInput) {
    const assembled = constructingAssembledConfig;
    constructingAssembledConfig = false;
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError("DialCache key config must be an object");
    }
    if (Object.hasOwn(config, "shadowRamp")) {
      throw new TypeError('DialCacheKeyConfig.shadowRamp was replaced by "shadow.ramp"');
    }
    const hasUnknownFields = !assembled && hasUnknownKeyConfigFields(config);
    this.ttlSec = cloneLayerConfig(config.ttlSec, "ttlSec");
    this.ramp = cloneLayerConfig(config.ramp, "ramp");
    // Own-property read: an inherited shadow group must not activate shadow
    // work or put payload data into logs.
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
    // Like ttlSec/ramp leaves, validation is deferred to static-default capture
    // or runtime resolution so malformed runtime policy can fail open narrowly.
    if (config.staleOnErrorMaxAgeSec !== undefined) {
      this.staleOnErrorMaxAgeSec = config.staleOnErrorMaxAgeSec;
    }
    if (config.remoteReadTimeoutMs !== undefined) {
      assertValidDeadlineMs(config.remoteReadTimeoutMs, "DialCache remoteReadTimeoutMs");
      this.remoteReadTimeoutMs = config.remoteReadTimeoutMs;
    }
    new UnknownFieldsStamp(this, hasUnknownFields);
  }

  static enabled(ttlSec: number): DialCacheKeyConfig {
    return assembledKeyConfig({
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
   * The explicit cache-invocation kill switch: request-local caching, stale
   * recovery, and shadow work off, with both shared layers ramped to 0. As a
   * provider overlay it disables every inherited path instead of relying on
   * field omission. It does not cancel admitted work or disable explicit
   * maintenance operations.
   */
  static disabled(): DialCacheKeyConfig {
    return assembledKeyConfig({
      requestLocal: false,
      staleOnErrorMaxAgeSec: 0,
      shadow: {
        ramp: 0,
        // `Required` keeps this overlay exhaustive: leaves merge
        // independently, so an omitted leaf would let an inherited one
        // survive disabled().
        mismatchLogging: {
          value: false,
          diff: "off",
        } satisfies Required<ShadowMismatchLoggingConfig>,
      },
      ramp: {
        [CacheLayer.LOCAL]: 0,
        [CacheLayer.REMOTE]: 0,
      },
    });
  }
}

/**
 * Internal: constructs a config DialCache assembled itself, from literals or
 * from configs it already observed, without scanning it for unknown fields.
 * A default snapshot keeps the caller's layer maps, unknown layer names
 * included; those were reported when the default was observed.
 */
export function assembledKeyConfig(input: DialCacheKeyConfigInput): DialCacheKeyConfig {
  constructingAssembledConfig = true;
  return new DialCacheKeyConfig(input);
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
  const ramp = readOwnField(config, "ramp");
  const logMismatches = readOwnField(config, "logMismatches");
  const mismatchLogging = readOwnField(config, "mismatchLogging");
  return {
    ...(ramp === undefined ? {} : { ramp }),
    ...(logMismatches === undefined ? {} : { logMismatches }),
    ...(mismatchLogging === undefined ? {} : { mismatchLogging: cloneMismatchLoggingConfig(mismatchLogging) }),
  };
}

function cloneMismatchLoggingConfig(config: ShadowMismatchLoggingConfig): ShadowMismatchLoggingConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("DialCache shadow mismatchLogging config must be an object");
  }
  // Leaf values stay unvalidated, like layer-map leaves, so a malformed
  // runtime leaf fails open narrowly at resolution.
  const value = readOwnField(config, "value");
  const diff = readOwnField(config, "diff");
  return {
    ...(value === undefined ? {} : { value }),
    ...(diff === undefined ? {} : { diff }),
  };
}

function isConfigObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOwnField<T extends object, Key extends keyof T>(source: T, key: Key): T[Key] | undefined {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

function hasUnknownOwnFields(value: unknown, knownFields: readonly string[]): boolean {
  return isConfigObject(value) && Object.keys(value).some((name) => !knownFields.includes(name));
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
   * Instance default for deciding whether a source rejection may use a
   * retained Redis value. Must be synchronous. Per-use-case policy overrides
   * and replaces this callback; omission admits only DialCache's
   * FallbackTimeoutError. Throws, thenables, and non-boolean results deny
   * recovery without replacing the source rejection. Custom predicates should
   * narrowly admit transient, retriable infrastructure failures and deny
   * authoritative outcomes such as auth, permission, entitlement, revocation,
   * deletion, not-found, validation, and programmer errors. Use per-use-case
   * overrides when particular data requires a stricter policy.
   */
  readonly shouldAttemptStaleRecovery?: StaleRecoveryPredicate;
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

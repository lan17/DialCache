import {
  CacheLayer,
  DialCacheKeyConfig,
  hasUnknownKeyConfigFields,
  type CacheConfigProvider,
  type LayerConfig,
  type ShadowConfig,
  type ShadowMismatchDiffLevel,
} from "../config.js";
import type { DialCacheKey } from "../key.js";
import type { DisabledReason } from "../metrics.js";
import { isSupportedCacheTtlSec } from "./duration.js";
import { deterministicRampSample } from "./ramp.js";

export interface ResolvedLayerConfig {
  readonly ttlSec: number;
  readonly ramp: number;
}

/** Remote-only policy resolved against the same invocation snapshot as its TTL. */
export interface ResolvedRemoteLayerConfig extends ResolvedLayerConfig {
  readonly staleOnErrorMaxAgeSec: number | null;
}

export type LayerConfigResolution<Config extends ResolvedLayerConfig = ResolvedLayerConfig> =
  | { readonly status: "enabled"; readonly config: Config }
  | {
      readonly status: "disabled";
      readonly reason: "ramped_down";
      /** Valid policy retained even though its ramp excluded this key. */
      readonly config: Config;
    }
  | {
      readonly status: "disabled";
      readonly reason: Exclude<DisabledReason, "ramped_down">;
    };

/**
 * A malformed optional stale policy is diagnostic-only: the valid remote layer
 * remains available with recovery disabled.
 */
type RemoteLayerConfigResolution = LayerConfigResolution<ResolvedRemoteLayerConfig> & {
  readonly staleOnErrorConfigError?: true;
};

interface ResolveLayerConfigOptions {
  readonly config: DialCacheKeyConfig | null;
  readonly key: DialCacheKey;
  readonly layer: CacheLayer;
}

interface ResolveRemoteLayerConfigOptions {
  readonly config: DialCacheKeyConfig | null;
  readonly key: DialCacheKey;
}

export async function fetchKeyConfig(
  configProvider: CacheConfigProvider,
  key: DialCacheKey,
  onUnknownFields?: () => void,
): Promise<DialCacheKeyConfig | null> {
  const defaultConfig = key.defaultConfig;
  const runtimeConfig = (await configProvider(key)) as DialCacheKeyConfig | null | undefined;
  if (runtimeConfig === null || runtimeConfig === undefined) {
    return defaultConfig;
  }
  if (hasUnknownKeyConfigFields(runtimeConfig)) {
    onUnknownFields?.();
  }
  return mergeKeyConfig(defaultConfig, runtimeConfig);
}

export function resolveLayerConfigResult(options: ResolveLayerConfigOptions): LayerConfigResolution {
  const config = options.config;
  if (config === null) {
    return { status: "disabled", reason: "policy_disabled" };
  }

  const ttlSec = config.ttlSec[options.layer];
  if (ttlSec === undefined) {
    return { status: "disabled", reason: "policy_disabled" };
  }
  if (!isSupportedCacheTtlSec(ttlSec)) {
    return { status: "disabled", reason: "invalid_ttl" };
  }

  const configuredRampValue: unknown = config.ramp[options.layer];
  const configuredRamp = configuredRampValue === undefined ? 100 : configuredRampValue;
  if (
    typeof configuredRamp !== "number"
    || !Number.isFinite(configuredRamp)
    || configuredRamp < 0
    || configuredRamp > 100
  ) {
    return { status: "disabled", reason: "invalid_ramp" };
  }

  const ramp = configuredRamp;
  if (ramp <= 0) {
    return { status: "disabled", reason: "ramped_down", config: { ttlSec, ramp } };
  }
  if (ramp >= 100) {
    return { status: "enabled", config: { ttlSec, ramp } };
  }

  const sample = deterministicRampSample(options.key, options.layer);

  return sample < ramp
    ? { status: "enabled", config: { ttlSec, ramp } }
    : { status: "disabled", reason: "ramped_down", config: { ttlSec, ramp } };
}

export function resolveRemoteLayerConfigResult(
  options: ResolveRemoteLayerConfigOptions,
): RemoteLayerConfigResolution {
  const resolution = resolveLayerConfigResult({
    ...options,
    layer: CacheLayer.REMOTE,
  });
  const configuredMaxAge: unknown = options.config?.staleOnErrorMaxAgeSec;
  if (!("config" in resolution)) {
    if (
      resolution.reason === "policy_disabled"
      && configuredMaxAge !== undefined
      && configuredMaxAge !== 0
    ) {
      return { ...resolution, staleOnErrorConfigError: true };
    }
    return resolution;
  }

  if (configuredMaxAge === undefined || configuredMaxAge === 0) {
    return {
      ...resolution,
      config: { ...resolution.config, staleOnErrorMaxAgeSec: null },
    };
  }
  if (
    !isSupportedCacheTtlSec(configuredMaxAge)
    || configuredMaxAge <= resolution.config.ttlSec
  ) {
    return {
      ...resolution,
      config: { ...resolution.config, staleOnErrorMaxAgeSec: null },
      staleOnErrorConfigError: true,
    };
  }

  return {
    ...resolution,
    config: { ...resolution.config, staleOnErrorMaxAgeSec: configuredMaxAge },
  };
}

/**
 * Leaves one shadow group writes, before validation; `undefined` is unwritten.
 * `invalid` marks a malformed shorthand, which still owes one config_resolution.
 */
export interface MismatchLoggingLeaves {
  readonly value?: unknown;
  readonly diff?: unknown;
  readonly invalid?: true;
}

/** The effective mismatch-logging leaves and whether any written input was invalid. */
export interface MismatchLoggingResolution {
  readonly value: boolean;
  readonly diff: ShadowMismatchDiffLevel;
  readonly invalid: boolean;
}

const DIFF_LEVELS: readonly unknown[] = ["off", "paths", "values"] satisfies readonly ShadowMismatchDiffLevel[];

/**
 * Expands one shadow group's `logMismatches` shorthand into the leaves it
 * stands for, `true` as `{ value: true, diff: "values" }` and `false` as
 * `{ value: false, diff: "off" }`, then lets the leaves written in the same
 * group's `mismatchLogging` override them. A malformed shorthand expands to
 * both leaves off and is marked invalid.
 */
export function expandMismatchLogging(shadow: object): MismatchLoggingLeaves {
  const shorthand = readOwnUnknown(shadow, "logMismatches");
  const expanded: MismatchLoggingLeaves = shorthand === undefined
    ? {}
    : shorthand === true
      ? { value: true, diff: "values" }
      : shorthand === false
        ? { value: false, diff: "off" }
        : { value: false, diff: "off", invalid: true };
  const group = readOwnUnknown(shadow, "mismatchLogging");
  if (group === undefined) {
    return expanded;
  }
  if (group === null || typeof group !== "object" || Array.isArray(group)) {
    // Construction, merging and default snapshots reject this shape first.
    return { value: false, diff: "off", invalid: true };
  }
  const value = readOwnUnknown(group, "value");
  const diff = readOwnUnknown(group, "diff");
  return {
    ...expanded,
    ...(value === undefined ? {} : { value }),
    ...(diff === undefined ? {} : { diff }),
  };
}

/**
 * Resolves the effective mismatch-logging leaves of one shadow group. Each
 * leaf validates independently: an omitted leaf is off, an invalid leaf acts
 * off, and `invalid` reports that the group needs one config_resolution.
 */
export function resolveMismatchLogging(shadow: object): MismatchLoggingResolution {
  const leaves = expandMismatchLogging(shadow);
  const value = resolveValueLeaf(leaves.value);
  const diff = resolveDiffLeaf(leaves.diff);
  return {
    value: value ?? false,
    diff: diff ?? "off",
    invalid: leaves.invalid === true || value === null || diff === null,
  };
}

/** `null` marks an invalid leaf. */
function resolveValueLeaf(leaf: unknown): boolean | null {
  if (leaf === undefined) {
    return false;
  }
  return typeof leaf === "boolean" ? leaf : null;
}

/** `null` marks an invalid leaf. */
function resolveDiffLeaf(leaf: unknown): ShadowMismatchDiffLevel | null {
  if (leaf === undefined) {
    return "off";
  }
  return DIFF_LEVELS.includes(leaf) ? leaf as ShadowMismatchDiffLevel : null;
}

function mergeKeyConfig(
  defaultConfig: DialCacheKeyConfig | null,
  runtimeConfig: DialCacheKeyConfig | null | undefined,
): DialCacheKeyConfig {
  const overlay = runtimeConfig ?? undefined;
  assertKeyConfig(defaultConfig);
  assertKeyConfig(overlay);
  // Both booleans merge sparsely: omission survives the merge, and the read
  // sites own the effective defaults (requestLocal === true, coalesce !== false),
  // because an unmerged defaultConfig reaches them whenever the provider
  // returns null. `!== undefined` (not `??`) keeps a malformed null flowing to
  // the constructor so it still fails resolution as config_error.
  const requestLocal = overlay?.requestLocal !== undefined
    ? overlay.requestLocal
    : defaultConfig?.requestLocal;
  const coalesce = overlay?.coalesce !== undefined
    ? overlay.coalesce
    : defaultConfig?.coalesce;
  const remoteReadTimeoutMs = overlay?.remoteReadTimeoutMs !== undefined
    ? overlay.remoteReadTimeoutMs
    : defaultConfig?.remoteReadTimeoutMs;
  const staleOnErrorMaxAgeSec = overlay?.staleOnErrorMaxAgeSec !== undefined
    ? overlay.staleOnErrorMaxAgeSec
    : defaultConfig?.staleOnErrorMaxAgeSec;
  const shadow = mergeShadowConfig(
    readOwnUnknown(defaultConfig ?? undefined, "shadow") as ShadowConfig | undefined,
    readOwnUnknown(overlay, "shadow") as ShadowConfig | undefined,
  );

  return new DialCacheKeyConfig({
    ttlSec: mergeLayerConfig(defaultConfig?.ttlSec, overlay?.ttlSec, "ttlSec"),
    ramp: mergeLayerConfig(defaultConfig?.ramp, overlay?.ramp, "ramp"),
    ...(requestLocal === undefined ? {} : { requestLocal }),
    ...(coalesce === undefined ? {} : { coalesce }),
    ...(staleOnErrorMaxAgeSec === undefined ? {} : { staleOnErrorMaxAgeSec }),
    ...(remoteReadTimeoutMs === undefined ? {} : { remoteReadTimeoutMs }),
    ...(shadow === undefined ? {} : { shadow }),
  });
}

function assertKeyConfig(config: DialCacheKeyConfig | null | undefined): void {
  if (config !== null && config !== undefined && (typeof config !== "object" || Array.isArray(config))) {
    throw new TypeError("DialCache key config must be an object");
  }
  if (config !== null && config !== undefined && Object.hasOwn(config, "shadowRamp")) {
    throw new TypeError('DialCacheKeyConfig.shadowRamp was replaced by "shadow.ramp"');
  }
}

function mergeLayerConfig(
  defaults: LayerConfig | undefined,
  overlay: LayerConfig | undefined,
  name: "ttlSec" | "ramp",
): LayerConfig {
  assertLayerConfig(defaults, name);
  assertLayerConfig(overlay, name);

  const merged: LayerConfig = {};
  for (const layer of [CacheLayer.LOCAL, CacheLayer.REMOTE]) {
    const overlayValue = overlay?.[layer];
    const value = overlayValue !== undefined ? overlayValue : defaults?.[layer];
    if (value !== undefined) {
      merged[layer] = value;
    }
  }
  return merged;
}

function assertLayerConfig(config: LayerConfig | undefined, name: "ttlSec" | "ramp"): void {
  if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
    throw new TypeError(`DialCache ${name} config must be a layer map`);
  }
}

function mergeShadowConfig(
  defaults: ShadowConfig | undefined,
  overlay: ShadowConfig | undefined,
): ShadowConfig | undefined {
  assertShadowConfig(defaults);
  assertShadowConfig(overlay);

  if (defaults === undefined && overlay === undefined) {
    return undefined;
  }

  const overlayRamp = readOwnUnknown(overlay, "ramp");
  const ramp = overlayRamp !== undefined ? overlayRamp : readOwnUnknown(defaults, "ramp");
  // Each layer's shorthand expands before the leaf-wise merge, so a runtime
  // `logMismatches` replaces both inherited leaves while a leaf written beside
  // it still wins within its own layer.
  const defaultLeaves = defaults === undefined ? {} : expandMismatchLogging(defaults);
  const overlayLeaves = overlay === undefined ? {} : expandMismatchLogging(overlay);
  const value = overlayLeaves.value !== undefined ? overlayLeaves.value : defaultLeaves.value;
  const diff = overlayLeaves.diff !== undefined ? overlayLeaves.diff : defaultLeaves.diff;

  return {
    ...(ramp === undefined ? {} : { ramp: ramp as number }),
    // A malformed runtime shorthand keeps flowing to admission, which records
    // its config_resolution; its expanded leaves already won the merge.
    ...(overlayLeaves.invalid === true
      ? { logMismatches: readOwnUnknown(overlay, "logMismatches") as boolean }
      : {}),
    ...(value === undefined && diff === undefined
      ? {}
      : {
          mismatchLogging: {
            ...(value === undefined ? {} : { value: value as boolean }),
            ...(diff === undefined ? {} : { diff: diff as ShadowMismatchDiffLevel }),
          },
        }),
  };
}

function assertShadowConfig(config: ShadowConfig | undefined): void {
  if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
    throw new TypeError("DialCache shadow config must be an object");
  }
  const mismatchLogging = readOwnUnknown(config, "mismatchLogging");
  if (
    mismatchLogging !== undefined
    && (mismatchLogging === null || typeof mismatchLogging !== "object" || Array.isArray(mismatchLogging))
  ) {
    throw new TypeError("DialCache shadow mismatchLogging config must be an object");
  }
}

// Own-property reads keep runtime shadow policy immune to inherited values:
// an inherited leaf must never activate shadow work or put payload data into
// logs.
function readOwnUnknown(source: object | undefined, key: string): unknown {
  return source !== undefined && Object.hasOwn(source, key)
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

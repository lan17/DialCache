import {
  CacheLayer,
  DialCacheKeyConfig,
  SHADOW_MISMATCH_LOGGING_LEAVES,
  type CacheConfigProvider,
  type LayerConfig,
  type ShadowConfig,
  type ShadowMismatchLoggingConfig,
} from "../config.js";
import type { DialCacheKey } from "../key.js";
import type { DisabledReason } from "../metrics.js";
import { isSupportedCacheTtlSec } from "./duration.js";
import { deterministicRampSample } from "./ramp.js";

export interface ResolvedLayerConfig {
  readonly ttlSec: number;
  readonly ramp: number;
}

export type LayerConfigResolution =
  | { readonly status: "enabled"; readonly config: ResolvedLayerConfig }
  | {
      readonly status: "disabled";
      readonly reason: "ramped_down";
      /** Valid policy retained even though its ramp excluded this key. */
      readonly config: ResolvedLayerConfig;
    }
  | {
      readonly status: "disabled";
      readonly reason: Exclude<DisabledReason, "ramped_down">;
    };

interface ResolveLayerConfigOptions {
  readonly config: DialCacheKeyConfig | null;
  readonly key: DialCacheKey;
  readonly layer: CacheLayer;
}

export async function fetchKeyConfig(
  configProvider: CacheConfigProvider,
  key: DialCacheKey,
): Promise<DialCacheKeyConfig | null> {
  const defaultConfig = key.defaultConfig;
  const runtimeConfig = (await configProvider(key)) as DialCacheKeyConfig | null | undefined;
  if (runtimeConfig === null || runtimeConfig === undefined) {
    return defaultConfig;
  }
  return mergeKeyConfig(defaultConfig, runtimeConfig);
}

export function resolveLayerConfig(options: ResolveLayerConfigOptions): ResolvedLayerConfig | null {
  const resolution = resolveLayerConfigResult(options);
  return resolution.status === "enabled" ? resolution.config : null;
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
  const shadow = mergeShadowConfig(defaultConfig?.shadow, overlay?.shadow);

  return new DialCacheKeyConfig({
    ttlSec: mergeLayerConfig(defaultConfig?.ttlSec, overlay?.ttlSec, "ttlSec"),
    ramp: mergeLayerConfig(defaultConfig?.ramp, overlay?.ramp, "ramp"),
    ...(requestLocal === undefined ? {} : { requestLocal }),
    ...(coalesce === undefined ? {} : { coalesce }),
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

  const overlayRamp = readOwn(overlay, "ramp");
  const ramp = overlayRamp !== undefined ? overlayRamp : readOwn(defaults, "ramp");
  const mismatchLogging = mergeMismatchLoggingConfig(
    readOwn(defaults, "mismatchLogging"),
    readOwn(overlay, "mismatchLogging"),
  );

  return {
    ...(ramp === undefined ? {} : { ramp }),
    ...(mismatchLogging === undefined ? {} : { mismatchLogging }),
  };
}

function mergeMismatchLoggingConfig(
  defaults: ShadowMismatchLoggingConfig | undefined,
  overlay: ShadowMismatchLoggingConfig | undefined,
): ShadowMismatchLoggingConfig | undefined {
  assertMismatchLoggingConfig(defaults);
  assertMismatchLoggingConfig(overlay);

  if (defaults === undefined && overlay === undefined) {
    return undefined;
  }

  const merged: { -readonly [Leaf in keyof ShadowMismatchLoggingConfig]?: boolean } = {};
  for (const leaf of SHADOW_MISMATCH_LOGGING_LEAVES) {
    const overlayValue = readOwn(overlay, leaf);
    const value = overlayValue !== undefined ? overlayValue : readOwn(defaults, leaf);
    if (value !== undefined) {
      merged[leaf] = value;
    }
  }
  return merged;
}

// Own-property reads keep runtime shadow config immune to inherited values:
// prototype-carried leaves must never merge into an own `mismatchLogging`
// group (its failure direction is payload data reaching logs, unlike a TTL)
// and the same rule is applied to `ramp` so admission cannot be inherited.
function readOwn<T extends object, Key extends keyof T>(source: T | undefined, key: Key): T[Key] | undefined {
  return source !== undefined && Object.hasOwn(source, key) ? source[key] : undefined;
}

function assertShadowConfig(config: ShadowConfig | undefined): void {
  if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
    throw new TypeError("DialCache shadow config must be an object");
  }
  if (config !== undefined && Object.hasOwn(config, "logMismatches")) {
    throw new TypeError('ShadowConfig.logMismatches was replaced by "shadow.mismatchLogging"');
  }
}

function assertMismatchLoggingConfig(config: ShadowMismatchLoggingConfig | undefined): void {
  if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
    throw new TypeError("DialCache shadow mismatchLogging config must be an object");
  }
}

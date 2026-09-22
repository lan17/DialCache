import {
  CacheLayer,
  DialCacheKeyConfig,
  type CacheConfigProvider,
  type LayerConfig,
  type ShadowConfig,
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
): Promise<DialCacheKeyConfig | null> {
  const defaultConfig = key.defaultConfig;
  const runtimeConfig = (await configProvider(key)) as DialCacheKeyConfig | null | undefined;
  if (runtimeConfig === null || runtimeConfig === undefined) {
    return defaultConfig;
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
  const shadow = mergeShadowConfig(defaultConfig?.shadow, overlay?.shadow);

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

  const ramp = overlay?.ramp !== undefined ? overlay.ramp : defaults?.ramp;
  const logMismatches = overlay?.logMismatches !== undefined
    ? overlay.logMismatches
    : defaults?.logMismatches;

  return {
    ...(ramp === undefined ? {} : { ramp }),
    ...(logMismatches === undefined ? {} : { logMismatches }),
  };
}

function assertShadowConfig(config: ShadowConfig | undefined): void {
  if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
    throw new TypeError("DialCache shadow config must be an object");
  }
}

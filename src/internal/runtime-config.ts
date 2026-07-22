import {
  CacheLayer,
  DialCacheKeyConfig,
  type CacheConfigProvider,
  type CacheRampSampler,
  type LayerConfig,
} from "../config.js";
import type { DialCacheKey } from "../key.js";
import type { DisabledReason } from "../metrics.js";

export interface ResolvedLayerConfig {
  readonly ttlSec: number;
  readonly ramp: number;
}

export type LayerConfigResolution =
  | { readonly status: "enabled"; readonly config: ResolvedLayerConfig }
  | { readonly status: "disabled"; readonly reason: DisabledReason };

interface ResolveLayerConfigOptions {
  readonly config: DialCacheKeyConfig | null;
  readonly key: DialCacheKey;
  readonly layer: CacheLayer;
  readonly rampSampler: CacheRampSampler;
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

export async function resolveLayerConfig(options: ResolveLayerConfigOptions): Promise<ResolvedLayerConfig | null> {
  const resolution = await resolveLayerConfigResult(options);
  return resolution.status === "enabled" ? resolution.config : null;
}

export async function resolveLayerConfigResult(options: ResolveLayerConfigOptions): Promise<LayerConfigResolution> {
  const config = options.config;
  if (config === null) {
    return { status: "disabled", reason: "policy_disabled" };
  }

  const ttlSec = config.ttlSec[options.layer];
  if (ttlSec === undefined) {
    return { status: "disabled", reason: "policy_disabled" };
  }
  if (!Number.isSafeInteger(ttlSec) || ttlSec <= 0) {
    return { status: "disabled", reason: "invalid_ttl" };
  }

  const configuredRampValue = config.ramp[options.layer];
  const configuredRamp = configuredRampValue === undefined ? 100 : configuredRampValue;
  if (!Number.isFinite(configuredRamp)) {
    return { status: "disabled", reason: "invalid_ramp" };
  }

  const ramp = clampPercentage(configuredRamp);
  if (ramp <= 0) {
    return { status: "disabled", reason: "ramped_down" };
  }
  if (ramp >= 100) {
    return { status: "enabled", config: { ttlSec, ramp } };
  }

  const sample = await options.rampSampler({ key: options.key, layer: options.layer, ramp });
  if (!Number.isFinite(sample)) {
    return { status: "disabled", reason: "ramped_down" };
  }

  return clampPercentage(sample) < ramp
    ? { status: "enabled", config: { ttlSec, ramp } }
    : { status: "disabled", reason: "ramped_down" };
}

function mergeKeyConfig(
  defaultConfig: DialCacheKeyConfig | null,
  runtimeConfig: DialCacheKeyConfig | null | undefined,
): DialCacheKeyConfig {
  const overlay = runtimeConfig ?? undefined;
  assertKeyConfig(defaultConfig);
  assertKeyConfig(overlay);
  const defaultRequestLocal = defaultConfig?.requestLocal;
  const overlayRequestLocal = overlay?.requestLocal;
  const requestLocal = overlayRequestLocal !== undefined
    ? overlayRequestLocal
    : defaultRequestLocal !== undefined
      ? defaultRequestLocal
      : false;

  return new DialCacheKeyConfig({
    ttlSec: mergeLayerConfig(defaultConfig?.ttlSec, overlay?.ttlSec, "ttlSec"),
    ramp: mergeLayerConfig(defaultConfig?.ramp, overlay?.ramp, "ramp"),
    requestLocal,
  });
}

function assertKeyConfig(config: DialCacheKeyConfig | null | undefined): void {
  if (config !== null && config !== undefined && (typeof config !== "object" || Array.isArray(config))) {
    throw new TypeError("DialCache key config must be an object");
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

function clampPercentage(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 100) {
    return 100;
  }
  return value;
}

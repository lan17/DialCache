import { LRUCache } from "lru-cache";

import { CacheLayer, type CacheConfigProvider, type CacheRampSampler, type DialCacheKeyConfig } from "../config.js";
import type { DialCacheKey } from "../key.js";
import type { CacheGetResult } from "./cache-result.js";
import { fetchKeyConfig, resolveLayerConfigResult } from "./runtime-config.js";

export type Fallback<T> = () => Promise<T>;

interface LocalEntry<T> {
  readonly value: T;
}

export class LocalCache {
  private readonly cache: LRUCache<string, LocalEntry<unknown>>;

  constructor(
    private readonly configProvider: CacheConfigProvider,
    private readonly rampSampler: CacheRampSampler,
    maxSize: number,
  ) {
    this.cache = new LRUCache({
      max: maxSize,
      // Keep fake timers and injected Date clocks observable instead of capturing
      // the process clock when lru-cache is imported.
      perf: { now: () => Date.now() },
    });
  }

  async get<T>(key: DialCacheKey, fallback: Fallback<T>): Promise<T> {
    const result = await this.getIfPresentResult<T>(key);
    if (result.status === "hit") {
      return result.value;
    }

    const value = await fallback();
    if (result.status === "miss") {
      await this.put(key, value, result.config);
    }
    return value;
  }

  async getIfPresent<T>(key: DialCacheKey): Promise<T | undefined> {
    const result = await this.getIfPresentResult<T>(key);
    return result.status === "hit" ? result.value : undefined;
  }

  async getIfPresentResult<T>(key: DialCacheKey, keyConfig?: DialCacheKeyConfig | null): Promise<CacheGetResult<T>> {
    const layerConfig = await this.resolveLocalLayerConfig(key, keyConfig);
    if (layerConfig.status === "disabled") {
      return layerConfig;
    }

    const hit = this.cache.get(key.urn) as LocalEntry<T> | undefined;

    if (hit !== undefined) {
      return { status: "hit", value: hit.value };
    }

    return { status: "miss", config: layerConfig.config };
  }

  async put<T>(key: DialCacheKey, value: T, config?: { readonly ttlSec: number }): Promise<void> {
    const ttlSec = config?.ttlSec ?? await this.resolveLocalTtlSec(key);
    if (ttlSec === null) {
      return;
    }

    this.cache.set(key.urn, { value }, { ttl: ttlSec * 1000 });
  }

  async flushAll(): Promise<void> {
    this.cache.clear();
  }

  private async resolveLocalLayerConfig(key: DialCacheKey, keyConfig?: DialCacheKeyConfig | null) {
    // Chain callers pass the once-resolved config; standalone callers omit it and we fetch.
    const config = keyConfig === undefined ? await fetchKeyConfig(this.configProvider, key) : keyConfig;
    return await resolveLayerConfigResult({
      config,
      key,
      layer: CacheLayer.LOCAL,
      rampSampler: this.rampSampler,
    });
  }

  private async resolveLocalTtlSec(key: DialCacheKey): Promise<number | null> {
    const layerConfig = await this.resolveLocalLayerConfig(key);
    return layerConfig.status === "enabled" ? layerConfig.config.ttlSec : null;
  }
}

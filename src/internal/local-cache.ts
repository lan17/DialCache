import { performance } from "node:perf_hooks";

import { LRUCache } from "lru-cache";

import { CacheLayer, type CacheConfigProvider, type DialCacheKeyConfig } from "../config.js";
import type { DialCacheKey } from "../key.js";
import type { CacheGetResult } from "./cache-result.js";
import { cacheTtlSecToMs } from "./duration.js";
import {
  fetchKeyConfig,
  resolveLayerConfigResult,
  type LayerConfigResolution,
  type ResolvedLayerConfig,
} from "./runtime-config.js";

export type Fallback<T> = () => Promise<T>;

interface LocalEntry<T> {
  readonly value: T;
}

export class LocalCache {
  private readonly cache: LRUCache<string, LocalEntry<unknown>> | null;

  constructor(
    private readonly configProvider: CacheConfigProvider,
    maxSize: number,
  ) {
    this.cache =
      maxSize === 0
        ? null
        : new LRUCache({
            // Weight every entry as one so large configured limits remain sparse
            // instead of eagerly preallocating max-sized storage arrays.
            maxSize,
            // Read a fresh monotonic integer clock and avoid lru-cache's zero
            // timestamp sentinel when the process or a fake clock starts at 0.
            perf: { now: () => Math.floor(performance.now()) + 1 },
            ttlResolution: 0,
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
    const layerConfig = await this.resolveLayerConfig(key, keyConfig);
    if (layerConfig.status === "disabled") {
      return layerConfig;
    }

    return this.getWithResolvedConfig<T>(key, layerConfig.config);
  }

  getWithResolvedConfig<T>(key: DialCacheKey, layerConfig: ResolvedLayerConfig): CacheGetResult<T> {
    const hit = this.cache?.get(key.urn) as LocalEntry<T> | undefined;

    if (hit !== undefined) {
      return { status: "hit", value: hit.value };
    }

    return { status: "miss", config: layerConfig };
  }

  async resolveLayerConfig(
    key: DialCacheKey,
    keyConfig?: DialCacheKeyConfig | null,
  ): Promise<LayerConfigResolution> {
    // Chain callers pass the once-resolved config; standalone callers omit it and we fetch.
    const config = keyConfig === undefined ? await fetchKeyConfig(this.configProvider, key) : keyConfig;
    return resolveLayerConfigResult({
      config,
      key,
      layer: CacheLayer.LOCAL,
    });
  }

  async put<T>(
    key: DialCacheKey,
    value: T,
    config?: { readonly ttlSec: number },
    canPublish?: () => boolean,
  ): Promise<void> {
    if (this.cache === null) {
      return;
    }
    const ttlSec = config?.ttlSec ?? await this.resolveLocalTtlSec(key);
    if (ttlSec === null) {
      return;
    }
    if (canPublish !== undefined && !canPublish()) {
      return;
    }

    // lru-cache expires when age > ttl, while DialCache historically expired
    // when its integer-millisecond clock reached the configured boundary.
    const ttlMs = cacheTtlSecToMs(ttlSec) - 1;
    // Keep the publication guard and set synchronous so an invalidation either
    // deletes an already-published value or is observed before this write.
    this.cache.set(key.urn, { value }, { size: 1, ttl: ttlMs });
  }

  deleteTrackedPrefix(prefix: string): number {
    if (this.cache === null) {
      return 0;
    }
    let deleted = 0;
    for (const urn of this.cache.keys()) {
      if (urn.startsWith(prefix) && this.cache.delete(urn)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  clearTracked(): number {
    if (this.cache === null) {
      return 0;
    }
    let deleted = 0;
    for (const urn of this.cache.keys()) {
      // Tracked URNs begin with DialCache's reserved Redis hash tag. Namespace
      // and untracked key components cannot contain a literal opening brace.
      if (urn.startsWith("{") && this.cache.delete(urn)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  private async resolveLocalTtlSec(key: DialCacheKey): Promise<number | null> {
    const layerConfig = await this.resolveLayerConfig(key);
    return layerConfig.status === "enabled" ? layerConfig.config.ttlSec : null;
  }
}

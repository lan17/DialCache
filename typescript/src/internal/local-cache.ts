import { performance } from "node:perf_hooks";

import { LRUCache } from "lru-cache";

import { CacheLayer, type DialCacheKeyConfig } from "../config.js";
import type { DialCacheKey } from "../key.js";
import type { CacheGetResult } from "./cache-result.js";
import { cacheTtlSecToMs } from "./duration.js";
import {
  resolveLayerConfigResult,
  type LayerConfigResolution,
  type ResolvedLayerConfig,
} from "./runtime-config.js";

interface LocalEntry<T> {
  readonly value: T;
}

export class LocalCache {
  private readonly cache: LRUCache<string, LocalEntry<unknown>> | null;

  constructor(maxSize: number) {
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

  getWithResolvedConfig<T>(key: DialCacheKey, layerConfig: ResolvedLayerConfig): CacheGetResult<T> {
    const hit = this.cache?.get(key.urn) as LocalEntry<T> | undefined;

    if (hit !== undefined) {
      return { status: "hit", value: hit.value };
    }

    return { status: "miss", config: layerConfig };
  }

  resolveLayerConfig(
    key: DialCacheKey,
    keyConfig: DialCacheKeyConfig | null,
  ): LayerConfigResolution {
    return resolveLayerConfigResult({
      config: keyConfig,
      key,
      layer: CacheLayer.LOCAL,
    });
  }

  put<T>(key: DialCacheKey, value: T, config: { readonly ttlSec: number }): void {
    // lru-cache expires when age > ttl, while DialCache historically expired
    // when its integer-millisecond clock reached the configured boundary.
    const ttlMs = cacheTtlSecToMs(config.ttlSec) - 1;
    this.cache?.set(key.urn, { value }, { size: 1, ttl: ttlMs });
  }
}

import type { CacheLayer } from "../config.js";
import type { DialCacheKey } from "../key.js";

/**
 * Assigns each cache key to a stable per-layer rollout bucket in [0, 100).
 *
 * Keep this algorithm stable: changing it reshuffles partial-ramp cohorts
 * across every DialCache instance after an upgrade.
 */
export function deterministicRampSample(key: DialCacheKey, layer: CacheLayer): number {
  return stablePercent(`${key.urn}:${layer}`);
}

function stablePercent(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0x1_0000_0000) * 100;
}

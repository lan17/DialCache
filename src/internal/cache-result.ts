import type { ResolvedLayerConfig, ResolvedRemoteLayerConfig } from "./runtime-config.js";
import type { DisabledReason } from "../metrics.js";
import type { DecodedRedisFrame } from "../redis-client.js";

export type CacheGetResult<T> =
  | { readonly status: "hit"; readonly value: T }
  | { readonly status: "miss"; readonly config: ResolvedLayerConfig; readonly skipCacheWrite?: boolean }
  | {
      readonly status: "disabled";
      readonly reason: DisabledReason;
      readonly skipCacheWrite?: boolean;
    };

export type RedisCacheGetResult<T> =
  | { readonly status: "hit"; readonly value: T; readonly frame: DecodedRedisFrame }
  | {
      readonly status: "miss";
      readonly config: ResolvedRemoteLayerConfig;
      readonly skipCacheWrite?: boolean;
      /** The present payload failed normal decoding and cannot later qualify as stale. */
      readonly skipStaleRecovery?: boolean;
    }
  | Extract<CacheGetResult<T>, { readonly status: "disabled" }>;

export type RemoteCacheGetResult<T> =
  | RedisCacheGetResult<T>
  | { readonly status: "error"; readonly operation: "read" };

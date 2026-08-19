import type { ResolvedLayerConfig, ResolvedRemoteLayerConfig } from "./runtime-config.js";
import type { DisabledReason } from "../metrics.js";
import type { DecodedRedisFrame } from "../redis-client.js";

export type CacheGetResult<T> =
  | { readonly status: "hit"; readonly value: T }
  | { readonly status: "miss"; readonly config: ResolvedLayerConfig }
  | {
      readonly status: "disabled";
      readonly reason: DisabledReason;
      readonly skipCacheWrite?: boolean;
    };

export type RedisCacheMissReason = "cache_miss" | "deserialization_error";

export type RedisCacheGetResult<T> =
  | { readonly status: "hit"; readonly value: T; readonly frame: DecodedRedisFrame }
  | {
      readonly status: "miss";
      readonly config: ResolvedRemoteLayerConfig;
      readonly reason: RedisCacheMissReason;
    };

export type RemoteCacheGetResult<T> =
  | RedisCacheGetResult<T>
  | Extract<CacheGetResult<T>, { readonly status: "disabled" }>
  | { readonly status: "error" };

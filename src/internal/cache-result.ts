import type { ResolvedLayerConfig } from "./runtime-config.js";
import type { DisabledReason } from "../metrics.js";
import type { RedisCachePayload } from "../redis-client.js";

export type CacheGetResult<T> =
  | { readonly status: "hit"; readonly value: T }
  | { readonly status: "miss"; readonly config: ResolvedLayerConfig; readonly skipCacheWrite?: boolean }
  | {
      readonly status: "disabled";
      readonly reason: DisabledReason;
      readonly skipCacheWrite?: boolean;
    };

export type RedisCacheGetResult<T> =
  | { readonly status: "hit"; readonly value: T; readonly payload: RedisCachePayload }
  | Exclude<CacheGetResult<T>, { readonly status: "hit" }>;

export type RemoteCacheGetResult<T> =
  | RedisCacheGetResult<T>
  | { readonly status: "error"; readonly operation: "read" };

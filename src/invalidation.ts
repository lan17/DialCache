/**
 * Logical identity shared by every invalidation-tracked cache entry for one
 * namespace, key type, and id.
 */
export interface DialCacheInvalidationIdentity {
  readonly namespace: string;
  readonly keyType: string;
  readonly id: string;
}

/**
 * Versioned event published by the coordinated Redis invalidation protocol.
 * Redis timestamps remain canonical decimal strings on the wire and are
 * validated as safe integers before any local timing is derived.
 */
export interface DialCacheInvalidationEventV1 extends DialCacheInvalidationIdentity {
  readonly version: 1;
  readonly effectiveWatermarkMs: string;
  readonly redisNowMs: string;
}

export type DialCacheInvalidationCoordinatorState = "ready" | "unavailable" | "disposed";
export type DialCacheLocalInvalidationSource = "provisional" | "event";

/**
 * Process-local invalidation delivered synchronously to every registered
 * DialCache instance. `remainingMs` is translated onto each process's
 * monotonic clock by the listener.
 */
export interface DialCacheLocalInvalidation extends DialCacheInvalidationIdentity {
  readonly remainingMs: number;
  readonly source: DialCacheLocalInvalidationSource;
}

export interface DialCacheInvalidationCoordinatorListener {
  onInvalidation(invalidation: DialCacheLocalInvalidation): void;
  onStateChange(state: DialCacheInvalidationCoordinatorState, error?: unknown): void;
}

/**
 * Caller-owned, process-wide fan-out boundary for coordinated invalidation.
 *
 * Implementations must invoke listeners synchronously, isolate listener
 * failures, and deliver the current state synchronously from `addListener`
 * before it returns. `invalidate` must likewise complete local fan-out before
 * returning. The returned function removes only that listener.
 *
 * Coordinators are notification transports, not durable invalidation stores.
 * Implementations must enter `unavailable` whenever subscription continuity is
 * uncertain; DialCache then clears and bypasses coordinated tracked local
 * state until a newly acknowledged `ready` transition.
 */
export interface DialCacheInvalidationCoordinator {
  readonly namespace: string;
  readonly state: DialCacheInvalidationCoordinatorState;
  addListener(listener: DialCacheInvalidationCoordinatorListener): () => void;
  invalidate(invalidation: DialCacheLocalInvalidation): void;
}

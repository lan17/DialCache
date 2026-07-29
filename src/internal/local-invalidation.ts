import { performance } from "node:perf_hooks";

import type {
  DialCacheInvalidationCoordinatorState,
  DialCacheLocalInvalidation,
} from "../invalidation.js";
import { invalidationPrefix, redisClusterHashTag, type DialCacheKey } from "../key.js";
import type { LocalCache } from "./local-cache.js";

export type LocalPublicationPermit = number;

export interface LocalInvalidationTransition {
  readonly changed: boolean;
  readonly evicted: number;
}

export class LocalInvalidationState {
  private readonly fences = new Map<string, number>();
  private health: DialCacheInvalidationCoordinatorState = "unavailable";
  private healthEpoch = 0;
  private globalDeadlineMs = -1;

  constructor(
    private readonly localCache: LocalCache,
    private readonly maxFences: number,
  ) {}

  capturePublicationPermit(): LocalPublicationPermit {
    return this.healthEpoch;
  }

  get disposed(): boolean {
    return this.health === "disposed";
  }

  canPublish(key: DialCacheKey, permit: LocalPublicationPermit): boolean {
    if (this.health !== "ready" || permit !== this.healthEpoch) {
      return false;
    }

    const now = performance.now();
    if (this.globalDeadlineMs >= now) {
      return false;
    }
    this.globalDeadlineMs = -1;

    const deadline = this.fences.get(key.prefix);
    if (deadline === undefined) {
      return true;
    }
    if (deadline >= now) {
      return false;
    }
    this.fences.delete(key.prefix);
    return true;
  }

  apply(invalidation: DialCacheLocalInvalidation): number {
    if (this.maxFences === 0 || this.health === "disposed") {
      return 0;
    }

    const prefix = redisClusterHashTag(
      invalidationPrefix(invalidation.namespace, invalidation.keyType, invalidation.id),
    );
    const now = performance.now();
    const deadline = Math.min(now + invalidation.remainingMs, Number.MAX_SAFE_INTEGER);
    this.extendFence(prefix, deadline, now);
    return this.localCache.deleteTrackedPrefix(prefix);
  }

  transition(state: DialCacheInvalidationCoordinatorState): LocalInvalidationTransition {
    if (this.health === "disposed" || state === this.health) {
      return { changed: false, evicted: 0 };
    }

    this.health = state;
    this.healthEpoch += 1;
    const evicted = this.localCache.clearTracked();
    if (state === "disposed") {
      this.fences.clear();
      this.globalDeadlineMs = -1;
    }
    return { changed: true, evicted };
  }

  private extendFence(prefix: string, deadline: number, now: number): void {
    if (this.globalDeadlineMs >= now) {
      this.globalDeadlineMs = Math.max(this.globalDeadlineMs, deadline);
      return;
    }
    this.globalDeadlineMs = -1;

    const current = this.fences.get(prefix);
    if (current !== undefined) {
      this.fences.set(prefix, Math.max(current, deadline));
      return;
    }

    if (this.fences.size >= this.maxFences) {
      this.pruneExpired(now);
    }
    if (this.fences.size < this.maxFences) {
      this.fences.set(prefix, deadline);
      return;
    }

    let furthestDeadline = deadline;
    for (const activeDeadline of this.fences.values()) {
      furthestDeadline = Math.max(furthestDeadline, activeDeadline);
    }
    this.fences.clear();
    this.globalDeadlineMs = furthestDeadline;
  }

  private pruneExpired(now: number): void {
    for (const [prefix, deadline] of this.fences) {
      if (deadline < now) {
        this.fences.delete(prefix);
      }
    }
  }
}

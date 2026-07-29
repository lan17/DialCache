import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DialCacheKey } from "../src/key.js";
import { LocalCache } from "../src/internal/local-cache.js";
import { LocalInvalidationState } from "../src/internal/local-invalidation.js";

const resolvedLocal = { ttlSec: 60, ramp: 100 };
const tracked = (
  id: string,
  useCase: string,
  args: ReadonlyArray<readonly [string, string]> = [],
  namespace = "urn",
) => new DialCacheKey({
  namespace,
  keyType: "user_id",
  id,
  useCase,
  args,
  trackForInvalidation: true,
});
const untracked = (id: string, useCase: string) => new DialCacheKey({
  keyType: "user_id",
  id,
  useCase,
});

describe("LocalCache tracked eviction", () => {
  it("deletes one exact tracked identity across use cases and argument variants", async () => {
    const cache = new LocalCache(() => null, 10);
    const profile = tracked("123", "Profile");
    const permissions = tracked("123", "Permissions", [["scope", "admin"]]);
    const adjacent = tracked("1234", "Adjacent");
    const otherType = new DialCacheKey({
      keyType: "account_id",
      id: "123",
      useCase: "OtherType",
      trackForInvalidation: true,
    });
    const plain = untracked("123", "Plain");

    await Promise.all([
      cache.put(profile, "profile", resolvedLocal),
      cache.put(permissions, "permissions", resolvedLocal),
      cache.put(adjacent, "adjacent", resolvedLocal),
      cache.put(otherType, "other-type", resolvedLocal),
      cache.put(plain, "plain", resolvedLocal),
    ]);

    expect(cache.deleteTrackedPrefix(profile.prefix)).toBe(2);
    expect(cache.getWithResolvedConfig(profile, resolvedLocal).status).toBe("miss");
    expect(cache.getWithResolvedConfig(permissions, resolvedLocal).status).toBe("miss");
    expect(cache.getWithResolvedConfig<string>(adjacent, resolvedLocal)).toMatchObject({
      status: "hit",
      value: "adjacent",
    });
    expect(cache.getWithResolvedConfig<string>(otherType, resolvedLocal)).toMatchObject({
      status: "hit",
      value: "other-type",
    });
    expect(cache.getWithResolvedConfig<string>(plain, resolvedLocal)).toMatchObject({
      status: "hit",
      value: "plain",
    });
  });

  it("clears every tracked entry while preserving untracked entries", async () => {
    const cache = new LocalCache(() => null, 10);
    const first = tracked("1", "First");
    const second = tracked("2", "Second");
    const plain = untracked("1", "Plain");
    await cache.put(first, 1, resolvedLocal);
    await cache.put(second, 2, resolvedLocal);
    await cache.put(plain, 3, resolvedLocal);

    expect(cache.clearTracked()).toBe(2);
    expect(cache.clearTracked()).toBe(0);
    expect(cache.getWithResolvedConfig(first, resolvedLocal).status).toBe("miss");
    expect(cache.getWithResolvedConfig(second, resolvedLocal).status).toBe("miss");
    expect(cache.getWithResolvedConfig<number>(plain, resolvedLocal)).toMatchObject({
      status: "hit",
      value: 3,
    });
  });

  it("keeps zero-capacity operations allocation-free and no-op", async () => {
    const cache = new LocalCache(() => {
      throw new Error("provider must not run");
    }, 0);
    const key = tracked("1", "Disabled");
    const guard = vi.fn(() => true);

    await expect(cache.put(key, "value", undefined, guard)).resolves.toBeUndefined();
    expect(guard).not.toHaveBeenCalled();
    expect(cache.deleteTrackedPrefix(key.prefix)).toBe(0);
    expect(cache.clearTracked()).toBe(0);
  });

  it("checks a publication guard immediately before the synchronous set", async () => {
    const cache = new LocalCache(() => null, 2);
    const key = tracked("1", "Guarded");
    const denied = vi.fn(() => false);

    await cache.put(key, "denied", resolvedLocal, denied);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(cache.getWithResolvedConfig(key, resolvedLocal).status).toBe("miss");

    await cache.put(key, "allowed", resolvedLocal, () => true);
    expect(cache.getWithResolvedConfig<string>(key, resolvedLocal)).toMatchObject({
      status: "hit",
      value: "allowed",
    });
  });
});

describe("bounded process-local invalidation state", () => {
  let nowMs = 1_000;

  beforeEach(() => {
    nowMs = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs the fence before eviction and uses only monotonic time", async () => {
    const cache = new LocalCache(() => null, 10);
    const state = new LocalInvalidationState(cache, 10);
    const key = tracked("123", "Profile");
    const other = tracked("456", "Other");
    state.transition("ready");
    const permit = state.capturePublicationPermit();
    await cache.put(key, "old", resolvedLocal);

    expect(state.apply(signal("123", 100))).toBe(1);
    expect(cache.getWithResolvedConfig(key, resolvedLocal).status).toBe("miss");
    expect(state.canPublish(key, permit)).toBe(false);
    expect(state.canPublish(other, permit)).toBe(true);

    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2040-01-01T00:00:00.000Z"));
    nowMs = 1_100;
    expect(state.canPublish(key, permit)).toBe(false);
    nowMs = 1_100.001;
    expect(state.canPublish(key, permit)).toBe(true);
  });

  it("never shortens an identity fence and rescans equal events", async () => {
    const cache = new LocalCache(() => null, 10);
    const state = new LocalInvalidationState(cache, 10);
    const key = tracked("123", "Profile");
    state.transition("ready");
    const permit = state.capturePublicationPermit();

    state.apply(signal("123", 100));
    nowMs = 1_050;
    await cache.put(key, "late", resolvedLocal);
    expect(state.apply(signal("123", 10))).toBe(1);
    expect(cache.getWithResolvedConfig(key, resolvedLocal).status).toBe("miss");
    nowMs = 1_070;
    expect(state.canPublish(key, permit)).toBe(false);
    nowMs = 1_101;
    expect(state.canPublish(key, permit)).toBe(true);
  });

  it("advances health epochs on outage and recovery and preserves active fences", async () => {
    const cache = new LocalCache(() => null, 10);
    const state = new LocalInvalidationState(cache, 10);
    const key = tracked("123", "Profile");
    const plain = untracked("123", "Plain");
    state.transition("ready");
    const beforeGap = state.capturePublicationPermit();
    state.apply(signal("123", 100));
    await cache.put(key, "tracked", resolvedLocal);
    await cache.put(plain, "plain", resolvedLocal);

    expect(state.transition("unavailable")).toEqual({ changed: true, evicted: 1 });
    expect(state.transition("unavailable")).toEqual({ changed: false, evicted: 0 });
    expect(cache.getWithResolvedConfig<string>(plain, resolvedLocal)).toMatchObject({
      status: "hit",
      value: "plain",
    });
    expect(state.canPublish(key, beforeGap)).toBe(false);

    expect(state.transition("ready")).toEqual({ changed: true, evicted: 0 });
    const afterGap = state.capturePublicationPermit();
    expect(state.canPublish(key, beforeGap)).toBe(false);
    expect(state.canPublish(key, afterGap)).toBe(false);
    nowMs = 1_101;
    expect(state.canPublish(key, afterGap)).toBe(true);
  });

  it("collapses active overflow into a conservative global deadline", () => {
    const cache = new LocalCache(() => null, 2);
    const state = new LocalInvalidationState(cache, 2);
    const one = tracked("1", "One");
    const unrelated = tracked("unrelated", "Unrelated");
    state.transition("ready");
    const permit = state.capturePublicationPermit();

    state.apply(signal("1", 100));
    state.apply(signal("2", 200));
    state.apply(signal("3", 150));

    expect(state.canPublish(one, permit)).toBe(false);
    expect(state.canPublish(unrelated, permit)).toBe(false);
    nowMs = 1_200;
    expect(state.canPublish(unrelated, permit)).toBe(false);
    nowMs = 1_200.001;
    expect(state.canPublish(unrelated, permit)).toBe(true);
  });

  it("prunes expired identities before choosing global overflow", () => {
    const cache = new LocalCache(() => null, 2);
    const state = new LocalInvalidationState(cache, 2);
    const unrelated = tracked("unrelated", "Unrelated");
    state.transition("ready");
    const permit = state.capturePublicationPermit();

    state.apply(signal("1", 10));
    state.apply(signal("2", 100));
    nowMs = 1_020;
    state.apply(signal("3", 50));

    expect(state.canPublish(unrelated, permit)).toBe(true);
    expect(state.canPublish(tracked("2", "Two"), permit)).toBe(false);
    expect(state.canPublish(tracked("3", "Three"), permit)).toBe(false);
  });

  it("suppresses publication permanently after disposal and releases fence state", () => {
    const cache = new LocalCache(() => null, 1);
    const state = new LocalInvalidationState(cache, 1);
    const key = tracked("1", "One");
    state.transition("ready");
    const permit = state.capturePublicationPermit();
    state.apply(signal("1", 100));

    expect(state.transition("disposed")).toEqual({ changed: true, evicted: 0 });
    expect(state.apply(signal("1", 100))).toBe(0);
    expect(state.transition("ready")).toEqual({ changed: false, evicted: 0 });
    nowMs = 2_000;
    expect(state.canPublish(key, permit)).toBe(false);
  });

  it("retains no values or fences when local capacity is zero", () => {
    const cache = new LocalCache(() => null, 0);
    const state = new LocalInvalidationState(cache, 0);
    const key = tracked("1", "One");

    state.transition("ready");
    const permit = state.capturePublicationPermit();
    expect(state.apply(signal("1", 100))).toBe(0);
    expect(state.canPublish(key, permit)).toBe(true);
  });
});

function signal(id: string, remainingMs: number) {
  return {
    namespace: "urn",
    keyType: "user_id",
    id,
    remainingMs,
    source: "event" as const,
  };
}

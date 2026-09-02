import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  type CacheMetricLabels,
  type CoalescedMetricLabels,
  type DisabledMetricLabels,
  type ErrorMetricLabels,
  type DialCacheMetricsAdapter,
  type DialCacheRedisClient,
  type InvalidationMetricLabels,
  type MissMetricLabels,
  type RedisReadResult,
  type SerializationMetricLabels,
  type Serializer,
  type ShadowValidationMetricLabels,
  type StaleRecoveryMetricLabels,
} from "../src/index.js";
import { encodeFrame, FakeRedis } from "./fake-redis.js";

class RecordingMetrics implements DialCacheMetricsAdapter {
  readonly events: Array<{ readonly name: string; readonly labels: Record<string, unknown>; readonly value?: number }> = [];

  request(labels: CacheMetricLabels): void {
    this.record("request", labels);
  }

  miss(labels: MissMetricLabels): void {
    this.record("miss", labels);
  }

  disabled(labels: DisabledMetricLabels): void {
    this.record("disabled", labels);
  }

  error(labels: ErrorMetricLabels): void {
    this.record("error", labels);
  }

  invalidation(labels: InvalidationMetricLabels): void {
    this.record("invalidation", labels);
  }

  coalesced(labels: CoalescedMetricLabels): void {
    this.record("coalesced", labels);
  }

  staleRecovery(labels: StaleRecoveryMetricLabels): void {
    this.record("staleRecovery", labels);
  }

  observeStaleRecoveryValueAge(labels: StaleRecoveryMetricLabels, seconds: number): void {
    this.record("staleRecoveryValueAge", labels, seconds);
  }

  observeGet(labels: CacheMetricLabels, seconds: number): void {
    this.record("get", labels, seconds);
  }

  observeFallback(labels: CacheMetricLabels, seconds: number): void {
    this.record("fallback", labels, seconds);
  }

  observeSerialization(labels: SerializationMetricLabels, seconds: number): void {
    this.record("serialization", labels, seconds);
  }

  observeSize(labels: CacheMetricLabels, bytes: number): void {
    this.record("size", labels, bytes);
  }

  private record(name: string, labels: object, value?: number): void {
    this.events.push({ name, labels: { ...labels }, ...(value === undefined ? {} : { value }) });
  }
}

const localOnly = (ttlSec = 60) =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: ttlSec },
    ramp: { [CacheLayer.LOCAL]: 100 },
  });

const remoteOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

const staleRemoteOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 1 },
    ramp: { [CacheLayer.REMOTE]: 100 },
    staleOnErrorMaxAgeSec: 10,
  });

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("DialCache observability metrics", () => {
  it("consumes rejecting thenables returned by every metrics method without awaiting them", async () => {
    const then = vi.fn((
      _onFulfilled: ((value: unknown) => unknown) | null | undefined,
      onRejected: ((reason: unknown) => unknown) | null | undefined,
    ) => {
      onRejected?.(new Error("metrics transport failed"));
    });
    const thenable = { then };
    const metrics = {
      request: vi.fn(() => thenable),
      miss: vi.fn(() => thenable),
      disabled: vi.fn(() => thenable),
      error: vi.fn(() => thenable),
      invalidation: vi.fn(() => thenable),
      coalesced: vi.fn(() => thenable),
      shadowValidation: vi.fn(() => thenable),
      observeFutureTimestampOffset: vi.fn(() => thenable),
      staleRecovery: vi.fn(() => thenable),
      observeStaleRecoveryValueAge: vi.fn(() => thenable),
      observeGet: vi.fn(() => thenable),
      observeFallback: vi.fn(() => thenable),
      observeSerialization: vi.fn(() => thenable),
      observeSize: vi.fn(() => thenable),
    } as unknown as DialCacheMetricsAdapter;
    const dialcache = new DialCache({ metrics });
    const isolatedMetrics = (dialcache as unknown as {
      readonly metrics: DialCacheMetricsAdapter;
    }).metrics;
    const labels: CacheMetricLabels = {
      cacheNamespace: "urn",
      useCase: "RejectingMetricsThenable",
      keyType: "user_id",
      layer: CacheLayer.LOCAL,
    };

    isolatedMetrics.request(labels);
    isolatedMetrics.miss({ ...labels, reason: "value_absent" });
    isolatedMetrics.disabled({ ...labels, reason: "ramped_down" });
    isolatedMetrics.error({ ...labels, error: "cache_read", inFallback: false });
    isolatedMetrics.invalidation({
      cacheNamespace: "urn",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
    });
    isolatedMetrics.coalesced?.({
      cacheNamespace: "urn",
      useCase: "RejectingMetricsThenable",
      keyType: "user_id",
      scope: "process",
    });
    isolatedMetrics.shadowValidation?.({
      cacheNamespace: "urn",
      useCase: "RejectingMetricsThenable",
      keyType: "user_id",
      outcome: "match",
    } satisfies ShadowValidationMetricLabels);
    isolatedMetrics.observeFutureTimestampOffset?.(labels, 0.001);
    isolatedMetrics.staleRecovery?.({
      cacheNamespace: "urn",
      useCase: "RejectingMetricsThenable",
      keyType: "user_id",
      outcome: "served",
    } satisfies StaleRecoveryMetricLabels);
    isolatedMetrics.observeStaleRecoveryValueAge?.(
      {
        cacheNamespace: "urn",
        useCase: "RejectingMetricsThenable",
        keyType: "user_id",
        outcome: "served",
      } satisfies StaleRecoveryMetricLabels,
      60,
    );
    isolatedMetrics.observeGet(labels, 0);
    isolatedMetrics.observeFallback(labels, 0);
    isolatedMetrics.observeSerialization({ ...labels, operation: "dump" }, 0);
    isolatedMetrics.observeSize(labels, 0);

    expect(then).not.toHaveBeenCalled();
    await tick();
    expect(then).toHaveBeenCalledTimes(14);
  });

  it("includes the configured cache namespace on every metric path", async () => {
    const metrics = new RecordingMetrics();
    const redis = new FakeRedis();
    let releaseFallback: () => void = () => undefined;
    const fallbackGate = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    const dialcache = new DialCache({
      namespace: "users-cache",
      metrics,
      redis: { client: redis, readTimeoutMs: 1_000 },
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const getUser = dialcache.cached(async (userId: string) => {
      if (userId === "123") {
        await fallbackGate;
      }
      return { userId };
    }, {
      keyType: "user_id",
      useCase: "NamespaceMetrics",
      cacheKey: (userId) => userId,
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });
    const badKey = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "NamespaceNoKeyMetrics",
      cacheKey: () => {
        throw new Error("bad key");
      },
      defaultConfig: localOnly(),
    });

    await getUser("disabled");
    const pending = dialcache.enable(async () => await Promise.all([getUser("123"), getUser("123")]));
    await tick();
    releaseFallback();
    await pending;
    await dialcache.enable(async () => await badKey("123"));
    await dialcache.invalidateRemote("user_id", "123");

    expect(new Set(metrics.events.map(({ name }) => name))).toEqual(
      new Set([
        "request",
        "miss",
        "disabled",
        "error",
        "invalidation",
        "coalesced",
        "get",
        "fallback",
        "serialization",
        "size",
      ]),
    );
    expect(metrics.events.every(({ labels }) => labels.cacheNamespace === "users-cache")).toBe(true);
    expect(events(metrics, "disabled", { useCase: "NamespaceMetrics", layer: "noop", reason: "context" })).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "NamespaceNoKeyMetrics",
        layer: "noop",
        error: "key_construction",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(events(metrics, "invalidation", { keyType: "user_id", layer: CacheLayer.REMOTE })).toHaveLength(1);
  });

  it("supports an injected metrics adapter without requiring Prometheus", async () => {
    // Given a custom in-memory metrics adapter.
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "CustomMetricsAdapter",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });

    // When a local miss is followed by a local hit.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then the adapter receives behavioral request/miss/timer events for the local layer.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
    expect(events(metrics, "request", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(2);
    expect(
      events(metrics, "miss", {
        useCase: "CustomMetricsAdapter",
        layer: CacheLayer.LOCAL,
        reason: "value_absent",
      }),
    ).toHaveLength(1);
    expect(events(metrics, "fallback", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(1);
    expect(events(metrics, "get", { useCase: "CustomMetricsAdapter", layer: CacheLayer.LOCAL })).toHaveLength(2);
  });

  it("classifies request-local, local, and bundled Redis absence as value_absent", async () => {
    const metrics = new RecordingMetrics();
    const requestLocalCache = new DialCache({ metrics });
    const localCache = new DialCache({ metrics });
    const remoteCache = new DialCache({
      metrics,
      redis: { client: new FakeRedis(), readTimeoutMs: 1_000 },
    });

    const requestLocal = requestLocalCache.cached(async () => "request-local", {
      keyType: "user_id",
      useCase: "RequestLocalAbsentReason",
      cacheKey: () => "123",
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });
    const local = localCache.cached(async () => "local", {
      keyType: "user_id",
      useCase: "LocalAbsentReason",
      cacheKey: () => "123",
      defaultConfig: localOnly(),
    });
    const remote = remoteCache.cached(async () => "remote", {
      keyType: "user_id",
      useCase: "BundledRedisAbsentReason",
      cacheKey: () => "123",
      defaultConfig: remoteOnly(),
    });

    await requestLocalCache.enable(async () => await requestLocal());
    await localCache.enable(async () => await local());
    await remoteCache.enable(async () => await remote());

    expect(
      events(metrics, "miss", {
        useCase: "RequestLocalAbsentReason",
        layer: "request_local",
        reason: "value_absent",
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "miss", {
        useCase: "LocalAbsentReason",
        layer: CacheLayer.LOCAL,
        reason: "value_absent",
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "miss", {
        useCase: "BundledRedisAbsentReason",
        layer: CacheLayer.REMOTE,
        reason: "value_absent",
      }),
    ).toHaveLength(1);
  });

  it("classifies a legacy custom Redis null miss as unclassified", async () => {
    const metrics = new RecordingMetrics();
    const redis: DialCacheRedisClient = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
    };
    const dialcache = new DialCache({ metrics, redis: { client: redis, readTimeoutMs: 1_000 } });
    const getUser = dialcache.cached(async () => "fallback", {
      keyType: "user_id",
      useCase: "LegacyRedisNullReason",
      cacheKey: () => "123",
      defaultConfig: remoteOnly(),
    });

    await dialcache.enable(async () => await getUser());

    expect(
      events(metrics, "miss", {
        useCase: "LegacyRedisNullReason",
        layer: CacheLayer.REMOTE,
        reason: "unclassified",
      }),
    ).toHaveLength(1);
  });

  it("classifies a logically expired bundled Redis frame as an expired miss", async () => {
    const metrics = new RecordingMetrics();
    const redis = new FakeRedis();
    const useCase = "BundledRedisExpiredReason";
    const key = new DialCacheKey({ keyType: "user_id", id: "123", useCase });
    // Logically past the 60 s remote TTL while still physically present in Redis.
    redis.setRaw(`${key.urn}:dialcache-frame-v1`, encodeFrame("cached", Date.now() - 60_000), 120_000);
    const dialcache = new DialCache({ metrics, redis: { client: redis, readTimeoutMs: 1_000 } });
    const getUser = dialcache.cached(async () => "fallback", {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: remoteOnly(),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toBe("fallback");

    expect(events(metrics, "miss", { useCase })).toEqual([
      {
        name: "miss",
        labels: {
          cacheNamespace: "urn",
          useCase,
          keyType: "user_id",
          layer: CacheLayer.REMOTE,
          reason: "expired",
        },
      },
    ]);
    expect(redis.setCalls).toBe(1);
  });

  it("passes a custom adapter's expired reason through unchanged", async () => {
    const metrics = new RecordingMetrics();
    const redis: DialCacheRedisClient = {
      read: vi.fn(async () => ({ reason: "expired" as const })),
      write: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
    };
    const dialcache = new DialCache({ metrics, redis: { client: redis, readTimeoutMs: 1_000 } });
    const getUser = dialcache.cached(async () => "fallback", {
      keyType: "user_id",
      useCase: "CustomExpiredReason",
      cacheKey: () => "123",
      defaultConfig: remoteOnly(),
    });

    await dialcache.enable(async () => await getUser());

    expect(events(metrics, "miss", { useCase: "CustomExpiredReason" })).toEqual([
      {
        name: "miss",
        labels: {
          cacheNamespace: "urn",
          useCase: "CustomExpiredReason",
          keyType: "user_id",
          layer: CacheLayer.REMOTE,
          reason: "expired",
        },
      },
    ]);
    expect(redis.write).toHaveBeenCalledOnce();
  });

  it("normalizes untrusted custom miss metadata to unclassified", async () => {
    const cases: ReadonlyArray<{
      readonly useCase: string;
      readonly trackForInvalidation: boolean;
      readonly result: RedisReadResult;
    }> = [
      {
        useCase: "UntrackedCustomFenceReason",
        trackForInvalidation: false,
        result: { reason: "watermark_fenced" },
      },
      {
        useCase: "UntrackedCustomWatermarkMiss",
        trackForInvalidation: false,
        result: {
          kind: "watermark_miss",
          reason: "watermark_fenced",
          observedWatermarkMs: 1_700_000_000_000,
        },
      },
      {
        useCase: "UnboundedCustomReason",
        trackForInvalidation: false,
        result: { reason: "invented" } as unknown as RedisReadResult,
      },
      {
        useCase: "InvalidTrackedCustomFenceReason",
        trackForInvalidation: true,
        result: {
          kind: "watermark_miss",
          reason: "watermark_fenced",
          observedWatermarkMs: Number.NaN,
        },
      },
    ];
    let readIndex = 0;
    const metrics = new RecordingMetrics();
    const redis: DialCacheRedisClient = {
      read: vi.fn(async () => cases[readIndex++]?.result ?? null),
      write: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
    };
    const dialcache = new DialCache({ metrics, redis: { client: redis, readTimeoutMs: 1_000 } });

    for (const { useCase, trackForInvalidation } of cases) {
      const getUser = dialcache.cached(async () => "fallback", {
        keyType: "user_id",
        useCase,
        cacheKey: () => useCase,
        trackForInvalidation,
        defaultConfig: remoteOnly(),
      });
      await expect(dialcache.enable(async () => await getUser())).resolves.toBe("fallback");
      expect(
        events(metrics, "miss", { useCase, layer: CacheLayer.REMOTE, reason: "unclassified" }),
      ).toHaveLength(1);
      expect(
        events(metrics, "miss", { useCase, layer: CacheLayer.REMOTE, reason: "watermark_fenced" }),
      ).toHaveLength(0);
      expect(
        events(metrics, "error", { useCase, layer: CacheLayer.REMOTE, error: "cache_read", inFallback: false }),
      ).toHaveLength(0);
    }
  });

  it.each(["value_absent", "watermark_fenced"] as const)(
    "recognizes a custom %s miss with explicitly undefined hit fields",
    async (reason) => {
      const trackForInvalidation = reason === "watermark_fenced";
      const result = {
        reason,
        ...(trackForInvalidation ? {
          kind: "watermark_miss",
          observedWatermarkMs: Date.now() + 60_000,
        } : {}),
        payload: undefined,
        createdAtMs: undefined,
      } as unknown as RedisReadResult;
      const metrics = new RecordingMetrics();
      const redis: DialCacheRedisClient = {
        read: vi.fn(async () => result),
        write: vi.fn(async () => undefined),
        invalidate: vi.fn(async () => undefined),
      };
      const useCase = "ExplicitlyUndefinedMissFields";
      const dialcache = new DialCache({ metrics, redis: { client: redis, readTimeoutMs: 1_000 } });
      const getUser = dialcache.cached(async () => "fallback", {
        keyType: "user_id",
        useCase,
        cacheKey: () => "123",
        trackForInvalidation,
        defaultConfig: remoteOnly(),
      });

      await expect(dialcache.enable(async () => await getUser())).resolves.toBe("fallback");

      expect(events(metrics, "miss", { useCase, layer: CacheLayer.REMOTE, reason })).toHaveLength(1);
      expect(events(metrics, "error", { useCase })).toHaveLength(0);
      expect(redis.write).toHaveBeenCalledTimes(trackForInvalidation ? 0 : 1);
    },
  );

  it("classifies a tracked FakeRedis frame fenced by its observed watermark", async () => {
    const metrics = new RecordingMetrics();
    const redis = new FakeRedis();
    const useCase = "TrackedWatermarkFencedReason";
    const key = new DialCacheKey({
      keyType: "user_id",
      id: "123",
      useCase,
      trackForInvalidation: true,
    });
    redis.setRaw(`${key.urn}:dialcache-frame-v1`, encodeFrame("stale", 100));
    redis.setRaw(`${key.prefix}#watermark`, "100");
    const dialcache = new DialCache({ metrics, redis: { client: redis, readTimeoutMs: 1_000 } });
    const getUser = dialcache.cached(async () => "fallback", {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      trackForInvalidation: true,
      defaultConfig: remoteOnly(),
    });

    await dialcache.enable(async () => await getUser());

    expect(
      events(metrics, "miss", {
        useCase,
        layer: CacheLayer.REMOTE,
        reason: "watermark_fenced",
      }),
    ).toHaveLength(1);
  });

  it("reports request-local cache activity and request-scoped coalescing with bounded labels", async () => {
    const metrics = new RecordingMetrics();
    const dialcache = new DialCache({ metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "RequestLocalMetrics",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });

    const values = await dialcache.enable(async () => {
      const concurrent = await Promise.all([getUser("123"), getUser("123")]);
      return [...concurrent, await getUser("123")];
    });

    expect(values[1]).toBe(values[0]);
    expect(values[2]).toBe(values[0]);
    expect(calls).toBe(1);
    expect(events(metrics, "request", { useCase: "RequestLocalMetrics", layer: "request_local" })).toHaveLength(2);
    expect(
      events(metrics, "miss", {
        useCase: "RequestLocalMetrics",
        layer: "request_local",
        reason: "value_absent",
      }),
    ).toHaveLength(1);
    expect(events(metrics, "get", { useCase: "RequestLocalMetrics", layer: "request_local" })).toHaveLength(2);
    expect(events(metrics, "fallback", { useCase: "RequestLocalMetrics", layer: "request_local" })).toHaveLength(1);
    expect(events(metrics, "coalesced", { useCase: "RequestLocalMetrics", scope: "request_local" })).toHaveLength(1);
  });

  it("fails open when an injected metrics adapter throws", async () => {
    // Given a custom metrics adapter throws for every metric call.
    const throwingMetrics: DialCacheMetricsAdapter = {
      request: () => { throw new Error("metrics unavailable"); },
      miss: () => { throw new Error("metrics unavailable"); },
      disabled: () => { throw new Error("metrics unavailable"); },
      error: () => { throw new Error("metrics unavailable"); },
      invalidation: () => { throw new Error("metrics unavailable"); },
      observeGet: () => { throw new Error("metrics unavailable"); },
      observeFallback: () => { throw new Error("metrics unavailable"); },
      observeSerialization: () => { throw new Error("metrics unavailable"); },
      observeSize: () => { throw new Error("metrics unavailable"); },
    };
    const dialcache = new DialCache({ metrics: throwingMetrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "ThrowingMetricsFailOpen",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });

    // When metrics emission fails around a cache miss and hit.
    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    // Then metrics failures do not break application fallback or cache behavior.
    expect(first).toEqual({ userId: "123", calls: 1 });
    expect(second).toEqual({ userId: "123", calls: 1 });
  });

  it("fails open when the coalesced metrics hook throws", async () => {
    const metrics = new RecordingMetrics();
    const coalesced = vi.spyOn(metrics, "coalesced").mockImplementation(() => {
      throw new Error("metrics unavailable");
    });
    let releaseFallback: () => void = () => undefined;
    const fallbackGate = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    const dialcache = new DialCache({ metrics });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => {
      calls += 1;
      await fallbackGate;
      return { userId, calls };
    }, {
      keyType: "user_id",
      useCase: "ThrowingCoalescedMetricFailOpen",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });

    const inflight = dialcache.enable(async () => await Promise.all([getUser("123"), getUser("123")]));
    await tick();

    expect(calls).toBe(1);
    expect(coalesced).toHaveBeenCalledTimes(1);

    releaseFallback();

    await expect(inflight).resolves.toEqual([
      { userId: "123", calls: 1 },
      { userId: "123", calls: 1 },
    ]);
  });

  it("classifies disabled cache skips by reason", async () => {
    // Given one cache call is outside context and other enabled calls have disabled layer config.
    const metrics = new RecordingMetrics();
    const invalidRuntimeTtl = localOnly(0);
    const invalidRuntimeRamp = new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
      ramp: { [CacheLayer.LOCAL]: Number.NaN },
    });
    const dialcache = new DialCache({
      metrics,
      cacheConfigProvider: (key) =>
        key.useCase === "DisabledByInvalidTtl"
          ? invalidRuntimeTtl
          : key.useCase === "DisabledByInvalidRamp"
            ? invalidRuntimeRamp
            : null,
    });
    const contextDisabled = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "DisabledByContext",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });
    const policyDisabled = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "DisabledByPolicy",
      cacheKey: (userId) => userId,
    });
    const invalidTtl = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "DisabledByInvalidTtl",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });
    const invalidRamp = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "DisabledByInvalidRamp",
      cacheKey: (userId) => userId,
      defaultConfig: localOnly(),
    });
    const rampedDown = dialcache.cached(async (userId: string) => userId, {
      keyType: "user_id",
      useCase: "DisabledByRamp",
      cacheKey: (userId) => userId,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 0 },
      }),
    });

    // When each path is called.
    await contextDisabled("123");
    await dialcache.enable(async () => {
      await policyDisabled("123");
      await invalidTtl("123");
      await invalidRamp("123");
      await rampedDown("123");
    });

    // Then disabled metrics preserve the operational reason labels.
    expect(events(metrics, "disabled", { useCase: "DisabledByContext", layer: "noop", reason: "context" })).toHaveLength(1);
    expect(
      events(metrics, "disabled", { useCase: "DisabledByPolicy", layer: CacheLayer.LOCAL, reason: "policy_disabled" }),
    ).toHaveLength(1);
    expect(events(metrics, "disabled", { useCase: "DisabledByInvalidTtl", layer: CacheLayer.LOCAL, reason: "invalid_ttl" })).toHaveLength(1);
    expect(events(metrics, "disabled", { useCase: "DisabledByInvalidRamp", layer: CacheLayer.LOCAL, reason: "invalid_ramp" })).toHaveLength(1);
    expect(events(metrics, "disabled", { useCase: "DisabledByRamp", layer: CacheLayer.LOCAL, reason: "ramped_down" })).toHaveLength(1);

    // And invalid runtime leaves count as config_resolution errors, while
    // intentional ramp-downs and absent policy do not.
    expect(
      events(metrics, "error", { useCase: "DisabledByInvalidTtl", layer: CacheLayer.LOCAL, error: "config_resolution", inFallback: false }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", { useCase: "DisabledByInvalidRamp", layer: CacheLayer.LOCAL, error: "config_resolution", inFallback: false }),
    ).toHaveLength(1);
    expect(events(metrics, "error", { useCase: "DisabledByRamp" })).toHaveLength(0);
    expect(events(metrics, "error", { useCase: "DisabledByPolicy" })).toHaveLength(0);
  });

  it("reports invalid stale-on-error policy without disabling fresh Redis", async () => {
    const metrics = new RecordingMetrics();
    const redis = new FakeRedis();
    const dialcache = new DialCache({
      metrics,
      redis: { client: redis, readTimeoutMs: 1_000 },
      cacheConfigProvider: async () => new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        staleOnErrorMaxAgeSec: 60,
      }),
    });
    let calls = 0;
    const getUser = dialcache.cached(async (userId: string) => ({ userId, calls: ++calls }), {
      keyType: "user_id",
      useCase: "InvalidStaleOnErrorPolicy",
      cacheKey: (userId) => userId,
    });

    const first = await dialcache.enable(async () => await getUser("123"));
    const second = await dialcache.enable(async () => await getUser("123"));

    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(redis.getCalls).toBe(2);
    expect(redis.setCalls).toBe(1);
    expect(events(metrics, "error", {
      useCase: "InvalidStaleOnErrorPolicy",
      layer: CacheLayer.REMOTE,
      error: "config_resolution",
      inFallback: false,
    })).toHaveLength(2);
    expect(events(metrics, "disabled", {
      useCase: "InvalidStaleOnErrorPolicy",
      layer: CacheLayer.REMOTE,
    })).toHaveLength(0);
  });

  it("labels cache errors separately from fallback errors", async () => {
    // Given cache and fallback errors carry caller-defined names containing dynamic identifiers.
    const metrics = new RecordingMetrics();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cacheError = new Error("redis key urn:user_id:tenant-123 failed");
    cacheError.name = "Tenant123RedisError";
    const failingRedis: DialCacheRedisClient = {
      read: vi.fn(async () => {
        throw cacheError;
      }),
      write: vi.fn(async () => {}),
      invalidate: vi.fn(async () => undefined),
    };
    const cacheFailure = new DialCache({ redis: { client: failingRedis, readTimeoutMs: 1_000 }, metrics, logger });
    const readThroughFailure = cacheFailure.cached(async (userId: string) => ({ userId }), {
      keyType: "user_id",
      useCase: "CacheErrorClassification",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });
    const fallbackCache = new DialCache({ redis: { client: new FakeRedis(), readTimeoutMs: 1_000 }, metrics, logger });
    const fallbackFailure = fallbackCache.cached(async (userId: string) => {
      const fallbackError = new TypeError("database failed for tenant-456");
      fallbackError.name = "Tenant456DatabaseError";
      throw fallbackError;
    }, {
      keyType: "user_id",
      useCase: "FallbackErrorClassification",
      cacheKey: (userId) => userId,
      defaultConfig: remoteOnly(),
    });

    // When the cache error fails open and the fallback error escapes.
    await cacheFailure.enable(async () => await readThroughFailure("123"));
    await expect(fallbackCache.enable(async () => await fallbackFailure("123"))).rejects.toThrow("database failed for tenant-456");

    // Then stable failure sites reach the adapter without raw names, messages, IDs, or Redis keys.
    expect(
      events(metrics, "error", {
        useCase: "CacheErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "cache_read",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "FallbackErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "fallback",
        inFallback: true,
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(events(metrics, "error", {}))).not.toMatch(
      /Tenant123RedisError|Tenant456DatabaseError|tenant-123|tenant-456|urn:user_id/,
    );
  });

  it("records one complete telemetry trail when stale recovery serves a retained value", async () => {
    const metrics = new RecordingMetrics();
    const redis = new FakeRedis();
    const useCase = "StaleRecoveryServedMetrics";
    const staleValue = { userId: "123", version: 1 };
    const key = new DialCacheKey({ keyType: "user_id", id: "123", useCase });
    redis.setRaw(
      `${key.urn}:dialcache-frame-v1`,
      encodeFrame(staleValue, Date.now() - 2_000),
      10_000,
    );
    const source = vi.fn(async () => {
      throw new Error("source unavailable");
    });
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dialcache = new DialCache({
      metrics,
      redis: { client: redis, readTimeoutMs: 1_000 },
      logger,
      shouldAttemptStaleRecovery: () => true,
    });
    const getUser = dialcache.cached(source, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleRemoteOnly(),
    });

    await expect(dialcache.enable(async () => await getUser())).resolves.toEqual(staleValue);

    expect(source).toHaveBeenCalledOnce();
    expect(events(metrics, "error", { useCase })).toEqual([
      {
        name: "error",
        labels: {
          cacheNamespace: "urn",
          useCase,
          keyType: "user_id",
          layer: CacheLayer.REMOTE,
          error: "fallback",
          inFallback: true,
        },
      },
    ]);
    const remoteLabels = {
      cacheNamespace: "urn",
      useCase,
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
    };
    expect(events(metrics, "fallback", { useCase })).toEqual([
      { name: "fallback", labels: remoteLabels, value: expect.any(Number) },
    ]);
    expect(events(metrics, "miss", { useCase })).toEqual([
      { name: "miss", labels: { ...remoteLabels, reason: "expired" } },
    ]);
    expect(events(metrics, "request", { useCase })).toEqual([
      { name: "request", labels: remoteLabels },
    ]);
    expect(events(metrics, "get", { useCase })).toEqual([
      { name: "get", labels: remoteLabels, value: expect.any(Number) },
    ]);
    expect(events(metrics, "staleRecovery", { useCase })).toEqual([
      {
        name: "staleRecovery",
        labels: {
          cacheNamespace: "urn",
          useCase,
          keyType: "user_id",
          outcome: "served",
        },
      },
    ]);
    expect(events(metrics, "staleRecoveryValueAge", { useCase })).toEqual([
      {
        name: "staleRecoveryValueAge",
        labels: {
          cacheNamespace: "urn",
          useCase,
          keyType: "user_id",
          outcome: "served",
        },
        value: expect.any(Number),
      },
    ]);
    expect(events(metrics, "staleRecoveryValueAge", { useCase })[0]?.value).toBeGreaterThanOrEqual(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not record stale value age when recovery misses", async () => {
    const metrics = new RecordingMetrics();
    const redis = new FakeRedis();
    const useCase = "StaleRecoveryMissMetrics";
    const sourceError = new Error("source unavailable");
    const dialcache = new DialCache({
      metrics,
      redis: { client: redis, readTimeoutMs: 1_000 },
      shouldAttemptStaleRecovery: () => true,
    });
    const getUser = dialcache.cached(async (): Promise<{ readonly userId: string }> => {
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleRemoteOnly(),
    });

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(sourceError);

    expect(events(metrics, "staleRecovery", { useCase })).toEqual([
      {
        name: "staleRecovery",
        labels: {
          cacheNamespace: "urn",
          useCase,
          keyType: "user_id",
          outcome: "miss",
        },
      },
    ]);
    expect(events(metrics, "staleRecoveryValueAge", { useCase })).toHaveLength(0);
  });

  it("does not record stale value age when recovery deserialization fails", async () => {
    const metrics = new RecordingMetrics();
    const redis = new FakeRedis();
    const useCase = "StaleRecoveryDeserializationErrorMetrics";
    const sourceError = new Error("source unavailable");
    const key = new DialCacheKey({ keyType: "user_id", id: "123", useCase });
    redis.setRaw(
      `${key.urn}:dialcache-frame-v1`,
      encodeFrame({ userId: "123" }, Date.now() - 2_000),
      10_000,
    );
    const serializer: Serializer<{ readonly userId: string }> = {
      dump: async (value) => JSON.stringify(value),
      load: async () => {
        throw new Error("cannot deserialize retained value");
      },
    };
    const dialcache = new DialCache({
      metrics,
      redis: { client: redis, readTimeoutMs: 1_000 },
      shouldAttemptStaleRecovery: () => true,
    });
    const getUser = dialcache.cached(async (): Promise<{ readonly userId: string }> => {
      throw sourceError;
    }, {
      keyType: "user_id",
      useCase,
      cacheKey: () => "123",
      defaultConfig: staleRemoteOnly(),
      serializer,
    });

    await expect(dialcache.enable(async () => await getUser())).rejects.toBe(sourceError);

    expect(events(metrics, "staleRecovery", { useCase })).toEqual([
      {
        name: "staleRecovery",
        labels: {
          cacheNamespace: "urn",
          useCase,
          keyType: "user_id",
          outcome: "deserialization_error",
        },
      },
    ]);
    expect(events(metrics, "staleRecoveryValueAge", { useCase })).toHaveLength(0);
  });

  it("samples served stale value age after asynchronous deserialization completes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clockStart = new Date("2026-08-29T12:00:00.000Z");
    vi.setSystemTime(clockStart);

    try {
      const metrics = new RecordingMetrics();
      const redis = new FakeRedis();
      const useCase = "StaleRecoveryReturnTimeValueAgeMetrics";
      const staleValue = { userId: "123" };
      const key = new DialCacheKey({ keyType: "user_id", id: "123", useCase });
      redis.setRaw(
        `${key.urn}:dialcache-frame-v1`,
        encodeFrame(staleValue, clockStart.getTime() - 2_000),
        10_000,
      );
      let markLoadStarted!: () => void;
      const loadStarted = new Promise<void>((resolve) => {
        markLoadStarted = resolve;
      });
      let releaseLoad!: () => void;
      const loadGate = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      const serializer: Serializer<typeof staleValue> = {
        dump: async (value) => JSON.stringify(value),
        load: async () => {
          markLoadStarted();
          await loadGate;
          return staleValue;
        },
      };
      const dialcache = new DialCache({
        metrics,
        redis: { client: redis, readTimeoutMs: 1_000 },
        shouldAttemptStaleRecovery: () => true,
      });
      const getUser = dialcache.cached(async (): Promise<typeof staleValue> => {
        throw new Error("source unavailable");
      }, {
        keyType: "user_id",
        useCase,
        cacheKey: () => "123",
        defaultConfig: staleRemoteOnly(),
        serializer,
      });

      const result = dialcache.enable(async () => await getUser());
      await loadStarted;
      expect(events(metrics, "staleRecoveryValueAge", { useCase })).toHaveLength(0);

      vi.setSystemTime(clockStart.getTime() + 3_000);
      releaseLoad();

      await expect(result).resolves.toEqual(staleValue);
      expect(events(metrics, "staleRecoveryValueAge", { useCase })).toEqual([
        {
          name: "staleRecoveryValueAge",
          labels: {
            cacheNamespace: "urn",
            useCase,
            keyType: "user_id",
            outcome: "served",
          },
          value: 5,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies config, Redis write, and serializer failures by stable operation", async () => {
    const metrics = new RecordingMetrics();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const configFailure = new DialCache({
      metrics,
      logger,
      cacheConfigProvider: async () => new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: Number.NaN },
      }),
    });
    const resolveConfig = configFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "ConfigErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
      }),
    });
    await configFailure.enable(async () => await resolveConfig("123"));

    const failingWriteRedis = new FakeRedis();
    failingWriteRedis.failSet = true;
    const writeFailure = new DialCache({ redis: { client: failingWriteRedis, readTimeoutMs: 1_000 }, metrics, logger });
    const writeValue = writeFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "WriteErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly(),
    });
    await writeFailure.enable(async () => await writeValue("123"));

    const dumpError = new Error("tenant-456 serializer dump failed");
    dumpError.name = "Tenant456DumpError";
    const dumpSerializer: Serializer<string> = {
      dump: async () => {
        throw dumpError;
      },
      load: async (value) => value.toString(),
    };
    const dumpFailure = new DialCache({ redis: { client: new FakeRedis(), readTimeoutMs: 1_000 }, metrics, logger });
    const dumpValue = dumpFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "SerializationDumpClassification",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly(),
      serializer: dumpSerializer,
    });
    await dumpFailure.enable(async () => await dumpValue("123"));

    const loadRedis = new FakeRedis();
    const loadWriter = new DialCache({ redis: { client: loadRedis, readTimeoutMs: 1_000 } });
    const writeLoadFixture = loadWriter.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "SerializationLoadClassification",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly(),
    });
    await loadWriter.enable(async () => await writeLoadFixture("123"));
    const loadError = new Error("tenant-789 serializer load failed");
    loadError.name = "Tenant789LoadError";
    const loadSerializer: Serializer<string> = {
      dump: async (value) => value,
      load: async () => {
        throw loadError;
      },
    };
    const loadFailure = new DialCache({ redis: { client: loadRedis, readTimeoutMs: 1_000 }, metrics, logger });
    const loadValue = loadFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "SerializationLoadClassification",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly(),
      serializer: loadSerializer,
    });
    await loadFailure.enable(async () => await loadValue("123"));

    expect(
      events(metrics, "error", {
        useCase: "ConfigErrorClassification",
        layer: CacheLayer.LOCAL,
        error: "config_resolution",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "WriteErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "cache_write",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "SerializationDumpClassification",
        layer: CacheLayer.REMOTE,
        error: "serialization_dump",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "SerializationDumpClassification",
        layer: CacheLayer.REMOTE,
        error: "cache_write",
        inFallback: false,
      }),
    ).toHaveLength(0);
    expect(
      events(metrics, "error", {
        useCase: "SerializationLoadClassification",
        layer: CacheLayer.REMOTE,
        error: "serialization_load",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "miss", {
        useCase: "SerializationLoadClassification",
        layer: CacheLayer.REMOTE,
        reason: "unclassified",
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(events(metrics, "error", {}))).not.toMatch(
      /Tenant456DumpError|Tenant789LoadError|tenant-456|tenant-789/,
    );
  });

  it("classifies provider and remote layer config failures", async () => {
    const metrics = new RecordingMetrics();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const providerError = new Error("config provider failed for tenant-123");
    providerError.name = "Tenant123ConfigProviderError";
    const providerFailure = new DialCache({
      metrics,
      logger,
      cacheConfigProvider: async () => {
        throw providerError;
      },
    });
    const resolveProviderConfig = providerFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "ProviderConfigErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: localOnly(),
    });

    const remoteFailure = new DialCache({
      redis: { client: new FakeRedis(), readTimeoutMs: 1_000 },
      metrics,
      logger,
      cacheConfigProvider: async () => new DialCacheKeyConfig({
        ramp: { [CacheLayer.REMOTE]: Number.NaN },
      }),
    });
    const resolveRemoteConfig = remoteFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "RemoteConfigErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
      }),
    });

    await providerFailure.enable(async () => await resolveProviderConfig("123"));
    await remoteFailure.enable(async () => await resolveRemoteConfig("456"));

    expect(
      events(metrics, "error", {
        useCase: "ProviderConfigErrorClassification",
        layer: "noop",
        error: "config_resolution",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "RemoteConfigErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "config_resolution",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "disabled", {
        useCase: "ProviderConfigErrorClassification",
        layer: "noop",
        reason: "config_error",
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "disabled", {
        useCase: "RemoteConfigErrorClassification",
        layer: CacheLayer.REMOTE,
        reason: "invalid_ramp",
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(events(metrics, "error", {}))).not.toMatch(/Tenant123ConfigProviderError|tenant-123/);
  });

  it("classifies local cache reads and writes", async () => {
    const metrics = new RecordingMetrics();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const readFailure = new DialCache({ metrics, logger });
    const readLocalCache = (readFailure as unknown as {
      readonly localCache: { getWithResolvedConfig: () => unknown };
    }).localCache;
    vi.spyOn(readLocalCache, "getWithResolvedConfig").mockImplementationOnce(() => {
      throw new Error("local read failed");
    });
    const readValue = readFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "LocalReadErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: localOnly(),
    });

    const writeFailure = new DialCache({ metrics, logger });
    const writeLocalCache = (writeFailure as unknown as {
      readonly localCache: { put: () => void };
    }).localCache;
    vi.spyOn(writeLocalCache, "put").mockImplementationOnce(() => {
      throw new Error("local write failed");
    });
    const writeValue = writeFailure.cached(async (id: string) => id, {
      keyType: "user_id",
      useCase: "LocalWriteErrorClassification",
      cacheKey: (id) => id,
      defaultConfig: localOnly(),
    });

    await readFailure.enable(async () => await readValue("123"));
    await writeFailure.enable(async () => await writeValue("456"));

    expect(
      events(metrics, "error", {
        useCase: "LocalReadErrorClassification",
        layer: CacheLayer.LOCAL,
        error: "cache_read",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "LocalWriteErrorClassification",
        layer: CacheLayer.LOCAL,
        error: "cache_write",
        inFallback: false,
      }),
    ).toHaveLength(1);
  });

  it("labels fallback errors with every reachable metric layer", async () => {
    const metrics = new RecordingMetrics();
    const noopFailure = new DialCache({ metrics });
    const noopFallback = noopFailure.cached(async () => {
      throw new Error("noop fallback failed");
    }, {
      keyType: "user_id",
      useCase: "NoopFallbackErrorClassification",
      cacheKey: () => {
        throw new Error("key construction failed");
      },
      defaultConfig: localOnly(),
    });
    const requestLocalFailure = new DialCache({ metrics });
    const requestLocalFallback = requestLocalFailure.cached(async (_id: string) => {
      throw new Error("request-local fallback failed");
    }, {
      keyType: "user_id",
      useCase: "RequestLocalFallbackErrorClassification",
      cacheKey: (id: string) => id,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    });
    const localFailure = new DialCache({ metrics });
    const localFallback = localFailure.cached(async (_id: string) => {
      throw new Error("local fallback failed");
    }, {
      keyType: "user_id",
      useCase: "LocalFallbackErrorClassification",
      cacheKey: (id: string) => id,
      defaultConfig: localOnly(),
    });
    const remoteFailure = new DialCache({ redis: { client: new FakeRedis(), readTimeoutMs: 1_000 }, metrics });
    const remoteFallback = remoteFailure.cached(async (_id: string) => {
      throw new Error("remote fallback failed");
    }, {
      keyType: "user_id",
      useCase: "RemoteFallbackErrorClassification",
      cacheKey: (id: string) => id,
      defaultConfig: remoteOnly(),
    });

    await expect(noopFailure.enable(async () => await noopFallback())).rejects.toThrow("noop fallback failed");
    await expect(requestLocalFailure.enable(async () => await requestLocalFallback("123"))).rejects.toThrow(
      "request-local fallback failed",
    );
    await expect(localFailure.enable(async () => await localFallback("123"))).rejects.toThrow("local fallback failed");
    await expect(remoteFailure.enable(async () => await remoteFallback("123"))).rejects.toThrow("remote fallback failed");

    expect(
      events(metrics, "error", {
        useCase: "NoopFallbackErrorClassification",
        layer: "noop",
        error: "key_construction",
        inFallback: false,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "NoopFallbackErrorClassification",
        layer: "noop",
        error: "fallback",
        inFallback: true,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "RequestLocalFallbackErrorClassification",
        layer: "request_local",
        error: "fallback",
        inFallback: true,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "LocalFallbackErrorClassification",
        layer: CacheLayer.LOCAL,
        error: "fallback",
        inFallback: true,
      }),
    ).toHaveLength(1);
    expect(
      events(metrics, "error", {
        useCase: "RemoteFallbackErrorClassification",
        layer: CacheLayer.REMOTE,
        error: "fallback",
        inFallback: true,
      }),
    ).toHaveLength(1);
  });

});

function events(
  metrics: RecordingMetrics,
  name: string,
  labels: Record<string, string | boolean>,
): Array<{ readonly name: string; readonly labels: Record<string, unknown>; readonly value?: number }> {
  return metrics.events.filter(
    (event) => event.name === name && Object.entries(labels).every(([key, value]) => event.labels[key] === value),
  );
}

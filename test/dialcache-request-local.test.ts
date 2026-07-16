import { describe, expect, it, vi } from "vitest";

import { CacheLayer, DialCache, DialCacheKeyConfig } from "../src/index.js";
import { peekRequestLocalCache, type DialCacheContext } from "../src/context.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
}

interface RequestLocalCacheInspection {
  readonly values: Map<string, unknown>;
  readonly inFlight: Map<string, Promise<unknown>>;
  read: <T>(key: string) => { readonly status: "hit"; readonly value: T } | { readonly status: "miss" };
  set: <T>(key: string, value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const requestLocalConfig = (requestLocal = true): DialCacheKeyConfig =>
  new DialCacheKeyConfig({ requestLocal });

function inspectContext(dialcache: DialCache): DialCacheContext {
  return (dialcache as unknown as {
    readonly context: DialCacheContext;
  }).context;
}

describe("DialCache request-local cache", () => {
  it("memoizes sequential request-local-only reads without sharing across outer scopes", async () => {
    const dialcache = new DialCache({ localMaxSize: 0 });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "RequestLocalScopeIsolation",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });

    const firstScope = await dialcache.enable(async () => [await getUser("123"), await getUser("123")] as const);
    const secondScope = await dialcache.enable(async () => [await getUser("123"), await getUser("123")] as const);

    expect(firstScope).toEqual([
      { id: "123", call: 1 },
      { id: "123", call: 1 },
    ]);
    expect(secondScope).toEqual([
      { id: "123", call: 2 },
      { id: "123", call: 2 },
    ]);
    expect(calls).toBe(2);
  });

  it("reuses the outer request-local scope through nested enable and disable boundaries", async () => {
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "NestedRequestLocalScope",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });

    const result = await dialcache.enable(async () => {
      const first = await getUser("123");
      const nestedEnabled = await dialcache.enable(async () => await getUser("123"));
      const nestedDisabled = await dialcache.disable(async () => {
        const bypass = await getUser("123");
        const reenabled = await dialcache.enable(async () => await getUser("123"));
        return { bypass, reenabled };
      });
      const after = await getUser("123");
      return { first, nestedEnabled, nestedDisabled, after };
    });

    expect(result.first).toEqual({ id: "123", call: 1 });
    expect(result.nestedEnabled).toBe(result.first);
    expect(result.nestedDisabled.bypass).toEqual({ id: "123", call: 2 });
    expect(result.nestedDisabled.reenabled).toBe(result.first);
    expect(result.after).toBe(result.first);
    expect(calls).toBe(2);
  });

  it("keeps enabled state isolated across concurrent sibling branches sharing one request holder", async () => {
    const disabledGate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "ConcurrentNestedScopeIsolation",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });

    const result = await dialcache.enable(async () => {
      const seeded = await getUser("123");
      const disabledBranch = dialcache.disable(async () => {
        await disabledGate.promise;
        return await getUser("123");
      });
      const enabledBranch = await getUser("123");
      disabledGate.resolve();
      return { seeded, enabledBranch, disabledBranch: await disabledBranch };
    });

    expect(result.enabledBranch).toBe(result.seeded);
    expect(result.disabledBranch).toEqual({ id: "123", call: 2 });
    expect(calls).toBe(2);
  });

  it("reads runtime config once per invocation and preserves scoped values across a true-false-true sequence", async () => {
    const configs = [requestLocalConfig(), requestLocalConfig(false), requestLocalConfig()];
    const cacheConfigProvider = vi.fn(async () => configs.shift() ?? null);
    const dialcache = new DialCache({ cacheConfigProvider });
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "RuntimeRequestLocalToggle",
      cacheKey: (id) => id,
    });

    const result = await dialcache.enable(async () => {
      const enabled = await getUser("123");
      const disabled = await getUser("123");
      const reenabled = await getUser("123");
      return { enabled, disabled, reenabled };
    });

    expect(result.enabled).toEqual({ id: "123", call: 1 });
    expect(result.disabled).toEqual({ id: "123", call: 2 });
    expect(result.reenabled).toBe(result.enabled);
    expect(calls).toBe(2);
    expect(cacheConfigProvider).toHaveBeenCalledTimes(3);
  });

  it("isolates distinct keys and distinguishes cached undefined from a miss", async () => {
    const dialcache = new DialCache();
    const calls = new Map<string, number>();
    const getOptional = dialcache.cached(async (id: string) => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      return id === "missing" ? undefined : { id };
    }, {
      keyType: "optional_id",
      useCase: "RequestLocalDistinctAndUndefined",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });
    const result = await dialcache.enable(async () => {
      const distinct = await Promise.all([getOptional("123"), getOptional("456")]);
      return [
        ...distinct,
        await getOptional("123"),
        await getOptional("missing"),
        await getOptional("missing"),
      ] as const;
    });

    expect(result).toEqual([{ id: "123" }, { id: "456" }, { id: "123" }, undefined, undefined]);
    expect(calls).toEqual(new Map([
      ["123", 1],
      ["456", 1],
      ["missing", 1],
    ]));
  });

  it("removes a rejected request-local in-flight entry so the same scope can retry", async () => {
    const gate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => {
      const call = ++calls;
      if (call === 1) {
        await gate.promise;
        throw new Error("database failed");
      }
      return { id, call };
    }, {
      keyType: "user_id",
      useCase: "RequestLocalRejectRetry",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });

    await dialcache.enable(async () => {
      const first = getUser("123");
      const follower = getUser("123");
      await tick();
      gate.resolve();

      const rejected = await Promise.allSettled([first, follower]);
      expect(rejected).toEqual([
        { status: "rejected", reason: expect.any(Error) },
        { status: "rejected", reason: expect.any(Error) },
      ]);
      expect(rejected[0]?.status === "rejected" ? rejected[0].reason.message : undefined).toBe("database failed");
      expect(rejected[1]?.status === "rejected" ? rejected[1].reason.message : undefined).toBe("database failed");

      const retry = await getUser("123");
      const cachedRetry = await getUser("123");
      expect(retry).toEqual({ id: "123", call: 2 });
      expect(cachedRetry).toBe(retry);
    });

    expect(calls).toBe(2);
  });

  it("allocates request-local maps lazily, drops them on close, and rejects detached use of the closed scope", async () => {
    const detachedGate = deferred<void>();
    const dialcache = new DialCache();
    let calls = 0;
    const getUser = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "user_id",
      useCase: "RequestLocalLifecycle",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });
    const getProcessLocal = dialcache.cached(async (id: string) => ({ id }), {
      keyType: "user_id",
      useCase: "RequestLocalLifecycleSharedLayerOnly",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    });
    let requestLocalCache: RequestLocalCacheInspection | undefined;
    let detached: Promise<readonly [{ id: string; call: number }, { id: string; call: number }]> | undefined;
    const context = inspectContext(dialcache);

    const scoped = await dialcache.enable(async () => {
      expect(dialcache.isEnabled()).toBe(true);
      expect(peekRequestLocalCache(context)).toBeNull();
      await getProcessLocal("shared-only");
      expect(peekRequestLocalCache(context)).toBeNull();

      const value = await getUser("123");
      requestLocalCache = peekRequestLocalCache(context) as unknown as RequestLocalCacheInspection;
      expect(requestLocalCache.values.size).toBe(1);
      expect(requestLocalCache.inFlight.size).toBe(0);

      detached = (async () => {
        await detachedGate.promise;
        return [await getUser("123"), await getUser("123")] as const;
      })();
      return value;
    });

    expect(scoped).toEqual({ id: "123", call: 1 });
    expect(peekRequestLocalCache(context)).toBeNull();
    requestLocalCache?.set("late", { stale: true });
    expect(requestLocalCache?.read("late")).toEqual({ status: "miss" });
    expect(requestLocalCache?.values.size).toBe(0);
    expect(requestLocalCache?.inFlight.size).toBe(0);

    detachedGate.resolve();
    await expect(detached).resolves.toEqual([
      { id: "123", call: 2 },
      { id: "123", call: 3 },
    ]);
    expect(peekRequestLocalCache(context)).toBeNull();
    expect(calls).toBe(3);
  });

  it("returns the original value reference without cloning", async () => {
    const dialcache = new DialCache();
    const source = {
      id: "123",
      roles: ["reader"],
      metadata: new Map([["region", "us-west"]]),
      flags: new Set(["active"]),
      buffer: Buffer.from("cached"),
      typed: new Uint8Array([1, 2, 3]),
    };
    let calls = 0;
    const getUser = dialcache.cached(async () => {
      calls += 1;
      return source;
    }, {
      keyType: "user_id",
      useCase: "RequestLocalReferenceIdentity",
      cacheKey: () => "123",
      defaultConfig: requestLocalConfig(),
    });

    const [first, second] = await dialcache.enable(async () => [await getUser(), await getUser()] as const);

    expect(first).toBe(source);
    expect(second).toBe(source);
    expect(second).toBe(first);
    expect(second.metadata).toBe(source.metadata);
    expect(second.flags).toBe(source.flags);
    expect(second.buffer).toBe(source.buffer);
    expect(second.typed).toBe(source.typed);
    expect(calls).toBe(1);
  });

  it("does not apply the process-local entry cap to request-local values", async () => {
    const dialcache = new DialCache({ localMaxSize: 1 });
    let calls = 0;
    const getValue = dialcache.cached(async (id: string) => ({ id, call: ++calls }), {
      keyType: "item_id",
      useCase: "UnboundedRequestLocalEntries",
      cacheKey: (id) => id,
      defaultConfig: requestLocalConfig(),
    });

    await dialcache.enable(async () => {
      const first = await getValue("0");
      for (let id = 1; id <= 10_000; id += 1) {
        await getValue(String(id));
      }
      expect(await getValue("0")).toBe(first);
    });

    expect(calls).toBe(10_001);
  });
});

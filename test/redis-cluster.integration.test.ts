import * as valkeyGlide from "@valkey/valkey-glide";
import { commandOptions, createCluster, type RedisClusterOptions } from "redis";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CacheLayer, DialCache, DialCacheKeyConfig, type DialCacheRedisClient } from "../src/index.js";
import { createNodeRedisDialCacheClient } from "../src/node-redis.js";
import { createValkeyGlideDialCacheClient } from "../src/valkey-glide.js";

const remoteOnly = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

const createTestCluster = (options: RedisClusterOptions) => createCluster(options);

async function waitForCluster(container: StartedTestContainer): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await container.exec(["redis-cli", "cluster", "info"]);
    if (result.output.includes("cluster_state:ok")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Redis Cluster did not become ready");
}

describe("DialCache Redis protocol on Redis Cluster", () => {
  let network: StartedNetwork | undefined;
  let containers: Array<StartedTestContainer> = [];
  let cluster: ReturnType<typeof createTestCluster> | undefined;
  let glideCluster: valkeyGlide.GlideClusterClient | undefined;

  beforeAll(async () => {
    const startedNetwork = await new Network().start();
    network = startedNetwork;
    for (const alias of ["redis-1", "redis-2", "redis-3"]) {
      containers.push(
        await new GenericContainer("redis:7-alpine")
          .withNetwork(startedNetwork)
          .withNetworkAliases(alias)
          .withExposedPorts(6379)
          .withCommand([
            "redis-server",
            "--port",
            "6379",
            "--cluster-enabled",
            "yes",
            "--cluster-config-file",
            "/tmp/nodes.conf",
            "--cluster-node-timeout",
            "5000",
            "--appendonly",
            "no",
            "--protected-mode",
            "no",
          ])
          .withWaitStrategy(Wait.forListeningPorts())
          .start(),
      );
    }

    const networkName = network.getName();
    const internalAddresses = containers.map((container) => `${container.getIpAddress(networkName)}:6379`);
    const firstContainer = containers[0];
    if (firstContainer === undefined) {
      throw new Error("Redis Cluster containers did not start");
    }
    const createResult = await firstContainer.exec([
      "redis-cli",
      "--cluster",
      "create",
      ...internalAddresses,
      "--cluster-replicas",
      "0",
      "--cluster-yes",
    ]);
    if (createResult.exitCode !== 0) {
      throw new Error(`Could not create Redis Cluster: ${createResult.output}`);
    }
    await Promise.all(containers.map(waitForCluster));

    const nodeAddressMap = Object.fromEntries(
      containers.map((container) => [
        `${container.getIpAddress(networkName)}:6379`,
        { host: container.getHost(), port: container.getMappedPort(6379) },
      ]),
    );
    cluster = createTestCluster({
      rootNodes: [{ url: `redis://${firstContainer.getHost()}:${firstContainer.getMappedPort(6379)}` }],
      nodeAddressMap,
    });
    cluster.on("error", () => undefined);
    await cluster.connect();

    // GLIDE has no nodeAddressMap: it must reach the cluster's announced
    // container IPs directly. Those are host-routable on Linux (CI) but not
    // under Docker Desktop, so probe with a short timeout and let the GLIDE
    // assertions skip locally instead of failing. CI must fail closed: a
    // silent skip there would drop the only GLIDE cluster coverage.
    try {
      glideCluster = await valkeyGlide.GlideClusterClient.createClient({
        addresses: containers.map((container) => ({
          host: container.getIpAddress(networkName),
          port: 6379,
        })),
        requestTimeout: 5_000,
        advancedConfiguration: { connectionTimeout: 2_000 },
      });
    } catch (error) {
      const ci = process.env.CI;
      if (ci !== undefined && ci !== "" && ci !== "0" && ci !== "false") {
        throw new Error(
          "GLIDE cluster client unavailable on CI, so the only GLIDE cluster coverage would "
          + "silently skip; commonly the cluster's announced container IPs are not host-routable",
          { cause: error },
        );
      }
      console.warn("GLIDE cluster client unavailable; skipping GLIDE cluster assertions", error);
    }
  });

  afterAll(async () => {
    glideCluster?.close();
    await cluster?.quit();
    await Promise.all(containers.map(async (container) => await container.stop()));
    await network?.stop();
  });

  it("routes cache operations across slots and reloads invalidation scripts per node", async () => {
    if (cluster === undefined) {
      throw new Error("Redis Cluster did not start");
    }
    const activeCluster = cluster;
    const scriptClient: DialCacheRedisClient = createNodeRedisDialCacheClient(activeCluster);
    const dialcache = new DialCache({
      namespace: "cluster-cache",
      redis: { client: scriptClient, readTimeoutMs: 10_000 },
    });
    const ids = Array.from({ length: 30 }, (_, index) => `item-${index}`);
    let calls = 0;
    const getValue = dialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
      keyType: "item_id",
      useCase: "ClusterSlots",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });

    const first = await dialcache.enable(async () => await Promise.all(ids.map(getValue)));
    const sizesBeforeFlush = await Promise.all(
      activeCluster.masters.map(async (master) => {
        const client = await activeCluster.nodeClient(master);
        return await client.dbSize();
      }),
    );
    await Promise.all(
      activeCluster.masters.map(async (master) => {
        const client = await activeCluster.nodeClient(master);
        await client.scriptFlush();
      }),
    );
    await Promise.all(ids.map(async (id) => await dialcache.invalidateRemote("item_id", id)));
    const second = await dialcache.enable(async () => await Promise.all(ids.map(getValue)));
    const sizesAfterRecovery = await Promise.all(
      activeCluster.masters.map(async (master) => {
        const client = await activeCluster.nodeClient(master);
        return await client.dbSize();
      }),
    );
    const callsAfterRecovery = calls;
    const third = await dialcache.enable(async () => await Promise.all(ids.map(getValue)));

    expect(first.map(({ id }) => id)).toEqual(ids);
    expect(sizesBeforeFlush.every((size) => size > 0)).toBe(true);
    expect(
      sizesAfterRecovery.every((size, index) => size > (sizesBeforeFlush[index] ?? Number.POSITIVE_INFINITY)),
    ).toBe(true);
    expect(second.map(({ id }) => id)).toEqual(ids);
    expect(third).toEqual(second);
    expect(callsAfterRecovery).toBe(60);
    expect(calls).toBe(callsAfterRecovery);
  });

  it("keeps tracked keys colocated and rejects mismatched hash tags", async () => {
    if (cluster === undefined) {
      throw new Error("Redis Cluster did not start");
    }
    const scriptClient: DialCacheRedisClient = createNodeRedisDialCacheClient(cluster);
    const dialcache = new DialCache({
      namespace: "cluster-cache",
      redis: { client: scriptClient, readTimeoutMs: 10_000 },
    });
    let version = 1;
    const getUser = dialcache.cached(async (id: string) => ({ id, version }), {
      keyType: "user_id",
      useCase: "ClusterTracked",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });

    const before = await dialcache.enable(async () => await getUser("123"));
    version = 2;
    await dialcache.invalidateRemote("user_id", "123");
    // Small margin is fine here: the assertion is served by the source
    // fallback whether or not the refill write beats the fence.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const after = await dialcache.enable(async () => await getUser("123"));

    expect(before).toEqual({ id: "123", version: 1 });
    expect(after).toEqual({ id: "123", version: 2 });
    await expect(
      scriptClient.read({
        valueKey: "{slot-a}:value",
        watermarkKey: "{slot-b}:watermark",
      }),
    ).rejects.toThrow(/CROSSSLOT/);
  });

  it("round-trips binary payloads through cluster routing", async () => {
    if (cluster === undefined) {
      throw new Error("Redis Cluster did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(cluster);
    const valueKey = "binary-cluster:{item:untracked}:value";
    const payload = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

    await expect(scriptClient.write({ valueKey, cacheTtlMs: 60_000, value: payload })).resolves.toBeUndefined();
    const untrackedRead = await scriptClient.read({ valueKey });
    expect(untrackedRead?.payload).toEqual(payload);
    expect(untrackedRead?.createdAtMs).toBeGreaterThan(0);

    const stored = await cluster.get(commandOptions({ returnBuffers: true }), valueKey);
    expect(stored?.length).toBe(10 + payload.length);
    expect(stored?.[9]).toBe(1);
    expect(stored?.subarray(10)).toEqual(payload);

    const trackedValueKey = "binary-cluster:{item:tracked}:value";
    const watermarkKey = "binary-cluster:{item:tracked}:watermark";
    const trackedPayload = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);
    const trackedCreatedAtMs = 1_700_000_000_123;
    const now = vi.spyOn(Date, "now").mockReturnValue(trackedCreatedAtMs);
    try {
      await expect(
        scriptClient.write({
          valueKey: trackedValueKey,
          cacheTtlMs: 60_000,
          value: trackedPayload,
        }),
      ).resolves.toBeUndefined();
    } finally {
      now.mockRestore();
    }
    const trackedRead = await scriptClient.read({ valueKey: trackedValueKey, watermarkKey });
    expect(trackedRead?.payload).toEqual(trackedPayload);
    expect(trackedRead?.createdAtMs).toBe(trackedCreatedAtMs);
  });

  it("runs GLIDE tracked mutations against the real cluster", async (ctx) => {
    if (glideCluster === undefined) {
      return ctx.skip();
    }
    if (cluster === undefined) {
      throw new Error("Redis Cluster did not start");
    }
    const adapter = createValkeyGlideDialCacheClient(glideCluster, valkeyGlide);
    const valueKey = "glide-cluster:{item:tracked}:value";
    const watermarkKey = "glide-cluster:{item:tracked}:watermark";

    const createdAtMs = 1_700_000_000_456;
    const now = vi.spyOn(Date, "now").mockReturnValue(createdAtMs);
    try {
      await expect(
        adapter.write({ valueKey, cacheTtlMs: 60_000, value: "glide" }),
      ).resolves.toBeUndefined();
    } finally {
      now.mockRestore();
    }
    expect(await adapter.read({ valueKey, watermarkKey })).toMatchObject({
      payload: "glide",
      createdAtMs,
    });

    await adapter.invalidate({ watermarkKey, futureBufferMs: 0 });
    // The existing value remains fenced until a later client-stamped frame is
    // written past the zero-buffer watermark.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const observedWatermark = await cluster.get(watermarkKey);
    expect(observedWatermark).not.toBeNull();
    expect(await adapter.read({ valueKey, watermarkKey })).toEqual({
      kind: "watermark_miss",
      reason: "watermark_fenced",
      observedWatermarkMs: Number(observedWatermark),
    });
    await expect(
      adapter.write({ valueKey, cacheTtlMs: 60_000, value: "glide-2" }),
    ).resolves.toBeUndefined();
    expect((await adapter.read({ valueKey, watermarkKey }))?.payload).toBe("glide-2");

    const untrackedKey = "glide-cluster:{item:untracked}:value";
    await expect(
      adapter.write({ valueKey: untrackedKey, cacheTtlMs: 60_000, value: "plain" }),
    ).resolves.toBeUndefined();
    expect((await adapter.read({ valueKey: untrackedKey }))?.payload).toBe("plain");

  });

  it("recovers GLIDE cluster mutations after SCRIPT FLUSH on every master", async (ctx) => {
    if (glideCluster === undefined || cluster === undefined) {
      return ctx.skip();
    }
    const activeCluster = cluster;
    const flushAllMasters = async (): Promise<void> => {
      await Promise.all(
        activeCluster.masters.map(async (master) => {
          const nodeClient = await activeCluster.nodeClient(master);
          await nodeClient.scriptFlush();
        }),
      );
    };
    const adapter = createValkeyGlideDialCacheClient(glideCluster, valkeyGlide);
    const valueKey = "glide-flush:{item:tracked}:value";
    const watermarkKey = "glide-flush:{item:tracked}:watermark";

    await flushAllMasters();
    await expect(
      adapter.write({ valueKey, cacheTtlMs: 60_000, value: "recovered" }),
    ).resolves.toBeUndefined();
    expect((await adapter.read({ valueKey, watermarkKey }))?.payload).toBe("recovered");

    await flushAllMasters();
    await expect(adapter.invalidate({ watermarkKey, futureBufferMs: 0 })).resolves.toBeUndefined();
    const observedWatermark = await cluster.get(watermarkKey);
    expect(observedWatermark).not.toBeNull();
    expect(await adapter.read({ valueKey, watermarkKey })).toEqual({
      kind: "watermark_miss",
      reason: "watermark_fenced",
      observedWatermarkMs: Number(observedWatermark),
    });
  });
});

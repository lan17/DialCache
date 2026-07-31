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

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  invalidationPrefix,
  redisClusterHashTag,
  type DialCacheRedisClient,
} from "../src/index.js";
import { redisClusterSlot } from "../src/internal/redis-cluster-slot.js";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "../src/node-redis.js";
import { createValkeyGlideDialCacheClient } from "../src/valkey-glide.js";

const remoteOnly = new DialCacheKeyConfig({
  ttlSec: { [CacheLayer.REMOTE]: 60 },
  ramp: { [CacheLayer.REMOTE]: 100 },
});

const createTestCluster = (options: RedisClusterOptions) =>
  createCluster({
    ...options,
    scripts: dialcacheRedisScripts,
  });

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

async function configureAdvertisedClusterEndpoint(container: StartedTestContainer): Promise<void> {
  // GLIDE discovers every primary from the server topology and has no node-address remapping hook.
  // Advertise the host-reachable client endpoint while cluster creation and bus traffic use bridge IPs.
  const settings = [
    ["cluster-announce-hostname", container.getHost()],
    ["cluster-preferred-endpoint-type", "hostname"],
    ["cluster-announce-port", String(container.getMappedPort(6379))],
  ] as const;
  for (const [name, value] of settings) {
    const result = await container.exec(["redis-cli", "CONFIG", "SET", name, value]);
    if (result.exitCode !== 0 || !result.output.includes("OK")) {
      throw new Error(`Could not configure Redis Cluster endpoint ${name}: ${result.output}`);
    }
  }
}

function selectCrossPrimaryBatchIds(
  activeCluster: ReturnType<typeof createTestCluster>,
  watermarkFor: (id: string) => string,
): readonly [string, string, string] {
  const idsBySlot = new Map<number, string>();
  let sameSlotIds: readonly [string, string] | undefined;
  // A collision is guaranteed after 16,384 distinct keys, though one usually appears much sooner.
  for (let index = 0; index <= 16_384 && sameSlotIds === undefined; index += 1) {
    const id = `item-${index}`;
    const slot = redisClusterSlot(watermarkFor(id));
    const existing = idsBySlot.get(slot);
    if (existing === undefined) {
      idsBySlot.set(slot, id);
    } else {
      sameSlotIds = [existing, id];
    }
  }
  if (sameSlotIds === undefined) {
    throw new Error("Could not find two generated invalidation keys in the same Redis Cluster slot");
  }
  const sameSlotOwner = activeCluster.slots[redisClusterSlot(watermarkFor(sameSlotIds[0]))]?.master.id;
  if (sameSlotOwner === undefined) {
    throw new Error("Could not resolve the primary owning the generated same-slot keys");
  }
  for (let index = 0; index <= 16_384; index += 1) {
    const id = `item-${index}`;
    const slotOwner = activeCluster.slots[redisClusterSlot(watermarkFor(id))]?.master.id;
    if (slotOwner !== undefined && slotOwner !== sameSlotOwner) {
      return [sameSlotIds[0], sameSlotIds[1], id];
    }
  }
  throw new Error("Could not find an invalidation key owned by a different Redis Cluster primary");
}

describe("DialCache Lua protocol on Redis Cluster", () => {
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

    await Promise.all(containers.map(configureAdvertisedClusterEndpoint));

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
    glideCluster = await valkeyGlide.GlideClusterClient.createClient({
      addresses: containers.map((container) => ({
        host: container.getHost(),
        port: container.getMappedPort(6379),
      })),
      requestTimeout: 10_000,
      periodicChecks: "disabled",
      advancedConfiguration: { connectionTimeout: 5_000 },
    });
  });

  afterAll(async () => {
    glideCluster?.close();
    await cluster?.quit();
    await Promise.all(containers.map(async (container) => await container.stop()));
    await network?.stop();
  });

  it("routes scripts across slots and reloads them per node", async () => {
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
    const recoveryDialcache = new DialCache({
      namespace: "cluster-cache",
      redis: { client: scriptClient, readTimeoutMs: 10_000 },
    });
    const recoverValue = recoveryDialcache.cached(async (id: string) => ({ id, calls: ++calls }), {
      keyType: "item_id",
      useCase: "ClusterSlots",
      cacheKey: (id) => id,
      defaultConfig: remoteOnly,
    });
    const second = await recoveryDialcache.enable(async () => await Promise.all(ids.map(recoverValue)));

    expect(first.map(({ id }) => id)).toEqual(ids);
    expect(calls).toBe(30);
    expect(sizesBeforeFlush.every((size) => size > 0)).toBe(true);
    expect(second).toEqual(first);
  });

  it("keeps tracked keys colocated and rejects mismatched hash tags", async () => {
    if (cluster === undefined) {
      throw new Error("Redis Cluster did not start");
    }
    expect(dialcacheRedisScripts.dialcacheRead.IS_READ_ONLY).toBe(true);
    expect(dialcacheRedisScripts.dialcacheReadTracked.IS_READ_ONLY).toBe(false);
    expect(dialcacheRedisScripts.dialcacheRead.SHA1).not.toBe(dialcacheRedisScripts.dialcacheReadTracked.SHA1);
    expect(dialcacheRedisScripts.dialcacheWrite.SHA1).not.toBe(dialcacheRedisScripts.dialcacheWriteTracked.SHA1);
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
    await new Promise((resolve) => setTimeout(resolve, 2));
    const after = await dialcache.enable(async () => await getUser("123"));

    expect(before).toEqual({ id: "123", version: 1 });
    expect(after).toEqual({ id: "123", version: 2 });
    await expect(cluster.dialcacheReadTracked("{slot-a}:value", "{slot-b}:watermark")).rejects.toThrow(/CROSSSLOT/);
  });

  it("batches same-slot and cross-slot invalidations after per-node SCRIPT FLUSH", async () => {
    if (cluster === undefined) {
      throw new Error("Redis Cluster did not start");
    }
    const activeCluster = cluster;
    const namespace = "cluster-batch";
    const keyType = "item_id";
    const watermarkFor = (id: string) =>
      `${redisClusterHashTag(invalidationPrefix(namespace, keyType, id))}#watermark`;
    const ids = selectCrossPrimaryBatchIds(activeCluster, watermarkFor);
    const sameSlot = redisClusterSlot(watermarkFor(ids[0]));
    const sameSlotOwner = activeCluster.slots[sameSlot]?.master.id;
    if (sameSlotOwner === undefined) {
      throw new Error("Could not resolve the primary owning the generated same-slot keys");
    }
    const firstMaster = activeCluster.masters[0];
    if (firstMaster === undefined) {
      throw new Error("Redis Cluster has no primary nodes");
    }
    const slotInspector = await activeCluster.nodeClient(firstMaster);

    for (const key of [
      ...ids.map(watermarkFor),
      "123456789",
      "foo{}{bar}",
      "unicode:{café}:key",
    ]) {
      expect(await slotInspector.clusterKeySlot(key)).toBe(redisClusterSlot(key));
    }
    expect(await slotInspector.clusterKeySlot(watermarkFor(ids[0]!))).toBe(
      await slotInspector.clusterKeySlot(watermarkFor(ids[1]!)),
    );
    expect(await slotInspector.clusterKeySlot(watermarkFor(ids[2]!))).not.toBe(
      await slotInspector.clusterKeySlot(watermarkFor(ids[0]!)),
    );
    expect(activeCluster.slots[redisClusterSlot(watermarkFor(ids[2]!))]?.master.id).not.toBe(
      sameSlotOwner,
    );

    const scriptClient = createNodeRedisDialCacheClient(activeCluster);
    const dialcache = new DialCache({
      namespace,
      redis: { client: scriptClient, readTimeoutMs: 10_000 },
    });
    const versions = new Map(ids.map((id) => [id, 1]));
    const getValue = dialcache.cached(async (id: string) => ({ id, version: versions.get(id)! }), {
      keyType,
      useCase: "ClusterBatchInvalidation",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });

    const before = await dialcache.enable(async () => await Promise.all(ids.map(getValue)));
    for (const id of ids) {
      versions.set(id, 2);
    }
    await Promise.all(
      activeCluster.masters.map(async (master) => {
        const client = await activeCluster.nodeClient(master);
        await client.scriptFlush();
      }),
    );
    await dialcache.invalidateRemoteMany(ids.map((id) => ({ keyType, id })));
    await new Promise((resolve) => setTimeout(resolve, 2));
    const after = await dialcache.enable(async () => await Promise.all(ids.map(getValue)));

    expect(before).toEqual(ids.map((id) => ({ id, version: 1 })));
    expect(after).toEqual(ids.map((id) => ({ id, version: 2 })));
    const watermarks = await Promise.all(ids.map(async (id) => await activeCluster.get(watermarkFor(id))));
    expect(watermarks.every((watermark) => watermark !== null && /^\d+$/.test(watermark))).toBe(true);
  });

  it("batches same-slot and cross-primary invalidations through Valkey GLIDE Cluster", async () => {
    if (cluster === undefined || glideCluster === undefined) {
      throw new Error("Redis Cluster clients did not start");
    }
    const activeCluster = cluster;
    const activeGlideCluster = glideCluster;
    const namespace = "glide-cluster-batch";
    const keyType = "item_id";
    const watermarkFor = (id: string) =>
      `${redisClusterHashTag(invalidationPrefix(namespace, keyType, id))}#watermark`;
    const ids = selectCrossPrimaryBatchIds(activeCluster, watermarkFor);
    const scriptClient = createValkeyGlideDialCacheClient(activeGlideCluster, valkeyGlide);
    const executeBatch = vi.spyOn(activeGlideCluster, "exec");
    const dialcache = new DialCache({
      namespace,
      redis: { client: scriptClient, readTimeoutMs: 10_000 },
    });
    const versions = new Map(ids.map((id) => [id, 1]));
    const getValue = dialcache.cached(async (id: string) => ({ id, version: versions.get(id)! }), {
      keyType,
      useCase: "GlideClusterBatchInvalidation",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: remoteOnly,
    });

    try {
      const before = await dialcache.enable(async () => await Promise.all(ids.map(getValue)));
      for (const id of ids) {
        versions.set(id, 2);
      }
      await activeGlideCluster.scriptFlush({ route: "allPrimaries" });
      await dialcache.invalidateRemoteMany(ids.map((id) => ({ keyType, id })));
      expect(executeBatch).toHaveBeenCalledOnce();
      expect(executeBatch.mock.calls[0]?.[0]).toBeInstanceOf(valkeyGlide.ClusterBatch);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const after = await dialcache.enable(async () => await Promise.all(ids.map(getValue)));

      expect(before).toEqual(ids.map((id) => ({ id, version: 1 })));
      expect(after).toEqual(ids.map((id) => ({ id, version: 2 })));
      const watermarks = await Promise.all(
        ids.map(async (id) => await activeGlideCluster.get(
          watermarkFor(id),
          { decoder: valkeyGlide.Decoder.String },
        )),
      );
      expect(watermarks.every(
        (watermark) => typeof watermark === "string" && /^\d+$/.test(watermark),
      )).toBe(true);
    } finally {
      executeBatch.mockRestore();
      scriptClient.dispose();
    }
  });

  it("round-trips binary payloads through cluster script routing", async () => {
    if (cluster === undefined) {
      throw new Error("Redis Cluster did not start");
    }
    const scriptClient = createNodeRedisDialCacheClient(cluster);
    const valueKey = "binary-cluster:{item:untracked}:value";
    const payload = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

    expect(await scriptClient.write({ valueKey, cacheTtlMs: 60_000, value: payload })).toBe(true);
    expect(await scriptClient.read({ valueKey })).toEqual(payload);

    const stored = await cluster.get(commandOptions({ returnBuffers: true }), valueKey);
    expect(stored?.length).toBe(10 + payload.length);
    expect(stored?.[9]).toBe(1);
    expect(stored?.subarray(10)).toEqual(payload);

    const trackedValueKey = "binary-cluster:{item:tracked}:value";
    const watermarkKey = "binary-cluster:{item:tracked}:watermark";
    const trackedPayload = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80]);
    expect(
      await scriptClient.write({
        valueKey: trackedValueKey,
        watermarkKey,
        cacheTtlMs: 60_000,
        value: trackedPayload,
      }),
    ).toBe(true);
    expect(await scriptClient.read({ valueKey: trackedValueKey, watermarkKey })).toEqual(trackedPayload);
  });
});

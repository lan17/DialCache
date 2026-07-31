import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { createClient } from "redis";

import { DialCache, invalidationPrefix, redisClusterHashTag } from "../dist/index.js";
import {
  createNodeRedisDialCacheClient,
  dialcacheRedisScripts,
} from "../dist/node-redis.js";

const redisUrl = process.env.DIALCACHE_BENCH_REDIS_URL ?? "redis://127.0.0.1:6379";
const sizes = [10, 100, 1_000];
const runId = `${process.pid}-${Date.now()}`;
const redisClient = createClient({
  url: redisUrl,
  scripts: dialcacheRedisScripts,
  disableOfflineQueue: true,
  commandsQueueMaxLength: 10_000,
  socket: { connectTimeout: 2_000 },
});
redisClient.on("error", () => undefined);

await redisClient.connect();

try {
  const namespace = `dialcache-batch-invalidation-benchmark-${runId}`;
  const dialcache = new DialCache({
    namespace,
    redis: { client: createNodeRedisDialCacheClient(redisClient) },
  });
  const results = [];

  // Pay one-time connection and Lua loading costs before the measured runs.
  await dialcache.invalidateRemote("benchmark_warmup", runId);

  for (const size of sizes) {
    const scalarTargets = targetsFor(`scalar-${size}`, size);
    const scalarStartedAt = performance.now();
    await Promise.all(
      scalarTargets.map(({ keyType, id }) => dialcache.invalidateRemote(keyType, id)),
    );
    const scalarMs = performance.now() - scalarStartedAt;
    assert.equal(await countWatermarks(namespace, scalarTargets), size);

    const batchTargets = targetsFor(`batch-${size}`, size);
    const batchStartedAt = performance.now();
    await dialcache.invalidateRemoteMany(batchTargets);
    const batchMs = performance.now() - batchStartedAt;
    assert.equal(await countWatermarks(namespace, batchTargets), size);

    results.push({
      targets: size,
      "Promise.all scalar (ms)": scalarMs.toFixed(2),
      "single batch call (ms)": batchMs.toFixed(2),
      "scalar / batch": (scalarMs / batchMs).toFixed(2),
    });
  }

  console.table(results);
  console.log(
    "Directional maintainer benchmark only: results depend on Redis topology, client configuration, and network conditions; no timing threshold is asserted.",
  );
} finally {
  await redisClient.quit();
}

function targetsFor(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    keyType: "benchmark_id",
    id: `${runId}-${prefix}-${index}`,
  }));
}

async function countWatermarks(namespace, targets) {
  const keys = targets.map(({ keyType, id }) =>
    `${redisClusterHashTag(invalidationPrefix(namespace, keyType, String(id)))}#watermark`);
  return await redisClient.exists(keys);
}

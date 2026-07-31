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
const repetitions = positiveIntegerFromEnvironment("DIALCACHE_BENCH_REPETITIONS", 5);
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
    const scalarSamples = [];
    const batchSamples = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const scalarTargets = targetsFor(`scalar-${size}-${repetition}`, size);
      const batchTargets = targetsFor(`batch-${size}-${repetition}`, size);
      const runScalar = async () => {
        const startedAt = performance.now();
        await Promise.all(
          scalarTargets.map(({ keyType, id }) => dialcache.invalidateRemote(keyType, id)),
        );
        scalarSamples.push(performance.now() - startedAt);
        assert.equal(await countWatermarks(namespace, scalarTargets), size);
      };
      const runBatch = async () => {
        const startedAt = performance.now();
        await dialcache.invalidateRemoteMany(batchTargets);
        batchSamples.push(performance.now() - startedAt);
        assert.equal(await countWatermarks(namespace, batchTargets), size);
      };

      if (repetition % 2 === 0) {
        await runScalar();
        await runBatch();
      } else {
        await runBatch();
        await runScalar();
      }
    }
    const scalarMedianMs = median(scalarSamples);
    const batchMedianMs = median(batchSamples);

    results.push({
      targets: size,
      repetitions,
      "Promise.all scalar median (ms)": scalarMedianMs.toFixed(2),
      "batch median (ms)": batchMedianMs.toFixed(2),
      "median scalar / batch": (scalarMedianMs / batchMedianMs).toFixed(2),
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

function median(values) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function positiveIntegerFromEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

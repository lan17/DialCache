import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import * as valkeyGlide from "@valkey/valkey-glide";
import { createClient } from "redis";

import { DialCache, invalidationPrefix, redisClusterHashTag } from "../dist/index.js";
import {
  createNodeRedisDialCacheClient,
  dialcacheRedisScripts,
} from "../dist/node-redis.js";
import { createValkeyGlideDialCacheClient } from "../dist/valkey-glide.js";

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
let glideClient;
let glideAdapter;

try {
  glideClient = await valkeyGlide.GlideClient.createClient(glideConfiguration(redisUrl));
  glideAdapter = createValkeyGlideDialCacheClient(glideClient, valkeyGlide);
  const adapters = [
    { name: "node-redis", client: createNodeRedisDialCacheClient(redisClient) },
    { name: "Valkey GLIDE", client: glideAdapter },
  ];
  const results = [];

  for (const { name, client } of adapters) {
    const namespace = `dialcache-batch-invalidation-benchmark-${name}-${runId}`;
    const dialcache = new DialCache({
      namespace,
      redis: { client },
    });

    // Pay one-time connection and Lua loading costs before the measured runs.
    await dialcache.invalidateRemote("benchmark_warmup", runId);

    for (const size of sizes) {
      const scalarSamples = [];
      const batchSamples = [];
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const scalarTargets = targetsFor(`${name}-scalar-${size}-${repetition}`, size);
        const batchTargets = targetsFor(`${name}-batch-${size}-${repetition}`, size);
        const runScalar = async () => {
          const startedAt = performance.now();
          const operations = scalarTargets.map(({ keyType, id }) =>
            dialcache.invalidateRemote(keyType, id));
          try {
            await Promise.all(operations);
          } catch (error) {
            await Promise.allSettled(operations);
            throw error;
          }
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
        adapter: name,
        targets: size,
        repetitions,
        "Promise.all scalar median (ms)": scalarMedianMs.toFixed(2),
        "batch median (ms)": batchMedianMs.toFixed(2),
        "median scalar / batch": (scalarMedianMs / batchMedianMs).toFixed(2),
      });
    }
  }

  console.table(results);
  console.log(
    "Directional maintainer benchmark only: results depend on Redis topology, client configuration, and network conditions; no timing threshold is asserted.",
  );
} finally {
  try {
    glideAdapter?.dispose();
  } finally {
    try {
      glideClient?.close();
    } finally {
      await redisClient.quit();
    }
  }
}

function glideConfiguration(value) {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("DIALCACHE_BENCH_REDIS_URL must use redis: or rediss:");
  }
  if (url.username !== "" && url.password === "") {
    throw new Error("DIALCACHE_BENCH_REDIS_URL cannot specify a username without a password");
  }

  const databasePath = url.pathname.replace(/^\//, "");
  const databaseId = databasePath === "" ? 0 : Number(databasePath);
  if (!Number.isSafeInteger(databaseId) || databaseId < 0) {
    throw new Error("DIALCACHE_BENCH_REDIS_URL must contain a nonnegative database id");
  }

  return {
    addresses: [{ host: url.hostname, port: url.port === "" ? 6379 : Number(url.port) }],
    databaseId,
    useTLS: url.protocol === "rediss:",
    requestTimeout: 10_000,
    inflightRequestsLimit: 10_000,
    advancedConfiguration: { connectionTimeout: 2_000 },
    ...(url.password === ""
      ? {}
      : {
          credentials: {
            ...(url.username === "" ? {} : { username: decodeURIComponent(url.username) }),
            password: decodeURIComponent(url.password),
          },
        }),
  };
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

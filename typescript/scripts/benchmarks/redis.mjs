import assert from "node:assert/strict";

import { createClient } from "redis";
import { CacheLayer, DialCache, DialCacheKeyConfig, isRedisReadMiss } from "../../dist/index.js";
import { createNodeRedisDialCacheClient } from "../../dist/node-redis.js";
import { checkValues, emptyCommands, emptyCounters } from "./core.mjs";

export const redisKinds = new Set(["redis-hit", "redis-tracked-hit", "redis-write"]);

export async function runRedis(request) {
  const client = createClient({
    url: request.redisUrl,
    disableOfflineQueue: true,
    socket: { connectTimeout: 5_000, reconnectStrategy: false },
  });
  client.on("error", error => process.stderr.write(`Redis: ${error.message}\n`));
  try {
    await client.connect();
    if (request.case.warmup > 0) await phase(client, request, request.case.warmup, "warmup");
    return await phase(client, request, request.case.iterations, "measured");
  } finally {
    if (client.isOpen) await client.disconnect();
  }
}

async function phase(client, { id, case: workload, payload }, iterations, phaseName) {
  const { kind, capacity } = workload;
  const counters = emptyCounters();
  const native = createNodeRedisDialCacheClient(client);
  const keys = new Set();
  let priming = true;
  const adapter = {
    read(request, context) {
      counters.redisReads += 1;
      if (priming) {
        keys.add(request.valueKey);
        if (request.watermarkKey) keys.add(request.watermarkKey);
      }
      return native.read(request, context);
    },
    write(request) {
      counters.redisWrites += 1;
      if (priming) keys.add(request.valueKey);
      return native.write(request);
    },
    invalidate(request) { return native.invalidate(request); },
  };
  const namespace = `benchmark-${id}-${phaseName}`;
  const cache = new DialCache({
    namespace,
    localMaxSize: capacity,
    redis: { client: adapter, compression: false, readTimeoutMs: 60_000 },
  });
  const operation = cache.cached(async () => {
    counters.sourceCalls += 1;
    return payload;
  }, {
    keyType: "benchmark-key",
    useCase: "Benchmark",
    cacheKey: key => key,
    trackForInvalidation: kind === "redis-tracked-hit",
    fallbackTimeoutMs: 60_000,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 3600 },
      ramp: { [CacheLayer.REMOTE]: 100 },
    }),
  });
  const writeKey = `${namespace}:write`;
  const writeRequest = { valueKey: writeKey, cacheTtlMs: 3_600_000, value: Buffer.from(payload, "utf8") };
  const values = new Array(iterations);
  const latencyNs = new Array(iterations);
  let checksum = 0;
  try {
    if (kind === "redis-write") keys.add(writeKey);
    else assert.equal(await cache.enable(() => operation("shared")), payload);
    Object.assign(counters, emptyCounters());
    priming = false;
    const before = await commandStats(client);
    const start = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) {
      const operationStart = process.hrtime.bigint();
      let value;
      if (kind === "redis-write") {
        await adapter.write(writeRequest);
        value = payload;
      } else value = await cache.enable(() => operation("shared"));
      latencyNs[index] = Number(process.hrtime.bigint() - operationStart);
      values[index] = value;
      checksum += value.length; // The shared payload is ASCII; full content is checked below.
    }
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const after = await commandStats(client);
    const redisCommands = emptyCommands();
    for (const command of Object.keys(redisCommands)) redisCommands[command] = after[command] - before[command];

    if (kind === "redis-write") {
      // Verification reads are deliberately after the measured command snapshot.
      const frame = await native.read({ valueKey: writeKey });
      assert.ok(!isRedisReadMiss(frame), "the written frame must be readable");
      assert.equal(Buffer.isBuffer(frame.payload) ? frame.payload.toString("utf8") : frame.payload, payload);
      assert.equal(redisCommands.set, iterations, "writes must issue exactly one SET each");
      assert.equal(redisCommands.eval + redisCommands.evalsha + redisCommands.time, 0, "writes must not invoke scripts or TIME");
    }
    checkValues(values, payload);
    assert.equal(checksum, iterations * workload.payloadBytes);
    assert.equal(counters.sourceCalls, 0);
    assert.equal(counters.redisReads, kind === "redis-write" ? 0 : iterations);
    assert.equal(counters.redisWrites, kind === "redis-write" ? iterations : 0);
    return { operations: iterations, elapsedNs, checksum, valueValid: true, counters, redisCommands, latencyNs };
  } finally {
    if (keys.size > 0) await client.del([...keys]);
  }
}

async function commandStats(client) {
  const stats = emptyCommands();
  const response = await client.sendCommand(["INFO", "commandstats"]);
  for (const line of String(response).split("\n")) {
    const match = /^cmdstat_([a-z]+):calls=(\d+),/.exec(line.trim());
    if (match && Object.hasOwn(stats, match[1])) stats[match[1]] = Number(match[2]);
  }
  return stats;
}

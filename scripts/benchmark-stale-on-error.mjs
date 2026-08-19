// Maintainer benchmark for the stale-on-error Redis path. It uses the public
// node-redis adapter against a live Redis, keeps payload I/O native, and
// reports client latency plus INFO commandstats/network deltas. Results have
// no pass/fail timing threshold; compare runs only on the same environment.
//
// Requires Redis, e.g.: docker run --rm -p 6379:6379 redis:6.2
// Usage: pnpm benchmark:stale-on-error       (REDIS_URL to override)
// Optional sizing: DIALCACHE_BENCH_STALE_ITERATIONS,
// DIALCACHE_BENCH_STALE_FANOUT, and DIALCACHE_BENCH_STALE_PAYLOAD_BYTES.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { createClient } from "redis";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
} from "../dist/index.js";
import {
  createNodeRedisDialCacheClient,
  dialcacheRedisScripts,
} from "../dist/node-redis.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const iterations = readPositiveInteger("DIALCACHE_BENCH_STALE_ITERATIONS", 200);
const fanout = readPositiveInteger("DIALCACHE_BENCH_STALE_FANOUT", 500);
const payloadBytes = readPositiveInteger("DIALCACHE_BENCH_STALE_PAYLOAD_BYTES", 64 * 1024);
const freshAgeSec = 60;
const logicalFreshAgeSec = 1;
const staleMaxAgeSec = 60;
const namespace = `dialcache-stale-benchmark-${process.pid}-${Date.now()}`;
const keyType = "benchmark_id";
const id = "shared";
const sourceError = new Error("benchmark source unavailable");
const payloadPattern = "dialcache-stale-on-error-compressible-payload-";
const payload = {
  id,
  // Repeated text intentionally exercises the default zstd path instead of
  // benchmarking an unrealistically tiny raw JSON value.
  body: payloadPattern.repeat(
    Math.ceil(payloadBytes / payloadPattern.length),
  ).slice(0, payloadBytes),
};

const redis = createClient({
  url: redisUrl,
  scripts: dialcacheRedisScripts,
  disableOfflineQueue: true,
  commandsQueueMaxLength: 1_000,
  socket: { connectTimeout: 2_000 },
});
redis.on("error", () => undefined);

try {
  await redis.connect();
} catch (error) {
  console.error(
    `Could not reach Redis at ${redisUrl}; start one first, e.g. docker run --rm -p 6379:6379 redis:6.2`,
  );
  throw error;
}

const adapter = createNodeRedisDialCacheClient(redis);
const staleOutcomes = new Map();
const noOpMetrics = {
  request() {},
  miss() {},
  disabled() {},
  error() {},
  invalidation() {},
  coalesced() {},
  shadowValidation() {},
  staleRecovery({ outcome }) {
    staleOutcomes.set(outcome, (staleOutcomes.get(outcome) ?? 0) + 1);
  },
  compression() {},
  observeGet() {},
  observeFallback() {},
  observeSerialization() {},
  observeSize() {},
  observeStoredSize() {},
  observeCompressionRatio() {},
  observeCompression() {},
};
const dialcache = new DialCache({
  namespace,
  redis: {
    client: adapter,
    readTimeoutMs: 2_000,
    compression: { thresholdBytes: 1_024, level: 3 },
  },
  metrics: noOpMetrics,
  logger: { debug() {}, warn() {}, error() {} },
});

let freshSourceCalls = 0;
let freshWarmed = false;
const freshUseCase = "BenchmarkFreshHit";
const loadFresh = dialcache.cached(
  async () => {
    freshSourceCalls += 1;
    if (freshWarmed) {
      throw new Error("fresh benchmark unexpectedly reached the source");
    }
    return payload;
  },
  {
    keyType,
    useCase: freshUseCase,
    cacheKey: () => id,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: freshAgeSec },
    }),
  },
);

let staleSourceCalls = 0;
let staleSourceMode = "warm";
let staleSourceGate;
const staleUseCase = "BenchmarkStaleRecovery";
const loadStale = dialcache.cached(
  async () => {
    staleSourceCalls += 1;
    if (staleSourceMode === "warm") {
      return payload;
    }
    if (staleSourceMode === "gated-rejection") {
      await staleSourceGate.promise;
    }
    throw sourceError;
  },
  {
    keyType,
    useCase: staleUseCase,
    cacheKey: () => id,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: logicalFreshAgeSec },
      staleOnErrorMaxAgeSec: staleMaxAgeSec,
    }),
  },
);

const freshValueKey = redisValueKey(namespace, keyType, id, freshUseCase);
const staleValueKey = redisValueKey(namespace, keyType, id, staleUseCase);

try {
  assert.deepEqual(await dialcache.enable(async () => await loadFresh()), payload);
  freshWarmed = true;
  assert.deepEqual(await dialcache.enable(async () => await loadStale()), payload);
  staleSourceMode = "rejection";

  const storedBytes = await redis.strLen(staleValueKey);
  const serializedBytes = Buffer.byteLength(JSON.stringify(payload));
  const physicalTtlMs = await redis.pTTL(staleValueKey);
  assert(storedBytes > 10, "the stale benchmark frame must contain a payload");
  assert(
    storedBytes < serializedBytes / 2,
    "the representative payload should be materially compressed on Redis",
  );
  assert(
    physicalTtlMs <= staleMaxAgeSec * 1_000
      && physicalTtlMs >= staleMaxAgeSec * 1_000 - 5_000,
    `stale-on-error writes must retain the frame near M; observed ${physicalTtlMs} ms`,
  );

  const rows = [];
  rows.push(await measureScenario({
    name: "fresh end-to-end hit",
    operations: iterations,
    redis,
    run: async () => {
      for (let index = 0; index < iterations; index += 1) {
        assert.deepEqual(await dialcache.enable(async () => await loadFresh()), payload);
      }
    },
  }));
  assert.equal(freshSourceCalls, 1, "fresh hits must not reach the source after warmup");

  // Writes are stamped with Redis TIME. Waiting beyond F makes the retained
  // frame a deterministic normal miss while it remains physically present to M.
  await wait(logicalFreshAgeSec * 1_000 + 100);
  assert((await redis.pTTL(staleValueKey)) > 0, "the logically stale frame must remain retained");

  rows.push(await measureScenario({
    name: "logical stale adapter miss",
    operations: iterations,
    redis,
    run: async () => {
      for (let index = 0; index < iterations; index += 1) {
        assert.equal(
          await adapter.read({ valueKey: staleValueKey, maxAgeMs: logicalFreshAgeSec * 1_000 }),
          null,
        );
      }
    },
  }));
  assert.notEqual(
    await adapter.read({ valueKey: staleValueKey, maxAgeMs: staleMaxAgeSec * 1_000 }),
    null,
    "the same frame must remain eligible at M",
  );

  const recoveryOutcomesBefore = staleOutcomes.get("served") ?? 0;
  const recoverySourceCallsBefore = staleSourceCalls;
  rows.push(await measureScenario({
    name: "end-to-end stale recovery",
    operations: iterations,
    redis,
    run: async () => {
      for (let index = 0; index < iterations; index += 1) {
        assert.deepEqual(await dialcache.enable(async () => await loadStale()), payload);
      }
    },
  }));
  assert.equal(staleSourceCalls - recoverySourceCallsBefore, iterations);
  assert.equal((staleOutcomes.get("served") ?? 0) - recoveryOutcomesBefore, iterations);

  staleSourceGate = deferred();
  staleSourceMode = "gated-rejection";
  const coalescedSourceCallsBefore = staleSourceCalls;
  const coalescedOutcomesBefore = staleOutcomes.get("served") ?? 0;
  const coalesced = await measureScenario({
    name: "coalesced stale recovery",
    operations: fanout,
    redis,
    run: async () => {
      const pending = Array.from(
        { length: fanout },
        () => dialcache.enable(async () => await loadStale()),
      );
      await waitFor(() => staleSourceCalls > coalescedSourceCallsBefore);
      staleSourceGate.resolve();
      const values = await Promise.all(pending);
      for (const value of values) {
        assert.deepEqual(value, payload);
      }
    },
  });
  rows.push(coalesced);
  assert.equal(
    staleSourceCalls - coalescedSourceCallsBefore,
    1,
    "same-key coalescing must share one source rejection",
  );
  assert.equal(
    (staleOutcomes.get("served") ?? 0) - coalescedOutcomesBefore,
    1,
    "same-key coalescing must share one recovery read",
  );

  const serverInfo = parseInfo(await redis.sendCommand(["INFO", "server"]));
  console.log(
    `Stale-on-error benchmark — ${redisUrl} (${serverInfo.redis_version ?? "unknown engine"})`,
  );
  console.log(
    `payload JSON=${serializedBytes.toLocaleString("en-US")} B, stored frame=${storedBytes.toLocaleString("en-US")} B, F=${logicalFreshAgeSec}s, M=${staleMaxAgeSec}s`,
  );
  console.table(rows.map((row) => ({
    scenario: row.name,
    operations: row.operations,
    "elapsed (ms)": row.elapsedMs.toFixed(2),
    "ops/sec": Math.round((row.operations / row.elapsedMs) * 1_000).toLocaleString("en-US"),
    "GET/op": perOperation(row.commands.get, row.operations),
    "TIME/op": perOperation(row.commands.time, row.operations),
    "server us/op": perOperation(row.serverUsec, row.operations),
    "net in B/op": perOperation(row.netInputBytes, row.operations),
    "net out B/op": perOperation(row.netOutputBytes, row.operations),
  })));
  console.log(
    "Semantic assertions passed. INFO deltas are observational and include small snapshot-query overhead; no timing threshold is applied.",
  );
} finally {
  await redis.del([freshValueKey, staleValueKey]).catch(() => undefined);
  await redis.quit().catch(() => redis.disconnect());
}

async function measureScenario({ name, operations, redis: client, run }) {
  const before = await redisSnapshot(client);
  const start = performance.now();
  await run();
  const elapsedMs = performance.now() - start;
  const after = await redisSnapshot(client);
  const commands = {};
  let serverUsec = 0;
  for (const command of ["get", "mget", "time", "set", "evalsha", "eval"]) {
    const calls = (after.commands[command]?.calls ?? 0) - (before.commands[command]?.calls ?? 0);
    const usec = (after.commands[command]?.usec ?? 0) - (before.commands[command]?.usec ?? 0);
    commands[command] = calls;
    serverUsec += usec;
  }
  return {
    name,
    operations,
    elapsedMs,
    commands,
    serverUsec,
    netInputBytes: after.netInputBytes - before.netInputBytes,
    netOutputBytes: after.netOutputBytes - before.netOutputBytes,
  };
}

async function redisSnapshot(client) {
  const commandInfo = String(await client.sendCommand(["INFO", "commandstats"]));
  const statsInfo = parseInfo(await client.sendCommand(["INFO", "stats"]));
  const commands = {};
  for (const line of commandInfo.split("\n")) {
    const match = /^cmdstat_([a-z0-9_-]+):calls=(\d+),usec=(\d+)/.exec(line.trim());
    if (match !== null) {
      commands[match[1]] = { calls: Number(match[2]), usec: Number(match[3]) };
    }
  }
  return {
    commands,
    netInputBytes: Number(statsInfo.total_net_input_bytes ?? 0),
    netOutputBytes: Number(statsInfo.total_net_output_bytes ?? 0),
  };
}

function parseInfo(raw) {
  const values = {};
  for (const line of String(raw).split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0 && line[0] !== "#") {
      values[line.slice(0, separator)] = line.slice(separator + 1).trim();
    }
  }
  return values;
}

function redisValueKey(cacheNamespace, cacheKeyType, cacheId, useCase) {
  const key = new DialCacheKey({
    namespace: cacheNamespace,
    keyType: cacheKeyType,
    id: cacheId,
    useCase,
  });
  return `${key.urn}:dialcache-frame-v1`;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) {
      return;
    }
    await wait(1);
  }
  throw new Error("Timed out waiting for the benchmark source call");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function perOperation(value, operations) {
  return (value / operations).toFixed(2);
}

function readPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

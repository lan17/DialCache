// Maintainer benchmark for the stale-on-error Redis path. It uses the public
// node-redis adapter against a live Redis, keeps payload I/O native, and
// reports client latency plus INFO commandstats/network deltas. Results have
// no pass/fail timing threshold; compare runs only on the same environment.
//
// Requires Redis, e.g.: docker run --rm -p 6379:6379 redis:6.2
// Usage: pnpm benchmark:stale-on-error       (REDIS_URL to override)
// For less noisy memory deltas: pnpm build && node --expose-gc scripts/benchmark-stale-on-error.mjs
// Optional sizing: DIALCACHE_BENCH_STALE_ITERATIONS,
// DIALCACHE_BENCH_STALE_FANOUT, DIALCACHE_BENCH_STALE_PAYLOAD_BYTES,
// DIALCACHE_BENCH_STALE_MEMORY_KEYS,
// DIALCACHE_BENCH_STALE_MEMORY_PAYLOAD_BYTES, and
// DIALCACHE_BENCH_STALE_MEMORY_SOURCE_DELAY_MS.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createClient } from "redis";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
} from "../dist/index.js";
import { createNodeRedisDialCacheClient } from "../dist/node-redis.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const iterations = readPositiveInteger("DIALCACHE_BENCH_STALE_ITERATIONS", 200);
const fanout = readPositiveInteger("DIALCACHE_BENCH_STALE_FANOUT", 500);
const payloadBytes = readPositiveInteger("DIALCACHE_BENCH_STALE_PAYLOAD_BYTES", 64 * 1024);
const memoryKeyCount = readPositiveInteger("DIALCACHE_BENCH_STALE_MEMORY_KEYS", 128);
const memoryPayloadBytes = readPositiveInteger(
  "DIALCACHE_BENCH_STALE_MEMORY_PAYLOAD_BYTES",
  64 * 1024,
);
const memorySourceDelayMs = readPositiveInteger(
  "DIALCACHE_BENCH_STALE_MEMORY_SOURCE_DELAY_MS",
  250,
);
const freshAgeSec = 60;
const logicalFreshAgeSec = 1;
const staleMaxAgeSec = 60;
const redisReadTimeoutMs = 2_000;
const sourceStartTimeoutMs = redisReadTimeoutMs + 1_000;
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
const memoryPayload = randomBytes(memoryPayloadBytes);
// Avoid the single-byte escape used for raw payloads whose first byte overlaps
// a compression marker. This keeps the representative Redis frame exactly ten
// bytes larger than the random serializer payload.
memoryPayload[0] = 0xff;
const rawBufferSerializer = {
  dump(value) {
    assert(Buffer.isBuffer(value), "the memory benchmark serializer expects a Buffer");
    return Buffer.from(value);
  },
  load(value) {
    assert(Buffer.isBuffer(value), "the memory benchmark serializer expects binary Redis data");
    return Buffer.from(value);
  },
};

const redis = createClient({
  url: redisUrl,
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

const nativeAdapter = createNodeRedisDialCacheClient(redis);
let adapterReadCalls = 0;
const adapter = {
  ...nativeAdapter,
  read(...args) {
    adapterReadCalls += 1;
    return nativeAdapter.read(...args);
  },
};
const staleOutcomes = new Map();
const compressionOutcomes = new Map();
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
  compression({ outcome }) {
    compressionOutcomes.set(outcome, (compressionOutcomes.get(outcome) ?? 0) + 1);
  },
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
  shouldAttemptStaleRecovery: () => true,
  redis: {
    client: adapter,
    readTimeoutMs: redisReadTimeoutMs,
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

let memorySourceCalls = 0;
let memorySourceMode = "warm";
let memorySourceGate;
const memoryUseCase = "BenchmarkHighCardinalityMemory";
const memoryIds = Array.from(
  { length: memoryKeyCount },
  (_, index) => `memory-${index}`,
);
const loadMemory = dialcache.cached(
  async () => {
    memorySourceCalls += 1;
    if (memorySourceMode === "warm") {
      return memoryPayload;
    }
    await memorySourceGate.promise;
    throw sourceError;
  },
  {
    keyType,
    useCase: memoryUseCase,
    cacheKey: (memoryId) => memoryId,
    serializer: rawBufferSerializer,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: logicalFreshAgeSec },
      staleOnErrorMaxAgeSec: staleMaxAgeSec,
    }),
  },
);

const freshValueKey = redisValueKey(namespace, keyType, id, freshUseCase);
const staleValueKey = redisValueKey(namespace, keyType, id, staleUseCase);
const memoryValueKeys = memoryIds.map((memoryId) =>
  redisValueKey(namespace, keyType, memoryId, memoryUseCase)
);

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
    run: async () => {
      for (let index = 0; index < iterations; index += 1) {
        assert.deepEqual(await dialcache.enable(async () => await loadFresh()), payload);
      }
    },
  }));
  assert.equal(freshSourceCalls, 1, "fresh hits must not reach the source after warmup");

  // The writer and reader are this process, so waiting beyond F makes the
  // retained frame a deterministic logical miss while Redis keeps it to M.
  await wait(logicalFreshAgeSec * 1_000 + 100);
  assert((await redis.pTTL(staleValueKey)) > 0, "the logically stale frame must remain retained");

  rows.push(await measureRetainedScenario({
    name: "retained-frame native adapter read",
    operations: iterations,
    run: async () => {
      for (let index = 0; index < iterations; index += 1) {
        assert.notEqual(
          await adapter.read({ valueKey: staleValueKey }),
          null,
          "the adapter must return the retained frame for core age filtering",
        );
      }
    },
  }));

  const recoveryOutcomesBefore = staleOutcomes.get("served") ?? 0;
  const recoverySourceCallsBefore = staleSourceCalls;
  const endToEndRecovery = await measureRetainedScenario({
    name: "end-to-end stale recovery",
    operations: iterations,
    run: async () => {
      for (let index = 0; index < iterations; index += 1) {
        assert.deepEqual(await dialcache.enable(async () => await loadStale()), payload);
      }
    },
  });
  rows.push(endToEndRecovery);
  assert.equal(
    endToEndRecovery.adapterReadCalls,
    iterations,
    "each stale-recovery flight must issue exactly one native Redis read",
  );
  assert.equal(staleSourceCalls - recoverySourceCallsBefore, iterations);
  assert.equal((staleOutcomes.get("served") ?? 0) - recoveryOutcomesBefore, iterations);

  staleSourceGate = deferred();
  staleSourceMode = "gated-rejection";
  const coalescedSourceCallsBefore = staleSourceCalls;
  const coalescedOutcomesBefore = staleOutcomes.get("served") ?? 0;
  const coalesced = await measureRetainedScenario({
    name: "coalesced stale recovery",
    operations: fanout,
    run: async () => {
      const pending = Array.from(
        { length: fanout },
        () => dialcache.enable(async () => await loadStale()),
      );
      let sourceStartError;
      try {
        await waitFor(
          () => staleSourceCalls > coalescedSourceCallsBefore,
          sourceStartTimeoutMs,
        );
      } catch (error) {
        sourceStartError = error;
      } finally {
        // Do not strand the fanout if Redis or the benchmark assertion fails.
        staleSourceGate.resolve();
      }
      if (sourceStartError !== undefined) {
        await Promise.allSettled(pending);
        throw sourceStartError;
      }
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
    "same-key coalescing must share one recovery decision",
  );
  assert.equal(
    coalesced.adapterReadCalls,
    1,
    "same-key coalescing must share one native Redis read",
  );

  const memoryCompressionBefore = compressionOutcomes.get("compressed") ?? 0;
  const memoryWarmSourceCallsBefore = memorySourceCalls;
  const warmedMemoryValues = await Promise.all(
    memoryIds.map((memoryId) =>
      dialcache.enable(async () => await loadMemory(memoryId))
    ),
  );
  for (const value of warmedMemoryValues) {
    assert.deepEqual(value, memoryPayload);
  }
  assert.equal(
    memorySourceCalls - memoryWarmSourceCallsBefore,
    memoryKeyCount,
    "each high-cardinality key must be warmed from the source",
  );
  assert.equal(
    (compressionOutcomes.get("compressed") ?? 0) - memoryCompressionBefore,
    0,
    "random memory-benchmark payloads must remain raw rather than compressing",
  );
  const memoryStoredBytes = await redis.strLen(memoryValueKeys[0]);
  assert.equal(
    memoryStoredBytes,
    memoryPayloadBytes + 10,
    "the raw binary Redis frame must contain only its ten-byte protocol header beyond the payload",
  );

  await wait(logicalFreshAgeSec * 1_000 + 100);
  assert(
    (await redis.pTTL(memoryValueKeys[0])) > 0,
    "the high-cardinality frames must remain retained after becoming logically stale",
  );

  memorySourceGate = deferred();
  memorySourceMode = "gated-rejection";
  const memoryRecoverySourceCallsBefore = memorySourceCalls;
  const memoryOutcomesBefore = staleOutcomes.get("served") ?? 0;
  let memoryBefore;
  let memoryRetained;
  await collectGarbageIfAvailable();
  memoryBefore = process.memoryUsage();
  const highCardinality = await measureRetainedScenario({
    name: "high-cardinality delayed stale recovery",
    operations: memoryKeyCount,
    retainedValueKey: memoryValueKeys[0],
    run: async () => {
      const pending = memoryIds.map((memoryId) =>
        dialcache.enable(async () => await loadMemory(memoryId))
      );
      let sourceStartError;
      try {
        await waitFor(
          () => memorySourceCalls - memoryRecoverySourceCallsBefore >= memoryKeyCount,
          Math.max(sourceStartTimeoutMs, 10_000),
        );
        // Hold every distinct source call open so each flight retains its own
        // raw candidate before the process-level memory snapshot.
        await wait(memorySourceDelayMs);
        await collectGarbageIfAvailable();
        memoryRetained = process.memoryUsage();
      } catch (error) {
        sourceStartError = error;
      } finally {
        memorySourceGate.resolve();
      }
      if (sourceStartError !== undefined) {
        await Promise.allSettled(pending);
        throw sourceStartError;
      }
      const values = await Promise.all(pending);
      for (const value of values) {
        assert.deepEqual(value, memoryPayload);
      }
    },
  });
  await collectGarbageIfAvailable();
  const memoryAfter = process.memoryUsage();
  rows.push(highCardinality);
  assert.equal(
    highCardinality.adapterReadCalls,
    memoryKeyCount,
    "each distinct high-cardinality flight must issue exactly one native Redis read",
  );
  assert.equal(
    memorySourceCalls - memoryRecoverySourceCallsBefore,
    memoryKeyCount,
    "each distinct high-cardinality flight must reach its own source call",
  );
  assert.equal(
    (staleOutcomes.get("served") ?? 0) - memoryOutcomesBefore,
    memoryKeyCount,
    "each distinct high-cardinality flight must serve its retained candidate",
  );
  assert.notEqual(
    memoryRetained,
    undefined,
    "the delayed-source memory snapshot must be captured",
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
    "adapter reads": row.adapterReadCalls,
    "adapter reads/op": perOperation(row.adapterReadCalls, row.operations),
    "GET/op": perOperation(row.getCalls, row.operations),
    "server us/op": perOperation(row.serverUsec, row.operations),
    "net in B/op": perOperation(row.netInputBytes, row.operations),
    "net out B/op": perOperation(row.netOutputBytes, row.operations),
  })));
  console.log(
    `Node memory snapshots — ${memoryKeyCount.toLocaleString("en-US")} distinct flights held for ${memorySourceDelayMs.toLocaleString("en-US")} ms with ${memoryPayloadBytes.toLocaleString("en-US")} B incompressible raw payloads`,
  );
  console.table([
    memorySnapshotRow("before flights", memoryBefore, memoryBefore),
    memorySnapshotRow("all sources delayed", memoryRetained, memoryBefore),
    memorySnapshotRow("after recovery", memoryAfter, memoryBefore),
  ]);
  console.log(
    `Memory deltas are process-level observations that include Redis client buffers, promises, and source-call state; GC ${typeof globalThis.gc === "function" ? "was requested before the baseline" : "was not exposed"}. No memory or timing threshold is applied.`,
  );
  console.log(
    "Semantic assertions passed. INFO deltas are observational and include small snapshot-query overhead; no timing threshold is applied.",
  );
} finally {
  await redis.del([freshValueKey, staleValueKey, ...memoryValueKeys]).catch(() => undefined);
  await redis.quit().catch(() => redis.disconnect());
}

async function measureScenario({ name, operations, run }) {
  const before = await redisSnapshot(redis);
  const adapterReadsBefore = adapterReadCalls;
  const start = performance.now();
  await run();
  const elapsedMs = performance.now() - start;
  const scenarioAdapterReadCalls = adapterReadCalls - adapterReadsBefore;
  const after = await redisSnapshot(redis);
  const getCalls = commandDelta(before, after, "get", "calls");
  let serverUsec = 0;
  for (const command of ["get", "mget", "set", "evalsha", "eval"]) {
    serverUsec += commandDelta(before, after, command, "usec");
  }
  return {
    name,
    operations,
    elapsedMs,
    adapterReadCalls: scenarioAdapterReadCalls,
    getCalls,
    serverUsec,
    netInputBytes: after.netInputBytes - before.netInputBytes,
    netOutputBytes: after.netOutputBytes - before.netOutputBytes,
  };
}

async function measureRetainedScenario(options) {
  try {
    return await measureScenario(options);
  } catch (error) {
    const remainingTtlMs = await redis.pTTL(
      options.retainedValueKey ?? staleValueKey,
    ).catch(() => null);
    if (remainingTtlMs !== null && remainingTtlMs <= 0) {
      throw new Error(
        `Stale-on-error benchmark exhausted its M=${staleMaxAgeSec}s retention window during "${options.name}"; reduce the configured iteration, fanout, or payload size`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function collectGarbageIfAvailable() {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    // Give native Redis and compression buffers one turn to release their
    // backing stores before a second collection stabilizes the snapshot.
    await wait(0);
    globalThis.gc();
  }
}

function memorySnapshotRow(name, snapshot, baseline) {
  return {
    snapshot: name,
    "rss MiB": mebibytes(snapshot.rss),
    "rss delta MiB": mebibytes(snapshot.rss - baseline.rss),
    "heap MiB": mebibytes(snapshot.heapUsed),
    "heap delta MiB": mebibytes(snapshot.heapUsed - baseline.heapUsed),
    "external MiB": mebibytes(snapshot.external),
    "external delta MiB": mebibytes(snapshot.external - baseline.external),
  };
}

function mebibytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function commandDelta(before, after, command, field) {
  return (after.commands[command]?.[field] ?? 0) - (before.commands[command]?.[field] ?? 0);
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

async function waitFor(predicate, timeoutMs) {
  const deadlineMs = performance.now() + timeoutMs;
  while (performance.now() < deadlineMs) {
    if (predicate()) {
      return;
    }
    await wait(1);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for the benchmark source call`);
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

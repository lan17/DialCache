import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { CacheLayer, DialCache, DialCacheKeyConfig } from "../dist/index.js";

class BenchmarkCoordinator {
  state = "ready";
  #listeners = new Set();

  constructor(namespace) {
    this.namespace = namespace;
  }

  addListener(listener) {
    this.#listeners.add(listener);
    listener.onStateChange(this.state);
    return () => this.#listeners.delete(listener);
  }

  invalidate(invalidation) {
    for (const listener of this.#listeners) {
      try {
        listener.onInvalidation(invalidation);
      } catch {
        // Match the coordinator contract: one listener must not break fan-out.
      }
    }
  }
}

const silentLogger = {
  debug: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};
const hitIterations = readPositiveInteger("DIALCACHE_BENCH_ITERATIONS", 50_000);
const hitRounds = readPositiveInteger("DIALCACHE_BENCH_ROUNDS", 7);
const scanIterations = readPositiveInteger("DIALCACHE_BENCH_SCAN_ITERATIONS", 200);
const scanOccupancies = [
  ...new Set([
    1_000,
    10_000,
    readPositiveInteger("DIALCACHE_BENCH_LARGE_OCCUPANCY", 50_000),
  ]),
].sort((left, right) => left - right);

const unconfiguredHits = await prepareLocalHitBenchmark(false);
const coordinatedHits = await prepareLocalHitBenchmark(true);
await unconfiguredHits.run(Math.min(hitIterations, 10_000));
await coordinatedHits.run(Math.min(hitIterations, 10_000));

const hitSamples = new Map([
  [unconfiguredHits, []],
  [coordinatedHits, []],
]);
for (let round = 0; round < hitRounds; round += 1) {
  const order = round % 2 === 0
    ? [coordinatedHits, unconfiguredHits]
    : [unconfiguredHits, coordinatedHits];
  for (const benchmark of order) {
    hitSamples.get(benchmark).push(await benchmark.run(hitIterations));
  }
}
const hitResults = [unconfiguredHits, coordinatedHits].map((benchmark) => {
  const samples = hitSamples.get(benchmark);
  return {
    scenario: benchmark.scenario,
    operations: hitIterations,
    samples: samples.length,
    elapsedMs: median(samples),
    fallbackCalls: benchmark.fallbackCalls(),
  };
});
unconfiguredHits.dispose();
coordinatedHits.dispose();

console.log("\nTracked process-local hit throughput");
console.table(
  hitResults.map(({ scenario, operations, samples, elapsedMs, fallbackCalls }) => ({
    scenario,
    operations,
    samples,
    "median elapsed (ms)": elapsedMs.toFixed(2),
    "median operations/sec": Math.round((operations / elapsedMs) * 1_000).toLocaleString("en-US"),
    "fallback calls": fallbackCalls,
  })),
);
const [unconfiguredResult, coordinatedResult] = hitResults;
console.log(
  `Coordinated median elapsed-time delta: ${
    (((coordinatedResult.elapsedMs / unconfiguredResult.elapsedMs) - 1) * 100).toFixed(2)
  }% (informational).`,
);

const scanResults = [];
for (const occupancy of scanOccupancies) {
  scanResults.push(await benchmarkInvalidationScan({
    scenario: "peer Pub/Sub event",
    occupancy,
    iterations: scanIterations,
    signalSources: ["event"],
  }));
}
scanResults.push(await benchmarkInvalidationScan({
  scenario: "origin provisional + returned + echo",
  occupancy: 10_000,
  iterations: scanIterations,
  signalSources: ["provisional", "event", "event"],
}));

console.log("\nTracked process-local invalidation scan cost");
console.table(
  scanResults.map(({
    scenario,
    occupancy,
    operations,
    signalsPerOperation,
    scans,
    elapsedMs,
    fallbackCalls,
  }) => ({
    scenario,
    "local entries": occupancy,
    "logical invalidations": operations,
    "signals / invalidation": signalsPerOperation,
    "LRU scans": scans,
    "elapsed (ms)": elapsedMs.toFixed(2),
    "average invalidation (ms)": (elapsedMs / operations).toFixed(3),
    "average scan (ms)": (elapsedMs / scans).toFixed(3),
    "entries examined/sec": Math.round((occupancy * scans / elapsedMs) * 1_000)
      .toLocaleString("en-US"),
    "fallback calls": fallbackCalls,
  })),
);

console.log("Semantic assertions passed; elapsed times are informational and have no pass/fail threshold.");

async function prepareLocalHitBenchmark(coordinated) {
  // Keep every key/config input identical so this isolates coordinator state
  // rather than string hashing, ramp assignment, or cache-key construction.
  const namespace = "benchmark-local-hit";
  const coordinator = coordinated ? new BenchmarkCoordinator(namespace) : null;
  const redisClient = coordinated ? createUnusedCoordinatedRedisClient() : null;
  const dialcache = new DialCache({
    namespace,
    logger: silentLogger,
    ...(coordinator === null || redisClient === null
      ? {}
      : { redis: { client: redisClient, coordinator } }),
  });
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      return { id };
    },
    {
      keyType: "benchmark_id",
      useCase: "TrackedLocalHit",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnlyConfig(),
    },
  );

  const expected = await dialcache.enable(async () => await getValue("shared"));

  return {
    scenario: coordinated ? "coordinated healthy local hits" : "unconfigured local hits",
    async run(iterations) {
      let elapsedMs = 0;
      await dialcache.enable(async () => {
        let actual = expected;
        const start = performance.now();
        for (let index = 0; index < iterations; index += 1) {
          actual = await getValue("shared");
        }
        elapsedMs = performance.now() - start;
        assert.strictEqual(actual, expected);
      });
      assert.equal(fallbackCalls, 1, "process-local hits should execute the fallback once");
      assert.equal(redisClient?.calls ?? 0, 0, "local-only operations must not reach Redis");
      return elapsedMs;
    },
    fallbackCalls: () => fallbackCalls,
    dispose: () => dialcache.dispose(),
  };
}

async function benchmarkInvalidationScan({
  scenario,
  occupancy,
  iterations,
  signalSources,
}) {
  const signalsPerOperation = signalSources.length;
  const namespace = `benchmark-scan-${occupancy}-${signalsPerOperation}`;
  const coordinator = new BenchmarkCoordinator(namespace);
  const redisClient = createUnusedCoordinatedRedisClient();
  const dialcache = new DialCache({
    namespace,
    logger: silentLogger,
    localMaxSize: occupancy,
    redis: { client: redisClient, coordinator },
  });
  let version = 1;
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      return { id, version };
    },
    {
      keyType: "benchmark_id",
      useCase: `InvalidationScan${occupancy}x${signalsPerOperation}`,
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: localOnlyConfig(),
    },
  );

  await dialcache.enable(async () => {
    for (let index = 0; index < occupancy; index += 1) {
      await getValue(String(index));
    }
  });
  assert.equal(fallbackCalls, occupancy, "benchmark setup should populate every local entry");

  const missingInvalidation = {
    namespace,
    keyType: "benchmark_id",
    id: "not-present",
    remainingMs: 60_000,
    source: "event",
  };
  const invalidationSignals = signalSources.map((source) => ({
    ...missingInvalidation,
    source,
  }));
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    for (const signal of invalidationSignals) {
      coordinator.invalidate(signal);
    }
  }
  const elapsedMs = performance.now() - start;

  version = 2;
  const targetId = String(Math.floor(occupancy / 2));
  coordinator.invalidate({
    ...missingInvalidation,
    id: targetId,
  });
  const [firstAfterInvalidation, secondAfterInvalidation] = await dialcache.enable(async () => [
    await getValue(targetId),
    await getValue(targetId),
  ]);
  assert.equal(firstAfterInvalidation.version, 2, "invalidation should evict the matching local value");
  assert.equal(secondAfterInvalidation.version, 2, "the local fence should prevent immediate republication");
  assert.equal(
    fallbackCalls,
    occupancy + 2,
    "both calls inside an active local fence should execute the fallback",
  );
  assert.equal(redisClient.calls, 0, "direct local invalidation fan-out must not reach Redis");

  dialcache.dispose();
  return {
    scenario,
    occupancy,
    operations: iterations,
    signalsPerOperation,
    scans: iterations * signalsPerOperation,
    elapsedMs,
    fallbackCalls,
  };
}

function localOnlyConfig() {
  return new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
    ramp: { [CacheLayer.LOCAL]: 100 },
  });
}

function createUnusedCoordinatedRedisClient() {
  return {
    calls: 0,
    async read() {
      this.calls += 1;
      return null;
    },
    async write() {
      this.calls += 1;
      return true;
    },
    async invalidate() {
      this.calls += 1;
    },
    async invalidateAndPublish({ namespace, keyType, id, futureBufferMs }) {
      this.calls += 1;
      const redisNowMs = Date.now();
      return {
        version: 1,
        namespace,
        keyType,
        id,
        effectiveWatermarkMs: String(redisNowMs + futureBufferMs),
        redisNowMs: String(redisNowMs),
      };
    },
  };
}

function readPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function median(values) {
  assert(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

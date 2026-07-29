import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";

import { CacheLayer, DialCache, DialCacheKeyConfig } from "../dist/index.js";

const sequentialIterations = readPositiveInteger("DIALCACHE_BENCH_ITERATIONS", 50_000);
const coalescingFanout = readPositiveInteger("DIALCACHE_BENCH_FANOUT", 1_000);
const noOpMetrics = {
  request() {},
  miss() {},
  disabled() {},
  error() {},
  invalidation() {},
  coalesced() {},
  shadowValidation() {},
  observeGet() {},
  observeFallback() {},
  observeSerialization() {},
  observeSize() {},
};

const results = [
  await benchmarkSequentialRequestLocalHits(sequentialIterations),
  await benchmarkSequentialProcessLocalHits(sequentialIterations),
  await benchmarkEnabledFallbacks(sequentialIterations),
  await benchmarkRequestLocalCoalescing(coalescingFanout),
  await benchmarkProcessCoalescing(coalescingFanout),
  await benchmarkRedisReadDeadlineCoalescing(coalescingFanout),
  await benchmarkSequentialTrackedRedisHits(sequentialIterations, {
    scenario: "tracked Redis hits, shadow omitted",
    useCase: "BenchmarkTrackedRedisShadowOmitted",
  }),
  await benchmarkSequentialTrackedRedisHits(sequentialIterations, {
    scenario: "tracked Redis hits, shadow ramped out",
    useCase: "BenchmarkTrackedRedisShadowRampedOut",
    // This exact key's stable shadow sample is about 90.11.
    shadowRamp: 50,
  }),
];

console.table(
  results.map(({ scenario, operations, elapsedMs, fallbackCalls, redisReadCalls = 0, deadlineTimers = 0 }) => ({
    scenario,
    operations,
    "elapsed (ms)": elapsedMs.toFixed(2),
    "operations/sec": Math.round((operations / elapsedMs) * 1_000).toLocaleString("en-US"),
    "fallback calls": fallbackCalls,
    "Redis reads": redisReadCalls,
    "deadline timers": deadlineTimers,
  })),
);

console.log("Semantic assertions passed; elapsed times are informational and have no pass/fail threshold.");

async function benchmarkSequentialRequestLocalHits(iterations) {
  const dialcache = new DialCache();
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      return { id };
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkRequestLocalSequential",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    },
  );

  let elapsedMs = 0;
  await dialcache.enable(async () => {
    const expected = await getValue("shared");
    let actual = expected;
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      actual = await getValue("shared");
    }
    elapsedMs = performance.now() - start;
    assert.strictEqual(actual, expected);
  });

  assert.equal(fallbackCalls, 1, "sequential request-local hits should execute the fallback once");
  return { scenario: "request-local sequential hits", operations: iterations, elapsedMs, fallbackCalls };
}

async function benchmarkSequentialProcessLocalHits(iterations) {
  const dialcache = new DialCache();
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      return { id };
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkProcessLocalSequential",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    },
  );

  let elapsedMs = 0;
  await dialcache.enable(async () => {
    const expected = await getValue("shared");
    let actual = expected;
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      actual = await getValue("shared");
    }
    elapsedMs = performance.now() - start;
    assert.strictEqual(actual, expected);
  });

  assert.equal(fallbackCalls, 1, "process-local hits should reuse the first fallback value");
  return { scenario: "process-local sequential hits", operations: iterations, elapsedMs, fallbackCalls };
}

async function benchmarkEnabledFallbacks(iterations) {
  const dialcache = new DialCache();
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      return id;
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkEnabledFallbacks",
      cacheKey: (id) => id,
    },
  );

  let elapsedMs = 0;
  await dialcache.enable(async () => {
    await getValue("warmup");
    fallbackCalls = 0;
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      await getValue("shared");
    }
    elapsedMs = performance.now() - start;
  });

  assert.equal(fallbackCalls, iterations, "enabled uncached calls should each run a bounded fallback");
  return { scenario: "enabled bounded fallbacks", operations: iterations, elapsedMs, fallbackCalls };
}

async function benchmarkRequestLocalCoalescing(fanout) {
  const dialcache = new DialCache();
  const gate = deferred();
  const started = deferred();
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      started.resolve();
      await gate.promise;
      return id;
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkRequestLocalCoalescing",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
    },
  );

  const start = performance.now();
  const valuesPromise = dialcache.enable(async () => {
    const values = Array.from({ length: fanout }, () => getValue("shared"));
    await started.promise;
    await nextTurn();
    gate.resolve();
    return await Promise.all(values);
  });
  const values = await valuesPromise;
  const elapsedMs = performance.now() - start;

  assert.deepEqual(new Set(values), new Set(["shared"]));
  assert.equal(fallbackCalls, 1, "request-local coalescing should execute the fallback once");
  return { scenario: "request-local coalescing", operations: fanout, elapsedMs, fallbackCalls };
}

async function benchmarkProcessCoalescing(fanout) {
  const dialcache = new DialCache();
  const gate = deferred();
  const started = deferred();
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      started.resolve();
      await gate.promise;
      return id;
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkProcessCoalescing",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.LOCAL]: 60 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      }),
    },
  );

  const start = performance.now();
  const valuesPromise = Promise.all(
    Array.from({ length: fanout }, () => dialcache.enable(async () => await getValue("shared"))),
  );
  await started.promise;
  await nextTurn();
  const activeState = dialcache.getCoalescingState().process;
  assert.equal(activeState.activeLeaders, 1);
  assert.equal(activeState.activeFollowers, fanout - 1);
  assert.equal(typeof activeState.oldestLeaderAgeMs, "number");
  gate.resolve();
  const values = await valuesPromise;
  const elapsedMs = performance.now() - start;

  assert.deepEqual(new Set(values), new Set(["shared"]));
  assert.equal(fallbackCalls, 1, "process coalescing should execute the fallback once across enabled scopes");
  assert.deepEqual(dialcache.getCoalescingState().process, {
    activeLeaders: 0,
    activeFollowers: 0,
    oldestLeaderAgeMs: null,
  });
  return { scenario: "process coalescing", operations: fanout, elapsedMs, fallbackCalls };
}

async function benchmarkRedisReadDeadlineCoalescing(fanout) {
  const gate = deferred();
  const started = deferred();
  let redisReadCalls = 0;
  let deadlineTimers = 0;
  let clearedDeadlineTimers = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const redisClient = {
    async read() {
      redisReadCalls += 1;
      started.resolve();
      await gate.promise;
      return JSON.stringify("shared");
    },
    async write() {
      return true;
    },
    async invalidate() {},
  };
  const dialcache = new DialCache({
    redis: { client: redisClient, readTimeoutMs: 60_000 },
  });
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      return id;
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkRedisReadDeadlineCoalescing",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
      }),
    },
  );

  try {
    globalThis.setTimeout = (...args) => {
      deadlineTimers += 1;
      return originalSetTimeout(...args);
    };
    globalThis.clearTimeout = (timer) => {
      clearedDeadlineTimers += 1;
      originalClearTimeout(timer);
    };

    const start = performance.now();
    const valuesPromise = Promise.all(
      Array.from({ length: fanout }, () => dialcache.enable(async () => await getValue("shared"))),
    );
    await started.promise;
    await nextTurn();
    gate.resolve();
    const values = await valuesPromise;
    const elapsedMs = performance.now() - start;

    assert.deepEqual(new Set(values), new Set(["shared"]));
    assert.equal(fallbackCalls, 0, "a Redis hit should not execute the fallback");
    assert.equal(redisReadCalls, 1, "Redis followers should share one semantic read");
    assert.equal(deadlineTimers, 1, "one Redis read leader should allocate one deadline timer");
    assert.equal(clearedDeadlineTimers, 1, "the Redis read deadline timer should be cleared exactly once");
    return {
      scenario: "Redis read deadline coalescing",
      operations: fanout,
      elapsedMs,
      fallbackCalls,
      redisReadCalls,
      deadlineTimers,
    };
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

async function benchmarkSequentialTrackedRedisHits(iterations, { scenario, useCase, shadowRamp }) {
  let redisReadCalls = 0;
  let redisWriteCalls = 0;
  let redisInvalidationCalls = 0;
  const redisClient = {
    async read({ watermarkKey }) {
      assert.equal(typeof watermarkKey, "string", "the benchmark must exercise tracked Redis reads");
      redisReadCalls += 1;
      return JSON.stringify("shared");
    },
    async write() {
      redisWriteCalls += 1;
      return true;
    },
    async invalidate() {
      redisInvalidationCalls += 1;
    },
  };
  const dialcache = new DialCache({
    redis: { client: redisClient, readTimeoutMs: 60_000 },
    // Keep both scenarios on the path where shadow telemetry is available.
    metrics: noOpMetrics,
  });
  let fallbackCalls = 0;
  const getValue = dialcache.cached(
    async (id) => {
      fallbackCalls += 1;
      return id;
    },
    {
      keyType: "benchmark_id",
      useCase,
      cacheKey: (id) => id,
      trackForInvalidation: true,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
        ...(shadowRamp === undefined ? {} : { shadowRamp }),
      }),
    },
  );

  let actual;
  const start = performance.now();
  await dialcache.enable(async () => {
    for (let index = 0; index < iterations; index += 1) {
      actual = await getValue("shared");
    }
  });
  const elapsedMs = performance.now() - start;
  // Let an incorrectly selected detached validation start before checking that
  // omitted and ramped-out shadow policies never invoke the source loader.
  await nextTurn();

  assert.equal(actual, "shared");
  assert.equal(redisReadCalls, iterations, "every benchmark operation should be a Redis hit");
  assert.equal(redisWriteCalls, 0, "successful Redis hits must not write");
  assert.equal(redisInvalidationCalls, 0, "successful Redis hits must not invalidate");
  assert.equal(fallbackCalls, 0, "shadow-omitted and ramped-out hits must not invoke the source loader");
  return {
    scenario,
    operations: iterations,
    elapsedMs,
    fallbackCalls,
    redisReadCalls,
    deadlineTimers: "not measured",
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

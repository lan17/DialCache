import assert from "node:assert/strict";

import { CacheLayer, DialCache, DialCacheKeyConfig } from "../../dist/index.js";

export const coreKinds = new Set([
  "source-baseline", "disabled", "enabled-uncached", "request-local-hit",
  "process-local-hit", "local-eviction", "request-coalescing", "process-coalescing",
]);

export function emptyCounters() {
  return { sourceCalls: 0, redisReads: 0, redisWrites: 0, coalescedCalls: 0 };
}

export function emptyCommands() {
  return { get: 0, mget: 0, set: 0, eval: 0, evalsha: 0, time: 0 };
}

// Allocate result storage before timing, then check every full value afterward.
// Keeping only a final value would let an intermittently broken path pass.
export function checkValues(values, payload) {
  assert.ok(values.every(value => value === payload), "every result must equal the supplied payload");
}

export async function runCore(request) {
  if (request.case.warmup > 0) await phase(request, request.case.warmup);
  return phase(request, request.case.iterations);
}

async function phase({ case: workload, payload }, iterations) {
  const { kind, fanout, capacity } = workload;
  const coalescing = kind === "request-coalescing" || kind === "process-coalescing";
  const operations = iterations * (coalescing ? fanout : 1);
  const counters = emptyCounters();
  const values = new Array(operations);
  const keys = Array.from({ length: iterations }, (_, index) => `key-${index}`);
  const prefillKeys = Array.from({ length: capacity }, (_, index) => `prefill-${index}`);
  let activeBurst;
  const source = coalescing
    ? async () => {
      counters.sourceCalls += 1;
      await activeBurst.release.promise;
      return payload;
    }
    : async () => {
      counters.sourceCalls += 1;
      return payload;
    };
  const cache = new DialCache({
    localMaxSize: capacity,
    ...(coalescing ? { metrics: followerObserver(() => {
      counters.coalescedCalls += 1;
      activeBurst.followers += 1;
      if (activeBurst.followers === fanout - 1) activeBurst.joined.resolve();
    }) } : {}),
  });
  const local = ["process-local-hit", "local-eviction", "process-coalescing"].includes(kind);
  const operation = cache.cached(source, {
    keyType: "benchmark-key",
    useCase: "Benchmark",
    cacheKey: key => key,
    fallbackTimeoutMs: 60_000,
    defaultConfig: new DialCacheKeyConfig({
      requestLocal: ["disabled", "request-local-hit", "request-coalescing"].includes(kind),
      ...(local ? {
        ttlSec: { [CacheLayer.LOCAL]: 3600 },
        ramp: { [CacheLayer.LOCAL]: 100 },
      } : {}),
    }),
  });
  let checksum = 0;
  let elapsedNs;

  if (coalescing) {
    const start = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) {
      activeBurst = { release: Promise.withResolvers(), joined: Promise.withResolvers(), followers: 0 };
      const burst = async () => {
        const callers = Array.from({ length: fanout }, () => kind === "request-coalescing"
          ? operation(keys[index])
          : cache.enable(() => operation(keys[index])));
        const completed = Promise.all(callers);
        const timeout = setTimeout(() => activeBurst.joined.reject(new Error("coalescing followers did not join within 5s")), 5_000);
        try {
          if (fanout > 1) await Promise.race([activeBurst.joined.promise, completed]);
        } finally {
          clearTimeout(timeout);
          activeBurst.release.resolve();
        }
        return completed;
      };
      const results = kind === "request-coalescing" ? await cache.enable(burst) : await burst();
      for (let caller = 0; caller < fanout; caller += 1) {
        const value = results[caller];
        values[index * fanout + caller] = value;
        checksum += value.length; // The shared payload is ASCII; full content is checked below.
      }
    }
    elapsedNs = Number(process.hrtime.bigint() - start);
  } else {
    const loop = async () => {
      if (kind === "request-local-hit" || kind === "process-local-hit") {
        const prime = kind === "request-local-hit"
          ? await operation("shared") : await cache.enable(() => operation("shared"));
        assert.equal(prime, payload);
      }
      if (kind === "local-eviction") {
        for (const key of prefillKeys) assert.equal(await cache.enable(() => operation(key)), payload);
        const beforeProbe = counters.sourceCalls;
        assert.equal(await cache.enable(() => operation(prefillKeys.at(-1))), payload);
        assert.equal(counters.sourceCalls, beforeProbe, "prefilling must actually retain local entries");
      }
      counters.sourceCalls = 0;
      const start = process.hrtime.bigint();
      for (let index = 0; index < iterations; index += 1) {
        let value;
        if (kind === "source-baseline") value = await source();
        else if (kind === "process-local-hit") value = await cache.enable(() => operation("shared"));
        else if (kind === "local-eviction") value = await cache.enable(() => operation(keys[index]));
        else value = await operation("shared");
        values[index] = value;
        checksum += value.length;
      }
      elapsedNs = Number(process.hrtime.bigint() - start);
    };
    if (kind === "enabled-uncached" || kind === "request-local-hit") await cache.enable(loop);
    else await loop();
  }

  checkValues(values, payload);
  assert.equal(checksum, operations * workload.payloadBytes);
  const expectedSources = kind === "request-local-hit" || kind === "process-local-hit" ? 0 : iterations;
  assert.equal(counters.sourceCalls, expectedSources, "source-call count must prove the measured path");
  assert.equal(counters.coalescedCalls, coalescing ? iterations * (fanout - 1) : 0);
  const measuredCounters = { ...counters };
  if (kind === "local-eviction") {
    assert.equal(await cache.enable(() => operation(keys.at(-1))), payload);
    assert.equal(counters.sourceCalls, measuredCounters.sourceCalls, "the latest inserted entry must remain cached");
    assert.equal(await cache.enable(() => operation(prefillKeys[0])), payload);
    assert.equal(counters.sourceCalls, measuredCounters.sourceCalls + 1, "the oldest prefilled entry must have been evicted");
  }
  return { operations, elapsedNs, checksum, valueValid: true, counters: measuredCounters, redisCommands: emptyCommands(), latencyNs: [] };
}

function followerObserver(coalesced) {
  return {
    request() {}, miss() {}, disabled() {}, error() {}, invalidation() {},
    observeGet() {}, observeFallback() {}, observeSerialization() {}, observeSize() {},
    coalesced,
  };
}

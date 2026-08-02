import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

async function runBenchmark(url) {
  const iterations = readPositiveInteger("DIALCACHE_BENCH_ITERATIONS", 2_000);
  const fanout = readPositiveInteger("DIALCACHE_BENCH_FANOUT", 100);
  const targetPayloadBytes = readPositiveInteger("DIALCACHE_BENCH_PAYLOAD_BYTES", 1_024);
  const evictionPressureKeys = readNonnegativeInteger("DIALCACHE_BENCH_EVICTION_KEYS", 0);
  const evictionValueBytes = readPositiveInteger("DIALCACHE_BENCH_EVICTION_VALUE_BYTES", 16_384);
  const freshTtlSec = 60;
  const staleMaxAgeSec = 300;
  const staleAgeMs = 120_000;
  const physicalTtlMs = staleMaxAgeSec * 1_000;
  const namespace = `dialcache-stale-bench-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ownedKeys = new Set();

  const [redisModule, dialcacheModule, nodeRedisModule] = await Promise.all([
    import("redis"),
    import("../dist/index.js"),
    import("../dist/node-redis.js"),
  ]);
  const { commandOptions, createClient } = redisModule;
  const {
    CacheLayer,
    DialCache,
    DialCacheKey,
    DialCacheKeyConfig,
    invalidationPrefix,
    redisClusterHashTag,
  } = dialcacheModule;
  const { createNodeRedisDialCacheClient, dialcacheRedisScripts } = nodeRedisModule;

  const admin = createClient({
    url,
    scripts: dialcacheRedisScripts,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: false,
    },
  });
  let lastClientError = null;
  admin.on("error", (error) => {
    lastClientError = error;
  });

  try {
    try {
      await admin.connect();
      await admin.ping();
    } catch (error) {
      const cause = lastClientError ?? error;
      throw new Error(
        `Could not connect to DIALCACHE_BENCH_REDIS_URL (${safeEndpoint(url)}): ${errorMessage(cause)}`,
        { cause },
      );
    }

    const adapter = createNodeRedisDialCacheClient(admin);
    const server = await readServerReport(admin, url);
    const evictedKeysBefore = await readEvictedKeys(admin);
    const payload = makeJsonPayload(targetPayloadBytes);
    const payloadBytes = Buffer.byteLength(payload.encoded);

    const freshKey = redisKeys({
      DialCacheKey,
      invalidationPrefix,
      redisClusterHashTag,
      namespace,
      keyType: "benchmark_id",
      id: "redis-cpu",
      useCase: "BenchmarkStaleRedisCpu",
      tracked: false,
    });
    own(ownedKeys, freshKey);
    assert.equal(
      await adapter.write({ valueKey: freshKey.valueKey, cacheTtlMs: physicalTtlMs, value: payload.encoded }),
      true,
      "fresh CPU fixture should be written",
    );

    const freshCpu = await benchmarkRedisReads({
      admin,
      adapter,
      iterations,
      valueKey: freshKey.valueKey,
      maxAgeMs: freshTtlSec * 1_000,
      expected: payload.encoded,
      scenario: "fresh_hit",
    });

    await markFrameStale({
      admin,
      commandOptions,
      valueKey: freshKey.valueKey,
      ageMs: staleAgeMs,
    });
    assert.equal(
      await adapter.read({ valueKey: freshKey.valueKey, maxAgeMs: freshTtlSec * 1_000 }),
      null,
      "the CPU fixture should be logically stale at the fresh TTL",
    );
    assert.equal(
      await adapter.read({ valueKey: freshKey.valueKey, maxAgeMs: physicalTtlMs }),
      payload.encoded,
      "the CPU fixture should remain readable at the stale maximum age",
    );

    const logicalStaleCpu = await benchmarkRedisReads({
      admin,
      adapter,
      iterations,
      valueKey: freshKey.valueKey,
      maxAgeMs: freshTtlSec * 1_000,
      expected: null,
      scenario: "logical_stale_miss",
    });

    const outageKey = redisKeys({
      DialCacheKey,
      invalidationPrefix,
      redisClusterHashTag,
      namespace,
      keyType: "benchmark_id",
      id: "outage",
      useCase: "BenchmarkStaleOutage",
      tracked: false,
    });
    own(ownedKeys, outageKey);
    await writeLogicallyStaleFixture({
      admin,
      adapter,
      commandOptions,
      key: outageKey,
      value: payload.encoded,
      physicalTtlMs,
      staleAgeMs,
      freshMaxAgeMs: freshTtlSec * 1_000,
    });
    const outageNetworkBefore = await readNetworkBytes(admin);
    const outageRecoveryResult = await benchmarkOutageRecovery({
      CacheLayer,
      DialCache,
      DialCacheKeyConfig,
      adapter,
      iterations,
      namespace,
      payload: payload.value,
      payloadBytes,
      freshTtlSec,
      staleMaxAgeSec,
    });
    const outageNetworkAfter = await readNetworkBytes(admin);
    const outageRecovery = {
      ...outageRecoveryResult,
      redisNetwork: networkByteDelta(outageNetworkBefore, outageNetworkAfter, iterations),
    };

    const coalescedKey = redisKeys({
      DialCacheKey,
      invalidationPrefix,
      redisClusterHashTag,
      namespace,
      keyType: "benchmark_id",
      id: "coalesced",
      useCase: "BenchmarkStaleCoalescing",
      tracked: false,
    });
    own(ownedKeys, coalescedKey);
    await writeLogicallyStaleFixture({
      admin,
      adapter,
      commandOptions,
      key: coalescedKey,
      value: payload.encoded,
      physicalTtlMs,
      staleAgeMs,
      freshMaxAgeMs: freshTtlSec * 1_000,
    });
    const coalescing = await benchmarkCoalescedRecovery({
      CacheLayer,
      DialCache,
      DialCacheKeyConfig,
      adapter,
      fanout,
      namespace,
      payload: payload.value,
      freshTtlSec,
      staleMaxAgeSec,
    });

    const trackedKey = redisKeys({
      DialCacheKey,
      invalidationPrefix,
      redisClusterHashTag,
      namespace,
      keyType: "benchmark_id",
      id: "tracked-residency",
      useCase: "BenchmarkTrackedResidency",
      tracked: true,
    });
    own(ownedKeys, trackedKey);
    const trackedResidency = await inspectTrackedResidency({
      admin,
      adapter,
      key: trackedKey,
      value: payload.encoded,
      physicalTtlMs,
    });

    const expirationKey = redisKeys({
      DialCacheKey,
      invalidationPrefix,
      redisClusterHashTag,
      namespace,
      keyType: "benchmark_id",
      id: "expiration",
      useCase: "BenchmarkTrackedExpiration",
      tracked: true,
    });
    own(ownedKeys, expirationKey);
    const expiration = await inspectExpiration({
      admin,
      adapter,
      key: expirationKey,
      value: payload.encoded,
    });

    const memoryUsage = {
      logicalStaleValueBytes: await requiredMemoryUsage(admin, freshKey.valueKey, "logical-stale value"),
      outageValueBytes: await requiredMemoryUsage(admin, outageKey.valueKey, "outage recovery value"),
      trackedValueBytes: trackedResidency.valueMemoryBytes,
      trackedWatermarkBytes: trackedResidency.watermarkMemoryBytes,
      expirationWatermarkBytesAfterValueExpiry: expiration.watermarkMemoryBytesAfterValueExpiry,
    };

    const sentinelKeys = {
      logicalStaleValue: freshKey.valueKey,
      outageValue: outageKey.valueKey,
      coalescedValue: coalescedKey.valueKey,
      trackedValue: trackedKey.valueKey,
      trackedWatermark: trackedKey.watermarkKey,
      expirationWatermark: expirationKey.watermarkKey,
    };
    const evictedKeysBeforePressure = await readEvictedKeys(admin);
    const evictionPressure = await applyEvictionPressure({
      admin,
      adapter,
      namespace,
      ownedKeys,
      server,
      keyCount: evictionPressureKeys,
      valueBytes: evictionValueBytes,
      recoveryValueKey: outageKey.valueKey,
      recoveryMaxAgeMs: physicalTtlMs,
    });
    const evictedKeysAfter = await readEvictedKeys(admin);
    const residency = Object.fromEntries(
      await Promise.all(
        Object.entries(sentinelKeys).map(async ([name, key]) => [name, (await admin.exists(key)) === 1]),
      ),
    );
    const eviction = evictionReport({
      server,
      evictedKeysBefore,
      evictedKeysBeforePressure,
      evictedKeysAfter,
      residency,
      pressure: evictionPressure,
    });

    return {
      status: "passed",
      generatedAt: new Date().toISOString(),
      server,
      settings: {
        adapter: "node-redis",
        iterations,
        fanout,
        requestedPayloadBytes: targetPayloadBytes,
        actualJsonPayloadBytes: payloadBytes,
        freshTtlSec,
        staleOnErrorMaxAgeSec: staleMaxAgeSec,
        logicalStaleAgeMs: staleAgeMs,
        evictionPressureKeys,
        evictionValueBytes,
      },
      redisCpu: {
        freshHit: freshCpu,
        logicalStaleMiss: logicalStaleCpu,
        logicalStaleMinusFreshUsecPerOperation: round(
          logicalStaleCpu.redisUsecPerOperation - freshCpu.redisUsecPerOperation,
          4,
        ),
        measurementNote:
          "Redis CPU is the INFO commandstats delta for top-level EVAL/EVALSHA-family commands. Use an isolated server to avoid unrelated script traffic.",
      },
      outageRecovery,
      coalescing,
      memoryUsage,
      trackedResidency,
      expiration,
      eviction,
      assertions: "passed",
      thresholdPolicy: "No latency, throughput, CPU, memory, or eviction-count threshold is enforced.",
    };
  } finally {
    if (admin.isOpen) {
      if (ownedKeys.size > 0) {
        try {
          await withSafetyTimeout(admin.del([...ownedKeys]), 2_000, "benchmark key cleanup");
        } catch {
          // All owned keys have finite TTLs, so failed best-effort cleanup remains bounded in Redis.
        }
      }
      try {
        await withSafetyTimeout(admin.quit(), 2_000, "Redis client shutdown");
      } catch {
        if (admin.isOpen) {
          admin.disconnect();
        }
      }
    }
  }
}

async function benchmarkRedisReads({
  admin,
  adapter,
  iterations,
  valueKey,
  maxAgeMs,
  expected,
  scenario,
}) {
  assert.equal(await adapter.read({ valueKey, maxAgeMs }), expected, `${scenario} warm-up read should match`);
  const before = await readScriptCommandStats(admin);
  const start = performance.now();
  let payloadResponseBytes = 0;
  for (let index = 0; index < iterations; index += 1) {
    const result = await adapter.read({ valueKey, maxAgeMs });
    if (result !== expected) {
      throw new assert.AssertionError({
        message: `${scenario} read ${index} returned an unexpected result`,
        actual: result,
        expected,
        operator: "strictEqual",
      });
    }
    if (result !== null) {
      payloadResponseBytes += Buffer.isBuffer(result) ? result.byteLength : Buffer.byteLength(result);
    }
  }
  const elapsedMs = performance.now() - start;
  const after = await readScriptCommandStats(admin);
  const commandstats = subtractCommandStats(before, after);
  assert.ok(
    commandstats.calls >= iterations,
    `${scenario} should add at least ${iterations} EVAL/EVALSHA-family command calls; observed ${commandstats.calls}`,
  );
  return {
    operations: iterations,
    elapsedMs: round(elapsedMs, 3),
    operationsPerSecond: round((iterations / elapsedMs) * 1_000, 1),
    redisCommandCalls: commandstats.calls,
    redisUsec: commandstats.usec,
    redisUsecPerOperation: round(commandstats.usec / iterations, 4),
    applicationPayloadResponseBytes: payloadResponseBytes,
    commandstatsByCommand: commandstats.byCommand,
  };
}

async function benchmarkOutageRecovery({
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  adapter,
  iterations,
  namespace,
  payload,
  payloadBytes,
  freshTtlSec,
  staleMaxAgeSec,
}) {
  const counters = { reads: 0, sourceCalls: 0, staleServed: 0 };
  const client = countingClient(adapter, counters);
  const metrics = recordingMetrics({
    staleRecovery({ outcome }) {
      if (outcome === "served") {
        counters.staleServed += 1;
      }
    },
  });
  const dialcache = new DialCache({
    namespace,
    redis: { client, readTimeoutMs: 5_000 },
    metrics,
    logger: silentLogger,
  });
  const sourceError = new Error("simulated source outage");
  const getValue = dialcache.cached(
    async () => {
      counters.sourceCalls += 1;
      throw sourceError;
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkStaleOutage",
      cacheKey: () => "outage",
      defaultConfig: staleConfig(CacheLayer, DialCacheKeyConfig, freshTtlSec, staleMaxAgeSec),
    },
  );

  let bodyBytes = 0;
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const recovered = await dialcache.enable(async () => await getValue());
    assert.equal(recovered.kind, payload.kind);
    bodyBytes += recovered.body.length;
  }
  const elapsedMs = performance.now() - start;
  assert.equal(counters.sourceCalls, iterations, "each sequential logical miss should call the failing source once");
  assert.equal(counters.reads, iterations * 2, "each recovery should perform one fresh read and one stale reread");
  assert.equal(counters.staleServed, iterations, "every simulated outage should serve the retained value");
  assert.equal(bodyBytes, payload.body.length * iterations, "all recovered response bodies should be intact");

  return {
    operations: iterations,
    elapsedMs: round(elapsedMs, 3),
    operationsPerSecond: round((iterations / elapsedMs) * 1_000, 1),
    sourceRejections: counters.sourceCalls,
    redisReads: counters.reads,
    staleResponsesServed: counters.staleServed,
    redisPayloadResponseBytesPerOperation: payloadBytes,
    redisPayloadResponseBytesTotal: payloadBytes * iterations,
    responseByteNote: "Payload bytes exclude RESP framing and the logical-miss null reply.",
  };
}

async function benchmarkCoalescedRecovery({
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  adapter,
  fanout,
  namespace,
  payload,
  freshTtlSec,
  staleMaxAgeSec,
}) {
  const sourceGate = deferred();
  const sourceStarted = deferred();
  const counters = { reads: 0, sourceCalls: 0, staleServed: 0, processFollowers: 0 };
  const client = countingClient(adapter, counters);
  const metrics = recordingMetrics({
    coalesced({ scope }) {
      if (scope === "process") {
        counters.processFollowers += 1;
      }
    },
    staleRecovery({ outcome }) {
      if (outcome === "served") {
        counters.staleServed += 1;
      }
    },
  });
  const dialcache = new DialCache({
    namespace,
    redis: { client, readTimeoutMs: 5_000 },
    metrics,
    logger: silentLogger,
  });
  const sourceError = new Error("simulated coalesced source outage");
  const getValue = dialcache.cached(
    async () => {
      counters.sourceCalls += 1;
      sourceStarted.resolve();
      await sourceGate.promise;
      throw sourceError;
    },
    {
      keyType: "benchmark_id",
      useCase: "BenchmarkStaleCoalescing",
      cacheKey: () => "coalesced",
      defaultConfig: staleConfig(CacheLayer, DialCacheKeyConfig, freshTtlSec, staleMaxAgeSec),
    },
  );

  const start = performance.now();
  const calls = Array.from(
    { length: fanout },
    () => dialcache.enable(async () => await getValue()),
  );
  await withSafetyTimeout(sourceStarted.promise, 5_000, "coalesced source start");
  let activeState = dialcache.getCoalescingState().process;
  for (let turn = 0; turn < 20 && activeState.activeFollowers < fanout - 1; turn += 1) {
    await nextTurn();
    activeState = dialcache.getCoalescingState().process;
  }
  sourceGate.resolve();
  const values = await Promise.all(calls);
  const elapsedMs = performance.now() - start;

  assert.equal(activeState.activeLeaders, 1, "the fanout should have one process leader while the source is pending");
  assert.equal(activeState.activeFollowers, fanout - 1, "all remaining callers should be process followers");
  assert.equal(counters.processFollowers, fanout - 1, "coalescing telemetry should count every follower");
  assert.equal(counters.sourceCalls, 1, "coalescing should invoke the failing source once");
  assert.equal(counters.reads, 2, "the leader should perform one fresh read and one stale reread");
  assert.equal(counters.staleServed, 1, "the leader should record one stale recovery");
  assert.equal(values.length, fanout);
  assert.ok(values.every((value) => value.kind === payload.kind && value.body.length === payload.body.length));
  assert.deepEqual(dialcache.getCoalescingState().process, {
    activeLeaders: 0,
    activeFollowers: 0,
    oldestLeaderAgeMs: null,
  });

  return {
    callers: fanout,
    elapsedMs: round(elapsedMs, 3),
    callersPerSecond: round((fanout / elapsedMs) * 1_000, 1),
    activeLeadersAtSource: activeState.activeLeaders,
    activeFollowersAtSource: activeState.activeFollowers,
    processFollowerMetrics: counters.processFollowers,
    sourceRejections: counters.sourceCalls,
    redisReads: counters.reads,
    staleRecoveryMetrics: counters.staleServed,
  };
}

async function inspectTrackedResidency({ admin, adapter, key, value, physicalTtlMs }) {
  assert.equal(
    await adapter.write({
      valueKey: key.valueKey,
      watermarkKey: key.watermarkKey,
      cacheTtlMs: physicalTtlMs,
      value,
    }),
    true,
    "tracked residency fixture should be written",
  );
  const valueTtlMs = await admin.pTTL(key.valueKey);
  const watermarkTtlMs = await admin.pTTL(key.watermarkKey);
  assert.ok(valueTtlMs > 0, "tracked value should have a positive TTL");
  assert.ok(watermarkTtlMs > valueTtlMs, "tracked watermark should outlive its value");
  const valueMemoryBytes = await requiredMemoryUsage(admin, key.valueKey, "tracked value");
  const watermarkMemoryBytes = await requiredMemoryUsage(admin, key.watermarkKey, "tracked watermark");

  await adapter.invalidate({ watermarkKey: key.watermarkKey, futureBufferMs: 0 });
  assert.equal(
    await adapter.read({ valueKey: key.valueKey, watermarkKey: key.watermarkKey, maxAgeMs: physicalTtlMs }),
    null,
    "the resident tracked watermark should fence the older value",
  );
  const watermarkTtlAfterInvalidationMs = await admin.pTTL(key.watermarkKey);
  assert.ok(watermarkTtlAfterInvalidationMs > 0, "invalidation should retain a positive watermark TTL");

  return {
    valueTtlMs,
    watermarkTtlMs,
    watermarkRetentionLeadMs: watermarkTtlMs - valueTtlMs,
    watermarkTtlAfterInvalidationMs,
    valueMemoryBytes,
    watermarkMemoryBytes,
    invalidatedTrackedRead: "miss",
  };
}

async function inspectExpiration({ admin, adapter, key, value }) {
  const physicalTtlMs = 1_000;
  const startedAt = performance.now();
  assert.equal(
    await adapter.write({
      valueKey: key.valueKey,
      watermarkKey: key.watermarkKey,
      cacheTtlMs: physicalTtlMs,
      value,
    }),
    true,
    "expiration fixture should be written",
  );
  const valueInitialTtlMs = await admin.pTTL(key.valueKey);
  const watermarkInitialTtlMs = await admin.pTTL(key.watermarkKey);
  await waitFor(
    async () => (await admin.exists(key.valueKey)) === 0,
    5_000,
    "tracked value physical expiration",
  );
  const expirationWaitMs = performance.now() - startedAt;
  const watermarkResidentAfterValueExpiry = (await admin.exists(key.watermarkKey)) === 1;
  const watermarkTtlAfterValueExpiryMs = await admin.pTTL(key.watermarkKey);
  assert.equal(watermarkResidentAfterValueExpiry, true, "watermark should remain after its tracked value expires");
  assert.ok(watermarkTtlAfterValueExpiryMs > 0, "remaining watermark should still have a positive TTL");
  assert.equal(
    await adapter.read({ valueKey: key.valueKey, watermarkKey: key.watermarkKey, maxAgeMs: physicalTtlMs }),
    null,
    "an expired tracked value should read as a miss",
  );

  return {
    configuredValueTtlMs: physicalTtlMs,
    valueInitialTtlMs,
    watermarkInitialTtlMs,
    expirationWaitMs: round(expirationWaitMs, 3),
    valueExpired: true,
    watermarkResidentAfterValueExpiry,
    watermarkTtlAfterValueExpiryMs,
    watermarkMemoryBytesAfterValueExpiry: await requiredMemoryUsage(
      admin,
      key.watermarkKey,
      "expiration watermark",
    ),
  };
}

async function writeLogicallyStaleFixture({
  admin,
  adapter,
  commandOptions,
  key,
  value,
  physicalTtlMs,
  staleAgeMs,
  freshMaxAgeMs,
}) {
  assert.equal(
    await adapter.write({ valueKey: key.valueKey, cacheTtlMs: physicalTtlMs, value }),
    true,
    "logical-stale fixture should be written",
  );
  await markFrameStale({ admin, commandOptions, valueKey: key.valueKey, ageMs: staleAgeMs });
  assert.equal(
    await adapter.read({ valueKey: key.valueKey, maxAgeMs: freshMaxAgeMs }),
    null,
    "logical-stale fixture should miss at the fresh age",
  );
  assert.equal(
    await adapter.read({ valueKey: key.valueKey, maxAgeMs: physicalTtlMs }),
    value,
    "logical-stale fixture should hit at the maximum age",
  );
}

async function markFrameStale({ admin, commandOptions, valueKey, ageMs }) {
  const frame = await admin.get(commandOptions({ returnBuffers: true }), valueKey);
  assert.ok(Buffer.isBuffer(frame) && frame.length >= 10, "fixture should contain a DialCache frame");
  const remainingTtlMs = await admin.pTTL(valueKey);
  assert.ok(remainingTtlMs > 0, "fixture should have positive physical retention");
  const serverNowMs = (await admin.time()).getTime();
  const staleFrame = Buffer.from(frame);
  staleFrame.writeBigUInt64BE(BigInt(serverNowMs - ageMs), 1);
  await admin.set(valueKey, staleFrame, { PX: remainingTtlMs });
}

async function readScriptCommandStats(admin) {
  const parsed = parseCommandStats(await admin.info("commandstats"));
  return Object.fromEntries(
    Object.entries(parsed).filter(([command]) => /^(eval|eval_ro|evalsha|evalsha_ro)$/.test(command)),
  );
}

function subtractCommandStats(before, after) {
  const commands = new Set([...Object.keys(before), ...Object.keys(after)]);
  const byCommand = {};
  let calls = 0;
  let usec = 0;
  for (const command of [...commands].sort()) {
    const commandCalls = (after[command]?.calls ?? 0) - (before[command]?.calls ?? 0);
    const commandUsec = (after[command]?.usec ?? 0) - (before[command]?.usec ?? 0);
    if (commandCalls !== 0 || commandUsec !== 0) {
      byCommand[command] = { calls: commandCalls, usec: commandUsec };
      calls += commandCalls;
      usec += commandUsec;
    }
  }
  return { calls, usec, byCommand };
}

function parseCommandStats(info) {
  const result = {};
  for (const line of info.split(/\r?\n/)) {
    if (!line.startsWith("cmdstat_")) {
      continue;
    }
    const colon = line.indexOf(":");
    const command = line.slice("cmdstat_".length, colon);
    const fields = Object.fromEntries(
      line.slice(colon + 1).split(",").map((field) => {
        const equals = field.indexOf("=");
        return [field.slice(0, equals), Number(field.slice(equals + 1))];
      }),
    );
    result[command] = {
      calls: Number.isFinite(fields.calls) ? fields.calls : 0,
      usec: Number.isFinite(fields.usec) ? fields.usec : 0,
    };
  }
  return result;
}

async function readServerReport(admin, url) {
  const serverInfo = parseInfo(await admin.info("server"));
  const memoryInfo = parseInfo(await admin.info("memory"));
  return {
    endpoint: safeEndpoint(url),
    engine: serverInfo.server_name ?? (serverInfo.redis_version === undefined ? "unknown" : "Redis-compatible"),
    version: serverInfo.valkey_version ?? serverInfo.redis_version ?? "unknown",
    mode: serverInfo.redis_mode ?? "unknown",
    maxmemoryBytes: readInfoNumber(memoryInfo, "maxmemory"),
    maxmemoryHuman: memoryInfo.maxmemory_human ?? "unknown",
    maxmemoryPolicy: memoryInfo.maxmemory_policy ?? "unknown",
  };
}

async function readEvictedKeys(admin) {
  return readInfoNumber(parseInfo(await admin.info("stats")), "evicted_keys");
}

async function readNetworkBytes(admin) {
  const stats = parseInfo(await admin.info("stats"));
  return {
    inputBytes: readInfoNumber(stats, "total_net_input_bytes"),
    outputBytes: readInfoNumber(stats, "total_net_output_bytes"),
  };
}

function networkByteDelta(before, after, operations) {
  const inputBytes = after.inputBytes - before.inputBytes;
  const outputBytes = after.outputBytes - before.outputBytes;
  assert.ok(inputBytes >= 0 && outputBytes >= 0, "Redis network byte counters must be monotonic");
  return {
    inputBytes,
    outputBytes,
    inputBytesPerOperation: round(inputBytes / operations, 2),
    outputBytesPerOperation: round(outputBytes / operations, 2),
    measurementNote:
      "INFO total_net_* deltas include RESP framing and benchmark commands on this endpoint; use an isolated server to exclude unrelated traffic.",
  };
}

function parseInfo(info) {
  const result = {};
  for (const line of info.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      result[line.slice(0, colon)] = line.slice(colon + 1);
    }
  }
  return result;
}

function readInfoNumber(info, key) {
  const value = Number(info[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`Redis INFO did not include a finite ${key}`);
  }
  return value;
}

async function applyEvictionPressure({
  admin,
  adapter,
  namespace,
  ownedKeys,
  server,
  keyCount,
  valueBytes,
  recoveryValueKey,
  recoveryMaxAgeMs,
}) {
  if (keyCount === 0) {
    return {
      attempted: false,
      keyCount: 0,
      valueBytes,
      staleRecoveryAfterPressure: "not_measured",
      note: "Set DIALCACHE_BENCH_EVICTION_KEYS on a dedicated maxmemory endpoint to exercise eviction.",
    };
  }
  if (server.maxmemoryBytes <= 0 || server.maxmemoryPolicy === "noeviction") {
    throw new Error(
      "DIALCACHE_BENCH_EVICTION_KEYS requires a dedicated endpoint with maxmemory and an eviction policy",
    );
  }

  const value = Buffer.alloc(valueBytes, 0x78);
  for (let index = 0; index < keyCount; index += 1) {
    const key = `${namespace}:eviction-pressure:${index}`;
    ownedKeys.add(key);
    await admin.set(key, value, { PX: 300_000 });
  }
  const recovery = await adapter.read({ valueKey: recoveryValueKey, maxAgeMs: recoveryMaxAgeMs });
  return {
    attempted: true,
    keyCount,
    valueBytes,
    requestedValueBytes: keyCount * valueBytes,
    staleRecoveryAfterPressure: recovery === null ? "miss" : "served",
    note: "Pressure uses only random benchmark-owned keys and never changes Redis CONFIG.",
  };
}

function evictionReport({
  server,
  evictedKeysBefore,
  evictedKeysBeforePressure,
  evictedKeysAfter,
  residency,
  pressure,
}) {
  const evictedKeysTotalDelta = evictedKeysAfter - evictedKeysBefore;
  const evictedKeysPressureDelta = evictedKeysAfter - evictedKeysBeforePressure;
  if (pressure.attempted) {
    assert.ok(
      evictedKeysPressureDelta > 0,
      "requested eviction pressure did not increase evicted_keys; increase DIALCACHE_BENCH_EVICTION_KEYS",
    );
  }
  const allSentinelsResident = Object.values(residency).every(Boolean);
  const evictionConfigured = server.maxmemoryBytes > 0 && server.maxmemoryPolicy !== "noeviction";
  let assessment;
  if (!allSentinelsResident) {
    assessment =
      "At least one benchmark sentinel disappeared. Missing values remove stale recovery capacity; missing watermarks force tracked reads to miss.";
  } else if (evictionConfigured) {
    assessment =
      "Eviction is configured, but all benchmark sentinels remained resident. DialCache does not pin values or watermarks; either can be evicted under the configured policy.";
  } else {
    assessment =
      "Redis eviction is not currently configured. DialCache still does not pin values or watermarks, and external deletion remains observable as a cache miss.";
  }
  return {
    configured: evictionConfigured,
    maxmemoryBytes: server.maxmemoryBytes,
    maxmemoryPolicy: server.maxmemoryPolicy,
    evictedKeysBefore,
    evictedKeysBeforePressure,
    evictedKeysAfter,
    evictedKeysTotalDelta,
    evictedKeysPressureDelta,
    pressure,
    benchmarkSentinelResidency: residency,
    allSentinelsResident,
    assessment,
    attributionNote:
      "The pressure delta is sampled immediately around owned pressure writes; global counters can still include concurrent shared-server traffic.",
  };
}

function redisKeys({
  DialCacheKey,
  invalidationPrefix,
  redisClusterHashTag,
  namespace,
  keyType,
  id,
  useCase,
  tracked,
}) {
  const key = new DialCacheKey({ namespace, keyType, id, useCase, trackForInvalidation: tracked });
  return {
    valueKey: `${key.urn}:dialcache-frame-v1`,
    ...(tracked
      ? { watermarkKey: `${redisClusterHashTag(invalidationPrefix(namespace, keyType, id))}#watermark` }
      : {}),
  };
}

function own(ownedKeys, key) {
  ownedKeys.add(key.valueKey);
  if (key.watermarkKey !== undefined) {
    ownedKeys.add(key.watermarkKey);
  }
}

function countingClient(adapter, counters) {
  return {
    enforcesMaxAge: true,
    async read(request, context) {
      counters.reads += 1;
      return await adapter.read(request, context);
    },
    async write(request) {
      return await adapter.write(request);
    },
    async invalidate(request) {
      return await adapter.invalidate(request);
    },
  };
}

function staleConfig(CacheLayer, DialCacheKeyConfig, freshTtlSec, staleMaxAgeSec) {
  return new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: freshTtlSec },
    ramp: { [CacheLayer.REMOTE]: 100 },
    staleOnErrorMaxAgeSec: staleMaxAgeSec,
  });
}

function recordingMetrics(overrides = {}) {
  return {
    request() {},
    miss() {},
    disabled() {},
    error() {},
    invalidation() {},
    coalesced() {},
    shadowValidation() {},
    staleRecovery() {},
    observeGet() {},
    observeFallback() {},
    observeSerialization() {},
    observeSize() {},
    ...overrides,
  };
}

const silentLogger = {
  debug() {},
  error() {},
  warn() {},
};

function makeJsonPayload(targetBytes) {
  const emptyValue = { kind: "dialcache-stale-benchmark", body: "" };
  const overheadBytes = Buffer.byteLength(JSON.stringify(emptyValue));
  const value = {
    ...emptyValue,
    body: "x".repeat(Math.max(0, targetBytes - overheadBytes)),
  };
  return { value, encoded: JSON.stringify(value) };
}

async function requiredMemoryUsage(admin, key, label) {
  const bytes = await admin.memoryUsage(key);
  assert.equal(typeof bytes, "number", `${label} should be resident for MEMORY USAGE`);
  return bytes;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function withSafetyTimeout(promise, timeoutMs, label) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = globalThis.setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    globalThis.clearTimeout(timeout);
  }
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
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function readNonnegativeInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function safeEndpoint(url) {
  try {
    const parsed = new URL(url);
    const port = parsed.port.length > 0 ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${parsed.hostname}${port}`;
  } catch {
    return "<invalid Redis URL>";
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function printReport(report) {
  console.log("\nStale-on-error Redis CPU and throughput");
  console.table([
    {
      scenario: "fresh Redis hit",
      operations: report.redisCpu.freshHit.operations,
      "elapsed ms": report.redisCpu.freshHit.elapsedMs,
      "ops/sec": report.redisCpu.freshHit.operationsPerSecond,
      "Redis usec": report.redisCpu.freshHit.redisUsec,
      "Redis usec/op": report.redisCpu.freshHit.redisUsecPerOperation,
      "payload bytes/op": report.settings.actualJsonPayloadBytes,
    },
    {
      scenario: "logical-stale Redis miss",
      operations: report.redisCpu.logicalStaleMiss.operations,
      "elapsed ms": report.redisCpu.logicalStaleMiss.elapsedMs,
      "ops/sec": report.redisCpu.logicalStaleMiss.operationsPerSecond,
      "Redis usec": report.redisCpu.logicalStaleMiss.redisUsec,
      "Redis usec/op": report.redisCpu.logicalStaleMiss.redisUsecPerOperation,
      "payload bytes/op": 0,
    },
    {
      scenario: "SoT outage stale recovery",
      operations: report.outageRecovery.operations,
      "elapsed ms": report.outageRecovery.elapsedMs,
      "ops/sec": report.outageRecovery.operationsPerSecond,
      "Redis usec": "not isolated",
      "Redis usec/op": "not isolated",
      "payload bytes/op": report.outageRecovery.redisPayloadResponseBytesPerOperation,
      "wire input bytes/op": report.outageRecovery.redisNetwork.inputBytesPerOperation,
      "wire output bytes/op": report.outageRecovery.redisNetwork.outputBytesPerOperation,
    },
  ]);

  console.log("\nMemory, retention, and eviction");
  console.table([
    { item: "logical-stale value", bytes: report.memoryUsage.logicalStaleValueBytes },
    { item: "outage value", bytes: report.memoryUsage.outageValueBytes },
    { item: "tracked value", bytes: report.memoryUsage.trackedValueBytes },
    { item: "tracked watermark", bytes: report.memoryUsage.trackedWatermarkBytes },
    {
      item: "watermark after value expiry",
      bytes: report.memoryUsage.expirationWatermarkBytesAfterValueExpiry,
    },
  ]);
  console.log(
    `Coalesced fanout: ${report.coalescing.callers} callers, ${report.coalescing.sourceRejections} source rejection, ${report.coalescing.redisReads} Redis reads, ${report.coalescing.staleRecoveryMetrics} stale-recovery metric.`,
  );
  console.log(
    `Tracked expiration: value expired=${report.expiration.valueExpired}; watermark remained=${report.expiration.watermarkResidentAfterValueExpiry}; remaining watermark PTTL=${report.expiration.watermarkTtlAfterValueExpiryMs}ms.`,
  );
  console.log(`Eviction: ${report.eviction.assessment}`);
  if (report.eviction.pressure.attempted) {
    console.log(
      `Eviction pressure: ${report.eviction.pressure.keyCount} owned keys; evicted_keys +${report.eviction.evictedKeysPressureDelta}; stale recovery after pressure=${report.eviction.pressure.staleRecoveryAfterPressure}.`,
    );
  }
  console.log("Semantic assertions passed; measurements are informational and have no pass/fail timing threshold.");
  console.log("\nJSON report (pasteable):");
  console.log(JSON.stringify(report, null, 2));
}

const redisUrl = process.env.DIALCACHE_BENCH_REDIS_URL;

if (redisUrl === undefined || redisUrl.length === 0) {
  const skipped = {
    status: "skipped",
    reason: "DIALCACHE_BENCH_REDIS_URL is not set",
    example: "DIALCACHE_BENCH_REDIS_URL=redis://127.0.0.1:6379 corepack pnpm benchmark:stale-on-error",
  };
  console.log("Stale-on-error Redis benchmark skipped: set DIALCACHE_BENCH_REDIS_URL to a dedicated Redis or Valkey endpoint.");
  console.log(JSON.stringify(skipped, null, 2));
} else {
  const benchmarkTimeoutMs = readPositiveInteger("DIALCACHE_BENCH_TIMEOUT_MS", 120_000);
  const watchdog = globalThis.setTimeout(() => {
    console.error(`Stale-on-error Redis benchmark exceeded its ${benchmarkTimeoutMs}ms watchdog.`);
    process.exit(1);
  }, benchmarkTimeoutMs);
  watchdog.unref?.();
  try {
    const report = await runBenchmark(redisUrl);
    printReport(report);
  } catch (error) {
    console.error("Stale-on-error Redis benchmark failed.");
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  } finally {
    globalThis.clearTimeout(watchdog);
  }
}

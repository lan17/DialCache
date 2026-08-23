// Maintainer benchmark for the Redis write path. Measures the local build's
// tracked and untracked writes against a live Redis and reports server-side
// command cost per write (INFO commandstats; the EVALSHA entry envelopes
// script-internal calls) alongside client-side latency percentiles. It asserts
// the steady-state top-level SET/script shape and that no write invokes TIME,
// but applies no timing thresholds: absolute numbers are machine-, engine-,
// and load-dependent, so compare runs only against the same idle Redis.
//
// Requires a reachable Redis, e.g.: docker run --rm -p 6379:6379 redis:6.2
// Usage: pnpm benchmark:redis-write            (REDIS_URL to override)
// DIALCACHE_BENCH_WRITE_SCALE scales iteration counts (default 1).
import assert from "node:assert/strict";

import { createClient } from "redis";

import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "../dist/node-redis.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const SCALE = Number(process.env.DIALCACHE_BENCH_WRITE_SCALE ?? "1");
const SIZES = [
  { name: "100 B", bytes: 100, n: 4_000 },
  { name: "10 KiB", bytes: 10 * 1024, n: 2_000 },
  { name: "100 KiB", bytes: 100 * 1024, n: 600 },
  { name: "1 MiB", bytes: 1024 * 1024, n: 150 },
];
const WARMUP = 30;

function percentile(sortedAscending, p) {
  const index = Math.min(sortedAscending.length - 1, Math.floor((p / 100) * sortedAscending.length));
  return sortedAscending[index];
}

async function commandStats(client) {
  const raw = await client.sendCommand(["INFO", "commandstats"]);
  const stats = {};
  for (const line of String(raw).split("\n")) {
    const match = /^cmdstat_([a-z|]+):calls=(\d+),usec=(\d+)/.exec(line.trim());
    if (match !== null) {
      stats[match[1]] = { calls: Number(match[2]), usec: Number(match[3]) };
    }
  }
  return stats;
}

const client = createClient({
  url: REDIS_URL,
  scripts: dialcacheRedisScripts,
  disableOfflineQueue: true,
  socket: { connectTimeout: 2_000 },
});
client.on("error", () => undefined);
try {
  await client.connect();
} catch (error) {
  console.error(`Could not reach Redis at ${REDIS_URL}; start one first, e.g. docker run --rm -p 6379:6379 redis:6.2`);
  throw error;
}
const adapter = createNodeRedisDialCacheClient(client);

const rows = [];
for (const mode of ["tracked", "untracked"]) {
  for (const size of SIZES) {
    const iterations = Math.max(1, Math.round(size.n * SCALE));
    const payload = "x".repeat(size.bytes);
    const valueKey = `benchmark:write:${mode}:${size.bytes}:value`;
    const watermarkKey = `benchmark:write:${mode}:${size.bytes}:watermark`;
    const request = mode === "tracked"
      ? { valueKey, watermarkKey, cacheTtlMs: 60_000, value: payload }
      : { valueKey, cacheTtlMs: 60_000, value: payload };

    for (let i = 0; i < WARMUP; i += 1) {
      await adapter.write(request);
    }
    await client.sendCommand(["CONFIG", "RESETSTAT"]);

    const latenciesUsec = [];
    for (let i = 0; i < iterations; i += 1) {
      const start = process.hrtime.bigint();
      await adapter.write(request);
      latenciesUsec.push(Number(process.hrtime.bigint() - start) / 1_000);
    }

    // Sum only the commands the client dispatches top-level (SET, EVALSHA,
    // and the EVAL recovery). Script-internal calls surface in commandstats
    // too, but the EVALSHA entry already envelopes their execution time.
    const stats = await commandStats(client);
    const setCalls = stats.set?.calls ?? 0;
    const scriptCalls = (stats.evalsha?.calls ?? 0) + (stats.eval?.calls ?? 0);
    const timeCalls = stats.time?.calls ?? 0;
    assert.equal(setCalls, iterations, `${mode} writes must issue one top-level SET each`);
    assert.equal(
      scriptCalls,
      mode === "tracked" ? iterations : 0,
      `${mode} writes dispatched an unexpected number of stamp scripts`,
    );
    assert.equal(timeCalls, 0, `${mode} writes must not invoke Redis TIME`);
    const serverUsec = (stats.set?.usec ?? 0)
      + (stats.evalsha?.usec ?? 0)
      + (stats.eval?.usec ?? 0);
    latenciesUsec.sort((a, b) => a - b);
    rows.push({
      mode,
      size: size.name,
      writes: iterations,
      setCallsPerWrite: setCalls / iterations,
      scriptCallsPerWrite: scriptCalls / iterations,
      timeCallsPerWrite: timeCalls / iterations,
      serverUsecPerWrite: serverUsec / iterations,
      clientP50Usec: percentile(latenciesUsec, 50),
      clientP95Usec: percentile(latenciesUsec, 95),
    });
  }
}
await client.quit();

console.log(`Redis write benchmark — ${REDIS_URL}`);
console.log("mode       size      writes   SET/op   script/op   TIME/op   server µs/write   client p50 µs   client p95 µs");
for (const row of rows) {
  console.log(
    row.mode.padEnd(10)
    + row.size.padEnd(10)
    + String(row.writes).padEnd(9)
    + row.setCallsPerWrite.toFixed(1).padEnd(9)
    + row.scriptCallsPerWrite.toFixed(1).padEnd(12)
    + row.timeCallsPerWrite.toFixed(1).padEnd(10)
    + row.serverUsecPerWrite.toFixed(1).padEnd(18)
    + row.clientP50Usec.toFixed(0).padEnd(16)
    + row.clientP95Usec.toFixed(0),
  );
}
console.log("Command-shape assertions passed; elapsed times are informational and have no pass/fail threshold.");

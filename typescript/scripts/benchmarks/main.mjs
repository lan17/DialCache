import assert from "node:assert/strict";

import { coreKinds, runCore } from "./core.mjs";
import { redisKinds, runRedis } from "./redis.mjs";

try {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  validateRequest(request);
  const measured = await (request.case.suite === "redis" ? runRedis(request) : runCore(request));
  process.stdout.write(`${JSON.stringify({
    version: 1, id: request.id, port: "typescript", caseId: request.case.id,
    ...measured, runtime: { version: process.version, workers: 1 },
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}

function validateRequest(request) {
  assert.equal(request?.version, 1, "unsupported benchmark protocol version");
  assert.ok(typeof request.id === "string" && request.id.length > 0, "request id is required");
  const workload = request.case;
  assert.ok(workload && typeof workload === "object" && !Array.isArray(workload), "case is required");
  assert.ok(typeof workload.id === "string" && workload.id.length > 0, "case id is required");
  assert.ok(coreKinds.has(workload.kind) || redisKinds.has(workload.kind), "unknown case kind");
  assert.equal(workload.suite, redisKinds.has(workload.kind) ? "redis" : "core", "case suite does not match its kind");
  const scopes = {
    "source-baseline": "none", disabled: "none", "redis-write": "none",
    "enabled-uncached": "single", "request-local-hit": "single",
    "process-local-hit": "per-operation", "local-eviction": "per-operation",
    "process-coalescing": "per-operation", "redis-hit": "per-operation",
    "redis-tracked-hit": "per-operation", "request-coalescing": "per-burst",
  };
  assert.equal(workload.scope, scopes[workload.kind], "case scope does not match its kind");
  for (const field of ["iterations", "fanout", "capacity", "payloadBytes"]) {
    assert.ok(Number.isSafeInteger(workload[field]) && workload[field] > 0, `${field} must be a positive safe integer`);
  }
  assert.ok(Number.isSafeInteger(workload.warmup) && workload.warmup >= 0, "warmup must be a nonnegative safe integer");
  const coalescing = workload.kind.endsWith("-coalescing");
  assert.ok(coalescing ? workload.fanout >= 2 : workload.fanout === 1, "coalescing needs at least two callers; other cases need fanout 1");
  assert.ok(Number.isSafeInteger(workload.iterations * workload.fanout * workload.payloadBytes), "benchmark checksum would exceed the safe integer range");
  assert.equal(request.payload, "x".repeat(workload.payloadBytes), "payload must contain exactly payloadBytes ASCII x bytes");
  if (workload.suite === "redis") {
    assert.ok(typeof request.redisUrl === "string" && new URL(request.redisUrl).protocol === "redis:", "redis case requires a Redis URL");
  } else assert.equal(request.redisUrl, null, "core case must not use Redis");
}

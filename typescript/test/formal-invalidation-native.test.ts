import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGeneratedInvalidationVectors } from "../../formal/generate-invalidation-vectors.mjs";
import { invalidationClient, recordInvalidation } from "./invalidation-native-driver.js";
import { validVectorResult } from "../../formal/vector-evidence.mjs";

// Mutation runners provision a private real server. Ordinary unit runs leave
// this lane disabled; make integration has its own vector replay. Mutation
// cohorts require the server endpoint and reject skipped selection.
describe.runIf(process.env.DIALCACHE_VECTOR_REDIS_URL !== undefined)("generated invalidation vectors", () => {
  const vectors = readGeneratedInvalidationVectors().vectors;
  let client: ReturnType<typeof invalidationClient>;
  const key = `{formal-invalidation-${randomUUID()}}#watermark`;
  beforeAll(async () => {
    client = invalidationClient();
    client.on("error", () => {});
    await client.connect();
  });
  afterAll(async () => { if (client?.isOpen) { await client.del(key); await client.quit(); } });
  for (const row of vectors) it(row.name, async () => {
    let actual;
    try {
      actual = await recordInvalidation(client, key, { existing: row.existing, futureBufferMs: row.futureBufferMs, invalidatedAtMs: row.invalidatedAtMs });
      if (!validVectorResult("invalidation", actual)) throw new Error("Malformed native invalidation result");
    } catch (error) { throw new Error(`INVALIDATION_INFRASTRUCTURE: ${String(error)}`); }
    const expected = row.expected.state;
    expect({ outcome: actual.outcome, kind: actual.kind, content: actual.content }).toEqual({
      outcome: row.expected.error ? "rejected" : "success", kind: expected.kind,
      content: expected.kind === "string" ? expected.value : expected.kind === "list" ? expected.values : [],
    });
    if (expected.ttlMs < 0) expect(actual.ttlMs).toBe(expected.ttlMs);
    else {
      expect(actual.ttlMs).toBeGreaterThanOrEqual(Math.max(0, expected.ttlMs - actual.elapsedMs));
      expect(actual.ttlMs).toBeLessThanOrEqual(expected.ttlMs);
    }
  });
});

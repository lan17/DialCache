// Executed by the Go and Rust integration tests after bundling production TS
// imports. Inputs are operations and serialized values, never expected state.
import { readFileSync } from "node:fs";
import { createClient, createCluster } from "redis";
import { createNodeRedisDialCacheClient } from "../../../typescript/src/node-redis.js";
import { DialCacheKey, normalizeArgs } from "../../../typescript/src/key.js";
import { JsonSerializer } from "../../../typescript/src/serializer.js";
import { compressPayload, decompressPayload, escapeRawPayload } from "../../../typescript/src/internal/compression.js";
import { isRedisReadMiss } from "../../../typescript/src/redis-client.js";

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const client = input.cluster
    ? createCluster({ rootNodes: [{ url: `redis://${input.endpoint}` }], nodeAddressMap: input.mapping,
      useReplicas: true, defaults: { socket: { connectTimeout: 5000, reconnectStrategy: false }, disableOfflineQueue: true } })
    : createClient({ url: `redis://${input.endpoint}`, socket: { connectTimeout: 5000, reconnectStrategy: false }, disableOfflineQueue: true });
  client.on("error", () => undefined);
  await client.connect();
  const adapter = createNodeRedisDialCacheClient(client);
  const codec = new JsonSerializer();
  const results = [];
  try {
    for (const action of input.actions) {
      // Derive keys independently in TypeScript when the caller supplies a
      // logical identity. Numeric bits avoid JSON decimal formatting becoming
      // an accidental shared oracle for Number::toString regressions.
      const identity = action.identity;
      const args = { ...identity?.args };
      for (const [name, bits] of Object.entries(identity?.numberBits ?? {})) {
        args[name] = Buffer.from(bits as string, "hex").readDoubleBE();
      }
      const logical = identity === undefined ? undefined : new DialCacheKey({
        ...identity, args: normalizeArgs(args),
      });
      const keys = logical === undefined ? undefined : {
        logical: logical.urn,
        value: `${logical.urn}:dialcache-frame-v1`,
        watermark: logical.trackForInvalidation ? `${logical.prefix}#watermark` : null,
      };
      const key = keys?.value ?? action.key;
      const watermark = keys?.watermark ?? action.watermark;
      if (action.op === "key") {
        if (keys === undefined) throw new Error("key operation requires an identity");
        results.push({ kind: "key", keys });
      } else if (action.op === "write") {
        const serialized = action.binaryHex === undefined
          ? await codec.dump(action.absent ? undefined : action.value)
          : Buffer.from(action.binaryHex, "hex");
        const payload = action.compress
          ? compressPayload(serialized, { thresholdBytes: 1, level: 3 }).payload
          : escapeRawPayload(serialized);
        await adapter.write({ valueKey: key, value: payload, createdAtMs: action.stamp, cacheTtlMs: 60000 });
        results.push({ kind: "written", ...(keys ? { keys } : {}) });
      } else if (action.op === "read") {
        const result = await adapter.read({ valueKey: key, ...(watermark ? { watermarkKey: watermark } : {}) });
        if (isRedisReadMiss(result)) { results.push(result); continue; }
        const { payload } = decompressPayload(result.payload);
        const value = action.binary ? undefined : await codec.load(payload);
        results.push({ kind: "hit", stamp: result.createdAtMs, ...(keys ? { keys } : {}),
          ...(action.binary ? { binaryHex: Buffer.from(payload).toString("hex") } : { value: value === undefined ? { absent: true } : value }) });
      } else if (action.op === "invalidate") {
        const realNow = Date.now;
        Date.now = () => action.stamp;
        try { await adapter.invalidate({ watermarkKey: watermark, futureBufferMs: action.futureMs }); }
        finally { Date.now = realNow; }
        results.push({ kind: "invalidated" });
      } else { throw new Error(`Unknown interop operation ${action.op}`); }
    }
  } finally { await client.quit(); }
  process.stdout.write(JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

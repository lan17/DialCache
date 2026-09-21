import { randomUUID } from "node:crypto";
import { invalidationClient, recordInvalidation, type InvalidationInput } from "./invalidation-native-driver.js";
import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { DialCacheKey } from "../src/index.js";
import { decodeTrackedRedisReadResult, isRedisReadMiss } from "../src/redis-protocol.js";
import { DialCacheRedisPayloadEncodingError } from "../src/redis-client.js";
import { compressPayload, decompressPayload } from "../src/internal/compression.js";

const requestPath = process.env.DIALCACHE_VECTOR_REQUEST;
type Request =
  | { operation: "invalidation"; input: InvalidationInput }
  | { operation: "key"; input: ConstructorParameters<typeof DialCacheKey>[0] }
  | { operation: "trackedDecode"; input: { frameHex: string | null; watermarkUtf8: string | null } }
  | { operation: "envelope"; input: { inputHex: string } }
  | { operation: "compression"; input: { payloadType: "string" | "binary"; payloadUtf8?: string; payloadHex?: string; thresholdBytes: number; maxDecompressedBytes: number } };

// This worker receives only the operation and its external inputs. Expected
// values and the generated corpus remain in the parent coordinator.
it.runIf(requestPath !== undefined)("records one native vector result", async () => {
  const out = process.env.DIALCACHE_VECTOR_OUT;
  if (!out) throw new Error("DIALCACHE_VECTOR_OUT is required");
  const request = JSON.parse(readFileSync(requestPath!, "utf8")) as Request;
  if (Object.keys(request).sort().join() !== "input,operation") throw new Error("Invalid vector request");
  let actual: unknown;
  switch (request.operation) {
    case "invalidation": {
      const client = invalidationClient();
      client.on("error", () => {});
      const key = `{formal-boundary-${randomUUID()}}#watermark`;
      try { await client.connect(); actual = await recordInvalidation(client, key, request.input); }
      finally { if (client.isOpen) { await client.del(key); await client.quit(); } }
      break;
    }
    case "key": {
      try {
        const key = new DialCacheKey(request.input);
        actual = { kind: "key", logicalKey: key.urn, valueKey: `${key.urn}:dialcache-frame-v1`,
          watermarkKey: key.trackForInvalidation ? `${key.prefix}#watermark` : null };
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Redis Cluster hash tag components must not contain braces:")) throw error;
        actual = { kind: "key_error" };
      }
      break;
    }
    case "trackedDecode": {
      try {
        const { frameHex, watermarkUtf8 } = request.input;
        const result = decodeTrackedRedisReadResult(frameHex === null ? null : Buffer.from(frameHex, "hex"),
          watermarkUtf8 === null ? null : Buffer.from(watermarkUtf8));
        actual = isRedisReadMiss(result) ? result : { kind: "hit", createdAtMs: result.createdAtMs,
          ...(typeof result.payload === "string" ? { payloadType: "string", payloadUtf8: result.payload }
            : { payloadType: "binary", payloadHex: result.payload.toString("hex") }) };
      } catch (error) {
        if (!(error instanceof DialCacheRedisPayloadEncodingError)) throw error;
        actual = { kind: "payload_encoding_error" };
      }
      break;
    }
    case "envelope": {
      const result = decompressPayload(Buffer.from(request.input.inputHex, "hex"));
      actual = { decodedHex: Buffer.from(result.payload).toString("hex"), outcome: result.outcome };
      break;
    }
    case "compression": {
      const input = request.input;
      const raw = input.payloadType === "binary" ? Buffer.from(input.payloadHex!, "hex") : input.payloadUtf8!;
      const result = compressPayload(raw, { thresholdBytes: input.thresholdBytes, level: 3 }, input.maxDecompressedBytes);
      actual = { outcome: result.outcome, storedBytes: result.storedBytes,
        marker: result.outcome === "compressed" ? Buffer.from(result.payload)[0] : -1 };
      break;
    }
    default: throw new Error("Unknown vector operation");
  }
  writeFileSync(out, JSON.stringify({ actual }) + "\n");
});

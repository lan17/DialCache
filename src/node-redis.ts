import { commandOptions } from "redis";

import {
  buildRedisInvalidationScriptArguments,
  INVALIDATE_CACHE_SCRIPT,
  INVALIDATE_CACHE_SCRIPT_SHA1,
} from "./internal/redis-invalidation.js";
import {
  assertValidRedisTimestampMs,
  decodeRedisReadResult,
  decodeTrackedRedisReadResult,
  encodeRedisFrame,
} from "./internal/redis-payload.js";
import { ceilSupportedCacheTtlMs } from "./internal/duration.js";
import {
  validateRedisScriptInvalidationReply,
  validateRedisSetReply,
} from "./internal/redis-script-reply.js";
import {
  DialCacheRedisPayloadError,
  type DialCacheRedisClient,
} from "./redis-client.js";

type BufferReplyOptions = ReturnType<
  typeof commandOptions<{
    readonly returnBuffers: true;
    readonly signal?: AbortSignal;
  }>
>;
// Redis bulk strings are binary data; decoding them as UTF-8 would corrupt arbitrary serializer output.
const bufferReplyOptions: BufferReplyOptions = commandOptions({ returnBuffers: true });
type NodeRedisArgument = string | Buffer;

interface NodeRedisStandaloneClient {
  get(options: BufferReplyOptions, valueKey: string): Promise<Buffer | null>;
  sendCommand(
    args: Array<NodeRedisArgument>,
    options: BufferReplyOptions,
  ): Promise<unknown>;
}

interface NodeRedisClusterClient {
  /** Public node-redis Cluster topology view, used only to distinguish its sendCommand overload. */
  readonly masters: ReadonlyArray<unknown>;
  get(options: BufferReplyOptions, valueKey: string): Promise<Buffer | null>;
  sendCommand(
    firstKey: string,
    isReadonly: false,
    args: Array<NodeRedisArgument>,
    options: BufferReplyOptions,
  ): Promise<unknown>;
}

type NodeRedisClient = NodeRedisStandaloneClient | NodeRedisClusterClient;

function isNodeRedisClusterClient(client: NodeRedisClient): client is NodeRedisClusterClient {
  return "masters" in client && Array.isArray(client.masters);
}

function validateRedisMGetReply(reply: unknown): [unknown, unknown] {
  if (
    !Array.isArray(reply)
    || reply.length !== 2
  ) {
    throw new DialCacheRedisPayloadError(
      "Invalid DialCache Redis tracked read reply; expected an array with two entries",
    );
  }
  return [reply[0], reply[1]];
}

// Keyed commands route to the slot primary in cluster mode (isReadonly=false),
// so tracked reads observe the latest invalidation watermark even when the
// caller configured node-redis Cluster with useReplicas.
function sendKeyedCommand(
  client: NodeRedisClient,
  firstKey: string,
  args: Array<NodeRedisArgument>,
  options: BufferReplyOptions,
): Promise<unknown> {
  return isNodeRedisClusterClient(client)
    ? client.sendCommand(firstKey, false, args, options)
    : client.sendCommand(args, options);
}

async function readTracked(
  client: NodeRedisClient,
  options: BufferReplyOptions,
  valueKey: string,
  watermarkKey: string,
): Promise<[unknown, unknown]> {
  const raw = await sendKeyedCommand(client, valueKey, ["MGET", valueKey, watermarkKey], options);
  return validateRedisMGetReply(raw);
}

function sendFrameSet(
  client: NodeRedisClient,
  valueKey: string,
  frame: Buffer,
  cacheTtlMs: number,
): Promise<unknown> {
  return sendKeyedCommand(
    client,
    valueKey,
    ["SET", valueKey, frame, "PX", String(cacheTtlMs)],
    bufferReplyOptions,
  );
}

/**
 * Create a resource-free semantic view over a caller-owned node-redis client.
 * Read signals are passed to node-redis so queued commands can be removed when
 * supported. Aborting after dispatch does not unsend a command or prove the
 * server stopped executing it. Every write is one native SET of a complete
 * client-stamped frame. Invalidation retries any EVALSHA rejection once by
 * re-sending the script source as EVAL — the script is idempotent, so a
 * duplicate run is harmless — and a failed retry surfaces unmodified. An
 * accepted reply is validated after dispatch and is never retried. node-redis
 * has no per-command deadline:
 * `disableOfflineQueue`, `commandsQueueMaxLength`, and `reconnectStrategy`
 * bound queueing and dispatch, not the reply wait, so with the offline queue
 * enabled a retry issued during a disconnect can wait until reconnect. The
 * caller remains responsible for finite native command budgets, draining
 * work, and closing the client.
 */
export function createNodeRedisDialCacheClient(client: NodeRedisClient): DialCacheRedisClient {
  return {
    async read({ valueKey, watermarkKey }, context) {
      const options: BufferReplyOptions = context === undefined
        ? bufferReplyOptions
        : commandOptions({ returnBuffers: true, signal: context.signal });
      if (watermarkKey === undefined) {
        return decodeRedisReadResult(await client.get(options, valueKey));
      }
      const [rawValue, rawWatermark] = await readTracked(
        client,
        options,
        valueKey,
        watermarkKey,
      );
      return decodeTrackedRedisReadResult(rawValue, rawWatermark);
    },
    async write(request) {
      const { valueKey, value } = request;
      const cacheTtlMs = ceilSupportedCacheTtlMs(request.cacheTtlMs);
      const createdAtMs = request.createdAtMs === undefined ? Date.now() : request.createdAtMs;
      validateRedisSetReply(
        await sendFrameSet(client, valueKey, encodeRedisFrame(value, createdAtMs), cacheTtlMs),
      );
    },
    async invalidate({ watermarkKey, futureBufferMs }) {
      const invalidatedAtMs = Date.now();
      assertValidRedisTimestampMs(invalidatedAtMs);
      const invalidateArgs = buildRedisInvalidationScriptArguments(
        futureBufferMs,
        invalidatedAtMs,
      );
      let raw: unknown;
      try {
        raw = await sendKeyedCommand(
          client,
          watermarkKey,
          ["EVALSHA", INVALIDATE_CACHE_SCRIPT_SHA1, "1", watermarkKey, ...invalidateArgs],
          bufferReplyOptions,
        );
      } catch {
        // Any rejection is retried once with the source: the invalidation script is
        // idempotent (the watermark only advances and its TTL only widens),
        // so a duplicate run after an ambiguous failure is harmless, and
        // EVAL self-heals both a flushed script cache and an
        // EVALSHA-rejecting proxy without depending on error wording.
        // A failed retry surfaces unmodified, discarding this original
        // rejection: node-redis rejects every command flushed by a single
        // disconnect with one shared error instance — the same object its
        // "error" listeners and every other in-flight caller receive — so
        // the adapter never mutates a rejection it did not construct.
        raw = await sendKeyedCommand(
          client,
          watermarkKey,
          [
            "EVAL",
            INVALIDATE_CACHE_SCRIPT,
            "1",
            watermarkKey,
            ...invalidateArgs,
          ],
          bufferReplyOptions,
        );
      }
      validateRedisScriptInvalidationReply(raw);
    },
  };
}

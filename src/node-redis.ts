import { commandOptions, defineScript } from "redis";

import { INVALIDATE_CACHE_SCRIPT } from "./internal/redis-scripts.js";
import {
  assertValidRedisTimestampMs,
  decodeRedisFrame,
  decodeTrackedRedisFrame,
  encodeRedisFrame,
} from "./internal/redis-payload.js";
import { ceilSupportedCacheTtlMs } from "./internal/duration.js";
import {
  validateRedisScriptInvalidationReply,
  validateRedisSetReply,
} from "./internal/redis-script-reply.js";
import {
  DialCacheRedisPayloadError,
  DialCacheRedisProtocolError,
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
const invalidationReply = (reply: number): number => validateRedisScriptInvalidationReply(reply);
type NodeRedisArgument = string | Buffer;

interface NodeRedisScript<Args extends Array<unknown>, Reply> {
  readonly SCRIPT: string;
  readonly SHA1: string;
  readonly NUMBER_OF_KEYS: number;
  readonly FIRST_KEY_INDEX: number;
  readonly IS_READ_ONLY: boolean;
  transformArguments(...args: Args): Array<NodeRedisArgument>;
  transformReply(reply: Reply): Reply;
}

type NodeRedisScriptConfig<Args extends Array<unknown>, Reply> = Omit<NodeRedisScript<Args, Reply>, "SHA1">;

function defineDialCacheScript<Args extends Array<unknown>, Reply>(
  config: NodeRedisScriptConfig<Args, Reply>,
): NodeRedisScript<Args, Reply> {
  return defineScript(config);
}

/** DialCache's node-redis invalidation-script wiring. */
export type DialCacheNodeRedisScripts = {
  readonly dialcacheInvalidate: NodeRedisScript<
    [watermarkKey: string, futureBufferMs: number, invalidatedAtMs: number],
    number
  >;
};

/** See {@link DialCacheNodeRedisScripts}: wiring for the adapter, not a direct write API. */
export const dialcacheRedisScripts: DialCacheNodeRedisScripts = {
  dialcacheInvalidate: defineDialCacheScript({
    SCRIPT: INVALIDATE_CACHE_SCRIPT,
    NUMBER_OF_KEYS: 1,
    FIRST_KEY_INDEX: 0,
    IS_READ_ONLY: false,
    transformArguments(
      watermarkKey: string,
      futureBufferMs: number,
      invalidatedAtMs: number,
    ): Array<string> {
      return [watermarkKey, String(futureBufferMs), String(invalidatedAtMs)];
    },
    transformReply: invalidationReply,
  }),
};

interface NodeRedisScriptingClient {
  dialcacheInvalidate(
    watermarkKey: string,
    futureBufferMs: number,
    invalidatedAtMs: number,
  ): Promise<number>;
}

interface NodeRedisStandaloneClient extends NodeRedisScriptingClient {
  get(options: BufferReplyOptions, valueKey: string): Promise<Buffer | null>;
  sendCommand(
    args: Array<NodeRedisArgument>,
    options: BufferReplyOptions,
  ): Promise<unknown>;
}

interface NodeRedisClusterClient extends NodeRedisScriptingClient {
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
 * client-stamped frame. Invalidation retries any dispatch rejection other
 * than a reply-domain violation once by
 * re-sending the script source as EVAL — the script is idempotent, so a
 * duplicate run is harmless — and a failed retry surfaces unmodified, with
 * the original rejection discarded. node-redis has no per-command deadline:
 * `disableOfflineQueue`, `commandsQueueMaxLength`, and `reconnectStrategy`
 * bound queueing and dispatch, not the reply wait, so with the offline queue
 * enabled a retry issued during a disconnect can wait until reconnect. The
 * caller remains responsible for finite native command budgets, draining
 * work, and closing the client.
 */
export function createNodeRedisDialCacheClient(client: NodeRedisClient): DialCacheRedisClient {
  if (typeof client.dialcacheInvalidate !== "function") {
    throw new TypeError(
      "node-redis DialCache requires a client created with scripts: dialcacheRedisScripts",
    );
  }
  return {
    async read({ valueKey, watermarkKey }, context) {
      const options: BufferReplyOptions = context === undefined
        ? bufferReplyOptions
        : commandOptions({ returnBuffers: true, signal: context.signal });
      if (watermarkKey === undefined) {
        return decodeRedisFrame(await client.get(options, valueKey));
      }
      const [rawValue, rawWatermark] = await readTracked(
        client,
        options,
        valueKey,
        watermarkKey,
      );
      return decodeTrackedRedisFrame(rawValue, rawWatermark);
    },
    async write(request) {
      const { valueKey, value } = request;
      const cacheTtlMs = ceilSupportedCacheTtlMs(request.cacheTtlMs);
      validateRedisSetReply(
        await sendFrameSet(client, valueKey, encodeRedisFrame(value, Date.now()), cacheTtlMs),
      );
    },
    async invalidate({ watermarkKey, futureBufferMs }) {
      const invalidatedAtMs = Date.now();
      assertValidRedisTimestampMs(invalidatedAtMs);
      let raw: unknown;
      try {
        raw = await client.dialcacheInvalidate(watermarkKey, futureBufferMs, invalidatedAtMs);
      } catch (error) {
        // The registered transformReply validates inside the returned
        // promise, so a reply-domain violation surfaces here as a rejection;
        // it is deterministic and must not be retried. Any other rejection
        // is retried once with the source: the invalidation script is
        // idempotent (the watermark only advances and its TTL only widens),
        // so a duplicate run after an ambiguous failure is harmless, and
        // EVAL self-heals both a flushed script cache and an
        // EVALSHA-rejecting proxy without depending on error wording.
        if (error instanceof DialCacheRedisProtocolError) {
          throw error;
        }
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
            String(futureBufferMs),
            String(invalidatedAtMs),
          ],
          bufferReplyOptions,
        );
      }
      validateRedisScriptInvalidationReply(raw);
    },
  };
}

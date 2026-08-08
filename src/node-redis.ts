import { commandOptions, defineScript } from "redis";

import {
  INVALIDATE_CACHE_SCRIPT,
  WRITE_TRACKED_STAMP_SCRIPT,
} from "./internal/redis-scripts.js";
import {
  decodeRedisFrame,
  decodeTrackedRedisFrame,
  encodeRedisFrame,
} from "./internal/redis-payload.js";
import { ceilSupportedCacheTtlMs } from "./internal/duration.js";
import {
  validateRedisScriptInvalidationReply,
  validateRedisScriptWriteReply,
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
const writeReply = (reply: number): number => validateRedisScriptWriteReply(reply);
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

export type DialCacheNodeRedisScripts = {
  readonly dialcacheWriteTrackedStamp: NodeRedisScript<
    [valueKey: string, watermarkKey: string, cacheTtlMs: number],
    number
  >;
  readonly dialcacheInvalidate: NodeRedisScript<
    [watermarkKey: string, futureBufferMs: number],
    number
  >;
};

export const dialcacheRedisScripts: DialCacheNodeRedisScripts = {
  dialcacheWriteTrackedStamp: defineDialCacheScript({
    SCRIPT: WRITE_TRACKED_STAMP_SCRIPT,
    NUMBER_OF_KEYS: 2,
    FIRST_KEY_INDEX: 0,
    IS_READ_ONLY: false,
    transformArguments(
      valueKey: string,
      watermarkKey: string,
      cacheTtlMs: number,
    ): Array<string> {
      return [valueKey, watermarkKey, String(cacheTtlMs)];
    },
    transformReply: writeReply,
  }),
  dialcacheInvalidate: defineDialCacheScript({
    SCRIPT: INVALIDATE_CACHE_SCRIPT,
    NUMBER_OF_KEYS: 1,
    FIRST_KEY_INDEX: 0,
    IS_READ_ONLY: false,
    transformArguments(watermarkKey: string, futureBufferMs: number): Array<string> {
      return [watermarkKey, String(futureBufferMs)];
    },
    transformReply: invalidationReply,
  }),
};

interface NodeRedisWriteClient {
  dialcacheWriteTrackedStamp(
    valueKey: string,
    watermarkKey: string,
    cacheTtlMs: number,
  ): Promise<number>;
  dialcacheInvalidate(watermarkKey: string, futureBufferMs: number): Promise<number>;
}

interface NodeRedisStandaloneClient extends NodeRedisWriteClient {
  get(options: BufferReplyOptions, valueKey: string): Promise<Buffer | null>;
  sendCommand(
    args: Array<NodeRedisArgument>,
    options: BufferReplyOptions,
  ): Promise<unknown>;
}

interface NodeRedisClusterClient extends NodeRedisWriteClient {
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

async function readTracked(
  client: NodeRedisClient,
  options: BufferReplyOptions,
  valueKey: string,
  watermarkKey: string,
): Promise<[unknown, unknown]> {
  const args = ["MGET", valueKey, watermarkKey];
  const raw = isNodeRedisClusterClient(client)
    // A tracked read must observe the primary's latest invalidation watermark,
    // even when the caller configured node-redis Cluster with useReplicas.
    ? await client.sendCommand(valueKey, false, args, options)
    : await client.sendCommand(args, options);
  return validateRedisMGetReply(raw);
}

function sendFrameSet(
  client: NodeRedisClient,
  valueKey: string,
  frame: Buffer,
  cacheTtlMs: number,
): Promise<unknown> {
  const args: Array<NodeRedisArgument> = ["SET", valueKey, frame, "PX", String(cacheTtlMs)];
  return isNodeRedisClusterClient(client)
    ? client.sendCommand(valueKey, false, args, bufferReplyOptions)
    : client.sendCommand(args, bufferReplyOptions);
}

/**
 * Create a resource-free semantic view over a caller-owned node-redis client.
 * Read signals are passed to node-redis so queued commands can be removed when
 * supported. Aborting after dispatch does not unsend a command or prove the
 * server stopped executing it. Tracked writes enqueue their placeholder SET
 * and stamp script in one synchronous tick, so node-redis pipelines them in
 * order on one connection (per slot node in cluster mode). The caller remains
 * responsible for finite native command budgets, draining work, and closing
 * the client.
 */
export function createNodeRedisDialCacheClient(client: NodeRedisClient): DialCacheRedisClient {
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
      const { valueKey, watermarkKey, value } = request;
      const cacheTtlMs = ceilSupportedCacheTtlMs(request.cacheTtlMs);
      if (watermarkKey === undefined) {
        validateRedisSetReply(
          await sendFrameSet(client, valueKey, encodeRedisFrame(value, Date.now()), cacheTtlMs),
        );
        return true;
      }
      // Both commands must enqueue in this synchronous tick so they pipeline
      // in order; an await between them would allow reordering around them.
      const setPromise = sendFrameSet(client, valueKey, encodeRedisFrame(value, 0), cacheTtlMs);
      const stampPromise = client.dialcacheWriteTrackedStamp(valueKey, watermarkKey, cacheTtlMs);
      const [setResult, stampResult] = await Promise.allSettled([setPromise, stampPromise]);
      // A failed SET is the write outcome even when the stamp settled: the
      // stamp may have patched an unrelated frame's placeholder or no-opped.
      if (setResult.status === "rejected") {
        throw setResult.reason;
      }
      if (stampResult.status === "rejected") {
        throw stampResult.reason;
      }
      validateRedisSetReply(setResult.value);
      return validateRedisScriptWriteReply(stampResult.value) === 1;
    },
    async invalidate({ watermarkKey, futureBufferMs }) {
      const result = await client.dialcacheInvalidate(watermarkKey, futureBufferMs);
      validateRedisScriptInvalidationReply(result);
    },
  };
}

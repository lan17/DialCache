import { commandOptions, defineScript } from "redis";

import {
  INVALIDATE_CACHE_SCRIPT,
  WRITE_CACHE_SCRIPT,
  WRITE_TRACKED_CACHE_SCRIPT,
} from "./internal/redis-scripts.js";
import {
  decodeRedisFrame,
  decodeTrackedRedisFrame,
  redisPayloadEncoding,
} from "./internal/redis-payload.js";
import {
  validateRedisScriptInvalidationReply,
  validateRedisScriptWriteReply,
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
  readonly dialcacheWrite: NodeRedisScript<
    [valueKey: string, cacheTtlMs: number, encoding: number, payload: string | Buffer],
    number
  >;
  readonly dialcacheWriteTracked: NodeRedisScript<
    [
      valueKey: string,
      watermarkKey: string,
      cacheTtlMs: number,
      encoding: number,
      payload: string | Buffer,
    ],
    number
  >;
  readonly dialcacheInvalidate: NodeRedisScript<
    [watermarkKey: string, futureBufferMs: number],
    number
  >;
};

export const dialcacheRedisScripts: DialCacheNodeRedisScripts = {
  dialcacheWrite: defineDialCacheScript({
    SCRIPT: WRITE_CACHE_SCRIPT,
    NUMBER_OF_KEYS: 1,
    FIRST_KEY_INDEX: 0,
    IS_READ_ONLY: false,
    transformArguments(
      valueKey: string,
      cacheTtlMs: number,
      encoding: number,
      payload: string | Buffer,
    ): Array<NodeRedisArgument> {
      return [valueKey, String(cacheTtlMs), String(encoding), payload];
    },
    transformReply: writeReply,
  }),
  dialcacheWriteTracked: defineDialCacheScript({
    SCRIPT: WRITE_TRACKED_CACHE_SCRIPT,
    NUMBER_OF_KEYS: 2,
    FIRST_KEY_INDEX: 0,
    IS_READ_ONLY: false,
    transformArguments(
      valueKey: string,
      watermarkKey: string,
      cacheTtlMs: number,
      encoding: number,
      payload: string | Buffer,
    ): Array<NodeRedisArgument> {
      return [valueKey, watermarkKey, String(cacheTtlMs), String(encoding), payload];
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
  dialcacheWrite(valueKey: string, cacheTtlMs: number, encoding: number, payload: string | Buffer): Promise<number>;
  dialcacheWriteTracked(
    valueKey: string,
    watermarkKey: string,
    cacheTtlMs: number,
    encoding: number,
    payload: string | Buffer,
  ): Promise<number>;
  dialcacheInvalidate(watermarkKey: string, futureBufferMs: number): Promise<number>;
}

interface NodeRedisStandaloneClient extends NodeRedisWriteClient {
  get(options: BufferReplyOptions, valueKey: string): Promise<Buffer | null>;
  sendCommand(
    args: Array<string>,
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
    args: Array<string>,
    options: BufferReplyOptions,
  ): Promise<unknown>;
}

type NodeRedisClient = NodeRedisStandaloneClient | NodeRedisClusterClient;

function isNodeRedisClusterClient(client: NodeRedisClient): client is NodeRedisClusterClient {
  return "masters" in client;
}

function validateRedisBulkStringReply(reply: unknown): Buffer | null {
  if (reply === null || Buffer.isBuffer(reply)) {
    return reply;
  }
  throw new DialCacheRedisPayloadError(
    "Invalid DialCache Redis read reply; expected a bulk string or null",
  );
}

function validateRedisMGetReply(reply: unknown): [Buffer | null, Buffer | null] {
  if (
    !Array.isArray(reply)
    || reply.length !== 2
    || (reply[0] !== null && !Buffer.isBuffer(reply[0]))
    || (reply[1] !== null && !Buffer.isBuffer(reply[1]))
  ) {
    throw new DialCacheRedisPayloadError(
      "Invalid DialCache Redis tracked read reply; expected two bulk strings or nulls",
    );
  }
  return [reply[0], reply[1]];
}

async function readTracked(
  client: NodeRedisClient,
  options: BufferReplyOptions,
  valueKey: string,
  watermarkKey: string,
): Promise<[Buffer | null, Buffer | null]> {
  const args = ["MGET", valueKey, watermarkKey];
  const raw = isNodeRedisClusterClient(client)
    // A tracked read must observe the primary's latest invalidation watermark,
    // even when the caller configured node-redis Cluster with useReplicas.
    ? await client.sendCommand(valueKey, false, args, options)
    : await client.sendCommand(args, options);
  return validateRedisMGetReply(raw);
}

/**
 * Create a resource-free semantic view over a caller-owned node-redis client.
 * Read signals are passed to node-redis so queued commands can be removed when
 * supported. Aborting after dispatch does not unsend a command or prove the
 * server stopped executing it. The caller remains responsible for finite
 * native command budgets, draining work, and closing the client.
 */
export function createNodeRedisDialCacheClient(client: NodeRedisClient): DialCacheRedisClient {
  return {
    async read({ valueKey, watermarkKey }, context) {
      const options: BufferReplyOptions = context === undefined
        ? bufferReplyOptions
        : commandOptions({ returnBuffers: true, signal: context.signal });
      if (watermarkKey === undefined) {
        const raw = validateRedisBulkStringReply(await client.get(options, valueKey));
        return decodeRedisFrame(raw);
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
      const { valueKey, watermarkKey, cacheTtlMs, value } = request;
      const encodingByte = redisPayloadEncoding(value);
      const result = watermarkKey === undefined
        ? await client.dialcacheWrite(valueKey, cacheTtlMs, encodingByte, value)
        : await client.dialcacheWriteTracked(
            valueKey,
            watermarkKey,
            cacheTtlMs,
            encodingByte,
            value,
          );
      return validateRedisScriptWriteReply(result) === 1;
    },
    async invalidate({ watermarkKey, futureBufferMs }) {
      const result = await client.dialcacheInvalidate(watermarkKey, futureBufferMs);
      validateRedisScriptInvalidationReply(result);
    },
  };
}

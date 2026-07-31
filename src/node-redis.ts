import { commandOptions, defineScript } from "redis";

import { awaitAll } from "./internal/await-all.js";
import { redisClusterSlot } from "./internal/redis-cluster-slot.js";
import {
  INVALIDATE_CACHE_SCRIPT,
  READ_CACHE_SCRIPT,
  READ_TRACKED_CACHE_SCRIPT,
  WRITE_CACHE_SCRIPT,
  WRITE_TRACKED_CACHE_SCRIPT,
} from "./internal/redis-scripts.js";
import { decodeRedisPayload, redisPayloadEncoding } from "./internal/redis-payload.js";
import {
  validateRedisScriptInvalidationReply,
  validateRedisScriptWriteReply,
} from "./internal/redis-script-reply.js";
import { DialCacheRedisProtocolError, type DialCacheRedisClient } from "./redis-client.js";

type BufferReplyOptions = ReturnType<
  typeof commandOptions<{
    readonly returnBuffers: true;
    readonly signal?: AbortSignal;
  }>
>;
// Redis bulk strings are binary data; decoding them as UTF-8 would corrupt arbitrary serializer output.
const bufferReplyOptions: BufferReplyOptions = commandOptions({ returnBuffers: true });
const readReply = (reply: string | null): string | null => reply;
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
  readonly dialcacheRead: NodeRedisScript<[valueKey: string], string | null>;
  readonly dialcacheReadTracked: NodeRedisScript<[valueKey: string, watermarkKey: string], string | null>;
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
  dialcacheRead: defineDialCacheScript({
    SCRIPT: READ_CACHE_SCRIPT,
    NUMBER_OF_KEYS: 1,
    FIRST_KEY_INDEX: 0,
    IS_READ_ONLY: true,
    transformArguments(valueKey: string): Array<string> {
      return [valueKey];
    },
    transformReply: readReply,
  }),
  dialcacheReadTracked: defineDialCacheScript({
    SCRIPT: READ_TRACKED_CACHE_SCRIPT,
    NUMBER_OF_KEYS: 2,
    FIRST_KEY_INDEX: 0,
    // Replica lag must not hide a newly-written invalidation watermark.
    IS_READ_ONLY: false,
    transformArguments(valueKey: string, watermarkKey: string): Array<string> {
      return [valueKey, watermarkKey];
    },
    transformReply: readReply,
  }),
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

interface NodeRedisScriptClient {
  dialcacheRead(options: BufferReplyOptions, valueKey: string): Promise<Buffer | null>;
  dialcacheReadTracked(
    options: BufferReplyOptions,
    valueKey: string,
    watermarkKey: string,
  ): Promise<Buffer | null>;
  dialcacheWrite(valueKey: string, cacheTtlMs: number, encoding: number, payload: string | Buffer): Promise<number>;
  dialcacheWriteTracked(
    valueKey: string,
    watermarkKey: string,
    cacheTtlMs: number,
    encoding: number,
    payload: string | Buffer,
  ): Promise<number>;
  dialcacheInvalidate(watermarkKey: string, futureBufferMs: number): Promise<number>;
  multi?(routing?: NodeRedisArgument): NodeRedisMultiCommand;
  readonly slots?: readonly (NodeRedisClusterSlot | undefined)[];
}

interface NodeRedisMultiCommand {
  dialcacheInvalidate(watermarkKey: string, futureBufferMs: number): NodeRedisMultiCommand;
  execAsPipeline(): Promise<unknown[]>;
}

interface NodeRedisClusterSlot {
  readonly master?: {
    readonly id?: string;
  };
}

interface NodeRedisPipelineClient extends NodeRedisScriptClient {
  multi(routing?: NodeRedisArgument): NodeRedisMultiCommand;
}

interface NodeRedisClusterClient extends NodeRedisPipelineClient {
  readonly slots: readonly (NodeRedisClusterSlot | undefined)[];
}

interface NodeRedisInvalidationRequest {
  readonly watermarkKey: string;
  readonly futureBufferMs: number;
}

function hasNodeRedisPipeline(client: NodeRedisScriptClient): client is NodeRedisPipelineClient {
  return client.multi !== undefined;
}

function isNodeRedisClusterClient(client: NodeRedisPipelineClient): client is NodeRedisClusterClient {
  return Array.isArray(client.slots);
}

function partitionClusterInvalidations(
  client: NodeRedisClusterClient,
  requests: readonly NodeRedisInvalidationRequest[],
): NodeRedisInvalidationRequest[][] {
  const partitions: NodeRedisInvalidationRequest[][] = [];
  const partitionsByOwner = new Map<string, NodeRedisInvalidationRequest[]>();
  const slots = client.slots;

  for (const request of requests) {
    const slot = redisClusterSlot(request.watermarkKey);
    const ownerId = slots[slot]?.master?.id;
    if (ownerId === undefined) {
      // A stale or incomplete topology entry cannot be safely combined with another slot.
      // Keep it isolated and let node-redis route it from its own key.
      partitions.push([request]);
      continue;
    }

    const existing = partitionsByOwner.get(ownerId);
    if (existing === undefined) {
      const partition = [request];
      partitionsByOwner.set(ownerId, partition);
      partitions.push(partition);
    } else {
      existing.push(request);
    }
  }

  return partitions;
}

async function executeScalarInvalidations(
  client: NodeRedisScriptClient,
  requests: readonly NodeRedisInvalidationRequest[],
): Promise<void> {
  await awaitAll(
    requests.map(async ({ watermarkKey, futureBufferMs }) => {
      const reply = await client.dialcacheInvalidate(watermarkKey, futureBufferMs);
      validateRedisScriptInvalidationReply(reply);
    }),
    "Multiple DialCache invalidations failed",
  );
}

function isDirectRedisClusterRedirection(error: unknown): boolean {
  return error instanceof Error
    && (error.message.startsWith("MOVED ") || error.message.startsWith("ASK "));
}

function isRedisClusterRedirection(error: unknown): boolean {
  if (!(error instanceof Error) || !("replies" in error) || !("errorIndexes" in error)) {
    return isDirectRedisClusterRedirection(error);
  }

  const { replies, errorIndexes } = error as Error & {
    readonly replies: unknown;
    readonly errorIndexes: unknown;
  };
  if (!Array.isArray(replies) || !Array.isArray(errorIndexes) || errorIndexes.length === 0) {
    return false;
  }

  return errorIndexes.every((index: unknown) =>
    typeof index === "number"
    && Number.isInteger(index)
    && index >= 0
    && index < replies.length
    && isDirectRedisClusterRedirection(replies[index]));
}

async function executeInvalidationPipeline(
  client: NodeRedisPipelineClient,
  requests: readonly NodeRedisInvalidationRequest[],
): Promise<void> {
  const first = requests[0];
  if (first === undefined) {
    return;
  }

  // Supplying the first key is required for correct node-redis Cluster routing.
  // Standalone clients harmlessly ignore the extra optional argument.
  const pipeline = client.multi(first.watermarkKey);
  for (const { watermarkKey, futureBufferMs } of requests) {
    pipeline.dialcacheInvalidate(watermarkKey, futureBufferMs);
  }
  let replies: unknown[];
  try {
    replies = await pipeline.execAsPipeline();
  } catch (error) {
    if (!isRedisClusterRedirection(error)) {
      throw error;
    }

    // node-redis routes the mixed-slot pipeline using its first key. If topology
    // changes, a different key can keep redirecting that pipeline to the wrong
    // owner. Registered scalar calls are idempotent and route each key afresh.
    await executeScalarInvalidations(client, requests);
    return;
  }
  if (replies.length !== requests.length) {
    throw new DialCacheRedisProtocolError(
      `Invalid DialCache Redis invalidate batch reply count; expected ${requests.length}, received ${replies.length}`,
    );
  }
  for (const reply of replies) {
    validateRedisScriptInvalidationReply(reply);
  }
}

/**
 * Create a resource-free semantic view over a caller-owned node-redis client.
 * Read signals are passed to node-redis so queued commands can be removed when
 * supported. Aborting after dispatch does not unsend a command or prove the
 * server stopped executing it. The caller remains responsible for finite
 * native command budgets, draining work, and closing the client.
 */
export function createNodeRedisDialCacheClient(client: NodeRedisScriptClient): DialCacheRedisClient {
  return {
    async read({ valueKey, watermarkKey }, context) {
      const options: BufferReplyOptions = context === undefined
        ? bufferReplyOptions
        : commandOptions({ returnBuffers: true, signal: context.signal });
      const raw = watermarkKey === undefined
        ? await client.dialcacheRead(options, valueKey)
        : await client.dialcacheReadTracked(options, valueKey, watermarkKey);
      return raw === null ? null : decodeRedisPayload(raw);
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
    async invalidateMany(requests) {
      if (requests.length === 0) {
        return;
      }

      if (!hasNodeRedisPipeline(client)) {
        await executeScalarInvalidations(client, requests);
        return;
      }

      const partitions = isNodeRedisClusterClient(client)
        ? partitionClusterInvalidations(client, requests)
        : [requests];
      await awaitAll(
        partitions.map(async (partition) => await executeInvalidationPipeline(client, partition)),
        "Multiple DialCache invalidation partitions failed",
      );
    },
  };
}

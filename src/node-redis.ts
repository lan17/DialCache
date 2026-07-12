import { defineScript } from "redis";

import {
  INVALIDATE_CACHE_SCRIPT,
  READ_CACHE_SCRIPT,
  READ_TRACKED_CACHE_SCRIPT,
  REDIS_ENCODING_BASE64,
  REDIS_ENCODING_UTF8,
  WRITE_CACHE_SCRIPT,
  WRITE_TRACKED_CACHE_SCRIPT,
} from "./internal/redis-scripts.js";
import { DialCacheRedisPayloadEncodingError, DialCacheRedisPayloadError } from "./redis-client.js";
import type { DialCacheRedisClient, RedisCachePayload } from "./redis-client.js";

const readReply = (reply: string | null): string | null => reply;
const integerReply = (reply: number): number => reply;

interface NodeRedisScript<Args extends Array<unknown>, Reply> {
  readonly SCRIPT: string;
  readonly SHA1: string;
  readonly NUMBER_OF_KEYS: number;
  readonly FIRST_KEY_INDEX: number;
  readonly IS_READ_ONLY: boolean;
  transformArguments(...args: Args): Array<string>;
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
    [valueKey: string, cacheTtlMs: number, encoding: number, payload: string],
    number
  >;
  readonly dialcacheWriteTracked: NodeRedisScript<
    [
      valueKey: string,
      watermarkKey: string,
      cacheTtlMs: number,
      encoding: number,
      payload: string,
      watermarkTtlFloorMs: number,
    ],
    number
  >;
  readonly dialcacheInvalidate: NodeRedisScript<
    [watermarkKey: string, futureBufferMs: number, watermarkTtlFloorMs: number],
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
    transformArguments(valueKey: string, cacheTtlMs: number, encoding: number, payload: string): Array<string> {
      return [valueKey, String(cacheTtlMs), String(encoding), payload];
    },
    transformReply: integerReply,
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
      payload: string,
      watermarkTtlFloorMs: number,
    ): Array<string> {
      return [valueKey, watermarkKey, String(cacheTtlMs), String(encoding), payload, String(watermarkTtlFloorMs)];
    },
    transformReply: integerReply,
  }),
  dialcacheInvalidate: defineDialCacheScript({
    SCRIPT: INVALIDATE_CACHE_SCRIPT,
    NUMBER_OF_KEYS: 1,
    FIRST_KEY_INDEX: 0,
    IS_READ_ONLY: false,
    transformArguments(watermarkKey: string, futureBufferMs: number, watermarkTtlFloorMs: number): Array<string> {
      return [watermarkKey, String(futureBufferMs), String(watermarkTtlFloorMs)];
    },
    transformReply: integerReply,
  }),
};

interface NodeRedisScriptClient {
  dialcacheRead(valueKey: string): Promise<string | null>;
  dialcacheReadTracked(valueKey: string, watermarkKey: string): Promise<string | null>;
  dialcacheWrite(valueKey: string, cacheTtlMs: number, encoding: number, payload: string): Promise<number>;
  dialcacheWriteTracked(
    valueKey: string,
    watermarkKey: string,
    cacheTtlMs: number,
    encoding: number,
    payload: string,
    watermarkTtlFloorMs: number,
  ): Promise<number>;
  dialcacheInvalidate(watermarkKey: string, futureBufferMs: number, watermarkTtlFloorMs: number): Promise<number>;
  flushAll?(): Promise<unknown>;
}

interface NodeRedisClusterCommands {
  readonly masters: ReadonlyArray<unknown>;
  nodeClient(master: unknown): Promise<{ flushAll(): Promise<unknown> }>;
}

export function createNodeRedisDialCacheClient(client: NodeRedisScriptClient): DialCacheRedisClient {
  return {
    async read({ valueKey, watermarkKey }) {
      const raw = watermarkKey === undefined
        ? await client.dialcacheRead(valueKey)
        : await client.dialcacheReadTracked(valueKey, watermarkKey);
      return raw === null ? null : decodePayload(raw);
    },
    async write(request) {
      const { valueKey, watermarkKey, cacheTtlMs, encoding, value } = request;
      const encodingByte = encoding === "base64" ? REDIS_ENCODING_BASE64 : REDIS_ENCODING_UTF8;
      const result = watermarkKey === undefined
        ? await client.dialcacheWrite(valueKey, cacheTtlMs, encodingByte, value)
        : await client.dialcacheWriteTracked(
            valueKey,
            watermarkKey,
            cacheTtlMs,
            encodingByte,
            value,
            request.watermarkTtlFloorMs,
          );
      return result === 1;
    },
    async invalidate({ watermarkKey, futureBufferMs, watermarkTtlFloorMs }) {
      await client.dialcacheInvalidate(watermarkKey, futureBufferMs, watermarkTtlFloorMs);
    },
    async flushAll() {
      const cluster = clusterCommands(client);
      if (cluster === null) {
        if (client.flushAll === undefined) {
          throw new Error("Node-redis client does not implement flushAll");
        }
        await client.flushAll();
        return;
      }
      if (cluster.masters.length === 0) {
        throw new Error("Node-redis cluster has no connected masters");
      }
      await Promise.all(
        cluster.masters.map(async (master) => {
          const node = await cluster.nodeClient(master);
          await node.flushAll();
        }),
      );
    },
  };
}

function decodePayload(raw: string): RedisCachePayload {
  if (raw.length === 0) {
    throw new DialCacheRedisPayloadError("Invalid DialCache Redis payload");
  }

  const encoding = raw.charCodeAt(0);
  if (encoding === REDIS_ENCODING_UTF8) {
    return { encoding: "utf8", value: raw.slice(1) };
  }
  if (encoding === REDIS_ENCODING_BASE64) {
    return { encoding: "base64", value: raw.slice(1) };
  }
  throw new DialCacheRedisPayloadEncodingError("Invalid DialCache Redis payload encoding");
}

function clusterCommands(client: NodeRedisScriptClient): NodeRedisClusterCommands | null {
  if (!("masters" in client) || !("nodeClient" in client) || !Array.isArray(client.masters)) {
    return null;
  }
  return client as NodeRedisScriptClient & NodeRedisClusterCommands;
}

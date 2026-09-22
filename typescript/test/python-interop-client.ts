// One public-cache operation against the real server per subprocess. Python
// supplies logical inputs; TypeScript derives keys and writes its own frames.
import { readFileSync } from "node:fs";

import { commandOptions, createClient, createCluster } from "redis";

import {
  CacheLayer,
  DialCache,
  DialCacheKey,
  DialCacheKeyConfig,
  isRedisReadMiss,
  JsonSerializer,
  normalizeArgs,
  type DialCacheRedisClient,
  type Serializer,
} from "../src/index.js";
import { createNodeRedisDialCacheClient } from "../src/node-redis.js";

type TaggedValue =
  | { kind: "json"; value: unknown }
  | { kind: "undefined" }
  | { kind: "binary"; hex: string };

interface Request {
  url: string;
  cluster?: boolean;
  namespace: string;
  keyType: string;
  id: string;
  useCase: string;
  args: Record<string, string | number | boolean | null>;
  tracked: boolean;
  compression: boolean;
  codec: "json" | "binary";
  wallMs: number;
  op: "get" | "invalidate";
  source?: TaggedValue;
  futureBufferMs?: number;
}

const binarySerializer: Serializer<unknown> = {
  dump(value) {
    if (!Buffer.isBuffer(value)) throw new TypeError("Binary source must be a Buffer");
    return value;
  },
  load(payload) {
    if (!Buffer.isBuffer(payload)) throw new TypeError("Binary frame must retain its payload type");
    return Buffer.from(payload);
  },
};

function sourceValue(request: Request): unknown {
  const source = request.source;
  if (source === undefined) throw new Error("Cache missed without a supplied source");
  if (request.codec === "binary") {
    if (source.kind !== "binary" || !/^(?:[\da-f]{2})*$/i.test(source.hex)) {
      throw new TypeError("Binary source requires complete hexadecimal bytes");
    }
    return Buffer.from(source.hex, "hex");
  }
  if (source.kind === "undefined") return undefined;
  if (source.kind !== "json") throw new TypeError("JSON source requires JSON or undefined");
  return source.value;
}

function describeValue(value: unknown, codec: Request["codec"]): TaggedValue {
  if (codec === "binary") {
    if (!Buffer.isBuffer(value)) throw new TypeError("Binary result must be a Buffer");
    return { kind: "binary", hex: value.toString("hex") };
  }
  return value === undefined ? { kind: "undefined" } : { kind: "json", value };
}

async function bounded<T>(pending: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(0, "utf8")) as Request;
  if (!Number.isSafeInteger(request.wallMs) || request.wallMs < 0) {
    throw new RangeError("wallMs must be a nonnegative safe integer");
  }
  const connection = {
    socket: { connectTimeout: 5_000, reconnectStrategy: false as const },
    disableOfflineQueue: true,
    commandsQueueMaxLength: 32,
  };
  const client = request.cluster
    ? createCluster({ rootNodes: [{ url: request.url }], useReplicas: false, defaults: connection })
    : createClient({ url: request.url, ...connection });
  client.on("error", () => undefined);
  const realNow = Date.now;
  try {
    await bounded<unknown>(client.connect(), "Redis connection");
    Date.now = () => request.wallMs;
    const key = new DialCacheKey({
      namespace: request.namespace,
      keyType: request.keyType,
      id: request.id,
      useCase: request.useCase,
      args: normalizeArgs(request.args),
      trackForInvalidation: request.tracked,
    });
    const valueKey = `${key.urn}:dialcache-frame-v1`;
    const watermarkKey = request.tracked ? `${key.prefix}#watermark` : null;
    const native = createNodeRedisDialCacheClient(client);
    const writes: Array<Promise<void>> = [];
    let observedWatermarkMs: number | undefined;
    const observed: DialCacheRedisClient = {
      async read(readRequest, context) {
        const result = await native.read(readRequest, context);
        if (isRedisReadMiss(result)) observedWatermarkMs = result.observedWatermarkMs;
        return result;
      },
      write(writeRequest) {
        const pending = Promise.resolve(native.write(writeRequest));
        writes.push(pending);
        // The core handles write rejection as fail-open; retain it independently
        // so the helper cannot report a successfully persisted fill on failure.
        void pending.catch(() => undefined);
        return pending;
      },
      invalidate: invalidation => native.invalidate(invalidation),
    };
    const warnings: string[] = [];
    const cache = new DialCache({
      namespace: request.namespace,
      localMaxSize: 0,
      logger: {
        debug: () => undefined,
        warn: (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); },
        error: (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); },
      },
      redis: {
        client: observed,
        readTimeoutMs: 5_000,
        compression: request.compression ? { thresholdBytes: 1, level: 3 } : false,
      },
    });
    let sourceCalls = 0;
    let value: TaggedValue | undefined;
    let writeSkippedByFence = false;
    if (request.op === "get") {
      const loaded = await bounded(cache.enable(() => cache.getOrLoad(() => {
        sourceCalls++;
        return sourceValue(request);
      }, {
        key: { id: request.id, args: request.args },
        keyType: request.keyType,
        useCase: request.useCase,
        trackForInvalidation: request.tracked,
        defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.REMOTE]: 60 } }),
        fallbackTimeoutMs: 5_000,
        serializer: request.codec === "binary" ? binarySerializer : new JsonSerializer<unknown>(),
      })), "DialCache get", 10_000);
      value = describeValue(loaded, request.codec);
      writeSkippedByFence = sourceCalls > 0 && request.tracked
        && observedWatermarkMs !== undefined && request.wallMs <= observedWatermarkMs;
      const expectedWrites = sourceCalls > 0 && !writeSkippedByFence ? 1 : 0;
      if (writes.length !== expectedWrites) {
        throw new Error(`Expected ${expectedWrites} completed Redis writes; observed ${writes.length}`);
      }
      await bounded(Promise.all(writes), "Redis publication");
    } else if (request.op === "invalidate") {
      await bounded(cache.invalidateRemote(request.keyType, request.id, request.futureBufferMs ?? 0), "DialCache invalidation");
    } else {
      throw new Error(`Unknown operation: ${String(request.op)}`);
    }
    const [frame, watermark, ttlMs] = await bounded(Promise.all([
      client.get(commandOptions({ returnBuffers: true }), valueKey),
      watermarkKey === null ? Promise.resolve(null) : client.get(watermarkKey),
      client.pTTL(valueKey),
    ]), "Redis snapshot");
    process.stdout.write(JSON.stringify({
      ...(value === undefined ? {} : { value }),
      sourceCalls, valueKey, watermarkKey, frameHex: frame?.toString("hex") ?? null,
      watermark, ttlMs, writeCalls: writes.length, writeSkippedByFence, warnings,
    }));
  } finally {
    Date.now = realNow;
    if (client.isOpen) {
      try {
        await bounded<unknown>(client.quit(), "Redis shutdown", 1_000);
      } catch {
        if (client.isOpen) await bounded(client.disconnect(), "Redis disconnect", 1_000);
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

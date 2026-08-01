import { decodeRedisPayload, redisPayloadEncoding } from "./internal/redis-payload.js";
import { awaitAll } from "./internal/await-all.js";
import {
  INVALIDATE_CACHE_SCRIPT,
  READ_CACHE_SCRIPT,
  READ_TRACKED_CACHE_SCRIPT,
  WRITE_CACHE_SCRIPT,
  WRITE_TRACKED_CACHE_SCRIPT,
} from "./internal/redis-scripts.js";
import {
  validateRedisScriptInvalidationReply,
  validateRedisScriptWriteReply,
} from "./internal/redis-script-reply.js";
import {
  DialCacheRedisPayloadError,
  DialCacheRedisProtocolError,
  type DialCacheRedisClient,
  type RedisInvalidationRequest,
} from "./redis-client.js";

type ValkeyGlideString = string | Buffer;

export interface ValkeyGlideScriptHandle {
  /** Return the Redis script hash when exposed by this GLIDE runtime. */
  getHash?(): string;
  /** Release the native GLIDE script registration. */
  release(): void;
}

interface ValkeyGlideBatchExecutionOptions<TDecoder> {
  readonly decoder: TDecoder;
  readonly retryStrategy?: {
    readonly retryServerError: boolean;
    readonly retryConnectionError: boolean;
  };
}

export interface ValkeyGlideScriptingClient<TScript, TDecoder> {
  invokeScript(
    script: TScript,
    options: {
      keys: ValkeyGlideString[];
      args: ValkeyGlideString[];
      decoder: TDecoder;
    },
  ): Promise<unknown>;
  /** Optional native batch capability; scalar scripting remains supported. */
  exec?(
    batch: ValkeyGlideBatch,
    raiseOnError: boolean,
    options: ValkeyGlideBatchExecutionOptions<TDecoder>,
  ): Promise<unknown[] | null>;
}

interface ValkeyGlideBatch {
  customCommand(args: ValkeyGlideString[]): ValkeyGlideBatch;
}

interface ValkeyGlideBatchConstructor {
  new (isAtomic: boolean): ValkeyGlideBatch;
}

interface ValkeyGlideClusterClientConstructor {
  // The adapter only performs an instanceof check; modeling Symbol.hasInstance
  // avoids coupling its structural runtime contract to GLIDE's full constructor.
  [Symbol.hasInstance](value: unknown): boolean;
}

export interface ValkeyGlideRuntime<TScript extends ValkeyGlideScriptHandle, TDecoder> {
  /** The Script constructor exported by the same GLIDE module instance as the client. */
  readonly Script: new (source: string) => TScript;
  /** Optional standalone Batch constructor exported by that GLIDE module instance. */
  readonly Batch?: ValkeyGlideBatchConstructor;
  /** Optional ClusterBatch constructor exported by that GLIDE module instance. */
  readonly ClusterBatch?: ValkeyGlideBatchConstructor;
  /** Optional cluster client class exported by that GLIDE module instance. */
  readonly GlideClusterClient?: ValkeyGlideClusterClientConstructor;
  /** The Decoder enum exported by the same GLIDE module instance as the client. */
  readonly Decoder: {
    readonly Bytes: TDecoder;
  };
}

interface DialCacheGlideScripts<TScript> {
  readonly read: TScript;
  readonly readTracked: TScript;
  readonly write: TScript;
  readonly writeTracked: TScript;
  readonly invalidate: TScript;
}

// GLIDE 2.4.2 exposes script-cache misses only through Error.message. Match
// the observed GLIDE form and Redis's standard token, and fail closed otherwise.
function isScriptCacheMiss(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /\bNOSCRIPT\b/.test(error.message)
    || /\bNoScriptError:\s*No matching script(?:\.|\s|$)/.test(error.message);
}

// A native batch is one protobuf request regardless of its command count, and
// scalar wrappers can exhaust GLIDE's in-flight limit. Bound both paths.
const MAX_INVALIDATION_COMMANDS_PER_CHUNK = 1_000;

function validateInvalidationBatchReplies(raw: unknown, expectedReplies: number): void {
  if (!Array.isArray(raw) || raw.length !== expectedReplies) {
    throw new DialCacheRedisProtocolError(
      `Invalid DialCache Redis invalidate batch reply; expected ${expectedReplies} replies`,
    );
  }
  for (const reply of raw) {
    validateRedisScriptInvalidationReply(reply);
  }
}

export interface ValkeyGlideDialCacheClient extends DialCacheRedisClient {
  /** Advance multiple watermarks as one semantic operation through non-atomic GLIDE chunks. */
  invalidateMany(requests: readonly RedisInvalidationRequest[]): Promise<void>;
  /** Release the adapter-owned GLIDE Script handles. Does not close the wrapped GLIDE client. */
  dispose(): void;
}

/**
 * Wrap a caller-owned GLIDE connection. The returned adapter owns only its
 * Script handles and preserves the connection's `requestTimeout`. Pass the
 * same GLIDE module namespace used to create the client so native Script
 * handles are registered with that client's runtime. Callers dispose the
 * handles after draining work, then close GLIDE. A request timeout bounds
 * client waiting but is not server-side command cancellation. GLIDE's current
 * script API has no per-invocation signal, so DialCache's core read deadline
 * may return before this adapter's invocation settles.
 */
export function createValkeyGlideDialCacheClient<TScript extends ValkeyGlideScriptHandle, TDecoder>(
  client: ValkeyGlideScriptingClient<TScript, TDecoder>,
  glide: ValkeyGlideRuntime<TScript, TDecoder>,
): ValkeyGlideDialCacheClient {
  const scripts: DialCacheGlideScripts<TScript> = {
    read: new glide.Script(READ_CACHE_SCRIPT),
    readTracked: new glide.Script(READ_TRACKED_CACHE_SCRIPT),
    write: new glide.Script(WRITE_CACHE_SCRIPT),
    writeTracked: new glide.Script(WRITE_TRACKED_CACHE_SCRIPT),
    invalidate: new glide.Script(INVALIDATE_CACHE_SCRIPT),
  };
  let disposed = false;
  let activeInvocations = 0;

  const invokeTracked = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (disposed) {
      throw new Error("Valkey GLIDE DialCache client is disposed");
    }
    activeInvocations += 1;
    try {
      return await operation();
    } finally {
      activeInvocations -= 1;
    }
  };

  const invoke = async (
    script: TScript,
    keys: ValkeyGlideString[],
    args: ValkeyGlideString[] = [],
  ): Promise<unknown> => invokeTracked(
    async () => await client.invokeScript(script, { keys, args, decoder: glide.Decoder.Bytes }),
  );

  return {
    async read({ valueKey, watermarkKey }) {
      const raw = watermarkKey === undefined
        ? await invoke(scripts.read, [valueKey])
        : await invoke(scripts.readTracked, [valueKey, watermarkKey]);
      if (raw === null) {
        return null;
      }
      if (!Buffer.isBuffer(raw)) {
        throw new DialCacheRedisPayloadError("Invalid DialCache Redis payload reply");
      }
      return decodeRedisPayload(raw);
    },
    async write(request) {
      const { valueKey, watermarkKey, cacheTtlMs, value } = request;
      const encoding = redisPayloadEncoding(value);
      const raw = watermarkKey === undefined
        ? await invoke(scripts.write, [valueKey], [String(cacheTtlMs), String(encoding), value])
        : await invoke(
            scripts.writeTracked,
            [valueKey, watermarkKey],
            [String(cacheTtlMs), String(encoding), value],
          );
      return validateRedisScriptWriteReply(raw) === 1;
    },
    async invalidate({ watermarkKey, futureBufferMs }) {
      const raw = await invoke(
        scripts.invalidate,
        [watermarkKey],
        [String(futureBufferMs)],
      );
      validateRedisScriptInvalidationReply(raw);
    },
    async invalidateMany(requests) {
      if (requests.length === 0) {
        return;
      }

      const exec = client.exec?.bind(client);
      const StandaloneBatch = glide.Batch;
      const ClusterBatch = glide.ClusterBatch;
      const GlideClusterClient = glide.GlideClusterClient;
      if (
        exec === undefined
        || StandaloneBatch === undefined
        || ClusterBatch === undefined
        || GlideClusterClient === undefined
      ) {
        await invokeTracked(async () => {
          for (
            let index = 0;
            index < requests.length;
            index += MAX_INVALIDATION_COMMANDS_PER_CHUNK
          ) {
            const chunk = requests.slice(index, index + MAX_INVALIDATION_COMMANDS_PER_CHUNK);
            await awaitAll(
              chunk.map(async ({ watermarkKey, futureBufferMs }) => {
                const raw = await client.invokeScript(scripts.invalidate, {
                  keys: [watermarkKey],
                  args: [String(futureBufferMs)],
                  decoder: glide.Decoder.Bytes,
                });
                validateRedisScriptInvalidationReply(raw);
              }),
              "Multiple DialCache invalidations failed",
            );
          }
        });
        return;
      }

      await invokeTracked(async () => {
        const isCluster = client instanceof GlideClusterClient;
        const Batch = isCluster ? ClusterBatch : StandaloneBatch;
        const options: ValkeyGlideBatchExecutionOptions<TDecoder> = isCluster
          ? {
              decoder: glide.Decoder.Bytes,
              retryStrategy: {
                retryServerError: true,
                retryConnectionError: true,
              },
            }
          : { decoder: glide.Decoder.Bytes };
        const executeBatch = async (
          chunk: readonly RedisInvalidationRequest[],
          script: string,
          command: "EVAL" | "EVALSHA",
        ) => {
          const batch = new Batch(false);
          for (const { watermarkKey, futureBufferMs } of chunk) {
            batch.customCommand([
              command,
              script,
              "1",
              watermarkKey,
              String(futureBufferMs),
            ]);
          }
          return await exec(batch, true, options);
        };

        const scriptHash = scripts.invalidate.getHash?.();
        for (
          let index = 0;
          index < requests.length;
          index += MAX_INVALIDATION_COMMANDS_PER_CHUNK
        ) {
          const chunk = requests.slice(index, index + MAX_INVALIDATION_COMMANDS_PER_CHUNK);
          let raw: unknown;
          if (scriptHash === undefined) {
            raw = await executeBatch(chunk, INVALIDATE_CACHE_SCRIPT, "EVAL");
          } else {
            try {
              raw = await executeBatch(chunk, scriptHash, "EVALSHA");
            } catch (error) {
              if (!isScriptCacheMiss(error)) {
                throw error;
              }
              raw = await executeBatch(chunk, INVALIDATE_CACHE_SCRIPT, "EVAL");
            }
          }
          validateInvalidationBatchReplies(raw, chunk.length);
        }
      });
    },
    dispose() {
      if (disposed) {
        return;
      }
      if (activeInvocations > 0) {
        throw new Error("Cannot dispose Valkey GLIDE DialCache client while operations are in flight");
      }
      disposed = true;
      for (const script of Object.values(scripts)) {
        script.release();
      }
    },
  };
}

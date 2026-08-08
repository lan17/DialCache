import { createHash } from "node:crypto";

import { ceilSupportedCacheTtlMs } from "./internal/duration.js";
import {
  decodeRedisFrame,
  decodeTrackedRedisFrame,
  encodeRedisFrame,
  encodeTrackedRedisPlaceholder,
} from "./internal/redis-payload.js";
import {
  INVALIDATE_CACHE_SCRIPT,
  WRITE_TRACKED_STAMP_SCRIPT,
} from "./internal/redis-scripts.js";
import {
  resolveTrackedRedisWriteReply,
  validateRedisScriptInvalidationReply,
  validateRedisSetReply,
} from "./internal/redis-script-reply.js";
import { DialCacheRedisPayloadError, type DialCacheRedisClient } from "./redis-client.js";

type ValkeyGlideString = string | Buffer;

// Redis caches EVAL'd sources under sha1(source), so this digest is by
// definition the one the batched EVALSHA must use and the one the EVAL
// fallback repopulates.
const WRITE_TRACKED_STAMP_SHA1 = createHash("sha1").update(WRITE_TRACKED_STAMP_SCRIPT).digest("hex");

interface ValkeyGlideBatch {
  customCommand(args: ValkeyGlideString[]): ValkeyGlideBatch;
  mget(keys: ValkeyGlideString[]): ValkeyGlideBatch;
}

export interface ValkeyGlideScriptHandle {
  /** Release the native GLIDE script registration. */
  release(): void;
}

export interface ValkeyGlideScriptingClient<TScript, TDecoder> {
  customCommand(
    args: ValkeyGlideString[],
    options: {
      decoder: TDecoder;
      route?: { type: "primarySlotKey"; key: string };
    },
  ): Promise<unknown>;
  get(
    key: ValkeyGlideString,
    options: { decoder: TDecoder },
  ): Promise<unknown>;
  exec(
    batch: ValkeyGlideBatch,
    raiseOnError: boolean,
    options: {
      decoder: TDecoder;
      route?: { type: "primarySlotKey"; key: string };
    },
  ): Promise<unknown>;
  invokeScript(
    script: TScript,
    options: {
      keys: ValkeyGlideString[];
      args: ValkeyGlideString[];
      decoder: TDecoder;
    },
  ): Promise<unknown>;
}

interface ValkeyGlideClientIdentity {
  readonly [Symbol.hasInstance]: (value: unknown) => boolean;
}

export interface ValkeyGlideRuntime<TScript extends ValkeyGlideScriptHandle, TDecoder> {
  /** The Batch constructor exported by the same GLIDE module instance as the client. */
  readonly Batch: new (isAtomic: boolean) => ValkeyGlideBatch;
  /** The ClusterBatch constructor exported by the same GLIDE module instance as the client. */
  readonly ClusterBatch: new (isAtomic: boolean) => ValkeyGlideBatch;
  /** The standalone client class exported by the same GLIDE module instance as the client. */
  readonly GlideClient: ValkeyGlideClientIdentity;
  /** The cluster client class exported by the same GLIDE module instance as the client. */
  readonly GlideClusterClient: ValkeyGlideClientIdentity;
  /** The Script constructor exported by the same GLIDE module instance as the client. */
  readonly Script: new (source: string) => TScript;
  /** The Decoder enum exported by the same GLIDE module instance as the client. */
  readonly Decoder: {
    readonly Bytes: TDecoder;
  };
}

interface DialCacheGlideScripts<TScript> {
  readonly invalidate: TScript;
}

function matchesValkeyGlideIdentity(
  identity: unknown,
  name: "GlideClient" | "GlideClusterClient",
  client: unknown,
): boolean {
  if (
    identity === null
    || (typeof identity !== "object" && typeof identity !== "function")
    || typeof (identity as ValkeyGlideClientIdentity)[Symbol.hasInstance] !== "function"
  ) {
    throw new Error(`Invalid Valkey GLIDE runtime: ${name} must support Symbol.hasInstance`);
  }
  return (identity as ValkeyGlideClientIdentity)[Symbol.hasInstance](client);
}

function classifyValkeyGlideClient<TScript, TDecoder>(
  client: ValkeyGlideScriptingClient<TScript, TDecoder>,
  glide: ValkeyGlideRuntime<ValkeyGlideScriptHandle, TDecoder>,
): "standalone" | "cluster" {
  const isStandalone = matchesValkeyGlideIdentity(glide.GlideClient, "GlideClient", client);
  const isCluster = matchesValkeyGlideIdentity(
    glide.GlideClusterClient,
    "GlideClusterClient",
    client,
  );
  if (isStandalone && isCluster) {
    throw new Error(
      "Invalid Valkey GLIDE runtime: client matches both GlideClient and GlideClusterClient",
    );
  }
  if (!isStandalone && !isCluster) {
    throw new Error(
      "Valkey GLIDE DialCache requires a direct GlideClient or GlideClusterClient instance "
      + "from the supplied runtime; wrappers should implement DialCacheRedisClient directly",
    );
  }
  return isCluster ? "cluster" : "standalone";
}

export interface ValkeyGlideDialCacheClient extends DialCacheRedisClient {
  /** Release the adapter-owned GLIDE Script handles. Does not close the wrapped GLIDE client. */
  dispose(): void;
}

/**
 * Wrap a caller-owned GLIDE connection. The returned adapter owns only its
 * invalidation Script handle and preserves the connection's
 * `requestTimeout`. On GLIDE 2.0.0, releasing any Script handle for a source
 * has been observed to break other live handles for that same source despite
 * the documented reference counting, so adapters sharing one GLIDE module
 * namespace must be disposed together after draining, never swapped
 * dispose-after-create. Pass the same GLIDE module namespace used to create the
 * client so native Batch and Script objects come from that client's runtime.
 * Only direct GlideClient and GlideClusterClient instances are accepted;
 * wrappers should implement DialCacheRedisClient directly.
 * Callers dispose the handles after draining work, then close GLIDE. A request
 * timeout bounds client waiting but is not server-side command cancellation.
 * GLIDE's current command API has no per-invocation signal, so DialCache's core
 * read deadline may return before this adapter's invocation settles. Tracked
 * standalone reads use a one-command primary batch, while tracked cluster
 * reads route MGET explicitly to the slot primary, so replica lag cannot hide
 * an invalidation watermark. Tracked writes batch a native placeholder SET
 * with an EVALSHA of the stamp script — cluster write batches route to the
 * slot primary — and a flushed script cache falls back to invokeScript, which
 * reloads and re-runs the stamp, so the first tracked write against a cold
 * script cache pays one extra round trip. Batches are deliberately
 * non-atomic: MGET and SET are atomic themselves, an interleaved stamp is
 * safe by design, and MULTI/EXEC would consume caller-owned WATCH state.
 */
export function createValkeyGlideDialCacheClient<TScript extends ValkeyGlideScriptHandle, TDecoder>(
  client: ValkeyGlideScriptingClient<TScript, TDecoder>,
  glide: ValkeyGlideRuntime<TScript, TDecoder>,
): ValkeyGlideDialCacheClient {
  if (typeof glide.Batch !== "function" || typeof glide.ClusterBatch !== "function") {
    throw new Error(
      "Valkey GLIDE DialCache requires @valkey/valkey-glide >=2.0.0 with Batch and ClusterBatch constructors",
    );
  }
  const isCluster = classifyValkeyGlideClient(client, glide) === "cluster";
  const scripts: DialCacheGlideScripts<TScript> = {
    invalidate: new glide.Script(INVALIDATE_CACHE_SCRIPT),
  };
  let disposed = false;
  let activeOperations = 0;

  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (disposed) {
      throw new Error("Valkey GLIDE DialCache client is disposed");
    }
    activeOperations += 1;
    try {
      return await operation();
    } finally {
      activeOperations -= 1;
    }
  };

  return {
    async read({ valueKey, watermarkKey }) {
      if (watermarkKey === undefined) {
        const raw = await run(
          () => client.get(valueKey, { decoder: glide.Decoder.Bytes }),
        );
        return decodeRedisFrame(raw);
      }

      const pair = isCluster
        ? await run(
            () => client.customCommand(
              ["MGET", valueKey, watermarkKey],
              {
                decoder: glide.Decoder.Bytes,
                route: { type: "primarySlotKey", key: valueKey },
              },
            ),
          )
        : await run(async () => {
            const batch = new glide.Batch(false).mget([valueKey, watermarkKey]);
            const raw = await client.exec(batch, true, { decoder: glide.Decoder.Bytes });
            if (!Array.isArray(raw) || raw.length !== 1) {
              throw new DialCacheRedisPayloadError("Invalid DialCache Redis payload reply");
            }
            return raw[0];
          });
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new DialCacheRedisPayloadError("Invalid DialCache Redis payload reply");
      }
      return decodeTrackedRedisFrame(pair[0], pair[1]);
    },
    async write(request) {
      const { valueKey, watermarkKey, value } = request;
      const cacheTtlMs = ceilSupportedCacheTtlMs(request.cacheTtlMs);
      const execOptions: {
        decoder: TDecoder;
        route?: { type: "primarySlotKey"; key: string };
      } = isCluster
        ? { decoder: glide.Decoder.Bytes, route: { type: "primarySlotKey", key: valueKey } }
        : { decoder: glide.Decoder.Bytes };

      if (watermarkKey === undefined) {
        const frame = encodeRedisFrame(value, Date.now());
        validateRedisSetReply(await run(
          () => client.customCommand(["SET", valueKey, frame, "PX", String(cacheTtlMs)], execOptions),
        ));
        return true;
      }

      const { frame, nonce } = encodeTrackedRedisPlaceholder(value);
      const stampArgs: ValkeyGlideString[] = [String(cacheTtlMs), nonce];
      // One dispose-guarded operation covering the batch and its NOSCRIPT
      // recovery, so in-flight accounting spans the whole logical write.
      return await run(async () => {
        const batch = (isCluster ? new glide.ClusterBatch(false) : new glide.Batch(false))
          .customCommand(["SET", valueKey, frame, "PX", String(cacheTtlMs)])
          .customCommand([
            "EVALSHA",
            WRITE_TRACKED_STAMP_SHA1,
            "2",
            valueKey,
            watermarkKey,
            ...stampArgs,
          ]);
        const replies = await client.exec(batch, false, execOptions);
        if (!Array.isArray(replies) || replies.length !== 2) {
          throw new DialCacheRedisPayloadError("Invalid DialCache Redis write reply");
        }
        const [setReply, rawStamp] = replies as [unknown, unknown];
        // A failed SET is the write outcome even when the stamp settled.
        if (setReply instanceof Error) {
          throw setReply;
        }
        validateRedisSetReply(setReply);
        let stampReply: unknown = rawStamp;
        if (rawStamp instanceof Error) {
          // GLIDE maps the server's NOSCRIPT reply to its own NoScriptError wording.
          if (!rawStamp.message.includes("NOSCRIPT") && !rawStamp.message.includes("NoScriptError")) {
            throw rawStamp;
          }
          // Only NOSCRIPT proves the batched stamp never executed, so only it
          // is retried: after any other error a re-run could find its own
          // frame already promoted and misreport the write as a lost
          // placeholder. EVAL resends the source, the server caches it under
          // the same SHA1 the batched EVALSHA uses, and the nonce keeps the
          // late stamp paired to this write.
          stampReply = await client.customCommand(
            ["EVAL", WRITE_TRACKED_STAMP_SCRIPT, "2", valueKey, watermarkKey, ...stampArgs],
            execOptions,
          );
        }
        return resolveTrackedRedisWriteReply(stampReply);
      });
    },
    async invalidate({ watermarkKey, futureBufferMs }) {
      const raw = await run(() => client.invokeScript(scripts.invalidate, {
        keys: [watermarkKey],
        args: [String(futureBufferMs)],
        decoder: glide.Decoder.Bytes,
      }));
      validateRedisScriptInvalidationReply(raw);
    },
    dispose() {
      if (disposed) {
        return;
      }
      if (activeOperations > 0) {
        throw new Error("Cannot dispose Valkey GLIDE DialCache client while operations are in flight");
      }
      disposed = true;
      for (const script of Object.values(scripts)) {
        script.release();
      }
    },
  };
}

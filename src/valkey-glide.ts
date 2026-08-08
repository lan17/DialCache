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

// Redis caches EVAL'd sources under sha1(source), so these digests are by
// definition the ones the EVALSHA dispatches must use and the ones the EVAL
// recoveries repopulate.
const WRITE_TRACKED_STAMP_SHA1 = createHash("sha1").update(WRITE_TRACKED_STAMP_SCRIPT).digest("hex");
const INVALIDATE_CACHE_SHA1 = createHash("sha1").update(INVALIDATE_CACHE_SCRIPT).digest("hex");

// Matches the server's raw NOSCRIPT reply and GLIDE's mapped NoScriptError
// wording, case-insensitively so message-format drift cannot blind it.
function isNoScriptError(error: Error): boolean {
  return error.message.toLowerCase().includes("noscript");
}

interface ValkeyGlideBatch {
  customCommand(args: ValkeyGlideString[]): ValkeyGlideBatch;
  mget(keys: ValkeyGlideString[]): ValkeyGlideBatch;
}

export interface ValkeyGlideScriptingClient<TDecoder> {
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
}

interface ValkeyGlideClientIdentity {
  readonly [Symbol.hasInstance]: (value: unknown) => boolean;
}

export interface ValkeyGlideRuntime<TDecoder> {
  /** The Batch constructor exported by the same GLIDE module instance as the client. */
  readonly Batch: new (isAtomic: boolean) => ValkeyGlideBatch;
  /** The ClusterBatch constructor exported by the same GLIDE module instance as the client. */
  readonly ClusterBatch: new (isAtomic: boolean) => ValkeyGlideBatch;
  /** The standalone client class exported by the same GLIDE module instance as the client. */
  readonly GlideClient: ValkeyGlideClientIdentity;
  /** The cluster client class exported by the same GLIDE module instance as the client. */
  readonly GlideClusterClient: ValkeyGlideClientIdentity;
  /** The Decoder enum exported by the same GLIDE module instance as the client. */
  readonly Decoder: {
    readonly Bytes: TDecoder;
  };
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

function classifyValkeyGlideClient<TDecoder>(
  client: ValkeyGlideScriptingClient<TDecoder>,
  glide: ValkeyGlideRuntime<TDecoder>,
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

/**
 * Wrap a caller-owned GLIDE connection. The returned adapter is stateless —
 * it owns no native handles and needs no disposal — and preserves the
 * connection's `requestTimeout`. Pass the same GLIDE module namespace used to
 * create the client so native Batch objects come from that client's runtime.
 * Only direct GlideClient and GlideClusterClient instances are accepted;
 * wrappers should implement DialCacheRedisClient directly. A request
 * timeout bounds client waiting but is not server-side command cancellation.
 * GLIDE's current command API has no per-invocation signal, so DialCache's core
 * read deadline may return before this adapter's invocation settles. Tracked
 * standalone reads use a one-command primary batch, while tracked cluster
 * reads route MGET explicitly to the slot primary, so replica lag cannot hide
 * an invalidation watermark. Both mutation scripts dispatch as EVALSHA by
 * their source SHA1 and recover a flushed script cache by re-sending the
 * source as EVAL — which the server caches under that same SHA1 — so the
 * first mutation against a cold script cache pays one extra round trip.
 * Tracked writes batch a native placeholder SET with the stamp EVALSHA;
 * cluster write batches route to the slot primary. Batches are deliberately
 * non-atomic: MGET and SET are atomic themselves, an interleaved stamp is
 * safe by design, and MULTI/EXEC would consume caller-owned WATCH state.
 * Recovery differs by script: the stamp is retried only on NOSCRIPT, while
 * invalidation retries any rejection once with EVAL by source. When that
 * retry also fails, the original rejection is attached as the retry error's
 * `cause` unless it already carries one — safe here because GLIDE constructs
 * a fresh error object per rejection.
 */
export function createValkeyGlideDialCacheClient<TDecoder>(
  client: ValkeyGlideScriptingClient<TDecoder>,
  glide: ValkeyGlideRuntime<TDecoder>,
): DialCacheRedisClient {
  if (typeof glide.Batch !== "function" || typeof glide.ClusterBatch !== "function") {
    throw new Error(
      "Valkey GLIDE DialCache requires @valkey/valkey-glide >=2.0.0 with Batch and ClusterBatch constructors",
    );
  }
  const isCluster = classifyValkeyGlideClient(client, glide) === "cluster";
  // Keyed dispatch options: cluster commands pin the slot primary; standalone
  // commands carry only the byte decoder.
  const keyedOptions = (key: string): {
    decoder: TDecoder;
    route?: { type: "primarySlotKey"; key: string };
  } => isCluster
    ? { decoder: glide.Decoder.Bytes, route: { type: "primarySlotKey", key } }
    : { decoder: glide.Decoder.Bytes };

  return {
    async read({ valueKey, watermarkKey }) {
      if (watermarkKey === undefined) {
        const raw = await client.get(valueKey, { decoder: glide.Decoder.Bytes });
        return decodeRedisFrame(raw);
      }

      let pair: unknown;
      if (isCluster) {
        pair = await client.customCommand(
          ["MGET", valueKey, watermarkKey],
          keyedOptions(valueKey),
        );
      } else {
        const batch = new glide.Batch(false).mget([valueKey, watermarkKey]);
        const raw = await client.exec(batch, true, { decoder: glide.Decoder.Bytes });
        if (!Array.isArray(raw) || raw.length !== 1) {
          throw new DialCacheRedisPayloadError("Invalid DialCache Redis payload reply");
        }
        pair = raw[0];
      }
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new DialCacheRedisPayloadError("Invalid DialCache Redis payload reply");
      }
      return decodeTrackedRedisFrame(pair[0], pair[1]);
    },
    async write(request) {
      const { valueKey, watermarkKey, value } = request;
      const cacheTtlMs = ceilSupportedCacheTtlMs(request.cacheTtlMs);
      const execOptions = keyedOptions(valueKey);

      if (watermarkKey === undefined) {
        const frame = encodeRedisFrame(value, Date.now());
        validateRedisSetReply(
          await client.customCommand(["SET", valueKey, frame, "PX", String(cacheTtlMs)], execOptions),
        );
        return true;
      }

      const { frame, nonce } = encodeTrackedRedisPlaceholder(value);
      const stampArgs: ValkeyGlideString[] = [String(cacheTtlMs), nonce];
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
        if (!isNoScriptError(rawStamp)) {
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
    },
    async invalidate({ watermarkKey, futureBufferMs }) {
      const invalidateArgs: ValkeyGlideString[] = [String(futureBufferMs)];
      const options = keyedOptions(watermarkKey);
      let raw: unknown;
      try {
        raw = await client.customCommand(
          ["EVALSHA", INVALIDATE_CACHE_SHA1, "1", watermarkKey, ...invalidateArgs],
          options,
        );
      } catch (error) {
        // Any rejection is retried once with the source: the invalidation
        // script is idempotent (the watermark only advances and its TTL only
        // widens), so a duplicate run after an ambiguous failure is harmless,
        // and EVAL self-heals both a flushed script cache and an
        // EVALSHA-rejecting proxy without depending on error wording.
        try {
          raw = await client.customCommand(
            ["EVAL", INVALIDATE_CACHE_SCRIPT, "1", watermarkKey, ...invalidateArgs],
            options,
          );
        } catch (retryError) {
          // Mutating the rejection is safe on GLIDE only: it constructs a
          // fresh error per rejection, so no other caller holds this object
          // (node-redis shares flush errors and its adapter never mutates).
          if (retryError instanceof Error && retryError.cause === undefined) {
            retryError.cause = error;
          }
          throw retryError;
        }
      }
      validateRedisScriptInvalidationReply(raw);
    },
  };
}

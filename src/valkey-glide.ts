import { ceilSupportedCacheTtlMs } from "./internal/duration.js";
import {
  buildRedisInvalidationScriptArguments,
  INVALIDATE_CACHE_SCRIPT,
  INVALIDATE_CACHE_SCRIPT_SHA1,
} from "./internal/redis-invalidation.js";
import {
  assertValidRedisTimestampMs,
  decodeRedisFrame,
  decodeTrackedRedisReadResult,
  encodeRedisFrame,
} from "./internal/redis-payload.js";
import {
  validateRedisScriptInvalidationReply,
  validateRedisSetReply,
} from "./internal/redis-script-reply.js";
import { DialCacheRedisPayloadError, type DialCacheRedisClient } from "./redis-client.js";

type ValkeyGlideString = string | Buffer;

interface ValkeyGlideBatch {
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
 * an invalidation watermark. Every write is one native SET of a complete
 * client-stamped frame, routed to the slot primary for cluster clients.
 * Invalidation dispatches as EVALSHA by its source SHA1 and retries any
 * rejection once by re-sending the source as EVAL, which also repopulates a
 * flushed script cache. When that
 * retry also fails, the original rejection is attached as the retry error's
 * `cause` unless it already carries one.
 */
export function createValkeyGlideDialCacheClient<TDecoder>(
  client: ValkeyGlideScriptingClient<TDecoder>,
  glide: ValkeyGlideRuntime<TDecoder>,
): DialCacheRedisClient {
  if (typeof glide.Batch !== "function") {
    throw new Error(
      "Valkey GLIDE DialCache requires @valkey/valkey-glide >=2.0.0 with a Batch constructor",
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
      return decodeTrackedRedisReadResult(pair[0], pair[1]);
    },
    async write(request) {
      const { valueKey, value } = request;
      const cacheTtlMs = ceilSupportedCacheTtlMs(request.cacheTtlMs);
      const execOptions = keyedOptions(valueKey);
      const createdAtMs = request.createdAtMs === undefined ? Date.now() : request.createdAtMs;
      const frame = encodeRedisFrame(value, createdAtMs);
      validateRedisSetReply(
        await client.customCommand(["SET", valueKey, frame, "PX", String(cacheTtlMs)], execOptions),
      );
    },
    async invalidate({ watermarkKey, futureBufferMs }) {
      const invalidatedAtMs = Date.now();
      assertValidRedisTimestampMs(invalidatedAtMs);
      const invalidateArgs = buildRedisInvalidationScriptArguments(
        futureBufferMs,
        invalidatedAtMs,
      );
      const options = keyedOptions(watermarkKey);
      let raw: unknown;
      try {
        raw = await client.customCommand(
          ["EVALSHA", INVALIDATE_CACHE_SCRIPT_SHA1, "1", watermarkKey, ...invalidateArgs],
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

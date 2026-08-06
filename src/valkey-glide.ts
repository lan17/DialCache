import {
  decodeRedisFrame,
  decodeTrackedRedisFrame,
  redisPayloadEncoding,
} from "./internal/redis-payload.js";
import {
  INVALIDATE_CACHE_SCRIPT,
  WRITE_CACHE_SCRIPT,
  WRITE_TRACKED_CACHE_SCRIPT,
} from "./internal/redis-scripts.js";
import {
  validateRedisScriptInvalidationReply,
  validateRedisScriptWriteReply,
} from "./internal/redis-script-reply.js";
import { DialCacheRedisPayloadError, type DialCacheRedisClient } from "./redis-client.js";

type ValkeyGlideString = string | Buffer;

interface ValkeyGlideBatch {
  mget(keys: ValkeyGlideString[]): ValkeyGlideBatch;
}

interface ValkeyGlideClusterReadClient<TDecoder> {
  customCommand(
    args: ValkeyGlideString[],
    options: {
      decoder: TDecoder;
      route: { type: "primarySlotKey"; key: string };
    },
  ): Promise<unknown>;
}

export interface ValkeyGlideScriptHandle {
  /** Release the native GLIDE script registration. */
  release(): void;
}

export interface ValkeyGlideScriptingClient<TScript, TDecoder> {
  get(
    key: ValkeyGlideString,
    options: { decoder: TDecoder },
  ): Promise<unknown>;
  exec(
    batch: ValkeyGlideBatch,
    raiseOnError: boolean,
    options: { decoder: TDecoder },
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
  readonly write: TScript;
  readonly writeTracked: TScript;
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
 * three mutation Script handles and preserves the connection's
 * `requestTimeout`. Pass the same GLIDE module namespace used to create the
 * client so native Batch and Script objects come from that client's runtime.
 * Only direct GlideClient and GlideClusterClient instances are accepted;
 * wrappers should implement DialCacheRedisClient directly.
 * Callers dispose the handles after draining work, then close GLIDE. A request
 * timeout bounds client waiting but is not server-side command cancellation.
 * GLIDE's current command API has no per-invocation signal, so DialCache's core
 * read deadline may return before this adapter's invocation settles. Tracked
 * standalone reads use a one-command primary batch, while tracked cluster
 * reads route MGET explicitly to the slot primary, so replica lag cannot hide
 * an invalidation watermark. The standalone batch is deliberately non-atomic:
 * MGET itself is atomic, and MULTI/EXEC would consume caller-owned WATCH state.
 */
export function createValkeyGlideDialCacheClient<TScript extends ValkeyGlideScriptHandle, TDecoder>(
  client: ValkeyGlideScriptingClient<TScript, TDecoder>,
  glide: ValkeyGlideRuntime<TScript, TDecoder>,
): ValkeyGlideDialCacheClient {
  if (typeof glide.Batch !== "function") {
    throw new Error(
      "Valkey GLIDE DialCache requires @valkey/valkey-glide >=2.0.0 with a Batch constructor",
    );
  }
  const clientKind = classifyValkeyGlideClient(client, glide);
  const clusterClient = clientKind === "cluster"
    ? client as ValkeyGlideScriptingClient<TScript, TDecoder>
      & ValkeyGlideClusterReadClient<TDecoder>
    : undefined;
  const scripts: DialCacheGlideScripts<TScript> = {
    write: new glide.Script(WRITE_CACHE_SCRIPT),
    writeTracked: new glide.Script(WRITE_TRACKED_CACHE_SCRIPT),
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

  const invoke = async (
    script: TScript,
    keys: ValkeyGlideString[],
    args: ValkeyGlideString[] = [],
  ): Promise<unknown> => run(
    () => client.invokeScript(script, { keys, args, decoder: glide.Decoder.Bytes }),
  );

  return {
    async read({ valueKey, watermarkKey }) {
      if (watermarkKey === undefined) {
        const raw = await run(
          () => client.get(valueKey, { decoder: glide.Decoder.Bytes }),
        );
        return decodeRedisFrame(raw);
      }

      const pair = clusterClient !== undefined
        ? await run(
            () => clusterClient.customCommand(
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

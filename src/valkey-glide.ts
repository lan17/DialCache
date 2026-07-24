import { decodeRedisPayload, redisPayloadEncoding } from "./internal/redis-payload.js";
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
import { DialCacheRedisPayloadError, type DialCacheRedisClient } from "./redis-client.js";

type ValkeyGlideString = string | Buffer;

export interface ValkeyGlideScriptHandle {
  /** Release the native GLIDE script registration. */
  release(): void;
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
}

export interface ValkeyGlideRuntime<TScript extends ValkeyGlideScriptHandle, TDecoder> {
  /** The Script constructor exported by the same GLIDE module instance as the client. */
  readonly Script: new (source: string) => TScript;
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

export interface ValkeyGlideDialCacheClient extends DialCacheRedisClient {
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

  const invoke = async (
    script: TScript,
    keys: ValkeyGlideString[],
    args: ValkeyGlideString[] = [],
  ): Promise<unknown> => {
    if (disposed) {
      throw new Error("Valkey GLIDE DialCache client is disposed");
    }
    activeInvocations += 1;
    try {
      return await client.invokeScript(script, { keys, args, decoder: glide.Decoder.Bytes });
    } finally {
      activeInvocations -= 1;
    }
  };

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
            [String(cacheTtlMs), String(encoding), value, String(request.watermarkTtlFloorMs)],
          );
      return validateRedisScriptWriteReply(raw) === 1;
    },
    async invalidate({ watermarkKey, futureBufferMs, watermarkTtlFloorMs }) {
      const raw = await invoke(
        scripts.invalidate,
        [watermarkKey],
        [String(futureBufferMs), String(watermarkTtlFloorMs)],
      );
      validateRedisScriptInvalidationReply(raw);
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

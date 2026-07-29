import { commandOptions, defineScript } from "redis";

import type {
  DialCacheInvalidationCoordinator,
  DialCacheInvalidationCoordinatorListener,
} from "./invalidation.js";
import { InvalidationCoordinator } from "./internal/invalidation-coordinator.js";
import { decodeRedisInvalidationEvent } from "./internal/invalidation-event.js";
import {
  INVALIDATE_AND_PUBLISH_CACHE_SCRIPT,
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
import { DialCacheRedisProtocolError } from "./redis-client.js";
import type {
  DialCacheCoordinatedRedisClient,
  DialCacheRedisClient,
  RedisCoordinatedInvalidationRequest,
} from "./redis-client.js";

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
const coordinatedInvalidationReply = (reply: string): string => {
  if (typeof reply !== "string") {
    throw new DialCacheRedisProtocolError(
      "Invalid DialCache Redis coordinated invalidation reply; expected an event payload",
    );
  }
  decodeRedisInvalidationEvent(reply);
  return reply;
};
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
  readonly dialcacheInvalidateAndPublish: NodeRedisScript<
    [
      watermarkKey: string,
      futureBufferMs: number,
      channel: string,
      namespace: string,
      keyType: string,
      id: string,
    ],
    string
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
  dialcacheInvalidateAndPublish: defineDialCacheScript({
    SCRIPT: INVALIDATE_AND_PUBLISH_CACHE_SCRIPT,
    NUMBER_OF_KEYS: 1,
    FIRST_KEY_INDEX: 0,
    IS_READ_ONLY: false,
    transformArguments(
      watermarkKey: string,
      futureBufferMs: number,
      channel: string,
      namespace: string,
      keyType: string,
      id: string,
    ): Array<string> {
      return [watermarkKey, String(futureBufferMs), channel, namespace, keyType, id];
    },
    transformReply: coordinatedInvalidationReply,
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
}

interface CoordinatedNodeRedisScriptClient extends NodeRedisScriptClient {
  dialcacheInvalidateAndPublish(
    watermarkKey: string,
    futureBufferMs: number,
    channel: string,
    namespace: string,
    keyType: string,
    id: string,
  ): Promise<string>;
}

/**
 * Create a resource-free semantic view over a caller-owned node-redis client.
 * Read signals are passed to node-redis so queued commands can be removed when
 * supported. Aborting after dispatch does not unsend a command or prove the
 * server stopped executing it. The caller remains responsible for finite
 * native command budgets, draining work, and closing the client.
 */
export function createNodeRedisDialCacheClient(
  client: CoordinatedNodeRedisScriptClient,
): DialCacheCoordinatedRedisClient;
export function createNodeRedisDialCacheClient(client: NodeRedisScriptClient): DialCacheRedisClient;
export function createNodeRedisDialCacheClient(
  client: NodeRedisScriptClient,
): DialCacheRedisClient | DialCacheCoordinatedRedisClient {
  const adapter: DialCacheRedisClient = {
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
  };
  if (!isCoordinatedScriptClient(client)) {
    return adapter;
  }

  return {
    ...adapter,
    async invalidateAndPublish(request: RedisCoordinatedInvalidationRequest) {
      const payload = await client.dialcacheInvalidateAndPublish(
        request.watermarkKey,
        request.futureBufferMs,
        request.channel,
        request.namespace,
        request.keyType,
        request.id,
      );
      return decodeRedisInvalidationEvent(payload, request);
    },
  };
}

function isCoordinatedScriptClient(
  client: NodeRedisScriptClient,
): client is CoordinatedNodeRedisScriptClient {
  return typeof (client as Partial<CoordinatedNodeRedisScriptClient>).dialcacheInvalidateAndPublish
    === "function";
}

type NodeRedisBufferListener = (message: Buffer, channel: Buffer) => unknown;

/**
 * Minimal node-redis standalone subscriber surface. Redis Cluster command
 * clients may still publish; use a dedicated standalone subscriber connected
 * to a cluster node because the node-redis Cluster facade does not expose the
 * reconnect/ready lifecycle needed by this contract.
 */
export interface DialCacheNodeRedisSubscriberClient {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  readonly isPubSubActive: boolean;
  subscribe(channel: string, listener: NodeRedisBufferListener, bufferMode: true): Promise<void>;
  unsubscribe(channel: string, listener: NodeRedisBufferListener, bufferMode: true): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "reconnecting" | "ready" | "end", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "reconnecting" | "ready" | "end", listener: () => void): unknown;
}

export interface DialCacheNodeRedisInvalidationCoordinator
  extends DialCacheInvalidationCoordinator {
  readonly channel: string;
  dispose(): Promise<void>;
}

/**
 * Attach coordinated invalidation to a caller-created, connected, dedicated
 * node-redis standalone subscriber. The helper owns only its subscription and
 * EventEmitter listeners; it never creates, connects, or closes the client.
 * The returned promise settles only after the initial exact-channel
 * subscription acknowledgement. Dispose DialCache listeners first, then this
 * coordinator, then close the caller-owned subscriber. The caller must install
 * and retain its own node-redis `error` listener before connecting; the helper
 * removes its internal listener during disposal.
 */
export async function createNodeRedisDialCacheInvalidationCoordinator(
  subscriber: DialCacheNodeRedisSubscriberClient,
  options: { readonly namespace?: string } = {},
): Promise<DialCacheNodeRedisInvalidationCoordinator> {
  if (!subscriber.isOpen || !subscriber.isReady) {
    throw new TypeError("DialCache node-redis subscriber must already be connected and ready");
  }
  if (subscriber.isPubSubActive) {
    throw new TypeError("DialCache node-redis subscriber must be dedicated and unsubscribed");
  }

  const coordinator = new InvalidationCoordinator(options.namespace ?? "urn");
  const expectedChannel = Buffer.from(coordinator.channel);
  // A ready acknowledgement may recover transport loss, but it must not erase
  // a malformed event observed after that subscribe/resubscribe attempt began.
  let protocolFailureEpoch = 0;
  let recoveryProtocolFailureEpoch = protocolFailureEpoch;
  const markProtocolFailure = (error: unknown): void => {
    protocolFailureEpoch += 1;
    coordinator.unavailable(error);
  };
  const beginTransportRecovery = (error: unknown): void => {
    recoveryProtocolFailureEpoch = protocolFailureEpoch;
    coordinator.unavailable(error);
  };
  const onMessage: NodeRedisBufferListener = (message, channel) => {
    try {
      if (!channel.equals(expectedChannel)) {
        markProtocolFailure(
          new DialCacheRedisProtocolError("Invalid DialCache invalidation channel"),
        );
        return;
      }
      if (!coordinator.receive(message)) {
        protocolFailureEpoch += 1;
      }
    } catch (error) {
      // node-redis invokes Pub/Sub listeners synchronously without containing
      // callback exceptions.
      markProtocolFailure(error);
    }
  };
  const onError = (error: Error): void => beginTransportRecovery(error);
  const onReconnecting = (): void => {
    beginTransportRecovery(new Error("DialCache node-redis subscriber reconnecting"));
  };
  // node-redis 4.7 emits ready only after its automatic Pub/Sub resubscribe
  // acknowledgement has completed.
  const onReady = (): void => {
    if (protocolFailureEpoch === recoveryProtocolFailureEpoch) {
      coordinator.ready();
    }
  };
  const onEnd = (): void => {
    beginTransportRecovery(new Error("DialCache node-redis subscriber ended"));
  };

  subscriber.on("error", onError);
  subscriber.on("reconnecting", onReconnecting);
  subscriber.on("ready", onReady);
  subscriber.on("end", onEnd);

  const initialProtocolFailureEpoch = protocolFailureEpoch;
  try {
    await subscriber.subscribe(coordinator.channel, onMessage, true);
    if (protocolFailureEpoch === initialProtocolFailureEpoch) {
      coordinator.ready();
    }
  } catch (error) {
    coordinator.dispose();
    detachNodeRedisListeners(subscriber, { onError, onReconnecting, onReady, onEnd });
    if (subscriber.isOpen) {
      try {
        await subscriber.unsubscribe(coordinator.channel, onMessage, true);
      } catch {
        // Preserve the subscription failure that prevented factory completion.
      }
    }
    throw error;
  }

  let disposePromise: Promise<void> | null = null;
  return {
    get namespace() {
      return coordinator.namespace;
    },
    get channel() {
      return coordinator.channel;
    },
    get state() {
      return coordinator.state;
    },
    addListener(listener: DialCacheInvalidationCoordinatorListener) {
      return coordinator.addListener(listener);
    },
    invalidate(invalidation) {
      coordinator.invalidate(invalidation);
    },
    dispose() {
      if (disposePromise !== null) {
        return disposePromise;
      }

      let resolveDispose!: () => void;
      let rejectDispose!: (error: unknown) => void;
      disposePromise = new Promise<void>((resolve, reject) => {
        resolveDispose = resolve;
        rejectDispose = reject;
      });

      try {
        coordinator.dispose();
        detachNodeRedisListeners(subscriber, { onError, onReconnecting, onReady, onEnd });
      } catch (error) {
        rejectDispose(error);
        return disposePromise;
      }

      void (async () => {
        if (subscriber.isOpen) {
          await subscriber.unsubscribe(coordinator.channel, onMessage, true);
        }
      })().then(resolveDispose, rejectDispose);
      return disposePromise;
    },
  };
}

interface NodeRedisHealthListeners {
  readonly onError: (error: Error) => void;
  readonly onReconnecting: () => void;
  readonly onReady: () => void;
  readonly onEnd: () => void;
}

function detachNodeRedisListeners(
  subscriber: DialCacheNodeRedisSubscriberClient,
  listeners: NodeRedisHealthListeners,
): void {
  subscriber.off("error", listeners.onError);
  subscriber.off("reconnecting", listeners.onReconnecting);
  subscriber.off("ready", listeners.onReady);
  subscriber.off("end", listeners.onEnd);
}

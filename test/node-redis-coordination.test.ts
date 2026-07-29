import { describe, expect, it, vi } from "vitest";

import type { DialCacheInvalidationCoordinatorListener } from "../src/invalidation.js";
import {
  createNodeRedisDialCacheClient,
  createNodeRedisDialCacheInvalidationCoordinator,
  dialcacheRedisScripts,
  type DialCacheNodeRedisSubscriberClient,
} from "../src/node-redis.js";
import { INVALIDATE_AND_PUBLISH_CACHE_SCRIPT } from "../src/redis-protocol.js";
import { DialCacheRedisProtocolError } from "../src/redis-client.js";

const event = {
  version: 1,
  namespace: "users",
  keyType: "user_id",
  id: "123",
  effectiveWatermarkMs: "1785300001000",
  redisNowMs: "1785300000000",
} as const;
const payload = JSON.stringify(event);

describe("node-redis coordinated invalidation script adapter", () => {
  it("registers one-key write routing and the exact argument order", () => {
    const script = dialcacheRedisScripts.dialcacheInvalidateAndPublish;

    expect(script.SCRIPT).toBe(INVALIDATE_AND_PUBLISH_CACHE_SCRIPT);
    expect(script.NUMBER_OF_KEYS).toBe(1);
    expect(script.FIRST_KEY_INDEX).toBe(0);
    expect(script.IS_READ_ONLY).toBe(false);
    expect(script.transformArguments(
      "{users:user_id:123}#watermark",
      250,
      "dialcache:invalidation:v1:users",
      "users",
      "user_id",
      "123",
    )).toEqual([
      "{users:user_id:123}#watermark",
      "250",
      "dialcache:invalidation:v1:users",
      "users",
      "user_id",
      "123",
    ]);
    expect(script.transformReply(payload)).toBe(payload);
  });

  it.each([
    1,
    null,
    undefined,
    "{}",
    "{",
    JSON.stringify({ ...event, version: 2 }),
  ])("rejects malformed coordinated script reply %j", (reply) => {
    expect(() => dialcacheRedisScripts.dialcacheInvalidateAndPublish.transformReply(
      reply as string,
    )).toThrow(DialCacheRedisProtocolError);
  });

  it("adds the coordinated method only when the registered script is present", async () => {
    const client = coordinatedScriptClient(payload);
    const adapter = createNodeRedisDialCacheClient(client);

    await expect(adapter.invalidateAndPublish({
      watermarkKey: "{users:user_id:123}#watermark",
      futureBufferMs: 1_000,
      channel: "dialcache:invalidation:v1:users",
      namespace: "users",
      keyType: "user_id",
      id: "123",
    })).resolves.toEqual(event);
    expect(client.dialcacheInvalidateAndPublish).toHaveBeenCalledWith(
      "{users:user_id:123}#watermark",
      1_000,
      "dialcache:invalidation:v1:users",
      "users",
      "user_id",
      "123",
    );

    const legacy = createNodeRedisDialCacheClient(baseScriptClient());
    expect("invalidateAndPublish" in legacy).toBe(false);
  });

  it("rejects a returned event that does not match the requested identity", async () => {
    const adapter = createNodeRedisDialCacheClient(
      coordinatedScriptClient(JSON.stringify({ ...event, id: "other" })),
    );

    await expect(adapter.invalidateAndPublish({
      watermarkKey: "{users:user_id:123}#watermark",
      futureBufferMs: 0,
      channel: "dialcache:invalidation:v1:users",
      namespace: "users",
      keyType: "user_id",
      id: "123",
    })).rejects.toThrow(/event identity/);
  });
});

describe("node-redis invalidation coordinator", () => {
  it("awaits subscription acknowledgement and delivers Buffer events", async () => {
    const subscriber = new FakeSubscriber();
    const acknowledgement = deferred<void>();
    subscriber.subscribeGate = acknowledgement.promise;

    let settled = false;
    const pending = createNodeRedisDialCacheInvalidationCoordinator(subscriber, {
      namespace: "users",
    }).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      "dialcache:invalidation:v1:users",
      expect.any(Function),
      true,
    );
    expect(subscriber.listenerCount("error")).toBe(1);
    acknowledgement.resolve();
    const coordinator = await pending;
    expect(coordinator.state).toBe("ready");

    const recording = listener();
    coordinator.addListener(recording.value);
    subscriber.publish(Buffer.from(payload));
    expect(recording.invalidations).toEqual([{
      namespace: "users",
      keyType: "user_id",
      id: "123",
      remainingMs: 1_000,
      source: "event",
    }]);

    await coordinator.dispose();
  });

  it("does not erase a protocol failure delivered with the initial subscribe acknowledgement", async () => {
    const subscriber = new FakeSubscriber();
    subscriber.subscribeAcknowledgementHook = () => {
      subscriber.publish(Buffer.from([0xff]));
    };

    const coordinator = await createNodeRedisDialCacheInvalidationCoordinator(subscriber, {
      namespace: "users",
    });

    expect(coordinator.state).toBe("unavailable");
    subscriber.emit("ready");
    expect(coordinator.state).toBe("unavailable");

    subscriber.emit("reconnecting");
    subscriber.emit("ready");
    expect(coordinator.state).toBe("ready");
    await coordinator.dispose();
  });

  it("tracks reconnect, ready-after-resubscribe, error, and end transitions", async () => {
    const subscriber = new FakeSubscriber();
    const coordinator = await createNodeRedisDialCacheInvalidationCoordinator(subscriber, {
      namespace: "users",
    });
    const recording = listener();
    coordinator.addListener(recording.value);

    subscriber.emit("reconnecting");
    subscriber.emit("ready");
    const redisError = new Error("socket failed");
    subscriber.emit("error", redisError);
    subscriber.emit("ready");
    subscriber.emit("end");

    expect(recording.states).toEqual([
      ["ready", undefined],
      ["unavailable", expect.any(Error)],
      ["ready", undefined],
      ["unavailable", redisError],
      ["ready", undefined],
      ["unavailable", expect.any(Error)],
    ]);
    await coordinator.dispose();
  });

  it("contains malformed callbacks and remains unavailable until acknowledged recovery", async () => {
    const subscriber = new FakeSubscriber();
    const coordinator = await createNodeRedisDialCacheInvalidationCoordinator(subscriber, {
      namespace: "users",
    });
    const recording = listener();
    coordinator.addListener(recording.value);

    expect(() => subscriber.publish(Buffer.from([0xff]))).not.toThrow();
    expect(coordinator.state).toBe("unavailable");
    subscriber.publish(Buffer.from(payload));
    expect(recording.invalidations).toHaveLength(1);
    expect(coordinator.state).toBe("unavailable");

    subscriber.emit("ready");
    expect(coordinator.state).toBe("unavailable");
    subscriber.emit("reconnecting");
    subscriber.emit("ready");
    expect(coordinator.state).toBe("ready");
    subscriber.publish(Buffer.from(payload), Buffer.from("wrong"));
    expect(coordinator.state).toBe("unavailable");
    await coordinator.dispose();
  });

  it("does not erase a protocol failure received between reconnect and ready", async () => {
    const subscriber = new FakeSubscriber();
    const coordinator = await createNodeRedisDialCacheInvalidationCoordinator(subscriber, {
      namespace: "users",
    });

    subscriber.emit("reconnecting");
    subscriber.publish(Buffer.from([0xff]));
    subscriber.emit("ready");
    expect(coordinator.state).toBe("unavailable");

    subscriber.emit("reconnecting");
    subscriber.emit("ready");
    expect(coordinator.state).toBe("ready");
    await coordinator.dispose();
  });

  it("unsubscribes only its listener, detaches health listeners, and never closes the client", async () => {
    const subscriber = new FakeSubscriber();
    const coordinator = await createNodeRedisDialCacheInvalidationCoordinator(subscriber, {
      namespace: "users",
    });
    const recording = listener();
    coordinator.addListener(recording.value);
    const unsubscribe = deferred<void>();
    subscriber.unsubscribeGate = unsubscribe.promise;
    let reentrantDispose: Promise<void> | undefined;
    coordinator.addListener({
      onInvalidation: () => undefined,
      onStateChange: (state) => {
        if (state === "disposed") {
          reentrantDispose = coordinator.dispose();
        }
      },
    });

    const firstDispose = coordinator.dispose();
    const secondDispose = coordinator.dispose();
    expect(reentrantDispose).toBe(firstDispose);
    expect(secondDispose).toBe(firstDispose);
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.listenerCount("error")).toBe(0);
    expect(subscriber.listenerCount("reconnecting")).toBe(0);
    expect(subscriber.listenerCount("ready")).toBe(0);
    expect(subscriber.listenerCount("end")).toBe(0);

    subscriber.emit("ready");
    subscriber.emit("error", new Error("late error"));
    expect(coordinator.state).toBe("disposed");

    unsubscribe.resolve();
    await Promise.all([firstDispose, secondDispose]);

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(
      "dialcache:invalidation:v1:users",
      expect.any(Function),
      true,
    );
    expect(subscriber.isOpen).toBe(true);
    expect(recording.states.at(-1)).toEqual(["disposed", undefined]);
  });

  it("attempts listener-specific unsubscribe while an open client reports inactive Pub/Sub", async () => {
    const subscriber = new FakeSubscriber();
    const coordinator = await createNodeRedisDialCacheInvalidationCoordinator(subscriber, {
      namespace: "users",
    });
    subscriber.isPubSubActive = false;

    await coordinator.dispose();

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(
      "dialcache:invalidation:v1:users",
      expect.any(Function),
      true,
    );
  });

  it.each([
    { isOpen: false, isReady: false, isPubSubActive: false, message: /connected and ready/ },
    { isOpen: true, isReady: false, isPubSubActive: false, message: /connected and ready/ },
    { isOpen: true, isReady: true, isPubSubActive: true, message: /dedicated and unsubscribed/ },
  ])("rejects invalid caller-owned subscriber state", async (state) => {
    const subscriber = new FakeSubscriber();
    subscriber.isOpen = state.isOpen;
    subscriber.isReady = state.isReady;
    subscriber.isPubSubActive = state.isPubSubActive;

    await expect(createNodeRedisDialCacheInvalidationCoordinator(subscriber))
      .rejects.toThrow(state.message);
    expect(subscriber.subscribe).not.toHaveBeenCalled();
  });

  it("cleans up helper listeners when initial subscribe fails", async () => {
    const subscriber = new FakeSubscriber();
    const failure = new Error("subscribe failed");
    subscriber.subscribe.mockRejectedValueOnce(failure);

    await expect(createNodeRedisDialCacheInvalidationCoordinator(subscriber))
      .rejects.toBe(failure);
    expect(subscriber.listenerCount("error")).toBe(0);
    expect(subscriber.listenerCount("ready")).toBe(0);
    expect(subscriber.isOpen).toBe(true);
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

function baseScriptClient() {
  return {
    dialcacheRead: vi.fn(async () => null),
    dialcacheReadTracked: vi.fn(async () => null),
    dialcacheWrite: vi.fn(async () => 1),
    dialcacheWriteTracked: vi.fn(async () => 1),
    dialcacheInvalidate: vi.fn(async () => 1),
  };
}

function coordinatedScriptClient(reply: string) {
  return {
    ...baseScriptClient(),
    dialcacheInvalidateAndPublish: vi.fn(async () => reply),
  };
}

type SubscriberEvent = "error" | "reconnecting" | "ready" | "end";
type SubscriberHandler = (...args: never[]) => void;

class FakeSubscriber implements DialCacheNodeRedisSubscriberClient {
  isOpen = true;
  isReady = true;
  isPubSubActive = false;
  subscribeGate: Promise<void> | null = null;
  subscribeAcknowledgementHook: (() => void) | null = null;
  unsubscribeGate: Promise<void> | null = null;
  private messageListener: ((message: Buffer, channel: Buffer) => unknown) | null = null;
  private subscribedChannel = "";
  private readonly handlers = new Map<SubscriberEvent, Set<SubscriberHandler>>();

  readonly subscribe = vi.fn(async (
    channel: string,
    listener: (message: Buffer, channel: Buffer) => unknown,
    _bufferMode: true,
  ) => {
    this.isPubSubActive = true;
    this.subscribedChannel = channel;
    this.messageListener = listener;
    if (this.subscribeGate !== null) {
      await this.subscribeGate;
    }
    this.subscribeAcknowledgementHook?.();
  });

  readonly unsubscribe = vi.fn(async (
    _channel: string,
    listener: (message: Buffer, channel: Buffer) => unknown,
    _bufferMode: true,
  ) => {
    if (this.unsubscribeGate !== null) {
      await this.unsubscribeGate;
    }
    if (this.messageListener === listener) {
      this.messageListener = null;
      this.isPubSubActive = false;
    }
  });

  on(event: "error", listener: (error: Error) => void): this;
  on(event: "reconnecting" | "ready" | "end", listener: () => void): this;
  on(event: SubscriberEvent, listener: SubscriberHandler): this {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(listener);
    this.handlers.set(event, handlers);
    return this;
  }

  off(event: "error", listener: (error: Error) => void): this;
  off(event: "reconnecting" | "ready" | "end", listener: () => void): this;
  off(event: SubscriberEvent, listener: SubscriberHandler): this {
    this.handlers.get(event)?.delete(listener);
    return this;
  }

  emit(event: "error", error: Error): void;
  emit(event: "reconnecting" | "ready" | "end"): void;
  emit(event: SubscriberEvent, error?: Error): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(error as never);
    }
  }

  publish(message: Buffer, channel = Buffer.from(this.subscribedChannel)): void {
    this.messageListener?.(message, channel);
  }

  listenerCount(event: SubscriberEvent): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

function listener(): {
  readonly value: DialCacheInvalidationCoordinatorListener;
  readonly states: Array<readonly [string, unknown]>;
  readonly invalidations: unknown[];
} {
  const states: Array<readonly [string, unknown]> = [];
  const invalidations: unknown[] = [];
  return {
    states,
    invalidations,
    value: {
      onInvalidation: (invalidation) => invalidations.push(invalidation),
      onStateChange: (state, error) => states.push([state, error]),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

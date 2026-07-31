import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  DialCacheRedisProtocolError,
} from "../src/index.js";
import { redisClusterSlot } from "../src/internal/redis-cluster-slot.js";
import { createNodeRedisDialCacheClient, dialcacheRedisScripts } from "../src/node-redis.js";

const INVALID_WRITE_REPLIES: readonly unknown[] = [
  -1,
  2,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "1",
  1n,
  true,
  null,
  undefined,
];
const INVALID_INVALIDATION_REPLIES: readonly unknown[] = [0, ...INVALID_WRITE_REPLIES];

interface FakeReplies {
  readonly read?: Buffer | null;
  readonly readTracked?: Buffer | null;
  readonly write?: unknown;
  readonly writeTracked?: unknown;
  readonly invalidate?: unknown;
}

function fakeClient(replies: FakeReplies = {}) {
  return {
    dialcacheRead: vi.fn(async () => Object.hasOwn(replies, "read") ? replies.read : null),
    dialcacheReadTracked: vi.fn(async () => Object.hasOwn(replies, "readTracked") ? replies.readTracked : null),
    dialcacheWrite: vi.fn(async () => Object.hasOwn(replies, "write") ? replies.write : 1),
    dialcacheWriteTracked: vi.fn(async () => Object.hasOwn(replies, "writeTracked") ? replies.writeTracked : 1),
    dialcacheInvalidate: vi.fn(async () => Object.hasOwn(replies, "invalidate") ? replies.invalidate : 1),
  };
}

interface FakePipeline {
  readonly routing: string | Buffer | undefined;
  readonly commands: Array<readonly [watermarkKey: string, futureBufferMs: number]>;
  readonly execAsPipeline: ReturnType<typeof vi.fn>;
}

interface FakeClusterSlot {
  readonly master: {
    readonly id: string;
  };
}

function fakeClusterSlots(
  entries: readonly (readonly [key: string, ownerId: string])[],
): Array<FakeClusterSlot | undefined> {
  const slots: Array<FakeClusterSlot | undefined> = [];
  for (const [key, ownerId] of entries) {
    slots[redisClusterSlot(key)] = { master: { id: ownerId } };
  }
  return slots;
}

function fakeBatchClient(options: {
  readonly cluster?: boolean;
  readonly slots?: readonly (FakeClusterSlot | undefined)[];
  readonly execute?: (pipeline: FakePipeline) => Promise<unknown[]>;
} = {}) {
  const pipelines: FakePipeline[] = [];
  const client = {
    ...fakeClient(),
    ...(options.cluster === true || options.slots !== undefined
      ? { slots: options.slots ?? [] }
      : {}),
    multi: vi.fn((routing?: string | Buffer) => {
      const commands: Array<readonly [string, number]> = [];
      const pipeline: FakePipeline & {
        dialcacheInvalidate(watermarkKey: string, futureBufferMs: number): unknown;
      } = {
        routing,
        commands,
        dialcacheInvalidate(watermarkKey: string, futureBufferMs: number) {
          commands.push([watermarkKey, futureBufferMs]);
          return pipeline;
        },
        execAsPipeline: vi.fn(async () =>
          options.execute === undefined
            ? commands.map(() => 1)
            : await options.execute(pipeline)),
      };
      pipelines.push(pipeline);
      return pipeline;
    }),
  };
  return { client, pipelines };
}

async function expectProtocolError(operation: Promise<unknown>, message: string): Promise<void> {
  let rejection: unknown;
  try {
    await operation;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(DialCacheRedisProtocolError);
  expect(rejection).toMatchObject({ name: "DialCacheRedisProtocolError", message });
}

describe("node-redis adapter", () => {
  it("provides the expected arguments for every bundled script", () => {
    const binary = Buffer.from([0, 0xff]);

    expect(dialcacheRedisScripts.dialcacheRead.transformArguments("plain:value")).toEqual(["plain:value"]);
    expect(
      dialcacheRedisScripts.dialcacheReadTracked.transformArguments(
        "tracked:{id}:value",
        "tracked:{id}:watermark",
      ),
    ).toEqual(["tracked:{id}:value", "tracked:{id}:watermark"]);
    expect(dialcacheRedisScripts.dialcacheWrite.transformArguments("plain:value", 1_000, 0, "plain")).toEqual([
      "plain:value",
      "1000",
      "0",
      "plain",
    ]);
    expect(
      dialcacheRedisScripts.dialcacheWriteTracked.transformArguments(
        "tracked:{id}:value",
        "tracked:{id}:watermark",
        1_000,
        1,
        binary,
      ),
    ).toEqual(["tracked:{id}:value", "tracked:{id}:watermark", "1000", "1", binary]);
    expect(
      dialcacheRedisScripts.dialcacheInvalidate.transformArguments("tracked:{id}:watermark", 50),
    ).toEqual(["tracked:{id}:watermark", "50"]);
  });

  it("accepts the exact write and invalidation reply domains", async () => {
    const client = fakeClient({
      read: Buffer.from([0, ...Buffer.from("plain")]),
      readTracked: Buffer.from([1, 0, 0xff]),
      write: 1,
      writeTracked: 0,
      invalidate: 1,
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.read({ valueKey: "plain:value" })).resolves.toBe("plain");
    await expect(
      adapter.read({ valueKey: "tracked:{id}:value", watermarkKey: "tracked:{id}:watermark" }),
    ).resolves.toEqual(Buffer.from([0, 0xff]));
    await expect(
      adapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" }),
    ).resolves.toBe(true);
    await expect(
      adapter.write({
        valueKey: "tracked:{id}:value",
        watermarkKey: "tracked:{id}:watermark",
        cacheTtlMs: 1_000,
        value: "tracked",
      }),
    ).resolves.toBe(false);
    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
    ).resolves.toBeUndefined();
  });

  it("pipelines a standalone invalidation batch in one explicitly routed call", async () => {
    const { client, pipelines } = fakeBatchClient();
    const adapter = createNodeRedisDialCacheClient(client as never);

    await adapter.invalidateMany?.([
      { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
      { watermarkKey: "cache:{two}:watermark", futureBufferMs: 250 },
    ]);

    expect(client.multi).toHaveBeenCalledOnce();
    expect(client.multi).toHaveBeenCalledWith("cache:{one}:watermark");
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.commands).toEqual([
      ["cache:{one}:watermark", 0],
      ["cache:{two}:watermark", 250],
    ]);
    expect(pipelines[0]?.execAsPipeline).toHaveBeenCalledOnce();
  });

  it("bounds standalone pipelines and dispatches their chunks sequentially", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requests = Array.from({ length: 1_001 }, (_, index) => ({
      watermarkKey: `cache:{standalone-${index}}:watermark`,
      futureBufferMs: index,
    }));
    const { client, pipelines } = fakeBatchClient({
      execute: async ({ routing, commands }) => {
        if (routing === requests[0]?.watermarkKey) {
          await firstGate;
        }
        return commands.map(() => 1);
      },
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    const operation = adapter.invalidateMany?.(requests) ?? Promise.resolve();
    await vi.waitFor(() => expect(pipelines).toHaveLength(1));
    expect(pipelines[0]?.commands).toHaveLength(1_000);

    releaseFirst();
    await operation;
    expect(client.multi).toHaveBeenCalledTimes(2);
    expect(pipelines).toHaveLength(2);
    expect(pipelines[1]).toMatchObject({
      routing: requests[1_000]?.watermarkKey,
      commands: [[requests[1_000]?.watermarkKey, 1_000]],
    });
  });

  it("does not dispatch later standalone chunks after one fails", async () => {
    const firstError = new Error("first chunk failed");
    const requests = Array.from({ length: 1_001 }, (_, index) => ({
      watermarkKey: `cache:{failed-standalone-${index}}:watermark`,
      futureBufferMs: index,
    }));
    const { client, pipelines } = fakeBatchClient({
      execute: async () => { throw firstError; },
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.invalidateMany?.(requests) ?? Promise.resolve()).rejects.toBe(firstError);
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.commands).toHaveLength(1_000);
  });

  it("partitions node-redis Cluster pipelines by current primary owner", async () => {
    const first = "cache:{one}:watermark";
    const second = "cache:{two}:watermark";
    const third = "cache:{three}:watermark";
    const { client, pipelines } = fakeBatchClient({
      slots: fakeClusterSlots([
        [first, "primary-a"],
        [second, "primary-b"],
        [third, "primary-a"],
      ]),
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    await adapter.invalidateMany?.([
      { watermarkKey: first, futureBufferMs: 10 },
      { watermarkKey: second, futureBufferMs: 20 },
      { watermarkKey: third, futureBufferMs: 30 },
    ]);

    expect(redisClusterSlot(first)).not.toBe(redisClusterSlot(third));
    expect(client.multi).toHaveBeenCalledTimes(2);
    expect(pipelines.map(({ routing }) => routing)).toEqual([first, second]);
    expect(pipelines[0]?.commands).toEqual([
      [first, 10],
      [third, 30],
    ]);
    expect(pipelines[1]?.commands).toEqual([[second, 20]]);
  });

  it("runs Cluster owners concurrently and each owner's bounded chunks sequentially", async () => {
    let releaseFirstOwner!: () => void;
    const firstOwnerGate = new Promise<void>((resolve) => {
      releaseFirstOwner = resolve;
    });
    const firstOwnerRequests = Array.from({ length: 1_001 }, (_, index) => ({
      watermarkKey: `cache:{primary-a-${index}}:watermark`,
      futureBufferMs: index,
    }));
    const firstOwnerSlots = new Set(
      firstOwnerRequests.map(({ watermarkKey }) => redisClusterSlot(watermarkKey)),
    );
    let secondOwnerKey = "";
    for (let index = 0; index < 16_384; index += 1) {
      const candidate = `cache:{primary-b-${index}}:watermark`;
      if (!firstOwnerSlots.has(redisClusterSlot(candidate))) {
        secondOwnerKey = candidate;
        break;
      }
    }
    expect(secondOwnerKey).not.toBe("");

    const { client, pipelines } = fakeBatchClient({
      slots: fakeClusterSlots([
        ...firstOwnerRequests.map(({ watermarkKey }) => [watermarkKey, "primary-a"] as const),
        [secondOwnerKey, "primary-b"],
      ]),
      execute: async ({ routing, commands }) => {
        if (routing === firstOwnerRequests[0]?.watermarkKey) {
          await firstOwnerGate;
        }
        return commands.map(() => 1);
      },
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    const operation = adapter.invalidateMany?.([
      ...firstOwnerRequests,
      { watermarkKey: secondOwnerKey, futureBufferMs: 2_000 },
    ]) ?? Promise.resolve();
    await vi.waitFor(() => expect(pipelines).toHaveLength(2));
    expect(pipelines.map(({ routing }) => routing)).toEqual([
      firstOwnerRequests[0]?.watermarkKey,
      secondOwnerKey,
    ]);
    expect(pipelines[0]?.commands).toHaveLength(1_000);
    expect(pipelines[1]?.commands).toEqual([[secondOwnerKey, 2_000]]);
    expect(pipelines[1]?.execAsPipeline).toHaveBeenCalledOnce();

    releaseFirstOwner();
    await operation;
    expect(pipelines).toHaveLength(3);
    expect(pipelines[2]).toMatchObject({
      routing: firstOwnerRequests[1_000]?.watermarkKey,
      commands: [[firstOwnerRequests[1_000]?.watermarkKey, 1_000]],
    });
  });

  it("routes requests with unmapped Cluster slots through registered scalar scripts", async () => {
    const mappedOne = "cache:{mapped-one}:watermark";
    const unmappedOne = "cache:{unmapped-one}:watermark";
    const mappedTwo = "cache:{mapped-two}:watermark";
    const unmappedTwo = "cache:{unmapped-two}:watermark";
    const { client, pipelines } = fakeBatchClient({
      slots: fakeClusterSlots([
        [mappedOne, "primary-a"],
        [mappedTwo, "primary-a"],
      ]),
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    await adapter.invalidateMany?.([
      { watermarkKey: mappedOne, futureBufferMs: 10 },
      { watermarkKey: unmappedOne, futureBufferMs: 20 },
      { watermarkKey: mappedTwo, futureBufferMs: 30 },
      { watermarkKey: unmappedTwo, futureBufferMs: 40 },
    ]);

    expect(client.multi).toHaveBeenCalledOnce();
    expect(pipelines.map(({ routing }) => routing)).toEqual([mappedOne]);
    expect(pipelines.map(({ commands }) => commands)).toEqual([
      [[mappedOne, 10], [mappedTwo, 30]],
    ]);
    expect(client.dialcacheInvalidate).toHaveBeenCalledTimes(2);
    expect(client.dialcacheInvalidate).toHaveBeenNthCalledWith(1, unmappedOne, 20);
    expect(client.dialcacheInvalidate).toHaveBeenNthCalledWith(2, unmappedTwo, 40);
  });

  it("bounds scalar routing for unmapped Cluster slots", async () => {
    let releaseFirstChunk!: () => void;
    const firstChunkGate = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve;
    });
    const { client } = fakeBatchClient({ cluster: true });
    client.dialcacheInvalidate.mockImplementation(async () => {
      await firstChunkGate;
      return 1;
    });
    const adapter = createNodeRedisDialCacheClient(client as never);
    const requests = Array.from({ length: 1_001 }, (_, index) => ({
      watermarkKey: `cache:{unmapped-${index}}:watermark`,
      futureBufferMs: index,
    }));

    const operation = adapter.invalidateMany?.(requests) ?? Promise.resolve();
    await vi.waitFor(() => expect(client.dialcacheInvalidate).toHaveBeenCalledTimes(1_000));
    expect(client.multi).not.toHaveBeenCalled();

    releaseFirstChunk();
    await operation;
    expect(client.dialcacheInvalidate).toHaveBeenCalledTimes(1_001);
  });

  it("falls back to registered scalar scripts when a client has no pipeline surface", async () => {
    const client = fakeClient();
    const adapter = createNodeRedisDialCacheClient(client as never);

    await adapter.invalidateMany?.([
      { watermarkKey: "cache:{one}:watermark", futureBufferMs: 10 },
      { watermarkKey: "cache:{two}:watermark", futureBufferMs: 20 },
    ]);

    expect(client.dialcacheInvalidate).toHaveBeenCalledTimes(2);
    expect(client.dialcacheInvalidate).toHaveBeenNthCalledWith(1, "cache:{one}:watermark", 10);
    expect(client.dialcacheInvalidate).toHaveBeenNthCalledWith(2, "cache:{two}:watermark", 20);
  });

  it("settles and validates every scalar fallback operation before rejecting", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const client = fakeClient();
    let call = 0;
    client.dialcacheInvalidate.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return 0;
      }
      await secondGate;
      return 1;
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    let settled = false;
    const operation = Promise.resolve(adapter.invalidateMany?.([
      { watermarkKey: "cache:{one}:watermark", futureBufferMs: 10 },
      { watermarkKey: "cache:{two}:watermark", futureBufferMs: 20 },
    ])).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(client.dialcacheInvalidate).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSecond();
    await expectProtocolError(
      operation,
      "Invalid DialCache Redis invalidate reply; expected integer 1",
    );
    expect(settled).toBe(true);
  });

  it.each([
    "MOVED 12 127.0.0.1:7001",
    "ASK 12 127.0.0.1:7001",
  ])("recovers a final %s pipeline redirection with scalar routing", async (message) => {
    const first = "cache:{one}:watermark";
    const second = "cache:{two}:watermark";
    const { client } = fakeBatchClient({
      slots: fakeClusterSlots([[first, "primary-a"], [second, "primary-a"]]),
      execute: async () => { throw new Error(message); },
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    await adapter.invalidateMany?.([
      { watermarkKey: first, futureBufferMs: 10 },
      { watermarkKey: second, futureBufferMs: 20 },
    ]);

    expect(client.dialcacheInvalidate).toHaveBeenCalledTimes(2);
    expect(client.dialcacheInvalidate).toHaveBeenNthCalledWith(1, first, 10);
    expect(client.dialcacheInvalidate).toHaveBeenNthCalledWith(2, second, 20);
  });

  it("waits for every Cluster partition before surfacing a failure", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstError = new Error("first partition failed");
    const first = "cache:{one}:watermark";
    const second = "cache:{two}:watermark";
    const { client, pipelines } = fakeBatchClient({
      slots: fakeClusterSlots([[first, "primary-a"], [second, "primary-b"]]),
      execute: async ({ routing, commands }) => {
        if (routing === first) {
          throw firstError;
        }
        await secondGate;
        return commands.map(() => 1);
      },
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    let settled = false;
    const operation = Promise.resolve(adapter.invalidateMany?.([
      { watermarkKey: first, futureBufferMs: 0 },
      { watermarkKey: second, futureBufferMs: 0 },
    ])).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(pipelines).toHaveLength(2));
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSecond();
    await expect(operation).rejects.toBe(firstError);
    expect(settled).toBe(true);
    expect(client.dialcacheInvalidate).not.toHaveBeenCalled();
  });

  it("rejects malformed invalidation batch replies and skips empty batches", async () => {
    const tooShort = fakeBatchClient({ execute: async () => [1] });
    const shortAdapter = createNodeRedisDialCacheClient(tooShort.client as never);
    await expectProtocolError(
      shortAdapter.invalidateMany?.([
        { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
        { watermarkKey: "cache:{two}:watermark", futureBufferMs: 0 },
      ]) ?? Promise.resolve(),
      "Invalid DialCache Redis invalidate batch reply count; expected 2, received 1",
    );

    const malformed = fakeBatchClient({ execute: async () => [1, 0] });
    const malformedAdapter = createNodeRedisDialCacheClient(malformed.client as never);
    await expectProtocolError(
      malformedAdapter.invalidateMany?.([
        { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
        { watermarkKey: "cache:{two}:watermark", futureBufferMs: 0 },
      ]) ?? Promise.resolve(),
      "Invalid DialCache Redis invalidate reply; expected integer 1",
    );

    const empty = fakeBatchClient();
    const emptyAdapter = createNodeRedisDialCacheClient(empty.client as never);
    await emptyAdapter.invalidateMany?.([]);
    expect(empty.client.multi).not.toHaveBeenCalled();
  });

  it("passes the cooperative read signal through node-redis command options", async () => {
    const client = fakeClient();
    const adapter = createNodeRedisDialCacheClient(client as never);
    const controller = new AbortController();
    const context = { timeoutMs: 25, signal: controller.signal } as const;

    await adapter.read({ valueKey: "plain:value" }, context);
    await adapter.read(
      { valueKey: "tracked:{id}:value", watermarkKey: "tracked:{id}:watermark" },
      context,
    );

    expect(client.dialcacheRead).toHaveBeenCalledWith(
      expect.objectContaining({ returnBuffers: true, signal: controller.signal }),
      "plain:value",
    );
    expect(client.dialcacheReadTracked).toHaveBeenCalledWith(
      expect.objectContaining({ returnBuffers: true, signal: controller.signal }),
      "tracked:{id}:value",
      "tracked:{id}:watermark",
    );
  });

  it("rejects every out-of-domain reply returned by a node-redis client", async () => {
    const writeMessage = "Invalid DialCache Redis write reply; expected integer 0 or 1";
    const invalidationMessage = "Invalid DialCache Redis invalidate reply; expected integer 1";

    for (const reply of INVALID_WRITE_REPLIES) {
      const untracked = createNodeRedisDialCacheClient(fakeClient({ write: reply }) as never);
      await expectProtocolError(
        Promise.resolve(untracked.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" })),
        writeMessage,
      );

      const tracked = createNodeRedisDialCacheClient(fakeClient({ writeTracked: reply }) as never);
      await expectProtocolError(
        Promise.resolve(tracked.write({
          valueKey: "tracked:{id}:value",
          watermarkKey: "tracked:{id}:watermark",
          cacheTtlMs: 1_000,
          value: "tracked",
        })),
        writeMessage,
      );
    }

    for (const reply of INVALID_INVALIDATION_REPLIES) {
      const adapter = createNodeRedisDialCacheClient(fakeClient({ invalidate: reply }) as never);
      await expectProtocolError(
        Promise.resolve(adapter.invalidate({
          watermarkKey: "tracked:{id}:watermark",
          futureBufferMs: 50,
        })),
        invalidationMessage,
      );
    }
  });

  it("validates replies at the public node-redis script transform boundary", () => {
    expect(dialcacheRedisScripts.dialcacheWrite.transformReply(0)).toBe(0);
    expect(dialcacheRedisScripts.dialcacheWriteTracked.transformReply(1)).toBe(1);
    expect(dialcacheRedisScripts.dialcacheInvalidate.transformReply(1)).toBe(1);

    for (const reply of INVALID_WRITE_REPLIES) {
      expect(() => dialcacheRedisScripts.dialcacheWrite.transformReply(reply as number)).toThrow(
        DialCacheRedisProtocolError,
      );
      expect(() => dialcacheRedisScripts.dialcacheWriteTracked.transformReply(reply as number)).toThrow(
        DialCacheRedisProtocolError,
      );
    }
    for (const reply of INVALID_INVALIDATION_REPLIES) {
      expect(() => dialcacheRedisScripts.dialcacheInvalidate.transformReply(reply as number)).toThrow(
        DialCacheRedisProtocolError,
      );
    }
  });

  it("keeps protocol error instanceof checks specific to the base class and subclasses", () => {
    class SpecializedProtocolError extends DialCacheRedisProtocolError {}

    const baseError = new DialCacheRedisProtocolError("base");
    const specializedError = new SpecializedProtocolError("specialized");
    const falselyBranded = Object.defineProperty(
      {},
      Symbol.for("dialcache.DialCacheRedisProtocolError"),
      { value: false },
    );

    expect(baseError).toBeInstanceOf(DialCacheRedisProtocolError);
    expect(baseError).not.toBeInstanceOf(SpecializedProtocolError);
    expect(specializedError).toBeInstanceOf(SpecializedProtocolError);
    expect(specializedError).toBeInstanceOf(DialCacheRedisProtocolError);
    expect(falselyBranded).not.toBeInstanceOf(DialCacheRedisProtocolError);
  });

  it("surfaces protocol failures through the normal DialCache observability path", async () => {
    const redisClient = createNodeRedisDialCacheClient(fakeClient({ write: 2, invalidate: 0 }) as never);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const metrics = {
      request: vi.fn(),
      miss: vi.fn(),
      disabled: vi.fn(),
      error: vi.fn(),
      invalidation: vi.fn(),
      observeGet: vi.fn(),
      observeFallback: vi.fn(),
      observeSerialization: vi.fn(),
      observeSize: vi.fn(),
    };
    const dialcache = new DialCache({ redis: { client: redisClient, readTimeoutMs: 1_000 }, logger, metrics });
    const load = dialcache.cached(async (id: string) => ({ id }), {
      keyType: "user_id",
      useCase: "ProtocolFailure",
      cacheKey: (id) => id,
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        ramp: { [CacheLayer.REMOTE]: 100 },
      }),
    });

    await expect(dialcache.enable(async () => await load("123"))).resolves.toEqual({ id: "123" });
    await expectProtocolError(
      dialcache.invalidateRemote("user_id", "123"),
      "Invalid DialCache Redis invalidate reply; expected integer 1",
    );

    expect(logger.warn).toHaveBeenCalledWith(
      "Error putting value in Redis cache",
      expect.any(DialCacheRedisProtocolError),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Error writing DialCache invalidation watermark",
      expect.any(DialCacheRedisProtocolError),
    );
    expect(metrics.error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "ProtocolFailure",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
      error: "cache_write",
      inFallback: false,
    });
    expect(metrics.error).toHaveBeenCalledWith({
      cacheNamespace: "urn",
      useCase: "watermark",
      keyType: "user_id",
      layer: CacheLayer.REMOTE,
      error: "invalidation",
      inFallback: false,
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  DialCacheRedisProtocolError,
} from "../src/index.js";
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

function fakeBatchClient(options: {
  readonly cluster?: boolean;
  readonly execute?: (pipeline: FakePipeline) => Promise<unknown[]>;
} = {}) {
  const pipelines: FakePipeline[] = [];
  const client = {
    ...fakeClient(),
    ...(options.cluster === true ? { slots: [] } : {}),
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

  it("partitions node-redis Cluster pipelines by exact slot", async () => {
    const { client, pipelines } = fakeBatchClient({ cluster: true });
    const adapter = createNodeRedisDialCacheClient(client as never);

    await adapter.invalidateMany?.([
      { watermarkKey: "cache:{k-620}:watermark", futureBufferMs: 10 },
      { watermarkKey: "cache:{different}:watermark", futureBufferMs: 20 },
      { watermarkKey: "cache:{k-1000}:watermark", futureBufferMs: 30 },
    ]);

    expect(client.multi).toHaveBeenCalledTimes(2);
    expect(pipelines.map(({ routing }) => routing)).toEqual([
      "cache:{k-620}:watermark",
      "cache:{different}:watermark",
    ]);
    expect(pipelines[0]?.commands).toEqual([
      ["cache:{k-620}:watermark", 10],
      ["cache:{k-1000}:watermark", 30],
    ]);
    expect(pipelines[1]?.commands).toEqual([
      ["cache:{different}:watermark", 20],
    ]);
  });

  it("waits for every Cluster partition before surfacing a failure", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstError = new Error("first partition failed");
    const { client, pipelines } = fakeBatchClient({
      cluster: true,
      execute: async ({ routing, commands }) => {
        if (routing === "cache:{one}:watermark") {
          throw firstError;
        }
        await secondGate;
        return commands.map(() => 1);
      },
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    let settled = false;
    const operation = Promise.resolve(adapter.invalidateMany?.([
      { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
      { watermarkKey: "cache:{two}:watermark", futureBufferMs: 0 },
    ])).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(pipelines).toHaveLength(2));
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSecond();
    await expect(operation).rejects.toBe(firstError);
    expect(settled).toBe(true);
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

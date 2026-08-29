import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CacheLayer,
  DialCache,
  DialCacheKeyConfig,
  DialCacheRedisProtocolError,
} from "../src/index.js";
import { createNodeRedisDialCacheClient } from "../src/node-redis.js";
import { INVALIDATE_CACHE_SCRIPT } from "../src/redis-protocol.js";

const INVALID_INVALIDATION_REPLIES: readonly unknown[] = [
  0,
  2,
  -1,
  3,
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

interface FakeReplies {
  readonly get?: unknown;
  readonly mGet?: unknown;
  readonly set?: unknown;
  readonly eval?: unknown;
  readonly evalSha?: unknown;
}

function fakeClient(replies: FakeReplies = {}) {
  return {
    get: vi.fn(async () => Object.hasOwn(replies, "get") ? replies.get : null),
    // Serves standalone (args, options) and cluster (firstKey, isReadonly, args, options) shapes.
    sendCommand: vi.fn(async (...callArgs: unknown[]) => {
      const args = (Array.isArray(callArgs[0]) ? callArgs[0] : callArgs[2]) as Array<unknown>;
      if (args[0] === "SET") {
        return Object.hasOwn(replies, "set") ? replies.set : "OK";
      }
      if (args[0] === "EVAL") {
        return Object.hasOwn(replies, "eval") ? replies.eval : 1;
      }
      if (args[0] === "EVALSHA") {
        return Object.hasOwn(replies, "evalSha") ? replies.evalSha : 1;
      }
      return Object.hasOwn(replies, "mGet") ? replies.mGet : [null, null];
    }),
  };
}

function fakeCluster(replies: FakeReplies = {}) {
  return {
    ...fakeClient(replies),
    masters: [],
  };
}

function encodeFrame(
  payload: string | Buffer,
  { createdAtMs = 1, encoding = Buffer.isBuffer(payload) ? 1 : 0 } = {},
): Buffer {
  const header = Buffer.alloc(10);
  header[0] = 1;
  header.writeBigUInt64BE(BigInt(createdAtMs), 1);
  header[9] = encoding;
  return Buffer.concat([header, Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps invalidation independent of the Redis server clock", () => {
    expect(INVALIDATE_CACHE_SCRIPT).not.toMatch(/redis\.call\(["']TIME["']\)/);
  });

  it("accepts an ordinary node-redis client without custom script registrations", () => {
    expect(() => createNodeRedisDialCacheClient(fakeClient() as never)).not.toThrow();
  });

  it("accepts the exact write and invalidation reply domains", async () => {
    const client = fakeClient({
      get: encodeFrame("plain"),
      mGet: [encodeFrame(Buffer.from([0, 0xff]), { createdAtMs: 2 }), Buffer.from("1")],
      set: "OK",
      evalSha: 1,
    });
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.read({ valueKey: "plain:value" })).resolves.toEqual({
      payload: "plain",
      createdAtMs: 1,
    });
    await expect(
      adapter.read({ valueKey: "tracked:{id}:value", watermarkKey: "tracked:{id}:watermark" }),
    ).resolves.toEqual({
      payload: Buffer.from([0, 0xff]),
      createdAtMs: 2,
      observedWatermarkMs: 1,
    });
    await expect(
      adapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.write({
        valueKey: "tracked:{id}:value",
        cacheTtlMs: 1_000,
        value: "tracked",
      }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
    ).resolves.toBeUndefined();
  });

  it("classifies an absent tracked value while preserving its observed watermark", async () => {
    const client = fakeClient({ mGet: [null, Buffer.from("1234")] });
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.read({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
    })).resolves.toEqual({
      kind: "watermark_miss",
      reason: "value_absent",
      observedWatermarkMs: 1_234,
    });

    expect(client.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("writes complete frames with one native SET", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234);
    const client = fakeClient();
    const adapter = createNodeRedisDialCacheClient(client as never);
    await expect(
      adapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" }),
    ).resolves.toBeUndefined();

    expect(client.sendCommand).toHaveBeenCalledTimes(1);
    const [args, options] = client.sendCommand.mock.calls[0] as [Array<unknown>, unknown];
    expect(args[0]).toBe("SET");
    expect(args[1]).toBe("plain:value");
    expect(args[3]).toBe("PX");
    expect(args[4]).toBe("1000");
    const frame = args[2] as Buffer;
    expect(frame[0]).toBe(1);
    expect(frame[9]).toBe(0);
    expect(frame.subarray(10).toString("utf8")).toBe("plain");
    expect(Number(frame.readBigUInt64BE(1))).toBe(1_234);
    expect(options).toMatchObject({ returnBuffers: true });
  });

  it("honors a supplied write timestamp without sampling the client clock", async () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now must not be sampled for a supplied timestamp");
    });
    const client = fakeClient();
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      cacheTtlMs: 1_000,
      value: "tracked",
      createdAtMs: 0,
    })).resolves.toBeUndefined();

    const [args] = client.sendCommand.mock.calls[0] as [Array<unknown>];
    expect(Number((args[2] as Buffer).readBigUInt64BE(1))).toBe(0);
    expect(now).not.toHaveBeenCalled();
  });

  it("writes binary values as complete frames with one client-clock sample", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_234);
    const client = fakeClient();
    const binary = Buffer.from([0, 0xff]);
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      cacheTtlMs: 2_000,
      value: binary,
    })).resolves.toBeUndefined();

    expect(client.sendCommand).toHaveBeenCalledTimes(1);
    const [args] = client.sendCommand.mock.calls[0] as [Array<unknown>];
    expect(args[0]).toBe("SET");
    expect(args[1]).toBe("tracked:{id}:value");
    expect(args[3]).toBe("PX");
    expect(args[4]).toBe("2000");
    const frame = args[2] as Buffer;
    expect(frame[0]).toBe(1);
    expect(frame[9]).toBe(1);
    expect(frame.subarray(10)).toEqual(binary);
    expect(Number(frame.readBigUInt64BE(1))).toBe(1_234);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("routes cluster write SETs by the value key", async () => {
    const client = fakeCluster();
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).resolves.toBeUndefined();

    const [firstKey, isReadonly, args] = client.sendCommand.mock.calls[0] as [string, boolean, Array<unknown>];
    expect(firstKey).toBe("tracked:{id}:value");
    expect(isReadonly).toBe(false);
    expect(args[0]).toBe("SET");
    expect(args[1]).toBe("tracked:{id}:value");
  });

  it("accepts SET replies returned as Buffers and rejects everything else", async () => {
    await expect(
      createNodeRedisDialCacheClient(fakeClient({ set: Buffer.from("OK") }) as never)
        .write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" }),
    ).resolves.toBeUndefined();

    for (const reply of ["QUEUED", null, 1, undefined, Buffer.from("NO")]) {
      const untracked = createNodeRedisDialCacheClient(fakeClient({ set: reply }) as never);
      await expectProtocolError(
        Promise.resolve(untracked.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" })),
        "Invalid DialCache Redis SET reply; expected OK",
      );

    }
  });

  it("rejects out-of-range cacheTtlMs before issuing commands and ceils fractional TTLs", async () => {
    const client = fakeClient();
    const adapter = createNodeRedisDialCacheClient(client as never);
    const invalidTtls = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 31_536_000_001, "500" as unknown as number];
    for (const cacheTtlMs of invalidTtls) {
      await expect(
        adapter.write({ valueKey: "plain:value", cacheTtlMs, value: "plain" }),
      ).rejects.toThrow(RangeError);
    }
    expect(client.sendCommand).not.toHaveBeenCalled();

    await adapter.write({
      valueKey: "tracked:{id}:value",
      cacheTtlMs: 1_000.1,
      value: "tracked",
    });
    const [args] = client.sendCommand.mock.calls[0] as [Array<unknown>];
    expect(args[4]).toBe("1001");
  });

  it("rejects invalid application timestamps before dispatching mutations", async () => {
    const now = vi.spyOn(Date, "now");
    const client = fakeClient();
    const adapter = createNodeRedisDialCacheClient(client as never);

    for (const timestampMs of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      now.mockReturnValue(timestampMs);
      await expect(
        adapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" }),
      ).rejects.toThrow(RangeError);
      await expect(
        adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
      ).rejects.toThrow(RangeError);
    }

    expect(client.sendCommand).not.toHaveBeenCalled();
  });

  it("surfaces a SET failure as the write error", async () => {
    const failure = new Error("OOM command not allowed when used memory > 'maxmemory'.");
    const client = fakeClient();
    client.sendCommand.mockRejectedValueOnce(failure);
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).rejects.toBe(failure);
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

    expect(client.get).toHaveBeenCalledWith(
      expect.objectContaining({ returnBuffers: true, signal: controller.signal }),
      "plain:value",
    );
    expect(client.sendCommand).toHaveBeenCalledWith(
      ["MGET", "tracked:{id}:value", "tracked:{id}:watermark"],
      expect.objectContaining({ returnBuffers: true, signal: controller.signal }),
    );
  });

  it("forces tracked Cluster MGET reads to the primary", async () => {
    const client = fakeCluster({
      mGet: [encodeFrame("tracked", { createdAtMs: 2 }), Buffer.from("1")],
    });
    const adapter = createNodeRedisDialCacheClient(client as never);
    const controller = new AbortController();

    await expect(adapter.read(
      { valueKey: "tracked:{id}:value", watermarkKey: "tracked:{id}:watermark" },
      { timeoutMs: 25, signal: controller.signal },
    )).resolves.toEqual({ payload: "tracked", createdAtMs: 2, observedWatermarkMs: 1 });

    expect(client.sendCommand).toHaveBeenCalledWith(
      "tracked:{id}:value",
      false,
      ["MGET", "tracked:{id}:value", "tracked:{id}:watermark"],
      expect.objectContaining({ returnBuffers: true, signal: controller.signal }),
    );
  });

  it("does not mistake unrelated standalone metadata for the Cluster topology marker", async () => {
    const client = {
      ...fakeClient({
        mGet: [encodeFrame("tracked", { createdAtMs: 2 }), Buffer.from("1")],
      }),
      masters: "application metadata",
    };
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.read({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
    })).resolves.toEqual({ payload: "tracked", createdAtMs: 2, observedWatermarkMs: 1 });

    expect(client.sendCommand).toHaveBeenCalledWith(
      ["MGET", "tracked:{id}:value", "tracked:{id}:watermark"],
      expect.objectContaining({ returnBuffers: true }),
    );
  });

  it("rejects malformed native read reply shapes", async () => {
    await expect(
      createNodeRedisDialCacheClient(fakeClient({ get: "not-bytes" }) as never)
        .read({ valueKey: "plain:value" }),
    ).rejects.toMatchObject({
      name: "DialCacheRedisPayloadError",
      message: "Invalid DialCache Redis read reply; expected a bulk string or null",
    });

    const malformedMGetEnvelopes: readonly unknown[] = [
      null,
      [null],
      [null, null, null],
    ];
    for (const reply of malformedMGetEnvelopes) {
      await expect(
        createNodeRedisDialCacheClient(fakeClient({ mGet: reply }) as never)
          .read({ valueKey: "tracked:{id}:value", watermarkKey: "tracked:{id}:watermark" }),
      ).rejects.toMatchObject({
        name: "DialCacheRedisPayloadError",
        message: "Invalid DialCache Redis tracked read reply; expected an array with two entries",
      });
    }

    for (const reply of [["not-bytes", null], [null, 0]]) {
      await expect(
        createNodeRedisDialCacheClient(fakeClient({ mGet: reply }) as never)
          .read({ valueKey: "tracked:{id}:value", watermarkKey: "tracked:{id}:watermark" }),
      ).rejects.toMatchObject({
        name: "DialCacheRedisPayloadError",
        message: "Invalid DialCache Redis read reply; expected a bulk string or null",
      });
    }
  });

  it("rejects every out-of-domain reply returned by a node-redis client", async () => {
    const invalidationMessage = "Invalid DialCache Redis invalidate reply; expected integer 1";

    for (const reply of INVALID_INVALIDATION_REPLIES) {
      const adapter = createNodeRedisDialCacheClient(fakeClient({ evalSha: reply }) as never);
      await expectProtocolError(
        Promise.resolve(adapter.invalidate({
          watermarkKey: "tracked:{id}:watermark",
          futureBufferMs: 50,
        })),
        invalidationMessage,
      );
    }
  });

  it("dispatches invalidation once with EVALSHA by the source digest", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_234);
    const client = fakeClient();
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
    ).resolves.toBeUndefined();

    expect(client.sendCommand).toHaveBeenCalledTimes(1);
    const [args, options] = client.sendCommand.mock.calls[0] as [Array<unknown>, object];
    expect(args).toEqual([
      "EVALSHA",
      createHash("sha1").update(INVALIDATE_CACHE_SCRIPT).digest("hex"),
      "1",
      "tracked:{id}:watermark",
      "50",
      "1234",
    ]);
    expect(now).toHaveBeenCalledTimes(1);
    expect(options).toMatchObject({ returnBuffers: true });
    expect(Object.keys(options)).toEqual(["returnBuffers"]);
  });

  it("retries a rejected EVALSHA once with EVAL by source", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_234);
    const client = fakeClient();
    client.sendCommand.mockRejectedValueOnce(
      new Error("NOPERM this user has no permissions to run the 'evalsha' command"),
    );
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
    ).resolves.toBeUndefined();

    expect(client.sendCommand).toHaveBeenCalledTimes(2);
    const [firstArgs] = client.sendCommand.mock.calls[0] as [Array<unknown>];
    const [args, options] = client.sendCommand.mock.calls[1] as [Array<unknown>, object];
    expect(firstArgs[0]).toBe("EVALSHA");
    expect(args).toEqual([
      "EVAL",
      INVALIDATE_CACHE_SCRIPT,
      "1",
      "tracked:{id}:watermark",
      "50",
      "1234",
    ]);
    expect(now).toHaveBeenCalledTimes(1);
    expect(options).toMatchObject({ returnBuffers: true });
    expect(Object.keys(options)).toEqual(["returnBuffers"]);
  });

  it("routes the invalidation EVAL retry through the cluster keyed overload", async () => {
    const client = fakeCluster();
    client.sendCommand.mockRejectedValueOnce(new Error("NOPERM evalsha denied"));
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
    ).resolves.toBeUndefined();

    expect(client.sendCommand).toHaveBeenCalledTimes(2);
    const [firstKey, isReadonly, firstArgs] = client.sendCommand.mock.calls[0] as [
      string,
      boolean,
      Array<unknown>,
    ];
    const [retryKey, retryIsReadonly, args, options] = client.sendCommand.mock.calls[1] as [
      string,
      boolean,
      Array<unknown>,
      object,
    ];
    expect(firstKey).toBe("tracked:{id}:watermark");
    expect(isReadonly).toBe(false);
    expect(firstArgs[0]).toBe("EVALSHA");
    expect(retryKey).toBe("tracked:{id}:watermark");
    expect(retryIsReadonly).toBe(false);
    expect(args[0]).toBe("EVAL");
    expect(options).toMatchObject({ returnBuffers: true });
  });

  it("surfaces the invalidation retry rejection unmodified", async () => {
    const client = fakeClient();
    const original = new Error("NOPERM evalsha denied");
    const retryFailure = new Error("NOPERM eval denied");
    client.sendCommand.mockRejectedValueOnce(original);
    client.sendCommand.mockRejectedValueOnce(retryFailure);
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
    ).rejects.toBe(retryFailure);

    expect(retryFailure.cause).toBeUndefined();
    expect(client.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("never writes to the rejection even when one instance rejects both dispatches", async () => {
    // node-redis flush rejections are shared with every other in-flight
    // caller and the client's "error" listeners. The same-instance fixture
    // is a deliberate over-approximation: even if one object surfaced on
    // both dispatches, the adapter writes nothing to it.
    const client = fakeClient();
    const shared = new Error("socket torn down");
    client.sendCommand.mockRejectedValueOnce(shared);
    client.sendCommand.mockRejectedValueOnce(shared);
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
    ).rejects.toBe(shared);

    expect(shared.cause).toBeUndefined();
  });

  it("passes a non-Error invalidation retry rejection through as-is", async () => {
    const client = fakeClient();
    client.sendCommand.mockRejectedValueOnce(new Error("NOPERM evalsha denied"));
    client.sendCommand.mockRejectedValueOnce("socket closed");
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
    ).rejects.toBe("socket closed");
  });

  it("validates the invalidation retry reply through the shared validator", async () => {
    const client = fakeClient({ eval: 0 });
    client.sendCommand.mockRejectedValueOnce(new Error("NOPERM evalsha denied"));
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expectProtocolError(
      Promise.resolve(adapter.invalidate({
        watermarkKey: "tracked:{id}:watermark",
        futureBufferMs: 50,
      })),
      "Invalid DialCache Redis invalidate reply; expected integer 1",
    );
    expect(client.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("does not retry an invalidation reply-domain violation", async () => {
    const client = fakeClient({ evalSha: 0 });
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expectProtocolError(
      Promise.resolve(adapter.invalidate({
        watermarkKey: "tracked:{id}:watermark",
        futureBufferMs: 50,
      })),
      "Invalid DialCache Redis invalidate reply; expected integer 1",
    );
    expect(client.sendCommand).toHaveBeenCalledTimes(1);
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
    const redisClient = createNodeRedisDialCacheClient(fakeClient({ set: 2, evalSha: 0 }) as never);
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

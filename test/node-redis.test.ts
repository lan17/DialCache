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
const INVALID_INVALIDATION_REPLIES: readonly unknown[] = [0, 2, ...INVALID_WRITE_REPLIES];

interface FakeReplies {
  readonly get?: unknown;
  readonly mGet?: unknown;
  readonly set?: unknown;
  readonly stamp?: unknown;
  readonly invalidate?: unknown;
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
      return Object.hasOwn(replies, "mGet") ? replies.mGet : [null, null];
    }),
    dialcacheWriteTrackedStamp: vi.fn(async () => Object.hasOwn(replies, "stamp") ? replies.stamp : 1),
    dialcacheInvalidate: vi.fn(async () => Object.hasOwn(replies, "invalidate") ? replies.invalidate : 1),
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
  it("provides the expected arguments for every bundled mutation script", () => {
    const nonce = Buffer.from("01234567");
    expect(Object.keys(dialcacheRedisScripts)).toEqual([
      "dialcacheWriteTrackedStamp",
      "dialcacheInvalidate",
    ]);
    expect(
      dialcacheRedisScripts.dialcacheWriteTrackedStamp.transformArguments(
        "tracked:{id}:value",
        "tracked:{id}:watermark",
        1_000,
        nonce,
      ),
    ).toEqual(["tracked:{id}:value", "tracked:{id}:watermark", "1000", nonce]);
    expect(
      dialcacheRedisScripts.dialcacheInvalidate.transformArguments("tracked:{id}:watermark", 50),
    ).toEqual(["tracked:{id}:watermark", "50"]);
  });

  it("rejects clients constructed without the DialCache script registrations", () => {
    expect(
      () => createNodeRedisDialCacheClient({ get: vi.fn(), sendCommand: vi.fn() } as never),
    ).toThrow(TypeError);
    expect(
      () => createNodeRedisDialCacheClient({ get: vi.fn(), sendCommand: vi.fn() } as never),
    ).toThrow("requires a client created with scripts: dialcacheRedisScripts");
  });

  it("accepts the exact write and invalidation reply domains", async () => {
    const client = fakeClient({
      get: encodeFrame("plain"),
      mGet: [encodeFrame(Buffer.from([0, 0xff]), { createdAtMs: 2 }), Buffer.from("1")],
      set: "OK",
      stamp: 0,
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

  it("writes untracked frames with one native SET", async () => {
    const client = fakeClient();
    const adapter = createNodeRedisDialCacheClient(client as never);
    const before = Date.now();
    await expect(
      adapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" }),
    ).resolves.toBe(true);
    const after = Date.now();

    expect(client.dialcacheWriteTrackedStamp).not.toHaveBeenCalled();
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
    const createdAtMs = Number(frame.readBigUInt64BE(1));
    expect(createdAtMs).toBeGreaterThanOrEqual(before);
    expect(createdAtMs).toBeLessThanOrEqual(after);
    expect(options).toMatchObject({ returnBuffers: true });
  });

  it("pairs a zero-stamped placeholder SET with the stamp script in issue order", async () => {
    const order: string[] = [];
    const client = fakeClient();
    client.sendCommand.mockImplementation(async () => {
      order.push("set");
      return "OK";
    });
    client.dialcacheWriteTrackedStamp.mockImplementation(async () => {
      order.push("stamp");
      return 1;
    });
    const binary = Buffer.from([0, 0xff]);
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 2_000,
      value: binary,
    })).resolves.toBe(true);

    expect(order).toEqual(["set", "stamp"]);
    const [args] = client.sendCommand.mock.calls[0] as [Array<unknown>];
    expect(args[0]).toBe("SET");
    expect(args[1]).toBe("tracked:{id}:value");
    expect(args[3]).toBe("PX");
    expect(args[4]).toBe("2000");
    const frame = args[2] as Buffer;
    expect(frame[0]).toBe(0);
    expect(frame[9]).toBe(1);
    expect(frame.subarray(10)).toEqual(binary);
    // The stamp must carry the exact nonce its paired placeholder was minted with.
    expect(client.dialcacheWriteTrackedStamp).toHaveBeenCalledWith(
      "tracked:{id}:value",
      "tracked:{id}:watermark",
      2_000,
      frame.subarray(1, 9),
    );
  });

  it("fails a tracked write whose placeholder was lost before the stamp", async () => {
    const adapter = createNodeRedisDialCacheClient(fakeClient({ stamp: 2 }) as never);
    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).rejects.toThrow("DialCache tracked write lost its placeholder before the stamp");
  });

  it("issues the stamp before the placeholder SET settles", async () => {
    const client = fakeClient();
    let resolveSet: ((value: string) => void) | undefined;
    client.sendCommand.mockImplementationOnce(
      async () => await new Promise<string>((resolve) => {
        resolveSet = resolve;
      }),
    );
    const adapter = createNodeRedisDialCacheClient(client as never);

    const write = adapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "tracked",
    });
    // The stamp must already be issued while the SET is still unsettled: an
    // await between the pair would leave it uncalled here and hang the write.
    expect(client.dialcacheWriteTrackedStamp).toHaveBeenCalledTimes(1);

    resolveSet?.("OK");
    await expect(write).resolves.toBe(true);
  });

  it("routes cluster write SETs by the value key", async () => {
    const client = fakeCluster();
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).resolves.toBe(true);

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
    ).resolves.toBe(true);

    for (const reply of ["QUEUED", null, 1, undefined, Buffer.from("NO")]) {
      const untracked = createNodeRedisDialCacheClient(fakeClient({ set: reply }) as never);
      await expectProtocolError(
        Promise.resolve(untracked.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" })),
        "Invalid DialCache Redis SET reply; expected OK",
      );

      const tracked = createNodeRedisDialCacheClient(fakeClient({ set: reply }) as never);
      await expectProtocolError(
        Promise.resolve(tracked.write({
          valueKey: "tracked:{id}:value",
          watermarkKey: "tracked:{id}:watermark",
          cacheTtlMs: 1_000,
          value: "tracked",
        })),
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
      await expect(
        adapter.write({
          valueKey: "tracked:{id}:value",
          watermarkKey: "tracked:{id}:watermark",
          cacheTtlMs,
          value: "tracked",
        }),
      ).rejects.toThrow(RangeError);
    }
    expect(client.sendCommand).not.toHaveBeenCalled();
    expect(client.dialcacheWriteTrackedStamp).not.toHaveBeenCalled();

    await adapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000.1,
      value: "tracked",
    });
    const [args] = client.sendCommand.mock.calls[0] as [Array<unknown>];
    expect(args[4]).toBe("1001");
    expect(client.dialcacheWriteTrackedStamp).toHaveBeenCalledWith(
      "tracked:{id}:value",
      "tracked:{id}:watermark",
      1_001,
      expect.any(Buffer),
    );
  });

  it("surfaces a SET failure as the write error even when the stamp settled", async () => {
    const failure = new Error("OOM command not allowed when used memory > 'maxmemory'.");
    const client = fakeClient();
    client.sendCommand.mockRejectedValueOnce(failure);
    const adapter = createNodeRedisDialCacheClient(client as never);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).rejects.toBe(failure);
    expect(client.dialcacheWriteTrackedStamp).toHaveBeenCalledTimes(1);

    const stampFailure = new Error("ERR invalid DialCache watermark");
    const stampClient = fakeClient();
    stampClient.dialcacheWriteTrackedStamp.mockRejectedValueOnce(stampFailure);
    const stampAdapter = createNodeRedisDialCacheClient(stampClient as never);
    await expect(stampAdapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).rejects.toBe(stampFailure);

    // A bad SET reply also wins over a failing stamp, matching the contract.
    const combinedClient = fakeClient({ set: "QUEUED" });
    combinedClient.dialcacheWriteTrackedStamp.mockRejectedValueOnce(new Error("ERR stamp"));
    const combinedAdapter = createNodeRedisDialCacheClient(combinedClient as never);
    await expectProtocolError(
      Promise.resolve(combinedAdapter.write({
        valueKey: "tracked:{id}:value",
        watermarkKey: "tracked:{id}:watermark",
        cacheTtlMs: 1_000,
        value: "tracked",
      })),
      "Invalid DialCache Redis SET reply; expected OK",
    );
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
    )).resolves.toBe("tracked");

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
    })).resolves.toBe("tracked");

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
    const writeMessage = "Invalid DialCache Redis write reply; expected integer 0, 1, or 2";
    const invalidationMessage = "Invalid DialCache Redis invalidate reply; expected integer 1";

    for (const reply of INVALID_WRITE_REPLIES) {
      const tracked = createNodeRedisDialCacheClient(fakeClient({ stamp: reply }) as never);
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
    expect(dialcacheRedisScripts.dialcacheWriteTrackedStamp.transformReply(0)).toBe(0);
    expect(dialcacheRedisScripts.dialcacheWriteTrackedStamp.transformReply(1)).toBe(1);
    expect(dialcacheRedisScripts.dialcacheWriteTrackedStamp.transformReply(2)).toBe(2);
    expect(dialcacheRedisScripts.dialcacheInvalidate.transformReply(1)).toBe(1);

    for (const reply of INVALID_WRITE_REPLIES) {
      expect(() => dialcacheRedisScripts.dialcacheWriteTrackedStamp.transformReply(reply as number)).toThrow(
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
    const redisClient = createNodeRedisDialCacheClient(fakeClient({ set: 2, invalidate: 0 }) as never);
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

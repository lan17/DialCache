import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  DialCacheRedisProtocolError,
} from "../src/redis-client.js";
import { INVALIDATE_CACHE_SCRIPT } from "../src/redis-protocol.js";
import { createValkeyGlideDialCacheClient } from "../src/valkey-glide.js";

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

const decoderBytes = Symbol("bytes");
const batchInstances: MockBatch[] = [];
const standaloneClients = new WeakSet<object>();
const clusterClients = new WeakSet<object>();

class MockBatch {
  readonly mget = vi.fn((keys: Array<string | Buffer>) => {
    this.keys = keys;
    return this;
  });
  keys: Array<string | Buffer> | undefined;

  constructor(readonly isAtomic: boolean) {
    batchInstances.push(this);
  }
}

function mockClientIdentity(instances: WeakSet<object>) {
  return {
    [Symbol.hasInstance](value: unknown): boolean {
      if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return false;
      }
      return instances.has(value);
    },
  };
}

const mockGlide = {
  Batch: MockBatch,
  Decoder: { Bytes: decoderBytes },
  GlideClient: mockClientIdentity(standaloneClients),
  GlideClusterClient: mockClientIdentity(clusterClients),
};

function createFakeClient(replies: unknown[]) {
  const nextReply = async (): Promise<unknown> => {
    if (replies.length === 0) {
      throw new Error("fake GLIDE reply queue exhausted; queue every expected dispatch");
    }
    return replies.shift();
  };
  const client = {
    customCommand: vi.fn(async (
      _args: Array<string | Buffer>,
      _options: {
        decoder: typeof decoderBytes;
        route?: { type: "primarySlotKey"; key: string };
      },
    ) => nextReply()),
    get: vi.fn(async (_key: string | Buffer, _options: { decoder: typeof decoderBytes }) => nextReply()),
    exec: vi.fn(async (
      _batch: MockBatch,
      _raiseOnError: boolean,
      _options: {
        decoder: typeof decoderBytes;
        route?: { type: "primarySlotKey"; key: string };
      },
    ) => nextReply()),
  };
  return client;
}

function fakeClient(...replies: unknown[]) {
  const client = createFakeClient(replies);
  standaloneClients.add(client);
  return client;
}

function fakeClusterClient(...replies: unknown[]) {
  const client = createFakeClient(replies);
  clusterClients.add(client);
  return client;
}

function redisFrame(
  payload: string | Buffer,
  options: { createdAtMs?: number; encoding?: number } = {},
): Buffer {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(10 + bytes.length);
  frame[0] = 1;
  frame.writeBigUInt64BE(BigInt(options.createdAtMs ?? 1_000), 1);
  frame[9] = options.encoding ?? (Buffer.isBuffer(payload) ? 1 : 0);
  bytes.copy(frame, 10);
  return frame;
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

describe("Valkey GLIDE adapter", () => {
  beforeEach(() => {
    batchInstances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses GET and a non-atomic primary MGET batch that preserves caller WATCH state", async () => {
    const client = fakeClient(
      redisFrame("plain"),
      [[redisFrame(Buffer.from([0, 0xff])), Buffer.from("0")]],
      null,
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.read({ valueKey: "plain:value" })).resolves.toEqual({
      payload: "plain",
      createdAtMs: 1_000,
    });
    await expect(
      adapter.read({ valueKey: "tracked:{id}:value", watermarkKey: "tracked:{id}:watermark" }),
    ).resolves.toEqual({ payload: Buffer.from([0, 0xff]), createdAtMs: 1_000 });
    await expect(adapter.read({ valueKey: "missing:value" })).resolves.toBeNull();

    expect(client.get).toHaveBeenNthCalledWith(
      1,
      "plain:value",
      { decoder: decoderBytes },
    );
    expect(client.get).toHaveBeenNthCalledWith(
      2,
      "missing:value",
      { decoder: decoderBytes },
    );
    expect(batchInstances).toHaveLength(1);
    expect(batchInstances[0]?.isAtomic).toBe(false);
    expect(batchInstances[0]?.mget).toHaveBeenCalledWith([
      "tracked:{id}:value",
      "tracked:{id}:watermark",
    ]);
    expect(client.exec).toHaveBeenCalledWith(
      batchInstances[0],
      true,
      { decoder: decoderBytes },
    );
    expect(client.customCommand).not.toHaveBeenCalled();
  });

  it("returns an observed watermark for tracked semantic misses", async () => {
    const client = fakeClient([[null, Buffer.from("1234")]]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.read({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
    })).resolves.toEqual({ kind: "watermark_miss", observedWatermarkMs: 1_234 });

    expect(client.exec).toHaveBeenCalledTimes(1);
  });

  it("routes tracked cluster MGET directly to the slot primary", async () => {
    const client = fakeClusterClient([
      redisFrame("tracked-cluster"),
      Buffer.from("0"),
    ]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(
      adapter.read({
        valueKey: "cluster:{id}:value",
        watermarkKey: "cluster:{id}:watermark",
      }),
    ).resolves.toEqual({ payload: "tracked-cluster", createdAtMs: 1_000 });

    expect(client.customCommand).toHaveBeenCalledWith(
      ["MGET", "cluster:{id}:value", "cluster:{id}:watermark"],
      {
        decoder: decoderBytes,
        route: { type: "primarySlotKey", key: "cluster:{id}:value" },
      },
    );
    expect(client.exec).not.toHaveBeenCalled();
    expect(batchInstances).toHaveLength(0);
  });

  it("rejects forwarding wrappers instead of silently treating them as standalone", () => {
    const directClient = fakeClient();
    const forwardingWrapper = {
      customCommand: directClient.customCommand,
      exec: directClient.exec,
      get: directClient.get,
    };

    expect(
      () => createValkeyGlideDialCacheClient(forwardingWrapper, mockGlide),
    ).toThrow(
      "Valkey GLIDE DialCache requires a direct GlideClient or GlideClusterClient instance "
      + "from the supplied runtime; wrappers should implement DialCacheRedisClient directly",
    );
  });

  it("rejects a direct client from a different GLIDE module instance", () => {
    const client = fakeClient();
    const otherGlide = {
      ...mockGlide,
      GlideClient: mockClientIdentity(new WeakSet<object>()),
      GlideClusterClient: mockClientIdentity(new WeakSet<object>()),
    };

    expect(
      () => createValkeyGlideDialCacheClient(client, otherGlide),
    ).toThrow(
      "Valkey GLIDE DialCache requires a direct GlideClient or GlideClusterClient instance "
      + "from the supplied runtime; wrappers should implement DialCacheRedisClient directly",
    );
  });

  it("rejects an ambiguous client identity", () => {
    const client = fakeClient();
    clusterClients.add(client);

    expect(
      () => createValkeyGlideDialCacheClient(client, mockGlide),
    ).toThrow(
      "Invalid Valkey GLIDE runtime: client matches both GlideClient and GlideClusterClient",
    );
  });

  it("requires GLIDE 2.x Batch support", () => {
    const client = fakeClient();
    const glideWithoutBatch = {
      ...mockGlide,
      Batch: undefined,
    } as unknown as typeof mockGlide;

    expect(
      () => createValkeyGlideDialCacheClient(client, glideWithoutBatch),
    ).toThrow(
      "Valkey GLIDE DialCache requires @valkey/valkey-glide >=2.0.0 with a Batch constructor",
    );
  });

  it("preserves GLIDE invocation options when given a core read context", async () => {
    const client = fakeClient(null);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
    const controller = new AbortController();

    await adapter.read(
      { valueKey: "plain:value" },
      { timeoutMs: 25, signal: controller.signal },
    );

    expect(client.get).toHaveBeenCalledWith(
      "plain:value",
      { decoder: decoderBytes },
    );
  });

  it("writes string and binary values as complete frames with one SET each", async () => {
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_234)
      .mockReturnValueOnce(2_345)
      .mockReturnValueOnce(3_456);
    const binary = Buffer.from([0, 0xff, 0x80]);
    const client = fakeClient(Buffer.from("OK"), "OK", 1);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(
      adapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "hello" }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.write({
        valueKey: "tracked:{id}:value",
        cacheTtlMs: 2_000,
        value: binary,
      }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 100 }),
    ).resolves.toBeUndefined();

    const [untrackedSet, untrackedOptions] = client.customCommand.mock.calls[0]
      ?? [[], undefined];
    expect(untrackedSet[0]).toBe("SET");
    expect(untrackedSet[1]).toBe("plain:value");
    expect(untrackedSet[3]).toBe("PX");
    expect(untrackedSet[4]).toBe("1000");
    const untrackedFrame = untrackedSet[2] as Buffer;
    expect(untrackedFrame[0]).toBe(1);
    expect(untrackedFrame[9]).toBe(0);
    expect(untrackedFrame.subarray(10).toString("utf8")).toBe("hello");
    expect(Number(untrackedFrame.readBigUInt64BE(1))).toBe(1_234);
    expect(untrackedOptions).toEqual({ decoder: decoderBytes });

    const [trackedSet, trackedOptions] = client.customCommand.mock.calls[1]
      ?? [[], undefined];
    expect(trackedSet[0]).toBe("SET");
    expect(trackedSet[1]).toBe("tracked:{id}:value");
    expect(trackedSet[3]).toBe("PX");
    expect(trackedSet[4]).toBe("2000");
    const trackedFrame = trackedSet[2] as Buffer;
    expect(trackedFrame[0]).toBe(1);
    expect(trackedFrame[9]).toBe(1);
    expect(trackedFrame.subarray(10)).toEqual(binary);
    expect(Number(trackedFrame.readBigUInt64BE(1))).toBe(2_345);
    expect(trackedOptions).toEqual({ decoder: decoderBytes });

    expect(batchInstances).toHaveLength(0);
    expect(client.exec).not.toHaveBeenCalled();
    expect(client.customCommand).toHaveBeenCalledTimes(3);
    expect(client.customCommand).toHaveBeenNthCalledWith(
      3,
      [
        "EVALSHA",
        createHash("sha1").update(INVALIDATE_CACHE_SCRIPT).digest("hex"),
        "1",
        "tracked:{id}:watermark",
        "100",
        "3456",
      ],
      { decoder: decoderBytes },
    );
    expect(now).toHaveBeenCalledTimes(3);
  });

  it("honors a supplied write timestamp without sampling the client clock", async () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now must not be sampled for a supplied timestamp");
    });
    const client = fakeClient("OK");
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      cacheTtlMs: 1_000,
      value: "tracked",
      createdAtMs: 0,
    })).resolves.toBeUndefined();

    const [args] = client.customCommand.mock.calls[0] ?? [[]];
    expect(Number((args[2] as Buffer).readBigUInt64BE(1))).toBe(0);
    expect(now).not.toHaveBeenCalled();
  });

  it("routes cluster writes and invalidations to the slot primary", async () => {
    const client = fakeClusterClient("OK", "OK", 1);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

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
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 25 }),
    ).resolves.toBeUndefined();

    const [, untrackedOptions] = client.customCommand.mock.calls[0] ?? [[], undefined];
    expect(untrackedOptions).toEqual({
      decoder: decoderBytes,
      route: { type: "primarySlotKey", key: "plain:value" },
    });
    const [, trackedOptions] = client.customCommand.mock.calls[1] ?? [[], undefined];
    expect(trackedOptions).toEqual({
      decoder: decoderBytes,
      route: { type: "primarySlotKey", key: "tracked:{id}:value" },
    });
    expect(batchInstances).toHaveLength(0);
    expect(client.exec).not.toHaveBeenCalled();
    const [, invalidateOptions] = client.customCommand.mock.calls[2] ?? [[], undefined];
    expect(invalidateOptions).toEqual({
      decoder: decoderBytes,
      route: { type: "primarySlotKey", key: "tracked:{id}:watermark" },
    });
  });

  it("rejects out-of-range cacheTtlMs before dispatch and ceils fractional TTLs", async () => {
    const client = fakeClient("OK");
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
    const invalidTtls = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 31_536_000_001, "500" as unknown as number];
    for (const cacheTtlMs of invalidTtls) {
      await expect(
        adapter.write({ valueKey: "plain:value", cacheTtlMs, value: "plain" }),
      ).rejects.toThrow(RangeError);
    }
    expect(client.customCommand).not.toHaveBeenCalled();
    expect(client.exec).not.toHaveBeenCalled();
    expect(batchInstances).toHaveLength(0);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      cacheTtlMs: 1_000.1,
      value: "tracked",
    })).resolves.toBeUndefined();
    expect(client.customCommand.mock.calls[0]?.[0]?.[4]).toBe("1001");
  });

  it("rejects invalid application timestamps before dispatching mutations", async () => {
    const now = vi.spyOn(Date, "now");
    const client = fakeClient();
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

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

    expect(client.customCommand).not.toHaveBeenCalled();
    expect(client.exec).not.toHaveBeenCalled();
    expect(batchInstances).toHaveLength(0);
  });

  it("surfaces SET command errors", async () => {
    const setFailure = new Error("OOM command not allowed when used memory > 'maxmemory'.");
    const setClient = fakeClient();
    setClient.customCommand.mockRejectedValueOnce(setFailure);
    const setAdapter = createValkeyGlideDialCacheClient(setClient, mockGlide);
    await expect(setAdapter.write({
      valueKey: "tracked:{id}:value",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).rejects.toBe(setFailure);
    expect(setClient.customCommand).toHaveBeenCalledTimes(1);
  });

  it("validates native SET replies", async () => {
    const setReplyClient = fakeClient("QUEUED");
    const setReplyAdapter = createValkeyGlideDialCacheClient(setReplyClient, mockGlide);
    await expectProtocolError(
      Promise.resolve(setReplyAdapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" })),
      "Invalid DialCache Redis SET reply; expected OK",
    );
  });

  it("rejects malformed native read and mutation script replies", async () => {
    const client = fakeClient(
      "not-bytes",
      redisFrame("invalid", { encoding: 2 }),
      "not-a-batch-reply",
      [[redisFrame("missing-watermark")]],
      "QUEUED",
      0,
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.read({ valueKey: "wrong-type" })).rejects.toBeInstanceOf(DialCacheRedisPayloadError);
    await expect(adapter.read({ valueKey: "wrong-encoding" })).rejects.toBeInstanceOf(
      DialCacheRedisPayloadEncodingError,
    );
    await expect(
      adapter.read({ valueKey: "bad:{id}:value", watermarkKey: "bad:{id}:watermark" }),
    ).rejects.toBeInstanceOf(DialCacheRedisPayloadError);
    await expect(
      adapter.read({ valueKey: "bad-pair:{id}:value", watermarkKey: "bad-pair:{id}:watermark" }),
    ).rejects.toBeInstanceOf(DialCacheRedisPayloadError);
    await expectProtocolError(
      Promise.resolve(adapter.write({
        valueKey: "bad-write:{id}:value",
        cacheTtlMs: 1_000,
        value: "value",
      })),
      "Invalid DialCache Redis SET reply; expected OK",
    );
    await expectProtocolError(
      Promise.resolve(
        adapter.invalidate({ watermarkKey: "bad-watermark", futureBufferMs: 0 }),
      ),
      "Invalid DialCache Redis invalidate reply; expected integer 1",
    );
  });

  it("rejects every out-of-domain invalidation reply", async () => {
    const invalidationMessage = "Invalid DialCache Redis invalidate reply; expected integer 1";

    for (const reply of INVALID_INVALIDATION_REPLIES) {
      const client = fakeClient(reply);
      const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
      await expectProtocolError(
        Promise.resolve(adapter.invalidate({
          watermarkKey: "tracked:{id}:watermark",
          futureBufferMs: 50,
        })),
        invalidationMessage,
      );
      // A reply-domain violation is deterministic and must never be retried.
      expect(client.customCommand).toHaveBeenCalledTimes(1);
    }
  });

  it("retries any invalidation rejection once with EVAL by source", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_234);
    // NOSCRIPT is the common trigger, but the retry deliberately covers every
    // rejection: the invalidation script is idempotent, and an
    // EVALSHA-rejecting proxy must self-heal rather than fail every call.
    for (const wording of [
      "An error was signalled by the server: - NoScriptError: No matching script.",
      "NOPERM this user has no permissions to run the 'evalsha' command",
    ]) {
      const client = fakeClient(1);
      client.customCommand.mockRejectedValueOnce(new Error(wording));
      const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

      await expect(
        adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
      ).resolves.toBeUndefined();

      expect(client.customCommand).toHaveBeenCalledTimes(2);
      expect(client.customCommand).toHaveBeenNthCalledWith(
        1,
        [
          "EVALSHA",
          createHash("sha1").update(INVALIDATE_CACHE_SCRIPT).digest("hex"),
          "1",
          "tracked:{id}:watermark",
          "50",
          "1234",
        ],
        { decoder: decoderBytes },
      );
      expect(client.customCommand).toHaveBeenNthCalledWith(
        2,
        ["EVAL", INVALIDATE_CACHE_SCRIPT, "1", "tracked:{id}:watermark", "50", "1234"],
        { decoder: decoderBytes },
      );
    }
    expect(now).toHaveBeenCalledTimes(2);
  });

  it("chains the original rejection when the invalidation retry also fails", async () => {
    const first = new Error("read ECONNRESET");
    const second = new Error("ERR invalid DialCache future buffer");
    const client = fakeClient();
    client.customCommand.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    const invalidation = adapter.invalidate({
      watermarkKey: "tracked:{id}:watermark",
      futureBufferMs: 50,
    });
    await expect(invalidation).rejects.toBe(second);
    await expect(invalidation).rejects.toMatchObject({ cause: first });
    expect(client.customCommand).toHaveBeenCalledTimes(2);
  });

  it("preserves a pre-existing cause on the invalidation retry rejection", async () => {
    const first = new Error("read ECONNRESET");
    const second = new Error("wrapped transport failure", { cause: "socket closed" });
    const client = fakeClient();
    client.customCommand.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
    ).rejects.toBe(second);

    expect(second.cause).toBe("socket closed");
  });

  it("passes a non-Error invalidation retry rejection through without decoration", async () => {
    // The cause attachment must guard on instanceof Error: assigning to a
    // primitive rejection would throw a TypeError and mask the failure.
    const client = fakeClient();
    client.customCommand
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockRejectedValueOnce("socket closed");
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 50 }),
    ).rejects.toBe("socket closed");
  });

  it("validates the invalidation retry reply through the shared validator", async () => {
    // The retry reply has no other guard; a non-1 integer must still fail.
    const client = fakeClient(0);
    client.customCommand.mockRejectedValueOnce(new Error("NOPERM evalsha denied"));
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expectProtocolError(
      Promise.resolve(adapter.invalidate({
        watermarkKey: "tracked:{id}:watermark",
        futureBufferMs: 50,
      })),
      "Invalid DialCache Redis invalidate reply; expected integer 1",
    );
    expect(client.customCommand).toHaveBeenCalledTimes(2);
  });

  it("uses Batch and Decoder from the supplied GLIDE module instance", async () => {
    class OtherBatch {
      mget(): this {
        return this;
      }
    }
    const otherGlide = {
      Batch: OtherBatch,
      Decoder: { Bytes: Symbol("other-bytes") },
    };
    const client = fakeClient(
      [[redisFrame("tracked"), Buffer.from("0")]],
      "OK",
      1,
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await adapter.read({
      valueKey: "module:{instance}:value",
      watermarkKey: "module:{instance}:watermark",
    });
    await adapter.write({
      valueKey: "module:{instance}:value",
      cacheTtlMs: 1_000,
      value: "value",
    });
    await adapter.invalidate({ watermarkKey: "module:{instance}:watermark", futureBufferMs: 5 });

    const [readBatch, , readOptions] = client.exec.mock.calls[0] ?? [];
    const [, writeOptions] = client.customCommand.mock.calls[0] ?? [];
    const [, invalidateOptions] = client.customCommand.mock.calls[1] ?? [];
    expect(readBatch).toBeInstanceOf(MockBatch);
    expect(readBatch).not.toBeInstanceOf(otherGlide.Batch);
    expect(readOptions?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(readOptions?.decoder).not.toBe(otherGlide.Decoder.Bytes);
    expect(writeOptions?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(writeOptions?.decoder).not.toBe(otherGlide.Decoder.Bytes);
    expect(invalidateOptions?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(invalidateOptions?.decoder).not.toBe(otherGlide.Decoder.Bytes);
  });
});

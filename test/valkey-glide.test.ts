import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  DialCacheRedisPlaceholderLostError,
  DialCacheRedisProtocolError,
} from "../src/redis-client.js";
import {
  INVALIDATE_CACHE_SCRIPT,
  WRITE_TRACKED_STAMP_SCRIPT,
  WRITE_UNTRACKED_STAMP_SCRIPT,
} from "../src/redis-protocol.js";
import { createValkeyGlideDialCacheClient } from "../src/valkey-glide.js";

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
const INVALID_UNTRACKED_WRITE_REPLIES: readonly unknown[] = [0, ...INVALID_WRITE_REPLIES];
const INVALID_INVALIDATION_REPLIES: readonly unknown[] = [0, 2, ...INVALID_WRITE_REPLIES];

const decoderBytes = Symbol("bytes");
const batchInstances: MockBatch[] = [];
const clusterBatchInstances: MockClusterBatch[] = [];
const standaloneClients = new WeakSet<object>();
const clusterClients = new WeakSet<object>();

class MockBatch {
  readonly commands: Array<Array<string | Buffer>> = [];
  readonly mget = vi.fn((keys: Array<string | Buffer>) => {
    this.keys = keys;
    this.commands.push(["MGET", ...keys]);
    return this;
  });
  readonly get = vi.fn((key: string | Buffer) => {
    this.commands.push(["GET", key]);
    return this;
  });
  readonly customCommand = vi.fn((args: Array<string | Buffer>) => {
    this.commands.push(args);
    return this;
  });
  keys: Array<string | Buffer> | undefined;

  constructor(readonly isAtomic: boolean) {
    batchInstances.push(this);
  }
}

class MockClusterBatch extends MockBatch {
  constructor(isAtomic: boolean) {
    super(isAtomic);
    clusterBatchInstances.push(this);
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
  ClusterBatch: MockClusterBatch,
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

function redisTime(nowMs: number): [Buffer, Buffer] {
  return [
    Buffer.from(String(Math.floor(nowMs / 1_000))),
    Buffer.from(String((nowMs % 1_000) * 1_000)),
  ];
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
    clusterBatchInstances.length = 0;
  });

  it("orders native reads before TIME in non-atomic primary batches", async () => {
    const client = fakeClient(
      [redisFrame("plain"), redisTime(1_500)],
      [[redisFrame(Buffer.from([0, 0xff])), Buffer.from("0")], redisTime(1_500)],
      [null, redisTime(1_500)],
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    expect(adapter.enforcesMaxAge).toBe(true);
    await expect(adapter.read({ valueKey: "plain:value", maxAgeMs: 1_000 })).resolves.toEqual({
      payload: "plain",
      createdAtMs: 1_000,
    });
    await expect(
      adapter.read({
        valueKey: "tracked:{id}:value",
        watermarkKey: "tracked:{id}:watermark",
        maxAgeMs: 1_000,
      }),
    ).resolves.toEqual({ payload: Buffer.from([0, 0xff]), createdAtMs: 1_000 });
    await expect(
      adapter.read({ valueKey: "missing:value", maxAgeMs: 1_000 }),
    ).resolves.toBeNull();

    expect(batchInstances).toHaveLength(3);
    expect(batchInstances.every(({ isAtomic }) => !isAtomic)).toBe(true);
    expect(batchInstances[0]?.commands).toEqual([
      ["GET", "plain:value"],
      ["TIME"],
    ]);
    expect(batchInstances[1]?.commands).toEqual([
      ["MGET", "tracked:{id}:value", "tracked:{id}:watermark"],
      ["TIME"],
    ]);
    expect(batchInstances[2]?.commands).toEqual([
      ["GET", "missing:value"],
      ["TIME"],
    ]);
    for (const batch of batchInstances) {
      expect(client.exec).toHaveBeenCalledWith(batch, true, { decoder: decoderBytes });
    }
    expect(client.get).not.toHaveBeenCalled();
    expect(client.customCommand).not.toHaveBeenCalled();
  });

  it("enforces the strict max-age boundary against the ordered Redis TIME", async () => {
    const frame = redisFrame("cached", { createdAtMs: 1_000 });
    const client = fakeClient(
      [frame, redisTime(2_999)],
      [frame, redisTime(3_000)],
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(
      adapter.read({ valueKey: "fresh:value", maxAgeMs: 2_000 }),
    ).resolves.toEqual({ payload: "cached", createdAtMs: 1_000 });
    await expect(
      adapter.read({ valueKey: "expired:value", maxAgeMs: 2_000 }),
    ).resolves.toBeNull();
  });

  it("rejects invalid maximum ages before dispatching a batch", async () => {
    const client = fakeClient();
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    for (const maxAgeMs of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      31_536_000_001,
      "100" as unknown as number,
    ]) {
      await expect(adapter.read({ valueKey: "plain:value", maxAgeMs })).rejects.toThrow(
        "DialCache Redis maxAgeMs must be a positive safe integer no greater than 31536000000",
      );
    }

    expect(client.exec).not.toHaveBeenCalled();
    expect(batchInstances).toHaveLength(0);
  });

  it("routes GET/MGET and their following TIME to the same slot primary on cluster", async () => {
    const client = fakeClusterClient(
      [redisFrame("plain-cluster"), redisTime(1_500)],
      [[redisFrame("tracked-cluster"), Buffer.from("0")], redisTime(1_500)],
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(
      adapter.read({ valueKey: "plain:{id}:value", maxAgeMs: 1_000 }),
    ).resolves.toEqual({ payload: "plain-cluster", createdAtMs: 1_000 });
    await expect(
      adapter.read({
        valueKey: "tracked:{id}:value",
        watermarkKey: "tracked:{id}:watermark",
        maxAgeMs: 1_000,
      }),
    ).resolves.toEqual({ payload: "tracked-cluster", createdAtMs: 1_000 });

    expect(clusterBatchInstances).toHaveLength(2);
    expect(clusterBatchInstances[0]?.commands).toEqual([
      ["GET", "plain:{id}:value"],
      ["TIME"],
    ]);
    expect(clusterBatchInstances[1]?.commands).toEqual([
      ["MGET", "tracked:{id}:value", "tracked:{id}:watermark"],
      ["TIME"],
    ]);
    expect(client.exec).toHaveBeenNthCalledWith(
      1,
      clusterBatchInstances[0],
      true,
      {
        decoder: decoderBytes,
        route: { type: "primarySlotKey", key: "plain:{id}:value" },
      },
    );
    expect(client.exec).toHaveBeenNthCalledWith(
      2,
      clusterBatchInstances[1],
      true,
      {
        decoder: decoderBytes,
        route: { type: "primarySlotKey", key: "tracked:{id}:value" },
      },
    );
    expect(client.customCommand).not.toHaveBeenCalled();
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

  it("rejects an ambiguous client identity before allocating scripts", () => {
    const client = fakeClient();
    clusterClients.add(client);

    expect(
      () => createValkeyGlideDialCacheClient(client, mockGlide),
    ).toThrow(
      "Invalid Valkey GLIDE runtime: client matches both GlideClient and GlideClusterClient",
    );
  });

  it("requires GLIDE 2.x Batch support before allocating scripts", () => {
    const client = fakeClient();
    const glideWithoutBatch = {
      ...mockGlide,
      Batch: undefined,
    } as unknown as typeof mockGlide;
    const glideWithoutClusterBatch = {
      ...mockGlide,
      ClusterBatch: undefined,
    } as unknown as typeof mockGlide;

    for (const runtime of [glideWithoutBatch, glideWithoutClusterBatch]) {
      expect(
        () => createValkeyGlideDialCacheClient(client, runtime),
      ).toThrow(
        "Valkey GLIDE DialCache requires @valkey/valkey-glide >=2.0.0 with Batch and ClusterBatch constructors",
      );
    }
  });

  it("preserves GLIDE invocation options when given a core read context", async () => {
    const client = fakeClient([null, redisTime(1_500)]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
    const controller = new AbortController();

    await adapter.read(
      { valueKey: "plain:value", maxAgeMs: 1_000 },
      { timeoutMs: 25, signal: controller.signal },
    );

    expect(client.exec).toHaveBeenCalledWith(
      batchInstances[0],
      true,
      { decoder: decoderBytes },
    );
    expect(batchInstances[0]?.commands).toEqual([["GET", "plain:value"], ["TIME"]]);
  });

  it("writes untracked and tracked placeholders through ordered non-atomic batches", async () => {
    const binary = Buffer.from([0, 0xff, 0x80]);
    const client = fakeClient(
      [Buffer.from("OK"), 1],
      [Buffer.from("OK"), 0],
      1,
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(
      adapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "hello" }),
    ).resolves.toBe(true);
    await expect(
      adapter.write({
        valueKey: "tracked:{id}:value",
        watermarkKey: "tracked:{id}:watermark",
        cacheTtlMs: 2_000,
        value: binary,
      }),
    ).resolves.toBe(false);
    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 100 }),
    ).resolves.toBeUndefined();

    expect(batchInstances).toHaveLength(2);
    const [untrackedBatch, trackedBatch] = batchInstances;
    expect(untrackedBatch?.isAtomic).toBe(false);
    expect(untrackedBatch?.commands).toHaveLength(2);
    const [untrackedSet, untrackedStamp] = untrackedBatch?.commands ?? [];
    expect(untrackedSet?.[0]).toBe("SET");
    expect(untrackedSet?.[1]).toBe("plain:value");
    expect(untrackedSet?.[3]).toBe("PX");
    expect(untrackedSet?.[4]).toBe("1000");
    const untrackedFrame = untrackedSet?.[2] as Buffer;
    expect(untrackedFrame[0]).toBe(0);
    expect(untrackedFrame[9]).toBe(0);
    expect(untrackedFrame.subarray(10).toString("utf8")).toBe("hello");
    const untrackedNonce = untrackedFrame.subarray(1, 9);
    expect(untrackedStamp).toEqual([
      "EVALSHA",
      createHash("sha1").update(WRITE_UNTRACKED_STAMP_SCRIPT).digest("hex"),
      "1",
      "plain:value",
      untrackedNonce,
    ]);
    expect(client.exec).toHaveBeenNthCalledWith(
      1,
      untrackedBatch,
      false,
      { decoder: decoderBytes },
    );

    expect(trackedBatch?.isAtomic).toBe(false);
    expect(trackedBatch?.commands).toHaveLength(2);
    const [trackedSet, stamp] = trackedBatch?.commands ?? [];
    expect(trackedSet?.[0]).toBe("SET");
    expect(trackedSet?.[1]).toBe("tracked:{id}:value");
    expect(trackedSet?.[3]).toBe("PX");
    expect(trackedSet?.[4]).toBe("2000");
    const trackedFrame = trackedSet?.[2] as Buffer;
    expect(trackedFrame[0]).toBe(0);
    expect(trackedFrame[9]).toBe(1);
    expect(trackedFrame.subarray(10)).toEqual(binary);
    const nonce = trackedFrame.subarray(1, 9);
    expect(stamp).toEqual([
      "EVALSHA",
      createHash("sha1").update(WRITE_TRACKED_STAMP_SCRIPT).digest("hex"),
      "2",
      "tracked:{id}:value",
      "tracked:{id}:watermark",
      "2000",
      nonce,
    ]);
    expect(client.exec).toHaveBeenCalledTimes(2);
    expect(client.exec).toHaveBeenNthCalledWith(
      2,
      trackedBatch,
      false,
      { decoder: decoderBytes },
    );

    // Writes use batches; invalidation alone dispatches directly by source SHA1.
    expect(client.customCommand).toHaveBeenCalledTimes(1);
    expect(client.customCommand).toHaveBeenNthCalledWith(
      1,
      [
        "EVALSHA",
        createHash("sha1").update(INVALIDATE_CACHE_SCRIPT).digest("hex"),
        "1",
        "tracked:{id}:watermark",
        "100",
      ],
      { decoder: decoderBytes },
    );
  });

  it("fails a tracked write whose placeholder was lost before the stamp", async () => {
    const client = fakeClient([Buffer.from("OK"), 2]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    const write = adapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "tracked",
    });
    await expect(write).rejects.toThrow("DialCache tracked write lost its placeholder before the stamp");
    await expect(write).rejects.toBeInstanceOf(DialCacheRedisPlaceholderLostError);
    // Reply 2 is a settled outcome, not a recovery trigger.
    expect(client.customCommand).not.toHaveBeenCalled();
  });

  it("fails an untracked write whose placeholder was lost before the stamp", async () => {
    const client = fakeClient([Buffer.from("OK"), 2]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    const write = adapter.write({
      valueKey: "plain:value",
      cacheTtlMs: 1_000,
      value: "plain",
    });
    await expect(write).rejects.toThrow("DialCache untracked write lost its placeholder before the stamp");
    await expect(write).rejects.toBeInstanceOf(DialCacheRedisPlaceholderLostError);
    expect(client.customCommand).not.toHaveBeenCalled();
  });

  it("falls back to the untracked stamp source only after NOSCRIPT", async () => {
    const noscript = new Error("NOSCRIPT No matching script. Please use EVAL.");
    const client = fakeClient([Buffer.from("OK"), noscript], 1);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.write({
      valueKey: "plain:value",
      cacheTtlMs: 2_000,
      value: "plain",
    })).resolves.toBe(true);

    const frame = batchInstances[0]?.commands[0]?.[2] as Buffer;
    expect(client.customCommand).toHaveBeenCalledOnce();
    expect(client.customCommand).toHaveBeenCalledWith(
      ["EVAL", WRITE_UNTRACKED_STAMP_SCRIPT, "1", "plain:value", frame.subarray(1, 9)],
      { decoder: decoderBytes },
    );
  });

  it("routes cluster writes and invalidations to the slot primary", async () => {
    const client = fakeClusterClient(["OK", 1], ["OK", 1], 1);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

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
    ).resolves.toBe(true);
    await expect(
      adapter.invalidate({ watermarkKey: "tracked:{id}:watermark", futureBufferMs: 25 }),
    ).resolves.toBeUndefined();

    expect(clusterBatchInstances).toHaveLength(2);
    expect(client.exec).toHaveBeenNthCalledWith(1, clusterBatchInstances[0], false, {
      decoder: decoderBytes,
      route: { type: "primarySlotKey", key: "plain:value" },
    });
    expect(client.exec).toHaveBeenNthCalledWith(2, clusterBatchInstances[1], false, {
      decoder: decoderBytes,
      route: { type: "primarySlotKey", key: "tracked:{id}:value" },
    });
    const [, invalidateOptions] = client.customCommand.mock.calls[0] ?? [[], undefined];
    expect(invalidateOptions).toEqual({
      decoder: decoderBytes,
      route: { type: "primarySlotKey", key: "tracked:{id}:watermark" },
    });
  });

  it("routes the EVAL recovery to the slot primary on cluster", async () => {
    const noscript = new Error("NOSCRIPT No matching script. Please use EVAL.");
    const client = fakeClusterClient([Buffer.from("OK"), noscript], 1);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 2_000,
      value: "tracked",
    })).resolves.toBe(true);

    const trackedFrame = clusterBatchInstances[0]?.commands[0]?.[2] as Buffer;
    expect(client.customCommand).toHaveBeenCalledWith(
      [
        "EVAL",
        WRITE_TRACKED_STAMP_SCRIPT,
        "2",
        "tracked:{id}:value",
        "tracked:{id}:watermark",
        "2000",
        trackedFrame.subarray(1, 9),
      ],
      {
        decoder: decoderBytes,
        route: { type: "primarySlotKey", key: "tracked:{id}:value" },
      },
    );
  });

  it("falls back to EVAL by source when the batched stamp hits NOSCRIPT", async () => {
    const noscriptWordings = [
      // Raw server reply wording.
      "NOSCRIPT No matching script. Please use EVAL.",
      // GLIDE's mapped RequestError wording.
      "An error was signalled by the server: - NoScriptError: No matching script.",
      // Case drift must not blind the stamp's recovery either.
      "noscript no matching script",
    ];
    for (const wording of noscriptWordings) {
      batchInstances.length = 0;
      const client = fakeClient([Buffer.from("OK"), new Error(wording)], 1);
      const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

      await expect(adapter.write({
        valueKey: "tracked:{id}:value",
        watermarkKey: "tracked:{id}:watermark",
        cacheTtlMs: 2_000,
        value: "tracked",
      })).resolves.toBe(true);

      const trackedFrame = batchInstances[0]?.commands[0]?.[2] as Buffer;
      expect(client.customCommand).toHaveBeenCalledTimes(1);
      expect(client.customCommand).toHaveBeenCalledWith(
        [
          "EVAL",
          WRITE_TRACKED_STAMP_SCRIPT,
          "2",
          "tracked:{id}:value",
          "tracked:{id}:watermark",
          "2000",
          trackedFrame.subarray(1, 9),
        ],
        { decoder: decoderBytes },
      );
    }
  });

  it("rejects out-of-range cacheTtlMs before batching and ceils fractional TTLs", async () => {
    const client = fakeClient([Buffer.from("OK"), 1]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
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
    expect(client.customCommand).not.toHaveBeenCalled();
    expect(client.exec).not.toHaveBeenCalled();
    expect(batchInstances).toHaveLength(0);

    await expect(adapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000.1,
      value: "tracked",
    })).resolves.toBe(true);
    const [trackedSet, stamp] = batchInstances[0]?.commands ?? [];
    expect(trackedSet?.[4]).toBe("1001");
    expect(stamp?.[5]).toBe("1001");
    expect(Buffer.isBuffer(stamp?.[6])).toBe(true);
  });

  it("surfaces batched SET and stamp command errors", async () => {
    const setFailure = new Error("OOM command not allowed when used memory > 'maxmemory'.");
    const setClient = fakeClient([
      setFailure,
      new Error("NOSCRIPT No matching script. Please use EVAL."),
    ]);
    const setAdapter = createValkeyGlideDialCacheClient(setClient, mockGlide);
    await expect(setAdapter.write({
      valueKey: "plain:value",
      cacheTtlMs: 1_000,
      value: "plain",
    })).rejects.toBe(setFailure);
    // The failed SET wins even over NOSCRIPT, so no stamp recovery is dispatched.
    expect(setClient.customCommand).not.toHaveBeenCalled();

    const stampFailure = new Error("ERR invalid DialCache stamp nonce");
    const stampClient = fakeClient([Buffer.from("OK"), stampFailure]);
    const stampAdapter = createValkeyGlideDialCacheClient(stampClient, mockGlide);
    await expect(stampAdapter.write({
      valueKey: "plain:value",
      cacheTtlMs: 1_000,
      value: "plain",
    })).rejects.toBe(stampFailure);
    expect(stampClient.customCommand).not.toHaveBeenCalled();
  });

  it("validates write batch envelopes and SET replies", async () => {
    const envelopeClient = fakeClient("not-a-batch-reply");
    const envelopeAdapter = createValkeyGlideDialCacheClient(envelopeClient, mockGlide);
    await expect(envelopeAdapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).rejects.toBeInstanceOf(DialCacheRedisPayloadError);

    const setReplyClient = fakeClient(["QUEUED", 1]);
    const setReplyAdapter = createValkeyGlideDialCacheClient(setReplyClient, mockGlide);
    await expectProtocolError(
      Promise.resolve(setReplyAdapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" })),
      "Invalid DialCache Redis SET reply; expected OK",
    );

    // A bad SET reply wins over a failing stamp, matching the write contract.
    const combinedClient = fakeClient(["QUEUED", new Error("ERR invalid DialCache watermark")]);
    const combinedAdapter = createValkeyGlideDialCacheClient(combinedClient, mockGlide);
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

  it("rejects malformed native read and mutation script replies", async () => {
    const client = fakeClient(
      ["not-bytes", redisTime(1_500)],
      [redisFrame("invalid", { encoding: 2 }), redisTime(1_500)],
      "not-a-batch-reply",
      [[redisFrame("missing-watermark")], redisTime(1_500)],
      [Buffer.from("OK"), "not-an-integer"],
      null,
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(
      adapter.read({ valueKey: "wrong-type", maxAgeMs: 1_000 }),
    ).rejects.toBeInstanceOf(DialCacheRedisPayloadError);
    await expect(
      adapter.read({ valueKey: "wrong-encoding", maxAgeMs: 1_000 }),
    ).rejects.toBeInstanceOf(
      DialCacheRedisPayloadEncodingError,
    );
    await expect(
      adapter.read({
        valueKey: "bad:{id}:value",
        watermarkKey: "bad:{id}:watermark",
        maxAgeMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(DialCacheRedisPayloadError);
    await expect(
      adapter.read({
        valueKey: "bad-pair:{id}:value",
        watermarkKey: "bad-pair:{id}:watermark",
        maxAgeMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(DialCacheRedisPayloadError);
    await expectProtocolError(
      Promise.resolve(adapter.write({
        valueKey: "bad-write:{id}:value",
        watermarkKey: "bad-write:{id}:watermark",
        cacheTtlMs: 1_000,
        value: "value",
      })),
      "Invalid DialCache Redis write reply; expected integer 0, 1, or 2",
    );
    await expectProtocolError(
      Promise.resolve(
        adapter.invalidate({ watermarkKey: "bad-watermark", futureBufferMs: 0 }),
      ),
      "Invalid DialCache Redis invalidate reply; expected integer 1",
    );
  });

  it("rejects a malformed TIME result even when the paired value is a miss", async () => {
    const client = fakeClient([null, [Buffer.from("1")]]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(
      adapter.read({ valueKey: "missing:value", maxAgeMs: 1_000 }),
    ).rejects.toMatchObject({
      name: "DialCacheRedisPayloadError",
      message: "Invalid DialCache Redis TIME reply; expected two unsigned decimal bulk strings",
    });
  });

  it("rejects every out-of-domain write and invalidation reply", async () => {
    const writeMessage = "Invalid DialCache Redis write reply; expected integer 0, 1, or 2";
    const untrackedWriteMessage = "Invalid DialCache Redis untracked write reply; expected integer 1 or 2";
    const invalidationMessage = "Invalid DialCache Redis invalidate reply; expected integer 1";

    for (const reply of INVALID_UNTRACKED_WRITE_REPLIES) {
      const untracked = createValkeyGlideDialCacheClient(
        fakeClient([Buffer.from("OK"), reply]),
        mockGlide,
      );
      await expectProtocolError(
        Promise.resolve(untracked.write({
          valueKey: "plain:value",
          cacheTtlMs: 1_000,
          value: "plain",
        })),
        untrackedWriteMessage,
      );
    }

    for (const reply of INVALID_WRITE_REPLIES) {
      const tracked = createValkeyGlideDialCacheClient(
        fakeClient([Buffer.from("OK"), reply]),
        mockGlide,
      );
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
        2,
        ["EVAL", INVALIDATE_CACHE_SCRIPT, "1", "tracked:{id}:watermark", "50"],
        { decoder: decoderBytes },
      );
    }
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
      [[redisFrame("tracked"), Buffer.from("0")], redisTime(1_500)],
      [Buffer.from("OK"), 1],
      1,
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await adapter.read({
      valueKey: "module:{instance}:value",
      watermarkKey: "module:{instance}:watermark",
      maxAgeMs: 1_000,
    });
    await adapter.write({
      valueKey: "module:{instance}:value",
      watermarkKey: "module:{instance}:watermark",
      cacheTtlMs: 1_000,
      value: "value",
    });
    await adapter.invalidate({ watermarkKey: "module:{instance}:watermark", futureBufferMs: 5 });

    const [readBatch, , readOptions] = client.exec.mock.calls[0] ?? [];
    const [writeBatch, , writeOptions] = client.exec.mock.calls[1] ?? [];
    const [, invalidateOptions] = client.customCommand.mock.calls[0] ?? [];
    expect(readBatch).toBeInstanceOf(MockBatch);
    expect(readBatch).not.toBeInstanceOf(otherGlide.Batch);
    expect(writeBatch).toBeInstanceOf(MockBatch);
    expect(writeBatch).not.toBeInstanceOf(otherGlide.Batch);
    expect(readOptions?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(readOptions?.decoder).not.toBe(otherGlide.Decoder.Bytes);
    expect(writeOptions?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(writeOptions?.decoder).not.toBe(otherGlide.Decoder.Bytes);
    expect(invalidateOptions?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(invalidateOptions?.decoder).not.toBe(otherGlide.Decoder.Bytes);
  });
});

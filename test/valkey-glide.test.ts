import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  DialCacheRedisProtocolError,
} from "../src/redis-client.js";
import { WRITE_TRACKED_STAMP_SCRIPT } from "../src/redis-protocol.js";
import { createValkeyGlideDialCacheClient } from "../src/valkey-glide.js";

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

const decoderBytes = Symbol("bytes");
const scriptInstances: MockScript[] = [];
const batchInstances: MockBatch[] = [];
const clusterBatchInstances: MockClusterBatch[] = [];
const standaloneClients = new WeakSet<object>();
const clusterClients = new WeakSet<object>();

class MockScript {
  readonly release = vi.fn();

  constructor(readonly code: string) {
    scriptInstances.push(this);
  }
}

class MockBatch {
  readonly commands: Array<Array<string | Buffer>> = [];
  readonly mget = vi.fn((keys: Array<string | Buffer>) => {
    this.keys = keys;
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
  Script: MockScript,
};

interface InvokeScriptOptions {
  keys: Array<string | Buffer>;
  args: Array<string | Buffer>;
  decoder: typeof decoderBytes;
}

function createFakeClient(replies: unknown[]) {
  const nextReply = async (): Promise<unknown> => replies.shift();
  const client = {
    get: vi.fn(async (_key: string | Buffer, _options: { decoder: typeof decoderBytes }) => nextReply()),
    exec: vi.fn(async (
      _batch: MockBatch,
      _raiseOnError: boolean,
      _options: {
        decoder: typeof decoderBytes;
        route?: { type: "primarySlotKey"; key: string };
      },
    ) => nextReply()),
    invokeScript: vi.fn(async (_script: MockScript, _options: InvokeScriptOptions) => nextReply()),
  };
  return { client, nextReply };
}

function fakeClient(...replies: unknown[]) {
  const client = createFakeClient(replies).client;
  standaloneClients.add(client);
  return client;
}

function fakeClusterClient(...replies: unknown[]) {
  const { client, nextReply } = createFakeClient(replies);
  const clusterClient = {
    ...client,
    customCommand: vi.fn(async (
      _args: Array<string | Buffer>,
      _options: {
        decoder: typeof decoderBytes;
        route: { type: "primarySlotKey"; key: string };
      },
    ) => nextReply()),
  };
  clusterClients.add(clusterClient);
  return clusterClient;
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
    scriptInstances.length = 0;
    batchInstances.length = 0;
    clusterBatchInstances.length = 0;
  });

  it("uses GET and a non-atomic primary MGET batch that preserves caller WATCH state", async () => {
    const client = fakeClient(
      redisFrame("plain"),
      [[redisFrame(Buffer.from([0, 0xff])), Buffer.from("0")]],
      null,
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.read({ valueKey: "plain:value" })).resolves.toBe("plain");
    await expect(
      adapter.read({ valueKey: "tracked:{id}:value", watermarkKey: "tracked:{id}:watermark" }),
    ).resolves.toEqual(Buffer.from([0, 0xff]));
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
    expect(client.invokeScript).not.toHaveBeenCalled();
    expect(scriptInstances).toHaveLength(2);
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
    ).resolves.toBe("tracked-cluster");

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
      exec: directClient.exec,
      get: directClient.get,
      invokeScript: directClient.invokeScript,
    };

    expect(
      () => createValkeyGlideDialCacheClient(forwardingWrapper, mockGlide),
    ).toThrow(
      "Valkey GLIDE DialCache requires a direct GlideClient or GlideClusterClient instance "
      + "from the supplied runtime; wrappers should implement DialCacheRedisClient directly",
    );
    expect(scriptInstances).toHaveLength(0);
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
    expect(scriptInstances).toHaveLength(0);
  });

  it("rejects an ambiguous client identity before allocating scripts", () => {
    const client = fakeClient();
    clusterClients.add(client);

    expect(
      () => createValkeyGlideDialCacheClient(client, mockGlide),
    ).toThrow(
      "Invalid Valkey GLIDE runtime: client matches both GlideClient and GlideClusterClient",
    );
    expect(scriptInstances).toHaveLength(0);
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
    expect(scriptInstances).toHaveLength(0);
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
    adapter.dispose();
  });

  it("writes frames through natively batched SET commands", async () => {
    const binary = Buffer.from([0, 0xff, 0x80]);
    const client = fakeClient(
      [Buffer.from("OK")],
      [Buffer.from("OK"), 0],
      1,
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    const before = Date.now();
    await expect(
      adapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "hello" }),
    ).resolves.toBe(true);
    const after = Date.now();
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
    expect(untrackedBatch?.commands).toHaveLength(1);
    const untrackedSet = untrackedBatch?.commands[0] ?? [];
    expect(untrackedSet[0]).toBe("SET");
    expect(untrackedSet[1]).toBe("plain:value");
    expect(untrackedSet[3]).toBe("PX");
    expect(untrackedSet[4]).toBe("1000");
    const untrackedFrame = untrackedSet[2] as Buffer;
    expect(untrackedFrame[0]).toBe(1);
    expect(untrackedFrame[9]).toBe(0);
    expect(untrackedFrame.subarray(10).toString("utf8")).toBe("hello");
    const createdAtMs = Number(untrackedFrame.readBigUInt64BE(1));
    expect(createdAtMs).toBeGreaterThanOrEqual(before);
    expect(createdAtMs).toBeLessThanOrEqual(after);
    expect(client.exec).toHaveBeenNthCalledWith(1, untrackedBatch, true, { decoder: decoderBytes });

    expect(trackedBatch?.isAtomic).toBe(false);
    expect(trackedBatch?.commands).toHaveLength(2);
    const [trackedSet, stamp] = trackedBatch?.commands ?? [];
    expect(trackedSet?.[0]).toBe("SET");
    expect(trackedSet?.[1]).toBe("tracked:{id}:value");
    expect(trackedSet?.[3]).toBe("PX");
    expect(trackedSet?.[4]).toBe("2000");
    const trackedFrame = trackedSet?.[2] as Buffer;
    expect(trackedFrame[0]).toBe(1);
    expect(trackedFrame.readBigUInt64BE(1)).toBe(0n);
    expect(trackedFrame[9]).toBe(1);
    expect(trackedFrame.subarray(10)).toEqual(binary);
    expect(stamp).toEqual([
      "EVALSHA",
      createHash("sha1").update(WRITE_TRACKED_STAMP_SCRIPT).digest("hex"),
      "2",
      "tracked:{id}:value",
      "tracked:{id}:watermark",
      "2000",
    ]);
    expect(client.exec).toHaveBeenNthCalledWith(2, trackedBatch, false, { decoder: decoderBytes });

    expect(client.invokeScript).toHaveBeenCalledTimes(1);
    expect(client.invokeScript).toHaveBeenCalledWith(
      expect.any(MockScript),
      { keys: ["tracked:{id}:watermark"], args: ["100"], decoder: decoderBytes },
    );
  });

  it("routes cluster writes through ClusterBatch to the slot primary", async () => {
    const client = fakeClusterClient(["OK"], ["OK", 1]);
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

    expect(clusterBatchInstances).toHaveLength(2);
    expect(client.exec).toHaveBeenNthCalledWith(1, clusterBatchInstances[0], true, {
      decoder: decoderBytes,
      route: { type: "primarySlotKey", key: "plain:value" },
    });
    expect(client.exec).toHaveBeenNthCalledWith(2, clusterBatchInstances[1], false, {
      decoder: decoderBytes,
      route: { type: "primarySlotKey", key: "tracked:{id}:value" },
    });
  });

  it("falls back to invokeScript when the batched stamp hits NOSCRIPT", async () => {
    const noscriptWordings = [
      // Raw server reply wording.
      "NOSCRIPT No matching script. Please use EVAL.",
      // GLIDE's mapped RequestError wording.
      "An error was signalled by the server: - NoScriptError: No matching script.",
    ];
    for (const wording of noscriptWordings) {
      const client = fakeClient([Buffer.from("OK"), new Error(wording)], 1);
      const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

      await expect(adapter.write({
        valueKey: "tracked:{id}:value",
        watermarkKey: "tracked:{id}:watermark",
        cacheTtlMs: 2_000,
        value: "tracked",
      })).resolves.toBe(true);

      expect(client.invokeScript).toHaveBeenCalledTimes(1);
      const [script, options] = client.invokeScript.mock.calls[0] ?? [];
      expect(script?.code).toBe(WRITE_TRACKED_STAMP_SCRIPT);
      expect(options).toEqual({
        keys: ["tracked:{id}:value", "tracked:{id}:watermark"],
        args: ["2000"],
        decoder: decoderBytes,
      });
      adapter.dispose();
    }
  });

  it("rejects out-of-range cacheTtlMs before batching and ceils fractional TTLs", async () => {
    const client = fakeClient([Buffer.from("OK"), 1]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
    for (const cacheTtlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 31_536_000_001]) {
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
    adapter.dispose();
  });

  it("surfaces batched SET and stamp command errors", async () => {
    const setFailure = new Error("OOM command not allowed when used memory > 'maxmemory'.");
    const setClient = fakeClient([setFailure, 1]);
    const setAdapter = createValkeyGlideDialCacheClient(setClient, mockGlide);
    await expect(setAdapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).rejects.toBe(setFailure);
    expect(setClient.invokeScript).not.toHaveBeenCalled();
    setAdapter.dispose();

    const stampFailure = new Error("ERR invalid DialCache watermark");
    const stampClient = fakeClient([Buffer.from("OK"), stampFailure]);
    const stampAdapter = createValkeyGlideDialCacheClient(stampClient, mockGlide);
    await expect(stampAdapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).rejects.toBe(stampFailure);
    expect(stampClient.invokeScript).not.toHaveBeenCalled();
    stampAdapter.dispose();
  });

  it("validates write batch envelopes and SET replies", async () => {
    const envelopeClient = fakeClient("not-a-batch-reply", [Buffer.from("OK")]);
    const envelopeAdapter = createValkeyGlideDialCacheClient(envelopeClient, mockGlide);
    await expect(
      envelopeAdapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" }),
    ).rejects.toBeInstanceOf(DialCacheRedisPayloadError);
    await expect(envelopeAdapter.write({
      valueKey: "tracked:{id}:value",
      watermarkKey: "tracked:{id}:watermark",
      cacheTtlMs: 1_000,
      value: "tracked",
    })).rejects.toBeInstanceOf(DialCacheRedisPayloadError);
    envelopeAdapter.dispose();

    const setReplyClient = fakeClient(["QUEUED"]);
    const setReplyAdapter = createValkeyGlideDialCacheClient(setReplyClient, mockGlide);
    await expectProtocolError(
      Promise.resolve(setReplyAdapter.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" })),
      "Invalid DialCache Redis SET reply; expected OK",
    );
    setReplyAdapter.dispose();
  });

  it("rejects malformed native read and mutation script replies", async () => {
    const client = fakeClient(
      "not-bytes",
      redisFrame("invalid", { encoding: 2 }),
      "not-a-batch-reply",
      [[redisFrame("missing-watermark")]],
      [Buffer.from("OK"), "not-an-integer"],
      null,
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
        watermarkKey: "bad-write:{id}:watermark",
        cacheTtlMs: 1_000,
        value: "value",
      })),
      "Invalid DialCache Redis write reply; expected integer 0 or 1",
    );
    await expectProtocolError(
      Promise.resolve(
        adapter.invalidate({ watermarkKey: "bad-watermark", futureBufferMs: 0 }),
      ),
      "Invalid DialCache Redis invalidate reply; expected integer 1",
    );
  });

  it("rejects every out-of-domain write and invalidation reply", async () => {
    const writeMessage = "Invalid DialCache Redis write reply; expected integer 0 or 1";
    const invalidationMessage = "Invalid DialCache Redis invalidate reply; expected integer 1";

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
      tracked.dispose();
    }

    for (const reply of INVALID_INVALIDATION_REPLIES) {
      const adapter = createValkeyGlideDialCacheClient(fakeClient(reply), mockGlide);
      await expectProtocolError(
        Promise.resolve(adapter.invalidate({
          watermarkKey: "tracked:{id}:watermark",
          futureBufferMs: 50,
        })),
        invalidationMessage,
      );
      adapter.dispose();
    }
  });

  it("releases every script exactly once and rejects later operations", async () => {
    const client = fakeClient();
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    adapter.dispose();
    adapter.dispose();

    expect(scriptInstances).toHaveLength(2);
    for (const script of scriptInstances) {
      expect(script.release).toHaveBeenCalledTimes(1);
    }
    await expect(adapter.read({ valueKey: "disposed" })).rejects.toThrow("Valkey GLIDE DialCache client is disposed");
    expect(client.get).not.toHaveBeenCalled();
    expect(client.exec).not.toHaveBeenCalled();
    expect(client.invokeScript).not.toHaveBeenCalled();
  });

  it("does not release scripts while a native read is in flight", async () => {
    let resolveRead: ((value: Buffer) => void) | undefined;
    const client = fakeClient();
    client.get.mockImplementationOnce(
      async () => await new Promise<Buffer>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    const read = adapter.read({ valueKey: "in-flight" });
    expect(() => adapter.dispose()).toThrow(
      "Cannot dispose Valkey GLIDE DialCache client while operations are in flight",
    );
    expect(scriptInstances.every((script) => script.release.mock.calls.length === 0)).toBe(true);

    resolveRead?.(redisFrame("done"));
    await expect(read).resolves.toBe("done");
    adapter.dispose();
    expect(scriptInstances.every((script) => script.release.mock.calls.length === 1)).toBe(true);
  });

  it("uses Batch, Script, and Decoder from the supplied GLIDE module instance", async () => {
    class OtherBatch {
      mget(): this {
        return this;
      }
    }
    class OtherScript {
      readonly release = vi.fn();
    }
    const otherGlide = {
      Batch: OtherBatch,
      Decoder: { Bytes: Symbol("other-bytes") },
      Script: OtherScript,
    };
    const client = fakeClient(
      [[redisFrame("tracked"), Buffer.from("0")]],
      [Buffer.from("OK")],
      1,
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await adapter.read({
      valueKey: "module:{instance}:value",
      watermarkKey: "module:{instance}:watermark",
    });
    await adapter.write({ valueKey: "module-instance", cacheTtlMs: 1_000, value: "value" });
    await adapter.invalidate({ watermarkKey: "module:{instance}:watermark", futureBufferMs: 5 });

    const [readBatch, , readOptions] = client.exec.mock.calls[0] ?? [];
    const [writeBatch, , writeOptions] = client.exec.mock.calls[1] ?? [];
    const [script, scriptOptions] = client.invokeScript.mock.calls[0] ?? [];
    expect(readBatch).toBeInstanceOf(MockBatch);
    expect(readBatch).not.toBeInstanceOf(otherGlide.Batch);
    expect(writeBatch).toBeInstanceOf(MockBatch);
    expect(writeBatch).not.toBeInstanceOf(otherGlide.Batch);
    expect(script).toBeInstanceOf(MockScript);
    expect(script).not.toBeInstanceOf(otherGlide.Script);
    expect(readOptions?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(readOptions?.decoder).not.toBe(otherGlide.Decoder.Bytes);
    expect(writeOptions?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(writeOptions?.decoder).not.toBe(otherGlide.Decoder.Bytes);
    expect(scriptOptions?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(scriptOptions?.decoder).not.toBe(otherGlide.Decoder.Bytes);
    adapter.dispose();
  });
});

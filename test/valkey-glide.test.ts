import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  DialCacheRedisProtocolError,
} from "../src/redis-client.js";
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

class MockScript {
  readonly release = vi.fn();

  constructor(readonly code: string) {
    scriptInstances.push(this);
  }
}

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

const mockGlide = {
  Batch: MockBatch,
  Decoder: { Bytes: decoderBytes },
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
      _options: { decoder: typeof decoderBytes },
    ) => nextReply()),
    invokeScript: vi.fn(async (_script: MockScript, _options: InvokeScriptOptions) => nextReply()),
  };
  return { client, nextReply };
}

function fakeClient(...replies: unknown[]) {
  return createFakeClient(replies).client;
}

function fakeClusterClient(...replies: unknown[]) {
  const { client, nextReply } = createFakeClient(replies);
  return {
    ...client,
    customCommand: vi.fn(async (
      _args: Array<string | Buffer>,
      _options: {
        decoder: typeof decoderBytes;
        route: { type: "primarySlotKey"; key: string };
      },
    ) => nextReply()),
    invokeScriptWithRoute: vi.fn(async () => undefined),
  };
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
    expect(scriptInstances).toHaveLength(3);
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

  it("passes string and Buffer writes directly to GLIDE", async () => {
    const binary = Buffer.from([0, 0xff, 0x80]);
    const client = fakeClient(1, 0, 1);
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

    expect(client.invokeScript).toHaveBeenNthCalledWith(
      1,
      expect.any(MockScript),
      { keys: ["plain:value"], args: ["1000", "0", "hello"], decoder: decoderBytes },
    );
    expect(client.invokeScript).toHaveBeenNthCalledWith(
      2,
      expect.any(MockScript),
      {
        keys: ["tracked:{id}:value", "tracked:{id}:watermark"],
        args: ["2000", "1", binary],
        decoder: decoderBytes,
      },
    );
    expect(client.invokeScript).toHaveBeenNthCalledWith(
      3,
      expect.any(MockScript),
      { keys: ["tracked:{id}:watermark"], args: ["100"], decoder: decoderBytes },
    );
  });

  it("rejects malformed native read and mutation script replies", async () => {
    const client = fakeClient(
      "not-bytes",
      redisFrame("invalid", { encoding: 2 }),
      "not-a-batch-reply",
      [[redisFrame("missing-watermark")]],
      "not-an-integer",
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
      Promise.resolve(adapter.write({ valueKey: "bad-write", cacheTtlMs: 1_000, value: "value" })),
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
      const untracked = createValkeyGlideDialCacheClient(fakeClient(reply), mockGlide);
      await expectProtocolError(
        Promise.resolve(untracked.write({ valueKey: "plain:value", cacheTtlMs: 1_000, value: "plain" })),
        writeMessage,
      );
      untracked.dispose();

      const tracked = createValkeyGlideDialCacheClient(fakeClient(reply), mockGlide);
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

    expect(scriptInstances).toHaveLength(3);
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
      1,
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await adapter.read({
      valueKey: "module:{instance}:value",
      watermarkKey: "module:{instance}:watermark",
    });
    await adapter.write({ valueKey: "module-instance", cacheTtlMs: 1_000, value: "value" });

    const [batch, , execOptions] = client.exec.mock.calls[0] ?? [];
    const [script, options] = client.invokeScript.mock.calls[0] ?? [];
    expect(batch).toBeInstanceOf(MockBatch);
    expect(batch).not.toBeInstanceOf(otherGlide.Batch);
    expect(script).toBeInstanceOf(MockScript);
    expect(script).not.toBeInstanceOf(otherGlide.Script);
    expect(execOptions?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(execOptions?.decoder).not.toBe(otherGlide.Decoder.Bytes);
    expect(options?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(options?.decoder).not.toBe(otherGlide.Decoder.Bytes);
    adapter.dispose();
  });
});

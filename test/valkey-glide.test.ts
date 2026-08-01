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
const invalidateScriptHash = "invalidate-script-hash";
const scriptInstances: MockScript[] = [];
const batchInstances: MockBatch[] = [];
const clusterBatchInstances: MockClusterBatch[] = [];

class MockScript {
  readonly getHash = vi.fn(() => invalidateScriptHash);
  readonly release = vi.fn();

  constructor(readonly code: string) {
    scriptInstances.push(this);
  }
}

class MockBatch {
  readonly commands: Array<Array<string | Buffer>> = [];

  constructor(readonly isAtomic: boolean) {
    batchInstances.push(this);
  }

  customCommand(args: Array<string | Buffer>): this {
    this.commands.push(args);
    return this;
  }
}

class MockClusterBatch extends MockBatch {
  constructor(isAtomic: boolean) {
    super(isAtomic);
    clusterBatchInstances.push(this);
  }
}

class MockClusterClient {
  readonly invokeScript = vi.fn(
    async (_script: MockScript, _options: InvokeScriptOptions): Promise<unknown> => null,
  );
  readonly exec = vi.fn(
    async (
      _batch: MockClusterBatch,
      _raiseOnError: boolean,
      _options: BatchExecutionOptions,
    ) =>
      [1],
  );
}

const mockGlide = {
  Batch: MockBatch,
  ClusterBatch: MockClusterBatch,
  Decoder: { Bytes: decoderBytes },
  GlideClusterClient: MockClusterClient,
  Script: MockScript,
};

interface InvokeScriptOptions {
  keys: Array<string | Buffer>;
  args: Array<string | Buffer>;
  decoder: typeof decoderBytes;
}

interface BatchExecutionOptions {
  decoder: typeof decoderBytes;
  retryStrategy?: {
    retryServerError: boolean;
    retryConnectionError: boolean;
  };
}

function fakeClient(...replies: unknown[]) {
  return {
    exec: vi.fn(
      async (
        _batch: MockBatch,
        _raiseOnError: boolean,
        _options: BatchExecutionOptions,
      ): Promise<unknown[] | null> => [],
    ),
    invokeScript: vi.fn(async (_script: MockScript, _options: InvokeScriptOptions) => replies.shift()),
  };
}

function invalidationRequests(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    watermarkKey: `cache:{${index}}:watermark`,
    futureBufferMs: index,
  }));
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

  it("invokes distinct read scripts with byte decoding", async () => {
    const client = fakeClient(Buffer.from([0, ...Buffer.from("plain")]), Buffer.from([1, 0, 0xff]), null);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.read({ valueKey: "plain:value" })).resolves.toBe("plain");
    await expect(
      adapter.read({ valueKey: "tracked:{id}:value", watermarkKey: "tracked:{id}:watermark" }),
    ).resolves.toEqual(Buffer.from([0, 0xff]));
    await expect(adapter.read({ valueKey: "missing:value" })).resolves.toBeNull();

    expect(client.invokeScript).toHaveBeenNthCalledWith(
      1,
      expect.any(MockScript),
      { keys: ["plain:value"], args: [], decoder: decoderBytes },
    );
    expect(client.invokeScript).toHaveBeenNthCalledWith(
      2,
      expect.any(MockScript),
      {
        keys: ["tracked:{id}:value", "tracked:{id}:watermark"],
        args: [],
        decoder: decoderBytes,
      },
    );
    expect(scriptInstances).toHaveLength(5);
  });

  it("preserves GLIDE invocation options when given a core read context", async () => {
    const client = fakeClient(null);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
    const controller = new AbortController();

    await adapter.read(
      { valueKey: "plain:value" },
      { timeoutMs: 25, signal: controller.signal },
    );

    expect(client.invokeScript).toHaveBeenCalledWith(
      expect.any(MockScript),
      { keys: ["plain:value"], args: [], decoder: decoderBytes },
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

  it("executes warm standalone invalidations by hash in one non-atomic batch", async () => {
    const client = fakeClient();
    client.exec.mockResolvedValueOnce([1, 1]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.invalidateMany([
      { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
      { watermarkKey: "cache:{two}:watermark", futureBufferMs: 250 },
    ])).resolves.toBeUndefined();

    expect(batchInstances).toHaveLength(1);
    expect(clusterBatchInstances).toHaveLength(0);
    expect(batchInstances[0]).toMatchObject({
      isAtomic: false,
      commands: [
        ["EVALSHA", invalidateScriptHash, "1", "cache:{one}:watermark", "0"],
        ["EVALSHA", invalidateScriptHash, "1", "cache:{two}:watermark", "250"],
      ],
    });
    expect(client.exec).toHaveBeenCalledTimes(1);
    expect(client.exec).toHaveBeenCalledWith(
      batchInstances[0],
      true,
      { decoder: decoderBytes },
    );
    expect(scriptInstances[4]?.getHash).toHaveBeenCalledTimes(1);
  });

  it("bounds native standalone batches and dispatches their chunks sequentially", async () => {
    let resolveFirstChunk: ((value: unknown[]) => void) | undefined;
    let resolveSecondChunk: ((value: unknown[]) => void) | undefined;
    const client = fakeClient();
    client.exec
      .mockImplementationOnce(
        async () => await new Promise<unknown[]>((resolve) => {
          resolveFirstChunk = resolve;
        }),
      )
      .mockImplementationOnce(
        async () => await new Promise<unknown[]>((resolve) => {
          resolveSecondChunk = resolve;
        }),
      );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    const invalidation = adapter.invalidateMany(invalidationRequests(1_001));
    await vi.waitFor(() => {
      expect(client.exec).toHaveBeenCalledTimes(1);
    });
    expect(batchInstances).toHaveLength(1);
    expect(batchInstances[0]?.commands).toHaveLength(1_000);
    expect(() => adapter.dispose()).toThrow(
      "Cannot dispose Valkey GLIDE DialCache client while operations are in flight",
    );

    resolveFirstChunk?.(Array.from({ length: 1_000 }, () => 1));
    await vi.waitFor(() => {
      expect(client.exec).toHaveBeenCalledTimes(2);
    });
    expect(batchInstances).toHaveLength(2);
    expect(batchInstances[1]?.commands).toHaveLength(1);
    expect(() => adapter.dispose()).toThrow(
      "Cannot dispose Valkey GLIDE DialCache client while operations are in flight",
    );

    resolveSecondChunk?.([1]);
    await expect(invalidation).resolves.toBeUndefined();
    adapter.dispose();
  });

  it.each([
    ["standard Redis", new Error("NOSCRIPT No matching script. Please use EVAL.")],
    [
      "GLIDE 2.4.2",
      new Error(
        "An error was signalled by the server - NoScriptError: No matching script. Please use EVAL.",
      ),
    ],
  ])("retries a cold %s script batch once with EVAL", async (_label, cacheMiss) => {
    const client = fakeClient();
    client.exec.mockRejectedValueOnce(cacheMiss).mockResolvedValueOnce([1, 1]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.invalidateMany([
      { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
      { watermarkKey: "cache:{two}:watermark", futureBufferMs: 250 },
    ])).resolves.toBeUndefined();

    expect(client.exec).toHaveBeenCalledTimes(2);
    expect(batchInstances).toHaveLength(2);
    expect(batchInstances[0]?.commands).toEqual([
      ["EVALSHA", invalidateScriptHash, "1", "cache:{one}:watermark", "0"],
      ["EVALSHA", invalidateScriptHash, "1", "cache:{two}:watermark", "250"],
    ]);
    expect(batchInstances[1]?.commands).toEqual([
      ["EVAL", expect.any(String), "1", "cache:{one}:watermark", "0"],
      ["EVAL", expect.any(String), "1", "cache:{two}:watermark", "250"],
    ]);
  });

  it("retries a script miss within only the affected native chunk", async () => {
    const client = fakeClient();
    client.exec
      .mockResolvedValueOnce(Array.from({ length: 1_000 }, () => 1))
      .mockRejectedValueOnce(new Error("NOSCRIPT No matching script. Please use EVAL."))
      .mockResolvedValueOnce([1]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.invalidateMany(invalidationRequests(1_001))).resolves.toBeUndefined();

    expect(client.exec).toHaveBeenCalledTimes(3);
    expect(batchInstances.map(({ commands }) => commands.length)).toEqual([1_000, 1, 1]);
    expect(batchInstances[0]?.commands[0]?.[0]).toBe("EVALSHA");
    expect(batchInstances[1]?.commands[0]?.[0]).toBe("EVALSHA");
    expect(batchInstances[2]?.commands[0]?.[0]).toBe("EVAL");
  });

  it("preserves unrelated native batch errors without retrying", async () => {
    const failure = new Error("ERR invalid command arguments");
    const client = fakeClient();
    client.exec.mockRejectedValueOnce(failure);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.invalidateMany([
      { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
    ])).rejects.toBe(failure);

    expect(client.exec).toHaveBeenCalledTimes(1);
    expect(batchInstances).toHaveLength(1);
    adapter.dispose();
  });

  it("keeps one-pass EVAL batching for Script handles without getHash", async () => {
    class ScriptWithoutHash {
      readonly release = vi.fn();
    }
    const glideWithoutHash = {
      ...mockGlide,
      Script: ScriptWithoutHash,
    };
    const client = {
      exec: vi.fn(async () => [1, 1]),
      invokeScript: vi.fn(async () => null),
    };
    const adapter = createValkeyGlideDialCacheClient(client, glideWithoutHash);

    await expect(adapter.invalidateMany([
      { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
      { watermarkKey: "cache:{two}:watermark", futureBufferMs: 250 },
    ])).resolves.toBeUndefined();

    expect(client.exec).toHaveBeenCalledTimes(1);
    expect(batchInstances).toHaveLength(1);
    expect(batchInstances[0]?.commands).toEqual([
      ["EVAL", expect.any(String), "1", "cache:{one}:watermark", "0"],
      ["EVAL", expect.any(String), "1", "cache:{two}:watermark", "250"],
    ]);
  });

  it("keeps legacy scalar-only GLIDE wrappers compatible", async () => {
    const client = {
      invokeScript: vi.fn(async () => 1),
    };
    const legacyGlide = {
      Decoder: { Bytes: decoderBytes },
      Script: MockScript,
    };
    const adapter = createValkeyGlideDialCacheClient(client, legacyGlide);

    await expect(adapter.invalidateMany([
      { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
      { watermarkKey: "cache:{two}:watermark", futureBufferMs: 250 },
    ])).resolves.toBeUndefined();

    expect(client.invokeScript).toHaveBeenCalledTimes(2);
    expect(client.invokeScript).toHaveBeenNthCalledWith(
      1,
      expect.any(MockScript),
      { keys: ["cache:{one}:watermark"], args: ["0"], decoder: decoderBytes },
    );
    expect(client.invokeScript).toHaveBeenNthCalledWith(
      2,
      expect.any(MockScript),
      { keys: ["cache:{two}:watermark"], args: ["250"], decoder: decoderBytes },
    );
  });

  it("bounds legacy scalar invalidations and dispatches their windows sequentially", async () => {
    let resolveFirstWindow: ((value: number) => void) | undefined;
    const firstWindow = new Promise<number>((resolve) => {
      resolveFirstWindow = resolve;
    });
    const client = {
      invokeScript: vi.fn(async () => {
        if (client.invokeScript.mock.calls.length <= 1_000) {
          return await firstWindow;
        }
        return 1;
      }),
    };
    const legacyGlide = {
      Decoder: { Bytes: decoderBytes },
      Script: MockScript,
    };
    const adapter = createValkeyGlideDialCacheClient(client, legacyGlide);

    const invalidation = adapter.invalidateMany(invalidationRequests(1_001));
    await vi.waitFor(() => {
      expect(client.invokeScript).toHaveBeenCalledTimes(1_000);
    });
    expect(() => adapter.dispose()).toThrow(
      "Cannot dispose Valkey GLIDE DialCache client while operations are in flight",
    );

    resolveFirstWindow?.(1);
    await expect(invalidation).resolves.toBeUndefined();
    expect(client.invokeScript).toHaveBeenCalledTimes(1_001);
    adapter.dispose();
  });

  it("settles a failed scalar window without dispatching later windows", async () => {
    const failure = new Error("first scalar invalidation failed");
    const client = {
      invokeScript: vi.fn(async () => {
        if (client.invokeScript.mock.calls.length === 1) {
          throw failure;
        }
        return 1;
      }),
    };
    const legacyGlide = {
      Decoder: { Bytes: decoderBytes },
      Script: MockScript,
    };
    const adapter = createValkeyGlideDialCacheClient(client, legacyGlide);

    await expect(adapter.invalidateMany(invalidationRequests(1_001))).rejects.toBe(failure);

    expect(client.invokeScript).toHaveBeenCalledTimes(1_000);
    adapter.dispose();
  });

  it("uses one native cluster batch for invalidations across hash slots", async () => {
    const client = new MockClusterClient();
    client.exec.mockResolvedValueOnce([1, 1]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.invalidateMany([
      { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
      { watermarkKey: "cache:{two}:watermark", futureBufferMs: 100 },
    ])).resolves.toBeUndefined();

    expect(clusterBatchInstances).toHaveLength(1);
    expect(clusterBatchInstances[0]).toMatchObject({ isAtomic: false });
    expect(client.exec).toHaveBeenCalledTimes(1);
    expect(client.exec).toHaveBeenCalledWith(
      clusterBatchInstances[0],
      true,
      {
        decoder: decoderBytes,
        retryStrategy: {
          retryServerError: true,
          retryConnectionError: true,
        },
      },
    );
  });

  it("uses bounded sequential native ClusterBatch chunks", async () => {
    const client = new MockClusterClient();
    client.exec.mockImplementation(async (batch) => batch.commands.map(() => 1));
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.invalidateMany(invalidationRequests(1_001))).resolves.toBeUndefined();

    expect(clusterBatchInstances).toHaveLength(2);
    expect(clusterBatchInstances.map(({ commands }) => commands.length)).toEqual([1_000, 1]);
    expect(client.exec).toHaveBeenCalledTimes(2);
    for (const batch of clusterBatchInstances) {
      expect(client.exec).toHaveBeenCalledWith(
        batch,
        true,
        {
          decoder: decoderBytes,
          retryStrategy: {
            retryServerError: true,
            retryConnectionError: true,
          },
        },
      );
    }
  });

  it("validates a native chunk before dispatching the next one", async () => {
    const client = fakeClient();
    client.exec.mockResolvedValueOnce(Array.from({ length: 999 }, () => 1));
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expectProtocolError(
      adapter.invalidateMany(invalidationRequests(1_001)),
      "Invalid DialCache Redis invalidate batch reply; expected 1000 replies",
    );

    expect(client.exec).toHaveBeenCalledTimes(1);
    expect(batchInstances).toHaveLength(1);
    adapter.dispose();
  });

  it("rejects malformed invalidation batch replies", async () => {
    const invalidationMessage = "Invalid DialCache Redis invalidate reply; expected integer 1";

    for (const reply of [null, [], [1, 1, 1]]) {
      const client = fakeClient();
      client.exec.mockResolvedValueOnce(reply);
      const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
      await expectProtocolError(
        adapter.invalidateMany([
          { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
          { watermarkKey: "cache:{two}:watermark", futureBufferMs: 0 },
        ]),
        "Invalid DialCache Redis invalidate batch reply; expected 2 replies",
      );
      adapter.dispose();
    }

    const client = fakeClient();
    client.exec.mockResolvedValueOnce([1, 0]);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
    await expectProtocolError(
      adapter.invalidateMany([
        { watermarkKey: "cache:{one}:watermark", futureBufferMs: 0 },
        { watermarkKey: "cache:{two}:watermark", futureBufferMs: 0 },
      ]),
      invalidationMessage,
    );
    adapter.dispose();
  });

  it("rejects malformed script replies", async () => {
    const client = fakeClient("not-bytes", Buffer.alloc(0), Buffer.from([2, 1]), "not-an-integer", null);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await expect(adapter.read({ valueKey: "wrong-type" })).rejects.toBeInstanceOf(DialCacheRedisPayloadError);
    await expect(adapter.read({ valueKey: "empty" })).rejects.toBeInstanceOf(DialCacheRedisPayloadError);
    await expect(adapter.read({ valueKey: "wrong-encoding" })).rejects.toBeInstanceOf(
      DialCacheRedisPayloadEncodingError,
    );
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

    expect(scriptInstances).toHaveLength(5);
    for (const script of scriptInstances) {
      expect(script.release).toHaveBeenCalledTimes(1);
    }
    await expect(adapter.read({ valueKey: "disposed" })).rejects.toThrow("Valkey GLIDE DialCache client is disposed");
    await expect(adapter.invalidateMany([
      { watermarkKey: "cache:{disposed}:watermark", futureBufferMs: 0 },
    ])).rejects.toThrow("Valkey GLIDE DialCache client is disposed");
    expect(client.invokeScript).not.toHaveBeenCalled();
    expect(client.exec).not.toHaveBeenCalled();
  });

  it("does not release scripts while an invocation is in flight", async () => {
    let resolveRead: ((value: Buffer) => void) | undefined;
    const client = fakeClient();
    client.invokeScript.mockImplementationOnce(
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

    resolveRead?.(Buffer.from([0, ...Buffer.from("done")]));
    await expect(read).resolves.toBe("done");
    adapter.dispose();
    expect(scriptInstances.every((script) => script.release.mock.calls.length === 1)).toBe(true);
  });

  it("does not release scripts while an invalidation batch is in flight", async () => {
    let resolveBatch: ((value: unknown[]) => void) | undefined;
    const client = fakeClient();
    client.exec.mockImplementationOnce(
      async () => await new Promise<unknown[]>((resolve) => {
        resolveBatch = resolve;
      }),
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    const invalidation = adapter.invalidateMany([
      { watermarkKey: "cache:{in-flight}:watermark", futureBufferMs: 0 },
    ]);
    expect(() => adapter.dispose()).toThrow(
      "Cannot dispose Valkey GLIDE DialCache client while operations are in flight",
    );
    expect(scriptInstances.every((script) => script.release.mock.calls.length === 0)).toBe(true);

    resolveBatch?.([1]);
    await expect(invalidation).resolves.toBeUndefined();
    adapter.dispose();
    expect(scriptInstances.every((script) => script.release.mock.calls.length === 1)).toBe(true);
  });

  it("tracks a cold-script EVAL retry until the fallback batch settles", async () => {
    let resolveFallback: ((value: unknown[]) => void) | undefined;
    const client = fakeClient();
    client.exec
      .mockRejectedValueOnce(
        new Error(
          "An error was signalled by the server - NoScriptError: No matching script. Please use EVAL.",
        ),
      )
      .mockImplementationOnce(
        async () => await new Promise<unknown[]>((resolve) => {
          resolveFallback = resolve;
        }),
      );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    const invalidation = adapter.invalidateMany([
      { watermarkKey: "cache:{cold-in-flight}:watermark", futureBufferMs: 0 },
    ]);
    await vi.waitFor(() => {
      expect(client.exec).toHaveBeenCalledTimes(2);
    });

    expect(() => adapter.dispose()).toThrow(
      "Cannot dispose Valkey GLIDE DialCache client while operations are in flight",
    );
    expect(scriptInstances.every((script) => script.release.mock.calls.length === 0)).toBe(true);

    resolveFallback?.([1]);
    await expect(invalidation).resolves.toBeUndefined();
    adapter.dispose();
    expect(scriptInstances.every((script) => script.release.mock.calls.length === 1)).toBe(true);
  });

  it("uses Script and Decoder from the supplied GLIDE module instance", async () => {
    class OtherScript {
      readonly release = vi.fn();
    }
    const otherGlide = {
      Decoder: { Bytes: Symbol("other-bytes") },
      Script: OtherScript,
    };
    const client = fakeClient(null);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);

    await adapter.read({ valueKey: "module-instance" });

    const [script, options] = client.invokeScript.mock.calls[0] ?? [];
    expect(script).toBeInstanceOf(MockScript);
    expect(script).not.toBeInstanceOf(otherGlide.Script);
    expect(options?.decoder).toBe(mockGlide.Decoder.Bytes);
    expect(options?.decoder).not.toBe(otherGlide.Decoder.Bytes);
    adapter.dispose();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  DialCacheRedisProtocolError,
} from "../src/redis-client.js";
import { INVALIDATE_AND_PUBLISH_CACHE_SCRIPT } from "../src/redis-protocol.js";
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

class MockScript {
  readonly release = vi.fn();

  constructor(readonly code: string) {
    scriptInstances.push(this);
  }
}

const mockGlide = {
  Decoder: { Bytes: decoderBytes },
  Script: MockScript,
};

interface InvokeScriptOptions {
  keys: Array<string | Buffer>;
  args: Array<string | Buffer>;
  decoder: typeof decoderBytes;
}

function fakeClient(...replies: unknown[]) {
  return {
    invokeScript: vi.fn(async (_script: MockScript, _options: InvokeScriptOptions) => replies.shift()),
  };
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
    expect(client.invokeScript).not.toHaveBeenCalled();
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

  it("lazily registers and invokes coordinated invalidation", async () => {
    const event = {
      version: 1,
      namespace: "users",
      keyType: "user_id",
      id: "123",
      effectiveWatermarkMs: "1785300001000",
      redisNowMs: "1785300000000",
    } as const;
    const client = fakeClient(Buffer.from(JSON.stringify(event)));
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
    expect(scriptInstances).toHaveLength(5);

    await expect(adapter.invalidateAndPublish({
      watermarkKey: "{users:user_id:123}#watermark",
      futureBufferMs: 1_000,
      channel: "dialcache:invalidation:v1:users",
      namespace: "users",
      keyType: "user_id",
      id: "123",
    })).resolves.toEqual(event);

    expect(scriptInstances).toHaveLength(6);
    expect(scriptInstances[5]?.code).toBe(INVALIDATE_AND_PUBLISH_CACHE_SCRIPT);
    expect(client.invokeScript).toHaveBeenCalledWith(
      scriptInstances[5],
      {
        keys: ["{users:user_id:123}#watermark"],
        args: [
          "1000",
          "dialcache:invalidation:v1:users",
          "users",
          "user_id",
          "123",
        ],
        decoder: decoderBytes,
      },
    );

    adapter.dispose();
    expect(scriptInstances[5]?.release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or mismatched coordinated invalidation replies", async () => {
    const wrongIdentity = Buffer.from(JSON.stringify({
      version: 1,
      namespace: "users",
      keyType: "user_id",
      id: "other",
      effectiveWatermarkMs: "1000",
      redisNowMs: "1000",
    }));
    const client = fakeClient("not-bytes", wrongIdentity);
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
    const request = {
      watermarkKey: "{users:user_id:123}#watermark",
      futureBufferMs: 0,
      channel: "dialcache:invalidation:v1:users",
      namespace: "users",
      keyType: "user_id",
      id: "123",
    } as const;

    await expect(adapter.invalidateAndPublish(request)).rejects.toBeInstanceOf(
      DialCacheRedisPayloadError,
    );
    await expect(adapter.invalidateAndPublish(request)).rejects.toBeInstanceOf(
      DialCacheRedisProtocolError,
    );
    adapter.dispose();
  });

  it("does not release a lazy coordinated script while its invocation is active", async () => {
    let resolveInvalidation: ((value: Buffer) => void) | undefined;
    const client = fakeClient();
    client.invokeScript.mockImplementationOnce(
      async () => await new Promise<Buffer>((resolve) => {
        resolveInvalidation = resolve;
      }),
    );
    const adapter = createValkeyGlideDialCacheClient(client, mockGlide);
    const operation = adapter.invalidateAndPublish({
      watermarkKey: "{users:user_id:123}#watermark",
      futureBufferMs: 0,
      channel: "dialcache:invalidation:v1:users",
      namespace: "users",
      keyType: "user_id",
      id: "123",
    });

    expect(() => adapter.dispose()).toThrow(
      "Cannot dispose Valkey GLIDE DialCache client while operations are in flight",
    );
    expect(scriptInstances).toHaveLength(6);
    expect(scriptInstances[5]?.release).not.toHaveBeenCalled();

    resolveInvalidation?.(Buffer.from(JSON.stringify({
      version: 1,
      namespace: "users",
      keyType: "user_id",
      id: "123",
      effectiveWatermarkMs: "1000",
      redisNowMs: "1000",
    })));
    await operation;
    adapter.dispose();
    expect(scriptInstances[5]?.release).toHaveBeenCalledTimes(1);
  });

  it("does not create a coordinated script after disposal", async () => {
    const adapter = createValkeyGlideDialCacheClient(fakeClient(), mockGlide);
    adapter.dispose();

    await expect(adapter.invalidateAndPublish({
      watermarkKey: "{users:user_id:123}#watermark",
      futureBufferMs: 0,
      channel: "dialcache:invalidation:v1:users",
      namespace: "users",
      keyType: "user_id",
      id: "123",
    })).rejects.toThrow("Valkey GLIDE DialCache client is disposed");
    expect(scriptInstances).toHaveLength(5);
  });
});

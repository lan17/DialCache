import type { CacheMissReason } from "../src/index.js";
import {
  decodeRedisReadResult,
  decodeTrackedRedisReadResult,
  encodeRedisFrame,
  isRedisReadMiss,
} from "../src/redis-protocol.js";
import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
} from "../src/redis-client.js";

function encodeFrame(
  payload: string | Buffer,
  encoding = 0,
  createdAtMs = 1_000,
  version = 1,
): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(createdAtMs));
  return Buffer.concat([
    Buffer.from([version]),
    timestamp,
    Buffer.from([encoding]),
    Buffer.from(payload),
  ]);
}

describe("Redis frame decoding", () => {
  it("decodes UTF-8 and binary payloads without copying binary data", () => {
    expect(decodeRedisReadResult(encodeFrame("cached"))).toEqual({
      payload: "cached",
      createdAtMs: 1_000,
    });

    const frame = encodeFrame(Buffer.from([0, 0xff, 0x80]), 1, 2_000);
    const decoded = decodeRedisReadResult(frame);
    expect(decoded).toEqual({ payload: Buffer.from([0, 0xff, 0x80]), createdAtMs: 2_000 });
    if (isRedisReadMiss(decoded)) {
      throw new Error("Expected a decoded Redis frame");
    }
    const { payload } = decoded;
    expect(Buffer.isBuffer(payload)).toBe(true);
    if (!Buffer.isBuffer(payload)) {
      throw new Error("Expected a binary Redis payload");
    }
    expect(payload.buffer).toBe(frame.buffer);
    expect(payload.byteOffset).toBe(frame.byteOffset + 10);
    expect(payload.byteLength).toBe(frame.byteLength - 10);
  });

  it("classifies untracked absence separately from short and unsupported frames", () => {
    expect(decodeRedisReadResult(null)).toEqual({ kind: "miss", reason: "value_absent" });
    expect(decodeRedisReadResult(Buffer.alloc(9))).toEqual({
      kind: "miss",
      reason: "unclassified",
    });
    expect(decodeRedisReadResult(encodeFrame("cached", 0, 1_000, 2))).toEqual({
      kind: "miss",
      reason: "unclassified",
    });
  });

  it("rejects unsupported payload encodings after validating the frame", () => {
    expect(() => decodeRedisReadResult(encodeFrame("cached", 2))).toThrow(
      DialCacheRedisPayloadEncodingError,
    );
  });

  it("rejects non-bulk-string runtime replies at the shared decoder boundary", () => {
    const invalidReplies: readonly unknown[] = [undefined, "not-bytes", 0, {}, []];

    for (const reply of invalidReplies) {
      expect(() => decodeRedisReadResult(reply)).toThrow(DialCacheRedisPayloadError);
      expect(() => decodeTrackedRedisReadResult(reply, null)).toThrow(
        DialCacheRedisPayloadError,
      );
      expect(() => decodeTrackedRedisReadResult(null, reply)).toThrow(
        DialCacheRedisPayloadError,
      );
    }
  });

  it("validates tracked frames against safe-integer watermarks", () => {
    const frame = encodeFrame("cached", 0, 1_000);
    const decoded = { payload: "cached", createdAtMs: 1_000 };

    expect(decodeTrackedRedisReadResult(frame, Buffer.from("999"))).toEqual(decoded);
    expect(decodeTrackedRedisReadResult(frame, Buffer.from("1000"))).toEqual({
      kind: "miss",
      reason: "watermark_fenced",
      observedWatermarkMs: 1_000,
    });

    const latestFrame = encodeFrame("latest", 0, Number.MAX_SAFE_INTEGER);
    expect(
      decodeTrackedRedisReadResult(
        latestFrame,
        Buffer.from(String(Number.MAX_SAFE_INTEGER - 1)),
      ),
    ).toEqual({ payload: "latest", createdAtMs: Number.MAX_SAFE_INTEGER });
    expect(
      decodeTrackedRedisReadResult(latestFrame, Buffer.from(String(Number.MAX_SAFE_INTEGER))),
    ).toEqual({
      kind: "miss",
      reason: "watermark_fenced",
      observedWatermarkMs: Number.MAX_SAFE_INTEGER,
    });
  });

  it("classifies tracked misses while preserving a valid observed watermark independently", () => {
    const watermark = Buffer.from("1000");

    const cases: ReadonlyArray<readonly [unknown, CacheMissReason]> = [
      [null, "value_absent"],
      [Buffer.alloc(9), "unclassified"],
      [encodeFrame("unsupported", 0, 2_000, 2), "unclassified"],
      [encodeFrame("fenced", 0, 1_000), "watermark_fenced"],
    ];
    for (const [frame, reason] of cases) {
      const result = decodeTrackedRedisReadResult(frame, watermark);
      expect(result).toEqual({ kind: "miss", reason, observedWatermarkMs: 1_000 });
      expect(isRedisReadMiss(result)).toBe(true);
    }
  });

  it("classifies nil before malformed or absent watermark metadata", () => {
    for (const watermark of [null, Buffer.from("invalid")]) {
      expect(decodeTrackedRedisReadResult(null, watermark)).toEqual({
        kind: "miss",
        reason: "value_absent",
      });
      expect(decodeTrackedRedisReadResult(Buffer.alloc(9), watermark)).toEqual({
        kind: "miss",
        reason: "unclassified",
      });
      expect(decodeTrackedRedisReadResult(
        encodeFrame("unsupported", 0, 2_000, 2),
        watermark,
      )).toEqual({ kind: "miss", reason: "unclassified" });
    }
  });

  it("returns the same undiscriminated hit shape on both read paths", () => {
    const frame = encodeFrame("cached", 0, 1_001);
    const decoded = { payload: "cached", createdAtMs: 1_001 };

    const untracked = decodeRedisReadResult(frame);
    expect(untracked).toEqual(decoded);
    expect(isRedisReadMiss(untracked)).toBe(false);
    for (const watermark of [null, Buffer.from("1000")]) {
      const tracked = decodeTrackedRedisReadResult(frame, watermark);
      expect(tracked).toEqual(decoded);
      expect(isRedisReadMiss(tracked)).toBe(false);
    }
  });

  it("preserves unsafe timestamps for core validation after decoding the payload", () => {
    const createdAtMs = Number.MAX_SAFE_INTEGER + 1;
    const frame = encodeFrame("cached", 0, createdAtMs);
    const decoded = { payload: "cached", createdAtMs };

    expect(decodeRedisReadResult(frame)).toEqual(decoded);
    for (const watermark of [null, Buffer.from("1000")]) {
      expect(decodeTrackedRedisReadResult(frame, watermark)).toEqual(decoded);
    }
  });

  it("preserves payload encoding errors for frames with unsafe timestamps", () => {
    const frame = encodeFrame("cached", 2, Number.MAX_SAFE_INTEGER + 1);

    expect(() => decodeRedisReadResult(frame)).toThrow(DialCacheRedisPayloadEncodingError);
    for (const watermark of [null, Buffer.from("1000")]) {
      expect(() => decodeTrackedRedisReadResult(frame, watermark)).toThrow(
        DialCacheRedisPayloadEncodingError,
      );
    }
  });

  it("treats a missing watermark as the zero baseline", () => {
    const frame = encodeFrame("cached", 0, 1_000);

    expect(decodeTrackedRedisReadResult(frame, null)).toEqual({
      payload: "cached",
      createdAtMs: 1_000,
    });
  });

  it("treats malformed and non-finite watermarks as unclassified tracked misses", () => {
    const frame = encodeFrame("cached", 0, 1_000);

    for (const watermark of [
      Buffer.from(""),
      Buffer.from("-1"),
      Buffer.from("1."),
      Buffer.from(".1"),
      Buffer.from("1e2"),
      Buffer.from("1\n"),
      Buffer.from("999.5"),
      Buffer.from(String(Number.MAX_SAFE_INTEGER + 1)),
      Buffer.from("9".repeat(400)),
    ]) {
      expect(decodeTrackedRedisReadResult(frame, watermark)).toEqual({
        kind: "miss",
        reason: "unclassified",
      });
      expect(decodeTrackedRedisReadResult(null, watermark)).toEqual({
        kind: "miss",
        reason: "value_absent",
      });
    }
  });

  it("validates tracked frame and watermark state before payload encoding", () => {
    const malformedPayload = encodeFrame("cached", 2, 1_000);

    expect(decodeTrackedRedisReadResult(null, Buffer.from("0"))).toEqual({
      kind: "miss",
      reason: "value_absent",
      observedWatermarkMs: 0,
    });
    expect(decodeTrackedRedisReadResult(Buffer.alloc(9), Buffer.from("0"))).toEqual({
      kind: "miss",
      reason: "unclassified",
      observedWatermarkMs: 0,
    });
    expect(() => decodeTrackedRedisReadResult(malformedPayload, null)).toThrow(
      DialCacheRedisPayloadEncodingError,
    );
    expect(decodeTrackedRedisReadResult(malformedPayload, Buffer.from("invalid"))).toEqual({
      kind: "miss",
      reason: "unclassified",
    });
    expect(decodeTrackedRedisReadResult(malformedPayload, Buffer.from("1000"))).toEqual({
      kind: "miss",
      reason: "watermark_fenced",
      observedWatermarkMs: 1_000,
    });
    expect(() => decodeTrackedRedisReadResult(malformedPayload, Buffer.from("999"))).toThrow(
      DialCacheRedisPayloadEncodingError,
    );
  });

  it("encodes frames that decode back through both read paths", () => {
    const utf8 = encodeRedisFrame("cachéd ✓", 1_000);
    expect(utf8[0]).toBe(1);
    expect(Number(utf8.readBigUInt64BE(1))).toBe(1_000);
    expect(utf8[9]).toBe(0);
    expect(decodeRedisReadResult(utf8)).toEqual({ payload: "cachéd ✓", createdAtMs: 1_000 });
    expect(decodeTrackedRedisReadResult(utf8, Buffer.from("999"))).toEqual({
      payload: "cachéd ✓",
      createdAtMs: 1_000,
    });

    const binaryPayload = Buffer.from([0, 0xff, 0x80]);
    const binary = encodeRedisFrame(binaryPayload, 2_000);
    expect(binary[9]).toBe(1);
    expect(binary).toEqual(encodeFrame(binaryPayload, 1, 2_000));
    expect(decodeRedisReadResult(binary)).toEqual({ payload: binaryPayload, createdAtMs: 2_000 });

    const empty = encodeRedisFrame("", 1);
    expect(empty.byteLength).toBe(10);
    expect(decodeRedisReadResult(empty)).toEqual({ payload: "", createdAtMs: 1 });
  });

  it("keeps zero-stamped version-1 frames unreadable on the tracked path", () => {
    const zeroStamped = encodeRedisFrame("pending", 0);

    expect(decodeTrackedRedisReadResult(zeroStamped, null)).toEqual({
      kind: "miss",
      reason: "unclassified",
    });
    expect(decodeTrackedRedisReadResult(zeroStamped, Buffer.from("0"))).toEqual({
      kind: "miss",
      reason: "unclassified",
      observedWatermarkMs: 0,
    });
    expect(decodeTrackedRedisReadResult(zeroStamped, Buffer.from("1"))).toEqual({
      kind: "miss",
      reason: "unclassified",
      observedWatermarkMs: 1,
    });
    expect(decodeRedisReadResult(zeroStamped)).toEqual({ payload: "pending", createdAtMs: 0 });
  });

  it("gates serving on the version byte even for hostile header bytes", () => {
    const hostile = encodeFrame("pending", 0, 1, 0);
    hostile.fill(0xff, 1, 9);

    expect(decodeRedisReadResult(hostile)).toEqual({ kind: "miss", reason: "unclassified" });
    expect(decodeTrackedRedisReadResult(hostile, Buffer.from("1"))).toEqual({
      kind: "miss",
      reason: "unclassified",
      observedWatermarkMs: 1,
    });
  });

  it("rejects unencodable createdAt timestamps", () => {
    for (const createdAtMs of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => encodeRedisFrame("value", createdAtMs)).toThrow(RangeError);
    }
  });

  it("preserves payload error identity across separately bundled entry points", () => {
    class SpecializedPayloadError extends DialCacheRedisPayloadError {}
    class SpecializedEncodingError extends DialCacheRedisPayloadEncodingError {}

    const payloadError = new DialCacheRedisPayloadError("payload");
    const encodingError = new DialCacheRedisPayloadEncodingError("encoding");
    const specializedPayloadError = new SpecializedPayloadError("specialized payload");
    const specializedEncodingError = new SpecializedEncodingError("specialized encoding");
    const crossBundlePayloadError = Object.defineProperty(
      new Error("payload"),
      Symbol.for("dialcache.DialCacheRedisPayloadError"),
      { value: true },
    );
    const crossBundleEncodingError = Object.defineProperty(
      new Error("encoding"),
      Symbol.for("dialcache.DialCacheRedisPayloadEncodingError"),
      { value: true },
    );
    const falselyBrandedPayloadError = Object.defineProperty(
      new Error("payload"),
      Symbol.for("dialcache.DialCacheRedisPayloadError"),
      { value: false },
    );
    const falselyBrandedEncodingError = Object.defineProperty(
      new Error("encoding"),
      Symbol.for("dialcache.DialCacheRedisPayloadEncodingError"),
      { value: false },
    );

    expect(payloadError).toBeInstanceOf(DialCacheRedisPayloadError);
    expect(payloadError).not.toBeInstanceOf(SpecializedPayloadError);
    expect(specializedPayloadError).toBeInstanceOf(SpecializedPayloadError);
    expect(specializedPayloadError).toBeInstanceOf(DialCacheRedisPayloadError);
    expect(crossBundlePayloadError).toBeInstanceOf(DialCacheRedisPayloadError);
    expect(falselyBrandedPayloadError).not.toBeInstanceOf(DialCacheRedisPayloadError);

    expect(encodingError).toBeInstanceOf(DialCacheRedisPayloadEncodingError);
    expect(encodingError).not.toBeInstanceOf(SpecializedEncodingError);
    expect(specializedEncodingError).toBeInstanceOf(SpecializedEncodingError);
    expect(specializedEncodingError).toBeInstanceOf(DialCacheRedisPayloadEncodingError);
    expect(crossBundleEncodingError).toBeInstanceOf(DialCacheRedisPayloadEncodingError);
    expect(falselyBrandedEncodingError).not.toBeInstanceOf(DialCacheRedisPayloadEncodingError);
  });
});

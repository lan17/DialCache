import {
  decodeRedisFrame,
  decodeTrackedRedisFrame,
  decodeTrackedRedisReadResult,
  encodeRedisFrame,
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
    expect(decodeRedisFrame(encodeFrame("cached"))).toEqual({ payload: "cached", createdAtMs: 1_000 });

    const frame = encodeFrame(Buffer.from([0, 0xff, 0x80]), 1, 2_000);
    const decoded = decodeRedisFrame(frame);
    expect(decoded).toEqual({ payload: Buffer.from([0, 0xff, 0x80]), createdAtMs: 2_000 });
    const payload = decoded?.payload;
    expect(Buffer.isBuffer(payload)).toBe(true);
    if (!Buffer.isBuffer(payload)) {
      throw new Error("Expected a binary Redis payload");
    }
    expect(payload.buffer).toBe(frame.buffer);
    expect(payload.byteOffset).toBe(frame.byteOffset + 10);
    expect(payload.byteLength).toBe(frame.byteLength - 10);
  });

  it("treats missing, short, and unsupported frames as misses", () => {
    expect(decodeRedisFrame(null)).toBeNull();
    expect(decodeRedisFrame(Buffer.alloc(9))).toBeNull();
    expect(decodeRedisFrame(encodeFrame("cached", 0, 1_000, 2))).toBeNull();
  });

  it("rejects unsupported payload encodings after validating the frame", () => {
    expect(() => decodeRedisFrame(encodeFrame("cached", 2))).toThrow(
      DialCacheRedisPayloadEncodingError,
    );
  });

  it("rejects non-bulk-string runtime replies at the shared decoder boundary", () => {
    const invalidReplies: readonly unknown[] = [undefined, "not-bytes", 0, {}, []];

    for (const reply of invalidReplies) {
      expect(() => decodeRedisFrame(reply)).toThrow(DialCacheRedisPayloadError);
      expect(() => decodeTrackedRedisFrame(reply, null)).toThrow(DialCacheRedisPayloadError);
      expect(() => decodeTrackedRedisFrame(null, reply)).toThrow(DialCacheRedisPayloadError);
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

    expect(decodeTrackedRedisFrame(frame, Buffer.from("999"))).toEqual(decoded);
    expect(decodeTrackedRedisFrame(frame, Buffer.from("1000"))).toBeNull();

    const latestFrame = encodeFrame("latest", 0, Number.MAX_SAFE_INTEGER);
    expect(
      decodeTrackedRedisFrame(latestFrame, Buffer.from(String(Number.MAX_SAFE_INTEGER - 1))),
    ).toEqual({ payload: "latest", createdAtMs: Number.MAX_SAFE_INTEGER });
    expect(
      decodeTrackedRedisFrame(latestFrame, Buffer.from(String(Number.MAX_SAFE_INTEGER))),
    ).toBeNull();
  });

  it("preserves valid observed watermarks for every tracked semantic miss", () => {
    const watermark = Buffer.from("1000");

    for (const frame of [
      null,
      Buffer.alloc(9),
      encodeFrame("unsupported", 0, 2_000, 2),
      encodeFrame("fenced", 0, 1_000),
    ]) {
      expect(decodeTrackedRedisReadResult(frame, watermark)).toEqual({
        kind: "watermark_miss",
        observedWatermarkMs: 1_000,
      });
      expect(decodeTrackedRedisFrame(frame, watermark)).toBeNull();
    }
  });

  it("retains generic misses when no trustworthy watermark was observed", () => {
    for (const watermark of [null, Buffer.from("invalid")]) {
      expect(decodeTrackedRedisReadResult(null, watermark)).toBeNull();
      expect(decodeTrackedRedisReadResult(Buffer.alloc(9), watermark)).toBeNull();
      expect(decodeTrackedRedisReadResult(
        encodeFrame("unsupported", 0, 2_000, 2),
        watermark,
      )).toBeNull();
    }
  });

  it("returns eligible tracked frames through the typed decoder", () => {
    expect(
      decodeTrackedRedisReadResult(
        encodeFrame("cached", 0, 1_001),
        Buffer.from("1000"),
      ),
    ).toEqual({ payload: "cached", createdAtMs: 1_001 });
  });

  it("treats a missing watermark as the zero baseline", () => {
    const frame = encodeFrame("cached", 0, 1_000);

    expect(decodeTrackedRedisFrame(frame, null)).toEqual({
      payload: "cached",
      createdAtMs: 1_000,
    });
  });

  it("treats malformed and non-finite watermarks as misses", () => {
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
      expect(decodeTrackedRedisFrame(frame, watermark)).toBeNull();
    }
  });

  it("validates tracked frame and watermark state before payload encoding", () => {
    const malformedPayload = encodeFrame("cached", 2, 1_000);

    expect(decodeTrackedRedisFrame(null, Buffer.from("0"))).toBeNull();
    expect(decodeTrackedRedisFrame(Buffer.alloc(9), Buffer.from("0"))).toBeNull();
    expect(() => decodeTrackedRedisFrame(malformedPayload, null)).toThrow(
      DialCacheRedisPayloadEncodingError,
    );
    expect(decodeTrackedRedisFrame(malformedPayload, Buffer.from("1000"))).toBeNull();
    expect(() => decodeTrackedRedisFrame(malformedPayload, Buffer.from("999"))).toThrow(
      DialCacheRedisPayloadEncodingError,
    );
  });

  it("encodes frames that decode back through both read paths", () => {
    const utf8 = encodeRedisFrame("cachéd ✓", 1_000);
    expect(utf8[0]).toBe(1);
    expect(Number(utf8.readBigUInt64BE(1))).toBe(1_000);
    expect(utf8[9]).toBe(0);
    expect(decodeRedisFrame(utf8)).toEqual({ payload: "cachéd ✓", createdAtMs: 1_000 });
    expect(decodeTrackedRedisFrame(utf8, Buffer.from("999"))).toEqual({ payload: "cachéd ✓", createdAtMs: 1_000 });

    const binaryPayload = Buffer.from([0, 0xff, 0x80]);
    const binary = encodeRedisFrame(binaryPayload, 2_000);
    expect(binary[9]).toBe(1);
    expect(binary).toEqual(encodeFrame(binaryPayload, 1, 2_000));
    expect(decodeRedisFrame(binary)).toEqual({ payload: binaryPayload, createdAtMs: 2_000 });

    const empty = encodeRedisFrame("", 1);
    expect(empty.byteLength).toBe(10);
    expect(decodeRedisFrame(empty)).toEqual({ payload: "", createdAtMs: 1 });
  });

  it("keeps zero-stamped version-1 frames unreadable on the tracked path", () => {
    const zeroStamped = encodeRedisFrame("pending", 0);

    expect(decodeTrackedRedisFrame(zeroStamped, null)).toBeNull();
    expect(decodeTrackedRedisFrame(zeroStamped, Buffer.from("0"))).toBeNull();
    expect(decodeTrackedRedisFrame(zeroStamped, Buffer.from("1"))).toBeNull();
    expect(decodeRedisFrame(zeroStamped)).toEqual({ payload: "pending", createdAtMs: 0 });
  });

  it("gates serving on the version byte even for hostile header bytes", () => {
    const hostile = encodeFrame("pending", 0, 1, 0);
    hostile.fill(0xff, 1, 9);

    expect(decodeRedisFrame(hostile)).toBeNull();
    expect(decodeTrackedRedisFrame(hostile, Buffer.from("1"))).toBeNull();
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

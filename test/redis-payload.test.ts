import {
  decodeRedisFrame,
  decodeTrackedRedisFrame,
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
    expect(decodeRedisFrame(encodeFrame("cached"))).toBe("cached");

    const frame = encodeFrame(Buffer.from([0, 0xff, 0x80]), 1);
    const decoded = decodeRedisFrame(frame);
    expect(decoded).toEqual(Buffer.from([0, 0xff, 0x80]));
    expect(Buffer.isBuffer(decoded)).toBe(true);
    if (!Buffer.isBuffer(decoded)) {
      throw new Error("Expected a binary Redis payload");
    }
    expect(decoded.buffer).toBe(frame.buffer);
    expect(decoded.byteOffset).toBe(frame.byteOffset + 10);
    expect(decoded.byteLength).toBe(frame.byteLength - 10);
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
    }
  });

  it("validates tracked frames against integer and fractional watermarks", () => {
    const frame = encodeFrame("cached", 0, 1_000);

    expect(decodeTrackedRedisFrame(frame, Buffer.from("999"))).toBe("cached");
    expect(decodeTrackedRedisFrame(frame, Buffer.from("999.5"))).toBe("cached");
    expect(decodeTrackedRedisFrame(frame, Buffer.from("1000"))).toBeNull();
    expect(decodeTrackedRedisFrame(frame, Buffer.from("1000.5"))).toBeNull();
  });

  it("treats missing, malformed, and non-finite watermarks as misses", () => {
    const frame = encodeFrame("cached", 0, 1_000);

    for (const watermark of [
      null,
      Buffer.from(""),
      Buffer.from("-1"),
      Buffer.from("1."),
      Buffer.from(".1"),
      Buffer.from("1e2"),
      Buffer.from("1\n"),
      Buffer.from("9".repeat(400)),
    ]) {
      expect(decodeTrackedRedisFrame(frame, watermark)).toBeNull();
    }
  });

  it("validates tracked frame and watermark state before payload encoding", () => {
    const malformedPayload = encodeFrame("cached", 2, 1_000);

    expect(decodeTrackedRedisFrame(null, Buffer.from("0"))).toBeNull();
    expect(decodeTrackedRedisFrame(Buffer.alloc(9), Buffer.from("0"))).toBeNull();
    expect(decodeTrackedRedisFrame(malformedPayload, null)).toBeNull();
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
    expect(decodeRedisFrame(utf8)).toBe("cachéd ✓");
    expect(decodeTrackedRedisFrame(utf8, Buffer.from("999"))).toBe("cachéd ✓");

    const binaryPayload = Buffer.from([0, 0xff, 0x80]);
    const binary = encodeRedisFrame(binaryPayload, 2_000);
    expect(binary[9]).toBe(1);
    expect(binary).toEqual(encodeFrame(binaryPayload, 1, 2_000));
    expect(decodeRedisFrame(binary)).toEqual(binaryPayload);

    const empty = encodeRedisFrame("", 1);
    expect(empty.byteLength).toBe(10);
    expect(decodeRedisFrame(empty)).toBe("");
  });

  it("keeps zero-stamped placeholder frames unreadable on the tracked path", () => {
    const placeholder = encodeRedisFrame("pending", 0);

    expect(decodeTrackedRedisFrame(placeholder, null)).toBeNull();
    expect(decodeTrackedRedisFrame(placeholder, Buffer.from("0"))).toBeNull();
    expect(decodeTrackedRedisFrame(placeholder, Buffer.from("1"))).toBeNull();
    expect(decodeRedisFrame(placeholder)).toBe("pending");
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

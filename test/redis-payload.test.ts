import {
  decodeRedisFrame,
  decodeRedisPayload,
  decodeTrackedRedisFrame,
} from "../src/internal/redis-payload.js";
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
  });

  it("treats missing, short, and unsupported frames as misses", () => {
    expect(decodeRedisFrame(null)).toBeNull();
    expect(decodeRedisFrame(Buffer.alloc(9))).toBeNull();
    expect(decodeRedisFrame(encodeFrame("cached", 0, 1_000, 2))).toBeNull();
  });

  it("rejects unsupported payload encodings after validating the frame", () => {
    expect(() => decodeRedisPayload(Buffer.alloc(0))).toThrow(DialCacheRedisPayloadError);
    expect(() => decodeRedisFrame(encodeFrame("cached", 2))).toThrow(
      DialCacheRedisPayloadEncodingError,
    );
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
});

import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  type DecodedRedisFrame,
  type RedisCachePayload,
} from "../redis-client.js";

const REDIS_FRAME_VERSION = 1;
const REDIS_ENCODING_UTF8 = 0;
const REDIS_ENCODING_BINARY = 1;
const REDIS_FRAME_TIMESTAMP_OFFSET = 1;
const REDIS_FRAME_TIMESTAMP_BYTES = 8;

const REDIS_FRAME_HEADER_BYTES = REDIS_FRAME_TIMESTAMP_OFFSET + REDIS_FRAME_TIMESTAMP_BYTES;
const REDIS_FRAME_MIN_BYTES = REDIS_FRAME_HEADER_BYTES + 1;

function validateRedisBulkStringReply(raw: unknown): Buffer | null {
  if (raw === null || Buffer.isBuffer(raw)) {
    return raw;
  }
  throw new DialCacheRedisPayloadError(
    "Invalid DialCache Redis read reply; expected a bulk string or null",
  );
}

function isSupportedRedisFrame(raw: Buffer | null): raw is Buffer {
  return raw !== null
    && raw.length >= REDIS_FRAME_MIN_BYTES
    && raw[0] === REDIS_FRAME_VERSION;
}

function parseRedisWatermark(raw: Buffer | null): number | null {
  if (raw === null) {
    return null;
  }
  const text = raw.toString("utf8");
  const match = /^[0-9]+(?:\.[0-9]+)?/.exec(text);
  if (match?.[0].length !== text.length) {
    return null;
  }
  const watermark = Number(text);
  return Number.isFinite(watermark) ? watermark : null;
}

function decodeRedisPayload(raw: Buffer): RedisCachePayload {
  const encoding = raw[0];
  const payload = raw.subarray(1);
  if (encoding === REDIS_ENCODING_UTF8) {
    return payload.toString("utf8");
  }
  if (encoding === REDIS_ENCODING_BINARY) {
    return payload;
  }
  throw new DialCacheRedisPayloadEncodingError("Invalid DialCache Redis payload encoding");
}

/**
 * Encode a serializer payload into a servable DialCache Redis frame.
 *
 * Writes stamp a client-clock `createdAtMs`. Core rejects decoded
 * frames dated after the reader's clock and uses the timestamp for shadow
 * value-age observations, so stamp real client time, not a constant.
 */
export function encodeRedisFrame(payload: RedisCachePayload, createdAtMs: number): Buffer {
  if (!isValidRedisTimestampMs(createdAtMs)) {
    throw new RangeError("DialCache frame createdAtMs must be a nonnegative safe integer");
  }
  const isBinary = Buffer.isBuffer(payload);
  const payloadBytes = isBinary ? payload.length : Buffer.byteLength(payload, "utf8");
  const frame = Buffer.allocUnsafe(REDIS_FRAME_MIN_BYTES + payloadBytes);
  frame[0] = REDIS_FRAME_VERSION;
  frame.writeBigUInt64BE(BigInt(createdAtMs), REDIS_FRAME_TIMESTAMP_OFFSET);
  frame[REDIS_FRAME_HEADER_BYTES] = isBinary ? REDIS_ENCODING_BINARY : REDIS_ENCODING_UTF8;
  if (isBinary) {
    payload.copy(frame, REDIS_FRAME_MIN_BYTES);
  } else {
    frame.write(payload, REDIS_FRAME_MIN_BYTES, "utf8");
  }
  return frame;
}

/** Validate an application-clock epoch timestamp before mutation dispatch. */
export function assertValidRedisTimestampMs(timestampMs: number): void {
  if (!isValidRedisTimestampMs(timestampMs)) {
    throw new RangeError("DialCache Redis timestamp must be a nonnegative safe integer");
  }
}

function isValidRedisTimestampMs(timestampMs: number): boolean {
  return Number.isSafeInteger(timestampMs) && timestampMs >= 0;
}

/**
 * Decode an untracked DialCache frame returned as a Redis bulk string into
 * its serializer payload and header creation time (the writer's application
 * clock). Missing, short, and unsupported-version frames are cache
 * misses. Invalid runtime reply types and unsupported payload encodings throw
 * typed errors.
 */
export function decodeRedisFrame(raw: unknown): DecodedRedisFrame | null {
  const frame = validateRedisBulkStringReply(raw);
  if (!isSupportedRedisFrame(frame)) {
    return null;
  }
  return {
    payload: decodeRedisPayload(frame.subarray(REDIS_FRAME_HEADER_BYTES)),
    createdAtMs: readFrameCreatedAtMs(frame),
  };
}

/**
 * Decode a tracked DialCache frame against a watermark from the same atomic,
 * authoritative snapshot into its serializer payload and header creation time
 * (application time supplied by the writer). A missing watermark is the
 * natural zero baseline; malformed state and frames created at or before the
 * watermark are cache misses. Invalid runtime reply types and unsupported
 * payload encodings throw typed errors.
 */
export function decodeTrackedRedisFrame(
  raw: unknown,
  rawWatermark: unknown,
): DecodedRedisFrame | null {
  const frame = validateRedisBulkStringReply(raw);
  const watermarkFrame = validateRedisBulkStringReply(rawWatermark);
  if (!isSupportedRedisFrame(frame)) {
    return null;
  }
  const watermark = watermarkFrame === null ? 0 : parseRedisWatermark(watermarkFrame);
  if (watermark === null) {
    return null;
  }
  const createdAtMs = readFrameCreatedAtMs(frame);
  return createdAtMs <= watermark
    ? null
    : {
        payload: decodeRedisPayload(frame.subarray(REDIS_FRAME_HEADER_BYTES)),
        createdAtMs,
      };
}

function readFrameCreatedAtMs(frame: Buffer): number {
  return Number(frame.readBigUInt64BE(REDIS_FRAME_TIMESTAMP_OFFSET));
}

import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  type RedisCachePayload,
} from "../redis-client.js";
import {
  REDIS_ENCODING_BINARY,
  REDIS_ENCODING_UTF8,
  REDIS_FRAME_VERSION,
} from "./redis-scripts.js";

const REDIS_FRAME_HEADER_BYTES = 9;
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

export function redisPayloadEncoding(value: RedisCachePayload): number {
  return Buffer.isBuffer(value) ? REDIS_ENCODING_BINARY : REDIS_ENCODING_UTF8;
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
 * Decode an untracked DialCache frame returned as a Redis bulk string.
 * Missing, short, and unsupported-version frames are cache misses. Invalid
 * runtime reply types and unsupported payload encodings throw typed errors.
 */
export function decodeRedisFrame(raw: unknown): RedisCachePayload | null {
  const frame = validateRedisBulkStringReply(raw);
  return isSupportedRedisFrame(frame)
    ? decodeRedisPayload(frame.subarray(REDIS_FRAME_HEADER_BYTES))
    : null;
}

/**
 * Decode a tracked DialCache frame against a watermark from the same atomic,
 * authoritative snapshot. Missing or malformed state and frames created at or
 * before the watermark are cache misses. Invalid runtime reply types and
 * unsupported payload encodings throw typed errors.
 */
export function decodeTrackedRedisFrame(
  raw: unknown,
  rawWatermark: unknown,
): RedisCachePayload | null {
  const frame = validateRedisBulkStringReply(raw);
  const watermarkFrame = validateRedisBulkStringReply(rawWatermark);
  if (!isSupportedRedisFrame(frame)) {
    return null;
  }
  const watermark = parseRedisWatermark(watermarkFrame);
  if (watermark === null) {
    return null;
  }
  const createdAtMs = Number(frame.readBigUInt64BE(1));
  return createdAtMs <= watermark
    ? null
    : decodeRedisPayload(frame.subarray(REDIS_FRAME_HEADER_BYTES));
}

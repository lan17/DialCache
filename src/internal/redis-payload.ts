import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  type RedisCachePayload,
} from "../redis-client.js";

export const REDIS_FRAME_VERSION = 1;
export const REDIS_ENCODING_UTF8 = 0;
export const REDIS_ENCODING_BINARY = 1;

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
 * Encode a serializer payload into a DialCache Redis frame.
 *
 * Untracked writes stamp an informational client-clock `createdAtMs`;
 * untracked reads never consult it. Tracked writes must pass zero: an
 * all-zeros timestamp is a placeholder that tracked reads can never serve,
 * and `WRITE_TRACKED_STAMP_SCRIPT` patches it with server time.
 */
export function encodeRedisFrame(payload: RedisCachePayload, createdAtMs: number): Buffer {
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new RangeError("DialCache frame createdAtMs must be a nonnegative safe integer");
  }
  const payloadBytes = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload, "utf8");
  const frame = Buffer.allocUnsafe(REDIS_FRAME_MIN_BYTES + payloadBytes);
  frame[0] = REDIS_FRAME_VERSION;
  frame.writeBigUInt64BE(BigInt(createdAtMs), 1);
  frame[REDIS_FRAME_HEADER_BYTES] = redisPayloadEncoding(payload);
  if (Buffer.isBuffer(payload)) {
    payload.copy(frame, REDIS_FRAME_MIN_BYTES);
  } else {
    frame.write(payload, REDIS_FRAME_MIN_BYTES, "utf8");
  }
  return frame;
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

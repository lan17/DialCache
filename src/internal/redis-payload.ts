import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  type RedisCachePayload,
  type RedisReadOutcome,
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

const MISS_NOT_FOUND: RedisReadOutcome = Object.freeze({ status: "miss", reason: "not_found" });
const MISS_FRAME_UNSUPPORTED: RedisReadOutcome = Object.freeze({ status: "miss", reason: "frame_unsupported" });
const MISS_WATERMARK_UNREADABLE: RedisReadOutcome = Object.freeze({ status: "miss", reason: "watermark_unreadable" });
const MISS_WATERMARK_INVALIDATED: RedisReadOutcome = Object.freeze({ status: "miss", reason: "watermark_invalidated" });

function isSupportedRedisFrame(raw: Buffer): boolean {
  return raw.length >= REDIS_FRAME_MIN_BYTES && raw[0] === REDIS_FRAME_VERSION;
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
 * A missing frame misses as `not_found`; a short or unsupported-version frame
 * misses as `frame_unsupported`. Invalid runtime reply types and unsupported
 * payload encodings throw typed errors.
 */
export function decodeRedisFrame(raw: unknown): RedisReadOutcome {
  const frame = validateRedisBulkStringReply(raw);
  if (frame === null) {
    return MISS_NOT_FOUND;
  }
  if (!isSupportedRedisFrame(frame)) {
    return MISS_FRAME_UNSUPPORTED;
  }
  return { status: "hit", payload: decodeRedisPayload(frame.subarray(REDIS_FRAME_HEADER_BYTES)) };
}

/**
 * Decode a tracked DialCache frame against a watermark from the same atomic,
 * authoritative snapshot. Frame state is classified before watermark state:
 * a missing frame misses as `not_found` and a short or unsupported-version
 * frame as `frame_unsupported` regardless of the watermark. A missing or
 * malformed watermark misses as `watermark_unreadable`, and a frame created
 * at or before the watermark is fenced as `watermark_invalidated`. Invalid
 * runtime reply types and unsupported payload encodings throw typed errors.
 */
export function decodeTrackedRedisFrame(
  raw: unknown,
  rawWatermark: unknown,
): RedisReadOutcome {
  const frame = validateRedisBulkStringReply(raw);
  const watermarkFrame = validateRedisBulkStringReply(rawWatermark);
  if (frame === null) {
    return MISS_NOT_FOUND;
  }
  if (!isSupportedRedisFrame(frame)) {
    return MISS_FRAME_UNSUPPORTED;
  }
  const watermark = parseRedisWatermark(watermarkFrame);
  if (watermark === null) {
    return MISS_WATERMARK_UNREADABLE;
  }
  const createdAtMs = Number(frame.readBigUInt64BE(1));
  return createdAtMs <= watermark
    ? MISS_WATERMARK_INVALIDATED
    : { status: "hit", payload: decodeRedisPayload(frame.subarray(REDIS_FRAME_HEADER_BYTES)) };
}

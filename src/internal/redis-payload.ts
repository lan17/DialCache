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

export function decodeRedisPayload(raw: Buffer): RedisCachePayload {
  if (raw.length === 0) {
    throw new DialCacheRedisPayloadError("Invalid DialCache Redis payload");
  }

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

export function decodeRedisFrame(raw: Buffer | null): RedisCachePayload | null {
  return isSupportedRedisFrame(raw)
    ? decodeRedisPayload(raw.subarray(REDIS_FRAME_HEADER_BYTES))
    : null;
}

export function decodeTrackedRedisFrame(
  raw: Buffer | null,
  rawWatermark: Buffer | null,
): RedisCachePayload | null {
  if (!isSupportedRedisFrame(raw)) {
    return null;
  }
  const watermark = parseRedisWatermark(rawWatermark);
  if (watermark === null) {
    return null;
  }
  const createdAtMs = Number(raw.readBigUInt64BE(1));
  return createdAtMs <= watermark
    ? null
    : decodeRedisPayload(raw.subarray(REDIS_FRAME_HEADER_BYTES));
}

import { randomBytes } from "node:crypto";

import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  type RedisCachePayload,
} from "../redis-client.js";

export const REDIS_FRAME_VERSION = 1;
const REDIS_ENCODING_UTF8 = 0;
const REDIS_ENCODING_BINARY = 1;
/** Version byte of a tracked-write placeholder; no read path serves it. */
export const REDIS_FRAME_PLACEHOLDER_VERSION = 0;
export const REDIS_FRAME_TIMESTAMP_OFFSET = 1;
export const REDIS_FRAME_TIMESTAMP_BYTES = 8;

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

function encodeFrameBytes(payload: RedisCachePayload, version: number, stampBytes: Buffer): Buffer {
  const payloadBytes = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload, "utf8");
  const frame = Buffer.allocUnsafe(REDIS_FRAME_MIN_BYTES + payloadBytes);
  frame[0] = version;
  stampBytes.copy(frame, REDIS_FRAME_TIMESTAMP_OFFSET);
  frame[REDIS_FRAME_HEADER_BYTES] = redisPayloadEncoding(payload);
  if (Buffer.isBuffer(payload)) {
    payload.copy(frame, REDIS_FRAME_MIN_BYTES);
  } else {
    frame.write(payload, REDIS_FRAME_MIN_BYTES, "utf8");
  }
  return frame;
}

/**
 * Encode a serializer payload into a servable DialCache Redis frame.
 *
 * Untracked writes stamp an informational client-clock `createdAtMs`;
 * untracked reads never consult it. Tracked writes must not use this
 * directly — they pair `encodeTrackedRedisPlaceholder` with
 * `WRITE_TRACKED_STAMP_SCRIPT` instead.
 */
export function encodeRedisFrame(payload: RedisCachePayload, createdAtMs: number): Buffer {
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new RangeError("DialCache frame createdAtMs must be a nonnegative safe integer");
  }
  const timestamp = Buffer.allocUnsafe(REDIS_FRAME_TIMESTAMP_BYTES);
  timestamp.writeBigUInt64BE(BigInt(createdAtMs));
  return encodeFrameBytes(payload, REDIS_FRAME_VERSION, timestamp);
}

export interface TrackedRedisPlaceholder {
  /** Version-0 frame that no read path serves until the stamp promotes it. */
  readonly frame: Buffer;
  /** Per-write identity passed to `WRITE_TRACKED_STAMP_SCRIPT` as its nonce argument. */
  readonly nonce: Buffer;
}

/**
 * Encode the placeholder frame a tracked write pairs with
 * `WRITE_TRACKED_STAMP_SCRIPT`.
 *
 * The frame carries the placeholder version byte, so both read paths treat it
 * as a miss, and a fresh random nonce where a stamped frame carries its
 * timestamp. The stamp promotes the frame — patching version and server-time
 * timestamp — only when the stored header matches this exact nonce, so it can
 * never publish a placeholder left behind by a different write. Mint one
 * placeholder per logical write: client-level retries must reuse the same
 * frame and nonce so a retried SET re-establishes the placeholder its stamp
 * expects.
 */
export function encodeTrackedRedisPlaceholder(payload: RedisCachePayload): TrackedRedisPlaceholder {
  const nonce = randomBytes(REDIS_FRAME_TIMESTAMP_BYTES);
  return { frame: encodeFrameBytes(payload, REDIS_FRAME_PLACEHOLDER_VERSION, nonce), nonce };
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
  const createdAtMs = Number(frame.readBigUInt64BE(REDIS_FRAME_TIMESTAMP_OFFSET));
  return createdAtMs <= watermark
    ? null
    : decodeRedisPayload(frame.subarray(REDIS_FRAME_HEADER_BYTES));
}

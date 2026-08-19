import { randomBytes } from "node:crypto";

import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  type DecodedRedisFrame,
  type RedisCachePayload,
} from "../redis-client.js";
import { MAX_SUPPORTED_DURATION_MS } from "./duration.js";

export const REDIS_FRAME_VERSION = 1;
const REDIS_ENCODING_UTF8 = 0;
const REDIS_ENCODING_BINARY = 1;
/** Version byte of a write placeholder; no read path serves it. */
export const REDIS_FRAME_PLACEHOLDER_VERSION = 0;
const REDIS_FRAME_TIMESTAMP_OFFSET = 1;
export const REDIS_FRAME_TIMESTAMP_BYTES = 8;

export const REDIS_FRAME_HEADER_BYTES = REDIS_FRAME_TIMESTAMP_OFFSET + REDIS_FRAME_TIMESTAMP_BYTES;
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

function redisPayloadEncoding(value: RedisCachePayload): number {
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
 * This fully stamped encoder is available for protocol tooling. Bundled
 * adapters do not use it for writes: they pair
 * `encodeTrackedRedisPlaceholder` with the appropriate server-time stamp
 * script so logical age never depends on the writer's wall clock.
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
  /** Per-write identity passed to the selected stamp script as its nonce argument. */
  readonly nonce: Buffer;
}

/**
 * Encode the placeholder frame a write pairs with its tracked or untracked
 * server-time stamp script. The historical public name is retained because
 * tracked writes introduced this wire shape.
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
 * Decode an untracked DialCache frame returned as a Redis bulk string into its
 * serializer payload and Redis-server creation time. Missing, short,
 * unsupported-version, and unsafe-timestamp frames are cache misses. Invalid
 * runtime reply types and unsupported payload encodings throw typed errors.
 */
export function decodeRedisFrame(raw: unknown): DecodedRedisFrame | null {
  const frame = validateRedisBulkStringReply(raw);
  if (!isSupportedRedisFrame(frame)) {
    return null;
  }
  const createdAtMs = readFrameCreatedAtMs(frame);
  if (createdAtMs === null) {
    return null;
  }
  return {
    payload: decodeRedisPayload(frame.subarray(REDIS_FRAME_HEADER_BYTES)),
    createdAtMs,
  };
}

/**
 * Decode a tracked DialCache frame against a watermark from the same atomic,
 * authoritative snapshot into its serializer payload and header creation time
 * (Redis server time written by the stamp script). Missing or malformed state
 * and frames created at or before the watermark are cache misses. Invalid
 * runtime reply types and unsupported payload encodings throw typed errors.
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
  const watermark = parseRedisWatermark(watermarkFrame);
  if (watermark === null) {
    return null;
  }
  const createdAtMs = readFrameCreatedAtMs(frame);
  return createdAtMs === null || createdAtMs <= watermark
    ? null
    : {
        payload: decodeRedisPayload(frame.subarray(REDIS_FRAME_HEADER_BYTES)),
        createdAtMs,
      };
}

/**
 * Decode the native Redis `TIME` reply into epoch milliseconds. With binary
 * replies enabled, Redis returns two bulk strings: whole seconds and the
 * microsecond offset within that second. Any malformed or unsafe value is a
 * payload protocol error rather than an imprecise clock reading.
 */
export function decodeRedisServerTime(raw: unknown): number {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw invalidRedisTimeReply();
  }
  const [rawSeconds, rawMicroseconds] = raw;
  if (!Buffer.isBuffer(rawSeconds) || !Buffer.isBuffer(rawMicroseconds)) {
    throw invalidRedisTimeReply();
  }
  const secondsText = rawSeconds.toString("utf8");
  const microsecondsText = rawMicroseconds.toString("utf8");
  if (!/^[0-9]+$/.test(secondsText) || !/^[0-9]+$/.test(microsecondsText)) {
    throw invalidRedisTimeReply();
  }

  const seconds = BigInt(secondsText);
  const microseconds = BigInt(microsecondsText);
  if (microseconds > 999_999n) {
    throw invalidRedisTimeReply();
  }
  const serverNowMs = seconds * 1_000n + microseconds / 1_000n;
  if (serverNowMs > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidRedisTimeReply();
  }
  return Number(serverNowMs);
}

/** Validate the semantic read age before an adapter dispatches any commands. */
export function assertValidRedisMaxAgeMs(maxAgeMs: number): void {
  if (
    !Number.isSafeInteger(maxAgeMs)
    || maxAgeMs <= 0
    || maxAgeMs > MAX_SUPPORTED_DURATION_MS
  ) {
    throw new RangeError(
      `DialCache Redis maxAgeMs must be a positive safe integer no greater than ${MAX_SUPPORTED_DURATION_MS}`,
    );
  }
}

/** Return whether a decoded frame is strictly younger than the requested age. */
export function isRedisFrameWithinMaxAge(
  frame: DecodedRedisFrame,
  serverNowMs: number,
  maxAgeMs: number,
): boolean {
  assertValidRedisMaxAgeMs(maxAgeMs);
  const ageMs = serverNowMs - frame.createdAtMs;
  return ageMs >= 0 && ageMs < maxAgeMs;
}

function invalidRedisTimeReply(): DialCacheRedisPayloadError {
  return new DialCacheRedisPayloadError(
    "Invalid DialCache Redis TIME reply; expected two unsigned decimal bulk strings",
  );
}

function readFrameCreatedAtMs(frame: Buffer): number | null {
  const createdAtMs = frame.readBigUInt64BE(REDIS_FRAME_TIMESTAMP_OFFSET);
  return createdAtMs <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(createdAtMs) : null;
}

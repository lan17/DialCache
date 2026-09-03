import {
  DialCacheRedisPayloadEncodingError,
  DialCacheRedisPayloadError,
  redisReadMiss,
  type DecodedRedisFrame,
  type RedisCachePayload,
  type RedisReadResult,
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

function parseRedisWatermark(raw: Buffer): number | null {
  const text = raw.toString("utf8");
  if (!/^[0-9]+$/.test(text)) {
    return null;
  }
  const watermark = Number(text);
  return watermark <= Number.MAX_SAFE_INTEGER ? watermark : null;
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
 * Writes stamp a client-clock `createdAtMs`. Core rejects serving frames dated
 * after the reader's clock, enforces logical age, and uses decoded timestamps
 * for shadow value-age observations, so stamp real client time, not a constant.
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

/** Nonnegative safe-integer epoch milliseconds: the envelope for frame timestamps and watermarks. */
export function isValidRedisTimestampMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Decode an untracked DialCache read with a bounded miss reason. Invalid
 * runtime reply types and unsupported payload encodings still throw typed
 * errors rather than becoming misses.
 */
export function decodeRedisReadResult(raw: unknown): RedisReadResult {
  const frame = validateRedisBulkStringReply(raw);
  if (frame === null) {
    return redisReadMiss("value_absent");
  }
  if (!isSupportedRedisFrame(frame)) {
    return redisReadMiss("unclassified");
  }
  return decodedRedisFrame(frame);
}

/**
 * Decode a tracked DialCache read while preserving a trustworthy observed
 * watermark for semantic misses. Miss cause and a valid observed watermark are
 * independent: an absent value can retain a refill fence, while only a
 * supported, complete frame actually rejected by a valid watermark is
 * `watermark_fenced`. Invalid runtime reply types and unsupported payload
 * encodings on otherwise eligible frames throw typed errors.
 *
 * Custom adapters opting into this result must also honor a supplied
 * `RedisWriteRequest.createdAtMs` exactly.
 */
export function decodeTrackedRedisReadResult(
  raw: unknown,
  rawWatermark: unknown,
): RedisReadResult {
  const frame = validateRedisBulkStringReply(raw);
  const watermarkFrame = validateRedisBulkStringReply(rawWatermark);

  // Redis nil is decisive evidence of absence regardless of paired metadata.
  // Preserve a valid paired watermark separately so a later refill can still
  // be skipped before serialization if its client timestamp cannot clear it.
  if (frame === null) {
    return redisReadMiss(
      "value_absent",
      watermarkFrame === null ? undefined : parseRedisWatermark(watermarkFrame) ?? undefined,
    );
  }
  if (!isSupportedRedisFrame(frame)) {
    return redisReadMiss(
      "unclassified",
      watermarkFrame === null ? undefined : parseRedisWatermark(watermarkFrame) ?? undefined,
    );
  }
  if (watermarkFrame === null) {
    return decodeTrackedFrame(frame);
  }
  const watermark = parseRedisWatermark(watermarkFrame);
  if (watermark === null) {
    return redisReadMiss("unclassified");
  }
  return decodeTrackedFrame(frame, watermark);
}

function decodeTrackedFrame(
  frame: Buffer,
  observedWatermarkMs?: number,
): RedisReadResult {
  const createdAtMs = readFrameCreatedAtMs(frame);
  // Preserve zero-baseline misses. Core validates all other timestamps after
  // payload decoding so corrupt encodings retain their existing error path.
  if (createdAtMs === 0) {
    return redisReadMiss("unclassified", observedWatermarkMs);
  }
  if (observedWatermarkMs !== undefined && createdAtMs <= observedWatermarkMs) {
    return redisReadMiss("watermark_fenced", observedWatermarkMs);
  }
  return decodedRedisFrame(frame);
}

function decodedRedisFrame(frame: Buffer): DecodedRedisFrame {
  return {
    payload: decodeRedisPayload(frame.subarray(REDIS_FRAME_HEADER_BYTES)),
    createdAtMs: readFrameCreatedAtMs(frame),
  };
}

function readFrameCreatedAtMs(frame: Buffer): number {
  return Number(frame.readBigUInt64BE(REDIS_FRAME_TIMESTAMP_OFFSET));
}

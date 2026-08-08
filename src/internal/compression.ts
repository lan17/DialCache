import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import type { RedisCachePayload } from "../redis-client.js";

/**
 * First payload byte marking a zstd-compressed Redis payload. The marker also
 * records whether the serializer emitted a UTF-8 string or a binary Buffer so
 * decompression can hand the serializer back the exact type it produced. 0x00
 * is reserved and future codecs claim new values. Raw serializer output that
 * happens to begin with a marker byte stays safe: decompression falls back to
 * the untouched payload when zstd rejects the frame.
 */
export const MARKER_ZSTD_UTF8 = 0x01;
export const MARKER_ZSTD_BINARY = 0x02;

export const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 4096;
export const DEFAULT_ZSTD_LEVEL = 3;

/** Write-side compression policy for serialized Redis payloads. */
export interface CompressionConfig {
  /**
   * Payloads of at least this many serialized bytes are compressed. Must be a
   * positive safe integer. Defaults to 4096.
   */
  readonly thresholdBytes?: number;
  /** zstd compression level between 1 and 22. Defaults to 3. */
  readonly level?: number;
}

export interface ResolvedCompressionConfig {
  readonly enabled: boolean;
  readonly thresholdBytes: number;
  readonly level: number;
}

export type CompressionWriteOutcome = "compressed" | "below_threshold" | "not_smaller";
export type CompressionReadOutcome = "passthrough" | "decompressed" | "fallback_raw";

export interface CompressPayloadResult {
  readonly payload: RedisCachePayload;
  readonly outcome: CompressionWriteOutcome;
  readonly originalBytes: number;
  readonly storedBytes: number;
}

export interface DecompressPayloadResult {
  readonly payload: RedisCachePayload;
  readonly outcome: CompressionReadOutcome;
}

export function resolveCompressionConfig(
  config: CompressionConfig | false | undefined,
): ResolvedCompressionConfig {
  if (config === false) {
    return {
      enabled: false,
      thresholdBytes: DEFAULT_COMPRESSION_THRESHOLD_BYTES,
      level: DEFAULT_ZSTD_LEVEL,
    };
  }

  const thresholdBytes = config?.thresholdBytes ?? DEFAULT_COMPRESSION_THRESHOLD_BYTES;
  if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes <= 0) {
    throw new TypeError("RedisConfig.compression.thresholdBytes must be a positive safe integer");
  }
  const level = config?.level ?? DEFAULT_ZSTD_LEVEL;
  if (!Number.isSafeInteger(level) || level < 1 || level > 22) {
    throw new TypeError("RedisConfig.compression.level must be an integer between 1 and 22");
  }
  return { enabled: true, thresholdBytes, level };
}

/**
 * Compress a serialized payload when it meets the configured threshold and
 * compression actually shrinks it, marker byte included. Payloads below the
 * threshold are returned untouched, so small values stay byte-identical to
 * their uncompressed form. Callers gate on the resolved enabled flag.
 */
export function compressPayload(
  payload: RedisCachePayload,
  config: ResolvedCompressionConfig,
): CompressPayloadResult {
  const isBinary = Buffer.isBuffer(payload);
  const originalBytes = isBinary ? payload.length : Buffer.byteLength(payload, "utf8");
  if (originalBytes < config.thresholdBytes) {
    return { payload, outcome: "below_threshold", originalBytes, storedBytes: originalBytes };
  }

  const compressed = zstdCompressSync(isBinary ? payload : Buffer.from(payload, "utf8"), {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: config.level },
  });
  const markedBytes = 1 + compressed.length;
  if (markedBytes >= originalBytes) {
    return { payload, outcome: "not_smaller", originalBytes, storedBytes: originalBytes };
  }

  const marked = Buffer.allocUnsafe(markedBytes);
  marked[0] = isBinary ? MARKER_ZSTD_BINARY : MARKER_ZSTD_UTF8;
  compressed.copy(marked, 1);
  return { payload: marked, outcome: "compressed", originalBytes, storedBytes: markedBytes };
}

/**
 * Reverse of compressPayload, applied unconditionally on reads so disabling
 * compression never orphans previously written entries. Payloads without a
 * known marker pass through untouched, which covers every pre-compression
 * legacy payload. A marked payload that zstd rejects is raw output from a
 * custom serializer colliding with the marker, not corruption, so the
 * original payload is returned unchanged. Never mutates the input and holds
 * no state, keeping repeated loads of a retained payload independent.
 */
export function decompressPayload(payload: RedisCachePayload): DecompressPayloadResult {
  if (!Buffer.isBuffer(payload)) {
    return { payload, outcome: "passthrough" };
  }
  const marker = payload[0];
  if (marker !== MARKER_ZSTD_UTF8 && marker !== MARKER_ZSTD_BINARY) {
    return { payload, outcome: "passthrough" };
  }

  let decompressed: Buffer;
  try {
    decompressed = zstdDecompressSync(payload.subarray(1));
  } catch {
    return { payload, outcome: "fallback_raw" };
  }
  return {
    payload: marker === MARKER_ZSTD_UTF8 ? decompressed.toString("utf8") : decompressed,
    outcome: "decompressed",
  };
}

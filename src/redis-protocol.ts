/**
 * Public frame protocol surface for adapter authors and out-of-band tooling.
 *
 * These exports describe the frame header (version, createdAt, encoding) and
 * decode a frame into its payload bytes. The payload region past the header
 * is opaque at this layer: entries written by DialCache 0.18+ may begin with
 * a compression envelope byte (0x00 escape, 0x01/0x02 zstd; see the README
 * Compression section), which DialCache core interprets above the adapter.
 * Adapters must never decompress or otherwise rewrite payload bytes.
 */
export {
  INVALIDATE_CACHE_SCRIPT,
  REDIS_ENCODING_BINARY,
  REDIS_ENCODING_UTF8,
  REDIS_FRAME_VERSION,
  WRITE_CACHE_SCRIPT,
  WRITE_TRACKED_CACHE_SCRIPT,
} from "./internal/redis-scripts.js";
export {
  decodeRedisFrame,
  decodeTrackedRedisFrame,
} from "./internal/redis-payload.js";

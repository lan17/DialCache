/**
 * Public frame protocol surface for adapter authors and out-of-band tooling.
 *
 * These exports encode frames and mint tracked placeholders (use
 * `encodeRedisFrame` and `encodeTrackedRedisPlaceholder` rather than
 * reimplementing them — see the latter's JSDoc for the nonce contract),
 * decode a frame into its payload bytes, resolve and validate mutation
 * replies, guard the write-TTL acceptance domain, and carry the tracked
 * stamp and invalidation Lua sources the bundled adapters dispatch. The
 * payload region past the header is opaque at this layer: entries written by
 * DialCache releases with payload compression may begin with a compression
 * envelope byte (0x00 escape, 0x01/0x02 zstd; see the README Compression
 * section), which DialCache core interprets above the adapter. Adapters must
 * never decompress or otherwise rewrite payload bytes.
 */
export { ceilSupportedCacheTtlMs } from "./internal/duration.js";
export {
  INVALIDATE_CACHE_SCRIPT,
  WRITE_TRACKED_STAMP_SCRIPT,
} from "./internal/redis-scripts.js";
export {
  decodeRedisFrame,
  decodeTrackedRedisFrame,
  encodeRedisFrame,
  encodeTrackedRedisPlaceholder,
  type TrackedRedisPlaceholder,
} from "./internal/redis-payload.js";
export {
  resolveTrackedRedisWriteReply,
  validateRedisScriptInvalidationReply,
  validateRedisSetReply,
} from "./internal/redis-script-reply.js";

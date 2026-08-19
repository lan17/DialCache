/**
 * Public frame protocol surface for adapter authors and out-of-band tooling.
 *
 * These exports encode frames and mint write placeholders (use
 * `encodeRedisFrame` and `encodeTrackedRedisPlaceholder` rather than
 * reimplementing them — see the latter's JSDoc for the nonce contract),
 * decode a frame into its payload bytes and header creation time, resolve
 * and validate mutation replies, guard the write-TTL acceptance domain, and
 * carry both stamp sources and the invalidation Lua source the bundled
 * adapters dispatch. The
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
  WRITE_UNTRACKED_STAMP_SCRIPT,
} from "./internal/redis-scripts.js";
export {
  assertValidRedisMaxAgeMs,
  decodeRedisServerTime,
  decodeRedisFrame,
  decodeTrackedRedisFrame,
  encodeRedisFrame,
  encodeTrackedRedisPlaceholder,
  isRedisFrameWithinMaxAge,
  type TrackedRedisPlaceholder,
} from "./internal/redis-payload.js";
export type { DecodedRedisFrame } from "./redis-client.js";
export {
  resolveTrackedRedisWriteReply,
  resolveUntrackedRedisWriteReply,
  validateRedisScriptInvalidationReply,
  validateRedisSetReply,
} from "./internal/redis-script-reply.js";

import {
  MAX_SUPPORTED_DURATION_MS,
  MAX_TRACKED_REDIS_VALUE_TTL_MS,
} from "./duration.js";

const WATERMARK_TTL_MARGIN_MS = 60_000;

/**
 * Current protocol floor for invalidation-owned watermarks.
 *
 * This relationship protects one release's values; it is not a rolling-version
 * compatibility guarantee. Raising the tracked-value cap requires a gated
 * protocol cutover because already-deployed invalidators retain their older
 * compiled floor.
 */
export const MIN_WATERMARK_TTL_MS = 2 * MAX_TRACKED_REDIS_VALUE_TTL_MS;

const PARSE_SAFE_INTEGER_LUA = String.raw`local function parse_safe_integer(raw)
  if not string.match(raw, "^%d+$") then
    return nil
  end
  local value = tonumber(raw)
  if not value or value > ${Number.MAX_SAFE_INTEGER} then
    return nil
  end
  return value
end`;

export const INVALIDATE_CACHE_SCRIPT = [
  PARSE_SAFE_INTEGER_LUA,
  String.raw`local future_buffer_ms = parse_safe_integer(ARGV[1])
if not future_buffer_ms or future_buffer_ms < 0 or future_buffer_ms > ${MAX_SUPPORTED_DURATION_MS} then
  return redis.error_reply("ERR invalid DialCache future buffer")
end
local invalidated_at_ms = parse_safe_integer(ARGV[2])
if not invalidated_at_ms or invalidated_at_ms > ${Number.MAX_SAFE_INTEGER} - future_buffer_ms then
  return redis.error_reply("ERR invalid DialCache invalidatedAtMs")
end`,
  String.raw`local proposed_watermark = invalidated_at_ms + future_buffer_ms
local raw_watermark = redis.pcall("GET", KEYS[1])
if type(raw_watermark) == "table" and raw_watermark.err then
  if not string.match(raw_watermark.err, "^WRONGTYPE ") then
    return raw_watermark
  end
  -- A wrong-type key cannot contain a valid watermark. Treat it as absent so
  -- the final SET repairs it, while preserving every other Redis error.
  raw_watermark = false
end
local current_watermark = 0

if raw_watermark then
  local parsed_watermark = parse_safe_integer(raw_watermark)
  if parsed_watermark then
    current_watermark = parsed_watermark
  end
end

local watermark = math.max(current_watermark, proposed_watermark)
local current_ttl_ms = -2
if raw_watermark then
  current_ttl_ms = redis.call("PTTL", KEYS[1])
end
local desired_ttl_ms = math.max(
  ${MIN_WATERMARK_TTL_MS},
  watermark - invalidated_at_ms + ${MAX_TRACKED_REDIS_VALUE_TTL_MS} + ${WATERMARK_TTL_MARGIN_MS}
)
if current_ttl_ms > desired_ttl_ms then
  desired_ttl_ms = current_ttl_ms
end

local encoded_watermark = string.format("%.0f", watermark)
if current_ttl_ms == -1 then
  redis.call("SET", KEYS[1], encoded_watermark)
else
  redis.call("SET", KEYS[1], encoded_watermark, "PX", desired_ttl_ms)
end`,
  "return 1",
].join("\n\n");

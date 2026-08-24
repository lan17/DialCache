import {
  MAX_SUPPORTED_DURATION_MS,
  MAX_TRACKED_REDIS_VALUE_TTL_MS,
} from "./duration.js";

const WATERMARK_TTL_MARGIN_MS = 60_000;
const MIN_WATERMARK_TTL_MS = 2 * MAX_TRACKED_REDIS_VALUE_TTL_MS;

const PARSE_WATERMARK_LUA = String.raw`local function parse_watermark(raw)
  if not string.match(raw, "^%d+$") and not string.match(raw, "^%d+%.%d+$") then
    return nil
  end
  local value = tonumber(raw)
  if not value or value >= math.huge then
    return nil
  end
  return value
end`;

const CEIL_FINITE_NUMBER_LUA = String.raw`local function ceil_finite_number(raw)
  local value = tonumber(raw)
  if not value or value ~= value or value >= math.huge or value <= -math.huge then
    return nil
  end
  return math.ceil(value)
end`;

const PARSE_TIMESTAMP_MS_LUA = String.raw`local function parse_timestamp_ms(raw)
  if not string.match(raw, "^%d+$") then
    return nil
  end
  local value = tonumber(raw)
  if not value or value >= math.huge or value > ${Number.MAX_SAFE_INTEGER} then
    return nil
  end
  return value
end`;

export const INVALIDATE_CACHE_SCRIPT = [
  PARSE_WATERMARK_LUA,
  CEIL_FINITE_NUMBER_LUA,
  PARSE_TIMESTAMP_MS_LUA,
  String.raw`local future_buffer_ms = ceil_finite_number(ARGV[1])
if not future_buffer_ms or future_buffer_ms < 0 or future_buffer_ms > ${MAX_SUPPORTED_DURATION_MS} then
  return redis.error_reply("ERR invalid DialCache future buffer")
end
local invalidated_at_ms = parse_timestamp_ms(ARGV[2])
if not invalidated_at_ms or invalidated_at_ms > ${Number.MAX_SAFE_INTEGER} - future_buffer_ms then
  return redis.error_reply("ERR invalid DialCache invalidatedAtMs")
end`,
  String.raw`local proposed_watermark = invalidated_at_ms + future_buffer_ms
local raw_watermark = redis.call("GET", KEYS[1])
local current_watermark = 0

if raw_watermark then
  local parsed_watermark = parse_watermark(raw_watermark)
  if parsed_watermark then
    current_watermark = parsed_watermark
  end
end

local watermark = math.ceil(math.max(current_watermark, proposed_watermark))
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

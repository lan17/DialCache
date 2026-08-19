import { MAX_SUPPORTED_DURATION_MS } from "./duration.js";
import {
  REDIS_FRAME_HEADER_BYTES,
  REDIS_FRAME_PLACEHOLDER_VERSION,
  REDIS_FRAME_TIMESTAMP_BYTES,
  REDIS_FRAME_VERSION,
} from "./redis-payload.js";

const WATERMARK_TTL_MARGIN_MS = 60_000;

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

const VALIDATE_STAMP_ARGUMENTS_LUA = String.raw`local cache_ttl_ms = ceil_finite_number(ARGV[1])
if not cache_ttl_ms or cache_ttl_ms <= 0 or cache_ttl_ms > ${MAX_SUPPORTED_DURATION_MS} then
  return redis.error_reply("ERR invalid DialCache TTL")
end
if string.len(ARGV[2]) ~= ${REDIS_FRAME_TIMESTAMP_BYTES} then
  return redis.error_reply("ERR invalid DialCache stamp nonce")
end`;

const REDIS_TIME_LUA = String.raw`local redis_time = redis.call("TIME")
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)`;

export const WRITE_UNTRACKED_STAMP_SCRIPT = [
  String.raw`if string.len(ARGV[1]) ~= ${REDIS_FRAME_TIMESTAMP_BYTES} then
  return redis.error_reply("ERR invalid DialCache stamp nonce")
end`,
  REDIS_TIME_LUA,
  String.raw`if redis.call("GETRANGE", KEYS[1], 0, ${REDIS_FRAME_HEADER_BYTES - 1}) == string.char(${REDIS_FRAME_PLACEHOLDER_VERSION}) .. ARGV[1] then
  redis.call("SETRANGE", KEYS[1], 0, string.char(${REDIS_FRAME_VERSION}) .. struct.pack(">I8", now_ms))
  return 1
end

-- Never promote a frame or placeholder this stamp does not own.
return 2`,
].join("\n\n");

export const WRITE_TRACKED_STAMP_SCRIPT = [
  PARSE_WATERMARK_LUA,
  CEIL_FINITE_NUMBER_LUA,
  VALIDATE_STAMP_ARGUMENTS_LUA,
  REDIS_TIME_LUA,
  String.raw`local raw_watermark = redis.call("GET", KEYS[2])
local watermark = 0
if raw_watermark then
  watermark = parse_watermark(raw_watermark)
  if not watermark then
    return redis.error_reply("ERR invalid DialCache watermark")
  end
end

if watermark >= now_ms then
  -- A fenced fallback write removes the placeholder it paired with, along with any
  -- stale frame that led to it. The UNLINK stays unconditional: any frame present
  -- here is already fenced, and removing a foreign in-flight placeholder only
  -- forces that writer's honest reply-2 failure. Reads that fail before reaching
  -- this script cannot benefit from this partial mitigation.
  redis.call("UNLINK", KEYS[1])
  return 0
end`,
  String.raw`local stamped = 1
if redis.call("GETRANGE", KEYS[1], 0, ${REDIS_FRAME_HEADER_BYTES - 1}) == string.char(${REDIS_FRAME_PLACEHOLDER_VERSION}) .. ARGV[2] then
  redis.call("SETRANGE", KEYS[1], 0, string.char(${REDIS_FRAME_VERSION}) .. struct.pack(">I8", now_ms))
else
  -- The placeholder this stamp paired with is gone: its SET was rejected,
  -- overwritten, or expired. Promoting any other frame could publish a value
  -- this write does not own, so leave the key untouched and report 2.
  stamped = 2
end`,
  String.raw`local desired_ttl_ms = cache_ttl_ms + ${WATERMARK_TTL_MARGIN_MS}
if not raw_watermark then
  redis.call("SET", KEYS[2], "0", "PX", desired_ttl_ms)
else
  local current_ttl_ms = redis.call("PTTL", KEYS[2])
  if current_ttl_ms == -2 then
    redis.call("SET", KEYS[2], raw_watermark, "PX", desired_ttl_ms)
  elseif current_ttl_ms ~= -1 and current_ttl_ms < desired_ttl_ms then
    redis.call("PEXPIRE", KEYS[2], desired_ttl_ms)
  end
end`,
  "return stamped",
].join("\n\n");

export const INVALIDATE_CACHE_SCRIPT = [
  PARSE_WATERMARK_LUA,
  CEIL_FINITE_NUMBER_LUA,
  String.raw`local future_buffer_ms = ceil_finite_number(ARGV[1])
if not future_buffer_ms or future_buffer_ms < 0 or future_buffer_ms > ${MAX_SUPPORTED_DURATION_MS} then
  return redis.error_reply("ERR invalid DialCache future buffer")
end`,
  REDIS_TIME_LUA,
  String.raw`local proposed_watermark = now_ms + future_buffer_ms
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
  future_buffer_ms + ${WATERMARK_TTL_MARGIN_MS},
  watermark - now_ms + ${WATERMARK_TTL_MARGIN_MS}
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

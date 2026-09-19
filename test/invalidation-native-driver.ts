import { createClient } from "redis";
import { INVALIDATE_CACHE_SCRIPT } from "../src/redis-protocol.js";
import type { InvalidationVectorState } from "../formal/generate-invalidation-vectors.mjs";

export type InvalidationInput = { existing: InvalidationVectorState; futureBufferMs: string; invalidatedAtMs: string };
export type InvalidationActual = { outcome: "success" | "rejected"; kind: "absent" | "string" | "list"; content: string | string[]; ttlMs: number; elapsedMs: number };

// Only setup and observation are test-owned. The transition is the production
// Lua, executed atomically between them. Redis TIME bounds actual expiry drift.
const script = `redis.replicate_commands()
local function now_ms()
  local now = redis.call("TIME")
  return tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
end
local started_at = now_ms()
redis.call("DEL", KEYS[1])
if ARGV[3] == "string" then redis.call("SET", KEYS[1], ARGV[4]) end
if ARGV[3] == "list" then
  for _, value in ipairs(cjson.decode(ARGV[4])) do redis.call("RPUSH", KEYS[1], value) end
end
if tonumber(ARGV[5]) > 0 then redis.call("PEXPIRE", KEYS[1], ARGV[5]) end
local result = (function()
${INVALIDATE_CACHE_SCRIPT}
end)()
local status = result == 1 and "success" or (type(result) == "table" and (result.err == "ERR invalid DialCache future buffer" or result.err == "ERR invalid DialCache invalidatedAtMs") and "rejected" or "unexpected_reply")
local kind = redis.call("TYPE", KEYS[1]).ok
local content = {}
if kind == "string" then content = redis.call("GET", KEYS[1]) end
if kind == "list" then content = redis.call("LRANGE", KEYS[1], 0, -1) end
if kind == "none" then kind = "absent" end
local ttl_ms = redis.call("PTTL", KEYS[1])
return {status, kind, content, ttl_ms, now_ms() - started_at}`;

export function invalidationClient(): ReturnType<typeof createClient> {
  const url = process.env.DIALCACHE_VECTOR_REDIS_URL;
  if (!url) throw new Error("INVALIDATION_INFRASTRUCTURE: Redis vector endpoint is required");
  return createClient({ url, socket: { reconnectStrategy: false, connectTimeout: 10_000 } });
}
export async function recordInvalidation(client: ReturnType<typeof invalidationClient>, key: string, input: InvalidationInput): Promise<InvalidationActual> {
  const initial = input.existing;
  const raw = await client.eval(script, { keys: [key], arguments: [input.futureBufferMs, input.invalidatedAtMs, initial.kind,
    initial.kind === "string" ? initial.value : initial.kind === "list" ? JSON.stringify(initial.values) : "", String(initial.ttlMs)] });
  if (!Array.isArray(raw) || raw.length !== 5) throw new Error("Invalid native invalidation reply");
  const [outcome, kind, content, ttlMs, elapsedMs] = raw;
  // The coordinator validates the complete result schema before comparison.
  return { outcome, kind, content, ttlMs, elapsedMs } as InvalidationActual;
}

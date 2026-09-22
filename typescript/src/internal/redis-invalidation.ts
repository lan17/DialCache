import { createHash } from "node:crypto";

import { INVALIDATE_CACHE_SCRIPT } from "./redis-scripts.js";

// Redis caches EVAL'd source under sha1(source), so EVALSHA dispatch and EVAL
// recovery must share this exact digest.
export const INVALIDATE_CACHE_SCRIPT_SHA1 = createHash("sha1")
  .update(INVALIDATE_CACHE_SCRIPT)
  .digest("hex");

type RedisInvalidationScriptArguments = readonly [
  futureBufferMs: string,
  invalidatedAtMs: string,
];

/** Encode the script's ordered ARGV contract; Lua validates both domains. */
export function buildRedisInvalidationScriptArguments(
  futureBufferMs: number,
  invalidatedAtMs: number,
): RedisInvalidationScriptArguments {
  return [String(futureBufferMs), String(invalidatedAtMs)];
}

export { INVALIDATE_CACHE_SCRIPT };

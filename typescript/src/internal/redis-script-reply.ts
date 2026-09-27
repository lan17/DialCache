import { DialCacheRedisProtocolError } from "../redis-client.js";

/** Validate the count from DEL of exactly one value key. */
export function validateRedisDelReply(reply: unknown): void {
  if (reply !== 0 && reply !== 1) {
    throw new DialCacheRedisProtocolError("Invalid DialCache Redis DEL reply; expected integer 0 or 1");
  }
}

export function validateRedisSetReply(reply: unknown): void {
  const text = typeof reply === "string"
    ? reply
    : Buffer.isBuffer(reply)
      ? reply.toString("utf8")
      : null;
  if (text !== "OK") {
    throw new DialCacheRedisProtocolError("Invalid DialCache Redis SET reply; expected OK");
  }
}

export function validateRedisScriptInvalidationReply(reply: unknown): 1 {
  if (reply !== 1) {
    throw new DialCacheRedisProtocolError("Invalid DialCache Redis invalidate reply; expected integer 1");
  }
  return reply;
}

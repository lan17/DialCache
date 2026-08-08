import {
  DialCacheRedisPlaceholderLostError,
  DialCacheRedisProtocolError,
} from "../redis-client.js";

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

export function validateRedisScriptWriteReply(reply: unknown): 0 | 1 | 2 {
  if (reply !== 0 && reply !== 1 && reply !== 2) {
    throw new DialCacheRedisProtocolError("Invalid DialCache Redis write reply; expected integer 0, 1, or 2");
  }
  return reply;
}

/**
 * Map a validated stamp reply onto the write() boolean contract: 0 (fenced)
 * is false, 1 (stamped) is true, and 2 — the paired placeholder was gone —
 * fails the write so split pairs surface through the normal fail-open path.
 */
export function resolveTrackedRedisWriteReply(reply: unknown): boolean {
  const stamp = validateRedisScriptWriteReply(reply);
  if (stamp === 2) {
    throw new DialCacheRedisPlaceholderLostError(
      "DialCache tracked write lost its placeholder before the stamp; the SET was rejected, overwritten, or expired",
    );
  }
  return stamp === 1;
}

export function validateRedisScriptInvalidationReply(reply: unknown): 1 {
  if (reply !== 1) {
    throw new DialCacheRedisProtocolError("Invalid DialCache Redis invalidate reply; expected integer 1");
  }
  return reply;
}

import { TextDecoder } from "node:util";

import {
  type DialCacheInvalidationEventV1,
  type DialCacheInvalidationIdentity,
  type DialCacheLocalInvalidation,
  type DialCacheLocalInvalidationSource,
} from "../invalidation.js";
import { invalidationPrefix } from "../key.js";
import { DialCacheRedisProtocolError } from "../redis-client.js";
import { MAX_SUPPORTED_DURATION_MS } from "./duration.js";

export const REDIS_INVALIDATION_EVENT_VERSION = 1;
export const MAX_REDIS_INVALIDATION_EVENT_BYTES = 16 * 1024;

const EVENT_FIELDS = new Set([
  "version",
  "namespace",
  "keyType",
  "id",
  "effectiveWatermarkMs",
  "redisNowMs",
]);
const CANONICAL_DECIMAL = /^(0|[1-9]\d*)$/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function redisInvalidationChannel(namespace: string): string {
  // Reuse key validation so channel and cache identity cannot disagree.
  invalidationPrefix(namespace, "", "");
  return `dialcache:invalidation:v${REDIS_INVALIDATION_EVENT_VERSION}:${
    encodeChannelComponent(namespace)
  }`;
}

export function decodeRedisInvalidationEvent(
  payload: string | Buffer,
  expected?: Partial<DialCacheInvalidationIdentity>,
): DialCacheInvalidationEventV1 {
  const byteLength = Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload);
  if (byteLength > MAX_REDIS_INVALIDATION_EVENT_BYTES) {
    throw protocolError("Invalid DialCache invalidation event; payload is too large");
  }

  let text: string;
  if (Buffer.isBuffer(payload)) {
    try {
      text = utf8Decoder.decode(payload);
    } catch {
      throw protocolError("Invalid DialCache invalidation event; payload is not valid UTF-8");
    }
  } else {
    text = payload;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw protocolError("Invalid DialCache invalidation event; payload is not valid JSON");
  }
  return validateRedisInvalidationEvent(value, expected);
}

export function validateRedisInvalidationEvent(
  value: unknown,
  expected?: Partial<DialCacheInvalidationIdentity>,
): DialCacheInvalidationEventV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("Invalid DialCache invalidation event; expected an object");
  }

  const record = value as Record<string, unknown>;
  const fields = Object.keys(record);
  if (fields.length !== EVENT_FIELDS.size || fields.some((field) => !EVENT_FIELDS.has(field))) {
    throw protocolError("Invalid DialCache invalidation event; unexpected fields");
  }
  if (record.version !== REDIS_INVALIDATION_EVENT_VERSION) {
    throw protocolError("Invalid DialCache invalidation event version");
  }
  if (
    typeof record.namespace !== "string"
    || typeof record.keyType !== "string"
    || typeof record.id !== "string"
  ) {
    throw protocolError("Invalid DialCache invalidation event identity");
  }

  try {
    invalidationPrefix(record.namespace, record.keyType, record.id);
  } catch {
    throw protocolError("Invalid DialCache invalidation event identity");
  }

  if (
    expected !== undefined
    && (
      (expected.namespace !== undefined && record.namespace !== expected.namespace)
      || (expected.keyType !== undefined && record.keyType !== expected.keyType)
      || (expected.id !== undefined && record.id !== expected.id)
    )
  ) {
    throw protocolError("Invalid DialCache invalidation event identity");
  }

  const effectiveWatermarkMs = parseCanonicalTimestamp(record.effectiveWatermarkMs);
  const redisNowMs = parseCanonicalTimestamp(record.redisNowMs);
  const remainingMs = effectiveWatermarkMs - redisNowMs;
  if (remainingMs < 0 || remainingMs > MAX_SUPPORTED_DURATION_MS) {
    throw protocolError("Invalid DialCache invalidation event timing");
  }

  return {
    version: REDIS_INVALIDATION_EVENT_VERSION,
    namespace: record.namespace,
    keyType: record.keyType,
    id: record.id,
    effectiveWatermarkMs: record.effectiveWatermarkMs as string,
    redisNowMs: record.redisNowMs as string,
  };
}

export function localInvalidationFromEvent(
  event: DialCacheInvalidationEventV1,
  source: DialCacheLocalInvalidationSource = "event",
): DialCacheLocalInvalidation {
  const validated = validateRedisInvalidationEvent(event);
  return {
    namespace: validated.namespace,
    keyType: validated.keyType,
    id: validated.id,
    remainingMs: Number(validated.effectiveWatermarkMs) - Number(validated.redisNowMs),
    source,
  };
}

export function isValidLocalInvalidation(
  invalidation: unknown,
  namespace: string,
): invalidation is DialCacheLocalInvalidation {
  if (invalidation === null || typeof invalidation !== "object" || Array.isArray(invalidation)) {
    return false;
  }

  const record = invalidation as Record<string, unknown>;
  if (
    record.namespace !== namespace
    || typeof record.keyType !== "string"
    || typeof record.id !== "string"
    || (record.source !== "provisional" && record.source !== "event")
    || !Number.isSafeInteger(record.remainingMs)
    || (record.remainingMs as number) < 0
    || (record.remainingMs as number) > MAX_SUPPORTED_DURATION_MS
  ) {
    return false;
  }

  try {
    invalidationPrefix(namespace, record.keyType, record.id);
    return true;
  } catch {
    return false;
  }
}

function parseCanonicalTimestamp(value: unknown): number {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    throw protocolError("Invalid DialCache invalidation event timing");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw protocolError("Invalid DialCache invalidation event timing");
  }
  return parsed;
}

function protocolError(message: string): DialCacheRedisProtocolError {
  return new DialCacheRedisProtocolError(message);
}

function encodeChannelComponent(value: string): string {
  // encodeURIComponent leaves Redis ACL glob metacharacter "*" unescaped.
  // Strict RFC 3986 encoding makes a returned channel safe to grant exactly.
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

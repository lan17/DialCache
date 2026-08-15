import diff, { type Difference } from "microdiff";

export const SHADOW_LOG_KEY_MAX_BYTES = 2 * 1024;
export const SHADOW_LOG_VALUE_MAX_BYTES = 8 * 1024;
export const SHADOW_LOG_DIFF_MAX_BYTES = 8 * 1024;
export const SHADOW_LOG_TRUNCATION_MARKER = "...[truncated]";

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TRUNCATION_MARKER_BYTES = UTF8_ENCODER.encode(SHADOW_LOG_TRUNCATION_MARKER);

export function previewShadowLogKey(value: string): string | null {
  try {
    return clampUtf8(value, SHADOW_LOG_KEY_MAX_BYTES);
  } catch {
    return null;
  }
}

export function previewShadowLogJson(
  value: unknown,
  maxBytes: number = SHADOW_LOG_VALUE_MAX_BYTES,
): string | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : clampUtf8(json, maxBytes);
  } catch {
    return null;
  }
}

/**
 * Bounded JSON of the differences between the two loggable forms, oriented
 * from the cached side to the source side: `oldValue` is cached, `value` is
 * source. Both inputs are first rendered to native JSON — the same forms
 * `value` logging shows — so `toJSON` redaction and serializer normalization
 * bound the diff exactly as they bound value logging. Identical loggable
 * forms yield `[]`; roots of the same container kind diff recursively; any
 * other root pair collapses to one root-level change entry.
 */
export function previewShadowLogDiff(cachedInput: unknown, sourceInput: unknown): string | null {
  try {
    const cachedJson = JSON.stringify(cachedInput);
    const sourceJson = JSON.stringify(sourceInput);
    if (cachedJson === sourceJson) {
      return "[]";
    }
    const cachedLoggable: unknown = cachedJson === undefined ? null : JSON.parse(cachedJson);
    const sourceLoggable: unknown = sourceJson === undefined ? null : JSON.parse(sourceJson);
    const entries = isSameContainerKind(cachedLoggable, sourceLoggable)
      ? diff(
          cachedLoggable as Record<string, unknown> | unknown[],
          sourceLoggable as Record<string, unknown> | unknown[],
        )
      : rootDifference(cachedLoggable, sourceLoggable);
    return previewShadowLogJson(entries, SHADOW_LOG_DIFF_MAX_BYTES);
  } catch {
    return null;
  }
}

function isSameContainerKind(cached: unknown, source: unknown): boolean {
  if (Array.isArray(cached) || Array.isArray(source)) {
    return Array.isArray(cached) && Array.isArray(source);
  }
  return typeof cached === "object" && cached !== null && typeof source === "object" && source !== null;
}

function rootDifference(cachedLoggable: unknown, sourceLoggable: unknown): Difference[] {
  return [{ type: "CHANGE", path: [], value: sourceLoggable, oldValue: cachedLoggable }];
}

function clampUtf8(value: string, maxBytes: number): string {
  const bytes = new Uint8Array(maxBytes);
  const encoded = UTF8_ENCODER.encodeInto(value, bytes);
  if (encoded.read === value.length) {
    return value;
  }

  const content = bytes.subarray(0, maxBytes - TRUNCATION_MARKER_BYTES.byteLength);
  const { written } = UTF8_ENCODER.encodeInto(value, content);
  bytes.set(TRUNCATION_MARKER_BYTES, written);
  return UTF8_DECODER.decode(bytes.subarray(0, written + TRUNCATION_MARKER_BYTES.byteLength));
}

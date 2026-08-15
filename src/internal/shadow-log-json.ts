import diff, { type Difference } from "microdiff";

export const SHADOW_LOG_KEY_MAX_BYTES = 2 * 1024;
export const SHADOW_LOG_VALUE_MAX_BYTES = 8 * 1024;
export const SHADOW_LOG_DIFF_MAX_BYTES = 8 * 1024;
export const SHADOW_LOG_TRUNCATION_MARKER = "...[truncated]";

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TRUNCATION_MARKER_BYTES = UTF8_ENCODER.encode(SHADOW_LOG_TRUNCATION_MARKER);

export function previewShadowLogKey(value: string): string {
  return clampUtf8(value, SHADOW_LOG_KEY_MAX_BYTES);
}

export function previewShadowLogJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : clampUtf8(json, SHADOW_LOG_VALUE_MAX_BYTES);
  } catch {
    return null;
  }
}

/**
 * Bounded JSON of the structural differences between the two loggable inputs,
 * oriented from the cached side to the source side: `oldValue` is cached,
 * `value` is source. Plain-object and array roots diff recursively (cycle-safe);
 * any other root pair collapses to one root-level change entry when the inputs
 * are not identical. `[]` means the inputs held no visible difference.
 */
export function previewShadowLogDiff(cachedInput: unknown, sourceInput: unknown): string | null {
  try {
    const entries = isDiffableRoot(cachedInput) && isDiffableRoot(sourceInput)
      ? diff(cachedInput, sourceInput)
      : rootDifference(cachedInput, sourceInput);
    const json = JSON.stringify(entries);
    return json === undefined ? null : clampUtf8(json, SHADOW_LOG_DIFF_MAX_BYTES);
  } catch {
    return null;
  }
}

function isDiffableRoot(value: unknown): value is Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) {
    return true;
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rootDifference(cachedInput: unknown, sourceInput: unknown): Difference[] {
  if (Object.is(cachedInput, sourceInput)) {
    return [];
  }
  return [{ type: "CHANGE", path: [], value: sourceInput, oldValue: cachedInput }];
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

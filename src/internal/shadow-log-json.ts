export const SHADOW_LOG_KEY_MAX_BYTES = 2 * 1024;
export const SHADOW_LOG_VALUE_MAX_BYTES = 8 * 1024;
export const SHADOW_LOG_TRUNCATION_MARKER = "...[truncated]";

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TRUNCATION_MARKER_BYTES = UTF8_ENCODER.encode(SHADOW_LOG_TRUNCATION_MARKER);

export interface ShadowMismatchLogDetails {
  readonly cacheKey: string;
  readonly cachedValueJson: string | null;
  readonly sourceValueJson: string | null;
}

export function previewShadowLogKey(value: string): string {
  return clampUtf8(value, SHADOW_LOG_KEY_MAX_BYTES);
}

export function previewShadowLogJson(value: unknown): string | null {
  try {
    if (value instanceof Uint8Array) {
      // Skipped before `Buffer.prototype.toJSON` can expand the whole view.
      return JSON.stringify(binaryMarker(value.byteLength));
    }
    const json = JSON.stringify(value, replaceBinary);
    return json === undefined ? null : clampUtf8(json, SHADOW_LOG_VALUE_MAX_BYTES);
  } catch {
    return null;
  }
}

/**
 * Byte arrays carry no diagnostic value as JSON: native semantics expand them
 * into one decimal element per byte, so a clamped preview is a run of digits.
 * Plain views are replaced before expansion; `Buffer` runs its own `toJSON`
 * first, so it is recognized from that result instead.
 */
function replaceBinary(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return binaryMarker(value.byteLength);
  }
  return isBufferJson(value) ? binaryMarker(value.data.length) : value;
}

function isBufferJson(value: unknown): value is { readonly data: readonly unknown[] } {
  return typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "Buffer"
    && Array.isArray((value as { data?: unknown }).data);
}

function binaryMarker(byteLength: number): string {
  return `<binary ${byteLength} bytes>`;
}

export function shadowMismatchLogDetails(
  cacheKey: string,
  cachedValue: unknown,
  sourceValue: unknown,
): ShadowMismatchLogDetails {
  return {
    cacheKey: previewShadowLogKey(cacheKey),
    cachedValueJson: previewShadowLogJson(cachedValue),
    sourceValueJson: previewShadowLogJson(sourceValue),
  };
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

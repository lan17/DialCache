export const SHADOW_LOG_KEY_MAX_BYTES = 2 * 1024;
export const SHADOW_LOG_VALUE_MAX_BYTES = 8 * 1024;
export const SHADOW_LOG_DIFF_MAX_BYTES = 8 * 1024;
export const SHADOW_LOG_TRUNCATION_MARKER = "...[truncated]";

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TRUNCATION_MARKER_BYTES = UTF8_ENCODER.encode(SHADOW_LOG_TRUNCATION_MARKER);

/** One loggable side of a confirmed mismatch; unavailable when its projection failed. */
export interface ShadowLoggableSide {
  readonly available: boolean;
  readonly value?: unknown;
}

export interface ShadowMismatchLogFields {
  readonly cachedValueJson?: string | null;
  readonly sourceValueJson?: string | null;
  readonly diffJson?: string | null;
}

export interface ShadowLogDifferenceCreate {
  readonly type: "CREATE";
  readonly path: readonly (string | number)[];
  readonly value: unknown;
}
export interface ShadowLogDifferenceRemove {
  readonly type: "REMOVE";
  readonly path: readonly (string | number)[];
  readonly oldValue: unknown;
}
export interface ShadowLogDifferenceChange {
  readonly type: "CHANGE";
  readonly path: readonly (string | number)[];
  readonly value: unknown;
  readonly oldValue: unknown;
}
export type ShadowLogDifference =
  | ShadowLogDifferenceCreate
  | ShadowLogDifferenceRemove
  | ShadowLogDifferenceChange;

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
 * Renders both loggable sides to native JSON exactly once and derives every
 * requested built-in warning field from those two snapshots, so `toJSON`
 * hooks run once per side and the diff provably compares the same forms that
 * value logging shows. An unavailable or unrenderable side yields `null` for
 * its value field and a `null` diff; equal snapshots yield `"[]"`.
 */
export function renderShadowMismatchJson(
  cached: ShadowLoggableSide,
  source: ShadowLoggableSide,
  include: { readonly value: boolean; readonly diff: boolean },
): ShadowMismatchLogFields {
  const cachedJson = renderLoggableJson(cached);
  const sourceJson = renderLoggableJson(source);
  return {
    ...(include.value
      ? {
          cachedValueJson: cachedJson === null ? null : clampJson(cachedJson, SHADOW_LOG_VALUE_MAX_BYTES),
          sourceValueJson: sourceJson === null ? null : clampJson(sourceJson, SHADOW_LOG_VALUE_MAX_BYTES),
        }
      : {}),
    ...(include.diff ? { diffJson: builtInDiffJson(cachedJson, sourceJson) } : {}),
  };
}

function renderLoggableJson(side: ShadowLoggableSide): string | null {
  if (!side.available) {
    return null;
  }
  try {
    const json = JSON.stringify(side.value);
    return json === undefined ? null : json;
  } catch {
    return null;
  }
}

function clampJson(json: string, maxBytes: number): string | null {
  try {
    return clampUtf8(json, maxBytes);
  } catch {
    return null;
  }
}

/**
 * Bounded JSON of the differences between the two rendered snapshots,
 * oriented from the cached side to the source side: `oldValue` is cached,
 * `value` is source. A side without a JSON rendering fails the diff closed to
 * `null` — the diff never attests anything about inputs value logging cannot
 * show. Identical snapshots yield `[]`.
 */
function builtInDiffJson(cachedJson: string | null, sourceJson: string | null): string | null {
  if (cachedJson === null || sourceJson === null) {
    return null;
  }
  if (cachedJson === sourceJson) {
    return "[]";
  }
  try {
    const cached: unknown = JSON.parse(cachedJson);
    const source: unknown = JSON.parse(sourceJson);
    const entries: ShadowLogDifference[] = [];
    appendJsonDifferences(cached, source, [], entries);
    return clampJson(serializeJsonTree(entries), SHADOW_LOG_DIFF_MAX_BYTES);
  } catch {
    return null;
  }
}

// Serializes the internally generated diff tree without handing any container
// to native JSON.stringify, so inherited `toJSON` hooks (for example a legacy
// or polluted `Array.prototype.toJSON`) can never replace or reshape the
// entries. `toJSON` runs only while rendering user data into the two side
// snapshots. The domain here is closed: entry objects and path arrays are
// built above, and every other member is JSON.parse output, so only null,
// booleans, finite numbers, strings, arrays, and plain objects appear.
function serializeJsonTree(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // Primitives never consult toJSON; JSON.stringify only handles escaping.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((member) => serializeJsonTree(member)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  const members = Object.keys(object).map(
    (name) => `${JSON.stringify(name)}:${serializeJsonTree(object[name])}`,
  );
  return `{${members.join(",")}}`;
}

// Structural difference between two parsed-JSON values. Only own enumerable
// keys and array indices are visited: the inputs are JSON.parse output, and
// prototype-carried data must never reach the log. Same-kind containers
// recurse (arrays index-wise, so an element shift reports every later
// index); any other pair is one CHANGE entry at its path.
function appendJsonDifferences(
  cached: unknown,
  source: unknown,
  path: readonly (string | number)[],
  out: ShadowLogDifference[],
): void {
  if (Array.isArray(cached) && Array.isArray(source)) {
    const shared = Math.min(cached.length, source.length);
    for (let index = 0; index < shared; index += 1) {
      appendJsonDifferences(cached[index], source[index], [...path, index], out);
    }
    for (let index = shared; index < cached.length; index += 1) {
      out.push({ type: "REMOVE", path: [...path, index], oldValue: cached[index] });
    }
    for (let index = shared; index < source.length; index += 1) {
      out.push({ type: "CREATE", path: [...path, index], value: source[index] });
    }
    return;
  }
  if (isJsonObject(cached) && isJsonObject(source)) {
    for (const name of Object.keys(cached)) {
      if (Object.hasOwn(source, name)) {
        appendJsonDifferences(cached[name], source[name], [...path, name], out);
      } else {
        out.push({ type: "REMOVE", path: [...path, name], oldValue: cached[name] });
      }
    }
    for (const name of Object.keys(source)) {
      if (!Object.hasOwn(cached, name)) {
        out.push({ type: "CREATE", path: [...path, name], value: source[name] });
      }
    }
    return;
  }
  if (cached !== source) {
    out.push({ type: "CHANGE", path, value: source, oldValue: cached });
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

import type { ShadowMismatchDiffLevel } from "../config.js";
import { fulfills, isPromiseLike } from "./thenable.js";

export const SHADOW_LOG_KEY_MAX_BYTES = 2 * 1024;
export const SHADOW_LOG_VALUE_MAX_BYTES = 8 * 1024;
export const SHADOW_LOG_DIFF_MAX_BYTES = 8 * 1024;
export const SHADOW_MISMATCH_MAX_ENTRIES = 64;
export const SHADOW_MISMATCH_PATH_MAX_BYTES = 512;
export const SHADOW_MISMATCH_SIDE_MAX_BYTES = 1024;
/** Reference tokens in the deepest pointer the built-in walk reports. */
export const SHADOW_MISMATCH_MAX_DEPTH = 32;
export const SHADOW_LOG_TRUNCATION_MARKER = "...[truncated]";

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TRUNCATION_MARKER_BYTES = UTF8_ENCODER.encode(SHADOW_LOG_TRUNCATION_MARKER);

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [member: string]: JsonValue;
}

/**
 * One built-in difference: an RFC 6901 pointer into the compared value and
 * the sides the walk holds there. A side is absent when the member exists on
 * the other side only.
 */
export interface ShadowMismatchJsonEntry {
  readonly path: string;
  readonly cached?: JsonValue;
  readonly source?: JsonValue;
}

/** The capped built-in difference list and its uncut length. */
export interface ShadowMismatchJsonDiff {
  readonly entries: readonly ShadowMismatchJsonEntry[];
  readonly count: number;
}

/** The effective content leaves of one confirmed-mismatch warning. */
export interface ShadowMismatchLogPlan {
  readonly value: boolean;
  readonly diff: ShadowMismatchDiffLevel;
}

/** A synchronous replacement for the built-in difference computation. */
export type ShadowMismatchEntriesHook = (cachedValue: never, sourceValue: never) => unknown;

/** Bounded content fields; each requested field is present, as null when it failed closed. */
export interface ShadowMismatchLogFields {
  readonly mismatchPaths?: readonly string[] | null;
  readonly mismatchPathCount?: number | null;
  readonly diffJson?: string | null;
  readonly cachedValueJson?: string | null;
  readonly sourceValueJson?: string | null;
}

/**
 * Why warning construction failed: `hook_error` when the hook threw or
 * returned something other than an array, which ranks above `render_error`
 * for JSON rendering. `null` when every requested field rendered.
 */
export type ShadowMismatchLogFailure = "hook_error" | "render_error";

export interface ShadowMismatchLogContent {
  readonly fields: ShadowMismatchLogFields;
  readonly failure: ShadowMismatchLogFailure | null;
}

export function previewShadowLogKey(value: string): string {
  return clampUtf8(value, SHADOW_LOG_KEY_MAX_BYTES);
}

/**
 * Builds the content fields the plan requests for one confirmed mismatch.
 * Each side is rendered to native JSON at most once, and every built-in field
 * derives from that rendering, so a stateful `toJSON` cannot put into one
 * field what another omits. Every failure fails its fields closed to `null`;
 * a failed hook never falls back to the built-in computation. An absent side,
 * the top-level `undefined` a negative-cache entry stores, is not a failure:
 * its value field is `null`, and the built-in reports the other side whole at
 * the root.
 */
export function renderShadowMismatchLog(
  plan: ShadowMismatchLogPlan,
  cachedValue: unknown,
  sourceValue: unknown,
  hook?: ShadowMismatchEntriesHook,
): ShadowMismatchLogContent {
  const renderSides = plan.value || (plan.diff !== "off" && hook === undefined);
  const cachedJson = renderSides ? renderJson(cachedValue) : null;
  const sourceJson = renderSides ? renderJson(sourceValue) : null;
  let diffFailed = false;
  let renderFailed = renderSides
    && ((cachedJson === null && cachedValue !== undefined) || (sourceJson === null && sourceValue !== undefined));

  let diffFields: ShadowMismatchLogFields = {};
  if (plan.diff !== "off") {
    const withValues = plan.diff === "values";
    let diff: RawMismatchDiff | null = null;
    if (hook !== undefined) {
      diff = runShadowMismatchHook(hook, cachedValue, sourceValue);
      diffFailed = diff === null;
    } else if (!renderFailed) {
      diff = walkRenderedJson(cachedJson, sourceJson);
    }

    if (diff === null) {
      diffFields = {
        mismatchPaths: null,
        mismatchPathCount: null,
        ...(withValues ? { diffJson: null } : {}),
      };
    } else {
      let diffJson: string | null = null;
      if (withValues) {
        diffJson = renderDiffJson(diff.entries);
        renderFailed ||= diffJson === null;
      }
      diffFields = {
        // "paths" never renders a side.
        mismatchPaths: diff.entries.map((entry) => clampPointer(entry.path)),
        mismatchPathCount: diff.count,
        ...(withValues ? { diffJson } : {}),
      };
    }
  }

  return {
    fields: {
      ...diffFields,
      ...(plan.value
        ? {
            cachedValueJson: cachedJson === null ? null : clampUtf8(cachedJson, SHADOW_LOG_VALUE_MAX_BYTES),
            sourceValueJson: sourceJson === null ? null : clampUtf8(sourceJson, SHADOW_LOG_VALUE_MAX_BYTES),
          }
        : {}),
    },
    failure: diffFailed ? "hook_error" : renderFailed ? "render_error" : null,
  };
}

/** Every field the plan requests, failed closed to `null`, in rendering order. */
export function failedShadowMismatchLogFields(plan: ShadowMismatchLogPlan): ShadowMismatchLogFields {
  return {
    ...(plan.diff === "off" ? {} : { mismatchPaths: null, mismatchPathCount: null }),
    ...(plan.diff === "values" ? { diffJson: null } : {}),
    ...(plan.value ? { cachedValueJson: null, sourceValueJson: null } : {}),
  };
}

/**
 * The built-in difference computation over two JSON values. Objects recurse
 * over the union of their member names in UTF-16 code-unit order, and a member
 * present on one side only is reported at its pointer with that side. Arrays
 * of equal length recurse by index; arrays of different length are reported
 * once at their own pointer. Any other differing pair, roots of different kinds
 * included, is reported at its pointer with both sides, and a differing pair of
 * containers at `SHADOW_MISMATCH_MAX_DEPTH` reference tokens is reported whole
 * without descending. Entries keep walk order and are cut at
 * `SHADOW_MISMATCH_MAX_ENTRIES`; `count` is the uncut total. Each pointer is
 * clamped to `SHADOW_MISMATCH_PATH_MAX_BYTES`, and a side whose JSON exceeds
 * `SHADOW_MISMATCH_SIDE_MAX_BYTES` becomes the clamped JSON text as a string.
 */
export function diffShadowMismatchJson(cached: JsonValue, source: JsonValue): ShadowMismatchJsonDiff {
  const diff = walkJson(cached, source);
  // JSON values always render, so every entry bounds.
  return { count: diff.count, entries: diff.entries.map((entry) => boundEntry(entry)!) };
}

/** Entries before the pointer and side clamps, from the walk or the hook. */
interface RawMismatchDiff {
  readonly entries: readonly RawMismatchEntry[];
  readonly count: number;
}

interface RawMismatchEntry {
  readonly path: string;
  readonly cached?: unknown;
  readonly source?: unknown;
}

/** `null` is an absent side; a side that failed to render never reaches here. */
function walkRenderedJson(cachedJson: string | null, sourceJson: string | null): RawMismatchDiff {
  if (cachedJson === sourceJson) {
    return { entries: [], count: 0 };
  }
  // Each string came from successful native JSON rendering, so this is the
  // single boundary from arbitrary values to the closed JSON domain.
  if (cachedJson === null) {
    return { entries: [{ path: "", source: JSON.parse(sourceJson!) as JsonValue }], count: 1 };
  }
  if (sourceJson === null) {
    return { entries: [{ path: "", cached: JSON.parse(cachedJson) as JsonValue }], count: 1 };
  }
  return walkJson(JSON.parse(cachedJson) as JsonValue, JSON.parse(sourceJson) as JsonValue);
}

function walkJson(cached: JsonValue, source: JsonValue): ShadowMismatchJsonDiff {
  const entries: ShadowMismatchJsonEntry[] = [];
  // Reference tokens from the root to the current pair; a pointer is built
  // only for an entry the cut keeps.
  const tokens: (number | string)[] = [];
  let count = 0;
  const report = (sides: { readonly cached?: JsonValue; readonly source?: JsonValue }): void => {
    count += 1;
    if (entries.length < SHADOW_MISMATCH_MAX_ENTRIES) {
      entries.push({ path: keptPointer(tokens), ...sides });
    }
  };
  const walk = (left: JsonValue, right: JsonValue): void => {
    const kind = jsonKind(left);
    if (kind !== jsonKind(right) || kind === "primitive") {
      if (left !== right) {
        report({ cached: left, source: right });
      }
      return;
    }
    if (tokens.length >= SHADOW_MISMATCH_MAX_DEPTH) {
      if (!jsonValuesEqual(left, right)) {
        report({ cached: left, source: right });
      }
      return;
    }
    if (kind === "array") {
      const leftItems = left as readonly JsonValue[];
      const rightItems = right as readonly JsonValue[];
      if (leftItems.length !== rightItems.length) {
        report({ cached: left, source: right });
        return;
      }
      for (let index = 0; index < leftItems.length; index += 1) {
        tokens.push(index);
        walk(leftItems[index]!, rightItems[index]!);
        tokens.pop();
      }
      return;
    }
    const leftMembers = left as JsonObject;
    const rightMembers = right as JsonObject;
    const names = Object.keys(leftMembers);
    for (const name of Object.keys(rightMembers)) {
      if (!Object.hasOwn(leftMembers, name)) {
        names.push(name);
      }
    }
    // The default sort order is UTF-16 code units.
    names.sort();
    for (const name of names) {
      tokens.push(name);
      if (!Object.hasOwn(rightMembers, name)) {
        report({ cached: leftMembers[name]! });
      } else if (!Object.hasOwn(leftMembers, name)) {
        report({ source: rightMembers[name]! });
      } else {
        walk(leftMembers[name]!, rightMembers[name]!);
      }
      tokens.pop();
    }
  };
  walk(cached, source);
  return { entries, count };
}

// Structural equality for a depth-capped pair, iterative so that a subtree as
// deep as native JSON rendering allows cannot exhaust the stack.
function jsonValuesEqual(cached: JsonValue, source: JsonValue): boolean {
  const pending: [JsonValue, JsonValue][] = [[cached, source]];
  while (pending.length > 0) {
    const [left, right] = pending.pop()!;
    const kind = jsonKind(left);
    if (kind !== jsonKind(right)) {
      return false;
    }
    if (kind === "primitive") {
      if (left !== right) {
        return false;
      }
    } else if (kind === "array") {
      const leftItems = left as readonly JsonValue[];
      const rightItems = right as readonly JsonValue[];
      if (leftItems.length !== rightItems.length) {
        return false;
      }
      for (let index = 0; index < leftItems.length; index += 1) {
        pending.push([leftItems[index]!, rightItems[index]!]);
      }
    } else {
      const leftMembers = left as JsonObject;
      const rightMembers = right as JsonObject;
      const names = Object.keys(leftMembers);
      if (names.length !== Object.keys(rightMembers).length) {
        return false;
      }
      for (const name of names) {
        if (!Object.hasOwn(rightMembers, name)) {
          return false;
        }
        pending.push([leftMembers[name]!, rightMembers[name]!]);
      }
    }
  }
  return true;
}

function jsonKind(value: JsonValue): "array" | "object" | "primitive" {
  if (Array.isArray(value)) {
    return "array";
  }
  return value !== null && typeof value === "object" ? "object" : "primitive";
}

/**
 * Joins reference tokens into a pointer, building no more of it than the
 * pointer clamp can keep. Each UTF-16 code unit is at least one UTF-8 byte, so
 * a pointer longer than `SHADOW_MISMATCH_PATH_MAX_BYTES` code units is clamped
 * to leading bytes that no later token changes: it stops growing there, and a
 * member name is cut to that many code units before escaping. The clamped
 * pointer is unchanged, and each kept entry materializes at most three times
 * the cap however deep it is or however long the member names above it are.
 */
function keptPointer(tokens: readonly (number | string)[]): string {
  let path = "";
  for (const token of tokens) {
    if (path.length > SHADOW_MISMATCH_PATH_MAX_BYTES) {
      break;
    }
    path += typeof token === "number"
      ? `/${token}`
      : `/${escapePointerToken(token.slice(0, SHADOW_MISMATCH_PATH_MAX_BYTES))}`;
  }
  return path;
}

function escapePointerToken(name: string): string {
  return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Runs the use case's hook under the comparator's synchronous discipline. A
 * throw, a promise-like or a non-array returns `null`. Only the kept entries
 * are read, inside the catch, and a path that is not a string is logged as
 * its string form: a hook that returns wrong entries gets wrong paths.
 */
function runShadowMismatchHook(
  hook: ShadowMismatchEntriesHook,
  cachedValue: unknown,
  sourceValue: unknown,
): RawMismatchDiff | null {
  try {
    const result: unknown = (hook as (cached: unknown, source: unknown) => unknown)(cachedValue, sourceValue);
    if (isPromiseLike(result)) {
      // The contract is synchronous. Consume an accidental rejecting
      // thenable without awaiting it, and fail closed.
      void fulfills(result);
      return null;
    }
    if (!Array.isArray(result)) {
      return null;
    }
    const entries: RawMismatchEntry[] = [];
    for (const member of result.slice(0, SHADOW_MISMATCH_MAX_ENTRIES) as readonly RawMismatchEntry[]) {
      const { path, cached, source } = member;
      entries.push({
        path: String(path),
        ...(cached === undefined ? {} : { cached }),
        ...(source === undefined ? {} : { source }),
      });
    }
    return { entries, count: result.length };
  } catch {
    return null;
  }
}

/**
 * Renders entries with their bounded sides; a side with no JSON rendering
 * makes the whole field `null`, and later sides are not rendered.
 */
function renderDiffJson(entries: readonly RawMismatchEntry[]): string | null {
  const bounded: ShadowMismatchJsonEntry[] = [];
  for (const entry of entries) {
    const next = boundEntry(entry);
    if (next === null) {
      return null;
    }
    bounded.push(next);
  }
  return clampUtf8(JSON.stringify(bounded), SHADOW_LOG_DIFF_MAX_BYTES);
}

/**
 * The one clamp rule for built-in and hook entries: the pointer is clamped,
 * and each present side is rendered once and kept as JSON, or as its clamped
 * text when the rendering exceeds the side cap. `null` when a side has no
 * JSON rendering.
 */
function boundEntry(entry: RawMismatchEntry): ShadowMismatchJsonEntry | null {
  const bounded: { path: string; cached?: JsonValue; source?: JsonValue } = { path: clampPointer(entry.path) };
  for (const side of ["cached", "source"] as const) {
    if (!Object.hasOwn(entry, side)) {
      continue;
    }
    const json = renderJson(entry[side]);
    if (json === null) {
      return null;
    }
    const clamped = clampUtf8(json, SHADOW_MISMATCH_SIDE_MAX_BYTES);
    // Parsing the one rendering keeps a stateful `toJSON` from rendering twice.
    bounded[side] = clamped === json ? JSON.parse(json) as JsonValue : clamped;
  }
  return bounded;
}

function clampPointer(path: string): string {
  return clampUtf8(path, SHADOW_MISMATCH_PATH_MAX_BYTES);
}

function renderJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
  } catch {
    return null;
  }
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

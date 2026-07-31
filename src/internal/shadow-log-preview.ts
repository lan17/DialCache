import { types as utilTypes } from "node:util";

export const SHADOW_LOG_KEY_MAX_BYTES = 2 * 1024;
export const SHADOW_LOG_VALUE_MAX_BYTES = 8 * 1024;
export const SHADOW_LOG_TRUNCATION_MARKER = "...[truncated]";

const MAX_DEPTH = 4;
const MAX_CONTAINER_ENTRIES = 32;
const MAX_VISITED_NODES = 128;
const MAX_OBJECT_SCAN = MAX_CONTAINER_ENTRIES * 2;
const MAX_RENDERED_BIGINT_MAGNITUDE = 10n ** 100n;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TRUNCATION_MARKER_BYTES = UTF8_ENCODER.encode(SHADOW_LOG_TRUNCATION_MARKER);

export interface BoundedLogPreview {
  readonly text: string;
  readonly truncated: boolean;
}

export interface ShadowMismatchLogDetails {
  readonly cacheKey: string;
  readonly cachedValuePreview: string;
  readonly sourceValuePreview: string;
  readonly detailsTruncated: boolean;
}

interface PreviewState {
  readonly writer: Utf8PreviewWriter;
  readonly ancestors: WeakSet<object>;
  visitedNodes: number;
}

class Utf8PreviewWriter {
  private readonly bytes: Uint8Array;
  private offset = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {
    this.bytes = new Uint8Array(maxBytes);
  }

  get isFull(): boolean {
    return this.offset >= this.contentLimit;
  }

  write(value: string): boolean {
    if (value.length === 0) {
      return true;
    }

    const destination = this.bytes.subarray(this.offset, this.contentLimit);
    const { read, written } = UTF8_ENCODER.encodeInto(value, destination);
    this.offset += written;
    if (read === value.length) {
      return true;
    }

    this.markTruncated();
    return false;
  }

  markTruncated(): void {
    if (this.truncated) {
      return;
    }

    this.truncated = true;
    if (this.offset > this.contentLimit) {
      this.offset = completeUtf8PrefixLength(this.bytes, this.contentLimit);
    }
  }

  finish(): BoundedLogPreview {
    if (this.truncated) {
      this.bytes.set(TRUNCATION_MARKER_BYTES, this.offset);
      this.offset += TRUNCATION_MARKER_BYTES.byteLength;
    }
    return {
      text: UTF8_DECODER.decode(this.bytes.subarray(0, this.offset)),
      truncated: this.truncated,
    };
  }

  private get contentLimit(): number {
    return this.truncated
      ? this.maxBytes - TRUNCATION_MARKER_BYTES.byteLength
      : this.maxBytes;
  }
}

export function previewShadowLogKey(value: string): BoundedLogPreview {
  const writer = new Utf8PreviewWriter(SHADOW_LOG_KEY_MAX_BYTES);
  writer.write(value);
  return writer.finish();
}

export function previewShadowLogValue(value: unknown): BoundedLogPreview {
  const state: PreviewState = {
    writer: new Utf8PreviewWriter(SHADOW_LOG_VALUE_MAX_BYTES),
    ancestors: new WeakSet(),
    visitedNodes: 0,
  };

  try {
    renderValue(state, value, 0);
    return state.writer.finish();
  } catch {
    return unavailablePreview();
  }
}

export function shadowMismatchLogDetails(
  cacheKey: string,
  cachedValue: unknown,
  sourceValue: unknown,
): ShadowMismatchLogDetails {
  const keyPreview = previewShadowLogKey(cacheKey);
  const cachedPreview = previewShadowLogValue(cachedValue);
  const sourcePreview = previewShadowLogValue(sourceValue);
  return {
    cacheKey: keyPreview.text,
    cachedValuePreview: cachedPreview.text,
    sourceValuePreview: sourcePreview.text,
    detailsTruncated: keyPreview.truncated || cachedPreview.truncated || sourcePreview.truncated,
  };
}

function renderValue(state: PreviewState, value: unknown, depth: number): void {
  if (state.writer.isFull) {
    state.writer.markTruncated();
    return;
  }
  if (state.visitedNodes >= MAX_VISITED_NODES) {
    writeTruncatedMarker(state, "[NodeLimit]");
    return;
  }
  state.visitedNodes += 1;

  try {
    if (value === null) {
      state.writer.write("null");
      return;
    }

    switch (typeof value) {
      case "undefined":
        state.writer.write("undefined");
        return;
      case "string":
        writeQuotedString(state.writer, value);
        return;
      case "boolean":
        state.writer.write(value ? "true" : "false");
        return;
      case "number":
        writeNumber(state.writer, value);
        return;
      case "bigint":
        writeBigInt(state.writer, value);
        return;
      case "symbol":
        writeTruncatedMarker(state, "[Symbol]");
        return;
      case "function":
        writeTruncatedMarker(state, utilTypes.isProxy(value) ? "[Proxy]" : "[Function]");
        return;
      case "object":
        renderObject(state, value, depth);
        return;
    }
  } catch {
    writeTruncatedMarker(state, "[unavailable]");
  }
}

function renderObject(state: PreviewState, value: object, depth: number): void {
  if (utilTypes.isProxy(value)) {
    writeTruncatedMarker(state, "[Proxy]");
    return;
  }
  if (state.ancestors.has(value)) {
    writeTruncatedMarker(state, "[Circular]");
    return;
  }
  if (depth >= MAX_DEPTH) {
    writeTruncatedMarker(state, "[MaxDepth]");
    return;
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      renderArray(state, value, depth);
    } else if (isPlainRecord(value)) {
      renderRecord(state, value, depth);
    } else {
      writeTruncatedMarker(state, "[Object]");
    }
  } finally {
    state.ancestors.delete(value);
  }
}

function renderArray(state: PreviewState, value: readonly unknown[], depth: number): void {
  state.writer.write(`Array(${value.length}) [`);
  const entryCount = Math.min(value.length, MAX_CONTAINER_ENTRIES);
  for (let index = 0; index < entryCount && !state.writer.isFull; index += 1) {
    if (index > 0) {
      state.writer.write(", ");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      state.writer.write("<empty>");
    } else if ("value" in descriptor) {
      renderValue(state, descriptor.value, depth + 1);
    } else {
      writeTruncatedMarker(state, "[Accessor]");
    }
  }
  if (value.length > entryCount) {
    state.writer.markTruncated();
  }
  state.writer.write("]");
}

function renderRecord(state: PreviewState, value: Record<string, unknown>, depth: number): void {
  state.writer.write("{");
  let emittedEntries = 0;
  let scannedEntries = 0;
  for (const property in value) {
    scannedEntries += 1;
    if (scannedEntries > MAX_OBJECT_SCAN || emittedEntries >= MAX_CONTAINER_ENTRIES) {
      state.writer.markTruncated();
      break;
    }
    if (!Object.hasOwn(value, property)) {
      continue;
    }
    if (emittedEntries > 0) {
      state.writer.write(", ");
    }
    writeQuotedString(state.writer, property);
    state.writer.write(": ");
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (descriptor === undefined) {
      writeTruncatedMarker(state, "[unavailable]");
    } else if ("value" in descriptor) {
      renderValue(state, descriptor.value, depth + 1);
    } else {
      writeTruncatedMarker(state, "[Accessor]");
    }
    emittedEntries += 1;
    if (state.writer.isFull) {
      break;
    }
  }
  state.writer.write("}");
}

function writeNumber(writer: Utf8PreviewWriter, value: number): void {
  if (Number.isNaN(value)) {
    writer.write("NaN");
  } else if (value === Number.POSITIVE_INFINITY) {
    writer.write("Infinity");
  } else if (value === Number.NEGATIVE_INFINITY) {
    writer.write("-Infinity");
  } else if (Object.is(value, -0)) {
    writer.write("-0");
  } else {
    writer.write(String(value));
  }
}

function writeBigInt(writer: Utf8PreviewWriter, value: bigint): void {
  if (value <= -MAX_RENDERED_BIGINT_MAGNITUDE || value >= MAX_RENDERED_BIGINT_MAGNITUDE) {
    writer.write("[BigInt]");
    writer.markTruncated();
    return;
  }
  writer.write(`${value}n`);
}

function writeQuotedString(writer: Utf8PreviewWriter, value: string): void {
  if (!writer.write('"')) {
    return;
  }
  for (let index = 0; index < value.length && !writer.isFull;) {
    const codePoint = value.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    if (!writer.write(escapeCharacter(codePoint, character))) {
      return;
    }
    index += character.length;
  }
  writer.write('"');
}

function escapeCharacter(codePoint: number, character: string): string {
  switch (character) {
    case '"':
      return '\\"';
    case "\\":
      return "\\\\";
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
  }
  if (
    codePoint < 0x20
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    || codePoint === 0x2028
    || codePoint === 0x2029
  ) {
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }
  return character;
}

function writeTruncatedMarker(state: PreviewState, marker: string): void {
  state.writer.write(marker);
  state.writer.markTruncated();
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function unavailablePreview(): BoundedLogPreview {
  const writer = new Utf8PreviewWriter(SHADOW_LOG_VALUE_MAX_BYTES);
  writer.write("[unavailable]");
  writer.markTruncated();
  return writer.finish();
}

function completeUtf8PrefixLength(bytes: Uint8Array, proposedLength: number): number {
  if (proposedLength === 0) {
    return 0;
  }
  let sequenceStart = proposedLength;
  while (sequenceStart > 0 && isUtf8ContinuationByte(bytes[sequenceStart]!)) {
    sequenceStart -= 1;
  }
  if (sequenceStart === proposedLength) {
    return proposedLength;
  }
  return sequenceStart + utf8SequenceLength(bytes[sequenceStart]!) <= proposedLength
    ? proposedLength
    : sequenceStart;
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function utf8SequenceLength(firstByte: number): number {
  if ((firstByte & 0x80) === 0) {
    return 1;
  }
  if ((firstByte & 0xe0) === 0xc0) {
    return 2;
  }
  if ((firstByte & 0xf0) === 0xe0) {
    return 3;
  }
  return 4;
}

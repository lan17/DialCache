import { inspect, types as utilTypes } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  SHADOW_LOG_KEY_MAX_BYTES,
  SHADOW_LOG_TRUNCATION_MARKER,
  SHADOW_LOG_VALUE_MAX_BYTES,
  previewShadowLogKey,
  previewShadowLogValue,
  shadowMismatchLogDetails,
} from "../src/internal/shadow-log-preview.js";

describe("shadow mismatch log previews", () => {
  it("keeps exact-limit strings and byte-clamps oversized ASCII and Unicode strings", () => {
    expect(previewShadowLogKey("")).toEqual({
      text: "",
      truncated: false,
    });

    const exact = "a".repeat(SHADOW_LOG_KEY_MAX_BYTES);
    const exactKeyPreview = previewShadowLogKey(exact);
    expect(exactKeyPreview).toEqual({
      text: exact,
      truncated: false,
    });
    expect(Buffer.byteLength(exactKeyPreview.text)).toBe(SHADOW_LOG_KEY_MAX_BYTES);

    const exactValue = "v".repeat(SHADOW_LOG_VALUE_MAX_BYTES - 2);
    const exactValuePreview = previewShadowLogValue(exactValue);
    expect(exactValuePreview).toEqual({
      text: `"${exactValue}"`,
      truncated: false,
    });
    expect(Buffer.byteLength(exactValuePreview.text)).toBe(SHADOW_LOG_VALUE_MAX_BYTES);

    for (const oversized of [
      "a".repeat(SHADOW_LOG_KEY_MAX_BYTES + 1),
      `${"a".repeat(SHADOW_LOG_KEY_MAX_BYTES - 1)}🙂`,
    ]) {
      const preview = previewShadowLogKey(oversized);

      expect(preview.truncated).toBe(true);
      expect(preview.text.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
      expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(SHADOW_LOG_KEY_MAX_BYTES);
      expect(preview.text).not.toContain("\uFFFD");
    }
  });

  it("rolls byte-clipped keys back to a complete two-, three-, or four-byte UTF-8 sequence", () => {
    const contentLimit = SHADOW_LOG_KEY_MAX_BYTES - Buffer.byteLength(SHADOW_LOG_TRUNCATION_MARKER);

    for (const character of ["é", "€", "🙂"]) {
      const prefix = "a".repeat(contentLimit - 1);
      const preview = previewShadowLogKey(
        `${prefix}${character}${"z".repeat(SHADOW_LOG_KEY_MAX_BYTES)}`,
      );

      expect(preview).toEqual({
        text: `${prefix}${SHADOW_LOG_TRUNCATION_MARKER}`,
        truncated: true,
      });
      expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(SHADOW_LOG_KEY_MAX_BYTES);
      expect(preview.text).not.toContain("\uFFFD");
    }
  });

  it("uses length-only markers before inspecting very large rope strings", () => {
    let rope = "x";
    for (let index = 0; index < 17; index += 1) {
      rope += rope;
    }
    expect(rope.length).toBe(131_072);
    const marker = `[String length=${rope.length} code units]${SHADOW_LOG_TRUNCATION_MARKER}`;

    expect(previewShadowLogKey(rope)).toEqual({
      text: marker,
      truncated: true,
    });
    expect(previewShadowLogValue(rope)).toEqual({
      text: marker,
      truncated: true,
    });
    expect(previewShadowLogValue({ [rope]: 1 })).toEqual({
      text: `{[PropertyName length=${rope.length} code units]: 1}${SHADOW_LOG_TRUNCATION_MARKER}`,
      truncated: true,
    });
  });

  it("renders supported primitives and escaped strings without truncation", () => {
    expect(previewShadowLogValue({
      undefined,
      null: null,
      text: "\"line\n\u2028",
      values: [true, false, 1, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 12n],
    })).toEqual({
      text: '{"undefined": undefined, "null": null, "text": "\\"line\\n\\u2028", '
        + '"values": Array(8) [true, false, 1, -0, NaN, Infinity, -Infinity, 12n]}',
      truncated: false,
    });
  });

  it("escapes every supported string control and separator sequence", () => {
    const cases = [
      ['"', '\\"'],
      ["\\", "\\\\"],
      ["\b", "\\b"],
      ["\f", "\\f"],
      ["\n", "\\n"],
      ["\r", "\\r"],
      ["\t", "\\t"],
      ["\u0000", "\\u0000"],
      ["\u001f", "\\u001f"],
      ["\u2028", "\\u2028"],
      ["\u2029", "\\u2029"],
      ["\ud800", "\\ud800"],
      ["\udfff", "\\udfff"],
    ] as const;

    for (const [input, escaped] of cases) {
      expect(previewShadowLogValue(input)).toEqual({
        text: `"${escaped}"`,
        truncated: false,
      });
    }
  });

  it("bounds large values and aggregates field truncation", () => {
    const details = shadowMismatchLogDetails(
      "k".repeat(SHADOW_LOG_KEY_MAX_BYTES + 1),
      "c".repeat(SHADOW_LOG_VALUE_MAX_BYTES + 1),
      "s".repeat(SHADOW_LOG_VALUE_MAX_BYTES + 1),
    );

    expect(details.detailsTruncated).toBe(true);
    expect(Buffer.byteLength(details.cacheKey)).toBeLessThanOrEqual(SHADOW_LOG_KEY_MAX_BYTES);
    expect(Buffer.byteLength(details.cachedValuePreview)).toBeLessThanOrEqual(SHADOW_LOG_VALUE_MAX_BYTES);
    expect(Buffer.byteLength(details.sourceValuePreview)).toBeLessThanOrEqual(SHADOW_LOG_VALUE_MAX_BYTES);
    expect(details.cacheKey.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(details.cachedValuePreview.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(details.sourceValuePreview.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
  });

  it("aggregates byte and structural truncation from each detail field independently", () => {
    const cases = [
      {
        name: "cache key",
        details: shadowMismatchLogDetails(
          "k".repeat(SHADOW_LOG_KEY_MAX_BYTES + 1),
          "cached",
          "source",
        ),
        truncatedField: "cacheKey",
      },
      {
        name: "cached value",
        details: shadowMismatchLogDetails(
          "key",
          "c".repeat(SHADOW_LOG_VALUE_MAX_BYTES + 1),
          "source",
        ),
        truncatedField: "cachedValuePreview",
      },
      {
        name: "source value",
        details: shadowMismatchLogDetails(
          "key",
          "cached",
          "s".repeat(SHADOW_LOG_VALUE_MAX_BYTES + 1),
        ),
        truncatedField: "sourceValuePreview",
      },
      {
        name: "structurally unsupported cached value",
        details: shadowMismatchLogDetails("key", new Map([["key", "value"]]), "source"),
        truncatedField: "cachedValuePreview",
      },
    ] as const;

    for (const { name, details, truncatedField } of cases) {
      expect(details.detailsTruncated, name).toBe(true);
      expect(
        (["cacheKey", "cachedValuePreview", "sourceValuePreview"] as const)
          .filter((field) => details[field].endsWith(SHADOW_LOG_TRUNCATION_MARKER)),
        name,
      ).toEqual([truncatedField]);
    }
  });

  it("limits depth, entry count, node count, large BigInts, and opaque values", () => {
    const deep = { one: { two: { three: { four: { five: "hidden" } } } } };
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key${index}`, index]));
    const manyNodes = Array.from({ length: 32 }, () => [1, 2, 3, 4, 5]);

    for (const value of [
      deep,
      wide,
      manyNodes,
      10n ** 100n,
      Symbol("symbol"),
      () => undefined,
      Promise.resolve(),
      new WeakMap(),
      new WeakSet(),
      new Proxy(() => undefined, {}),
    ]) {
      const preview = previewShadowLogValue(value);

      expect(preview.truncated).toBe(true);
      expect(preview.text.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
      expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(SHADOW_LOG_VALUE_MAX_BYTES);
    }
  });

  it("renders dates with intrinsic methods and distinguishes different timestamps", () => {
    const valueOf = vi.fn(() => {
      throw new Error("overridden valueOf invoked");
    });
    const toISOString = vi.fn(() => {
      throw new Error("overridden toISOString invoked");
    });
    const hostileDate = new Date("2026-07-30T00:00:00.000Z");
    Object.defineProperties(hostileDate, {
      valueOf: { value: valueOf },
      toISOString: { value: toISOString },
    });

    expect(previewShadowLogValue(hostileDate)).toEqual({
      text: "Date(2026-07-30T00:00:00.000Z)",
      truncated: false,
    });
    expect(previewShadowLogValue(new Date("2026-07-31T00:00:00.000Z"))).toEqual({
      text: "Date(2026-07-31T00:00:00.000Z)",
      truncated: false,
    });
    expect(previewShadowLogValue(new Date(Number.NaN))).toEqual({
      text: "Date(Invalid)",
      truncated: false,
    });
    expect(previewShadowLogValue({ updatedAt: hostileDate })).toEqual({
      text: '{"updatedAt": Date(2026-07-30T00:00:00.000Z)}',
      truncated: false,
    });
    expect(valueOf).not.toHaveBeenCalled();
    expect(toISOString).not.toHaveBeenCalled();
  });

  it("renders collection sizes without invoking instance hooks or iterators", () => {
    const hook = vi.fn(() => {
      throw new Error("collection hook invoked");
    });
    const map = new Map<unknown, unknown>([["a", 1], ["b", 2]]);
    const set = new Set<unknown>(["a", "b", "c"]);
    Object.defineProperties(map, {
      size: { get: hook },
      entries: { value: hook },
      [Symbol.iterator]: { value: hook },
    });
    Object.defineProperties(set, {
      size: { get: hook },
      values: { value: hook },
      [Symbol.iterator]: { value: hook },
    });

    expect(previewShadowLogValue(new Map())).toEqual({
      text: "Map(0)",
      truncated: false,
    });
    expect(previewShadowLogValue(new Set())).toEqual({
      text: "Set(0)",
      truncated: false,
    });
    expect(previewShadowLogValue(map)).toEqual({
      text: `Map(2)${SHADOW_LOG_TRUNCATION_MARKER}`,
      truncated: true,
    });
    expect(previewShadowLogValue(set)).toEqual({
      text: `Set(3)${SHADOW_LOG_TRUNCATION_MARKER}`,
      truncated: true,
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it("renders bounded raw bytes for buffers and every supported typed-array brand", () => {
    expect(previewShadowLogValue(Buffer.from([0, 1, 255]))).toEqual({
      text: "Buffer(3 bytes) [00 01 ff]",
      truncated: false,
    });

    const typedArrays = [
      ["Uint8Array", new Uint8Array(1)],
      ["Uint8ClampedArray", new Uint8ClampedArray(1)],
      ["Uint16Array", new Uint16Array(1)],
      ["Uint32Array", new Uint32Array(1)],
      ["Int8Array", new Int8Array(1)],
      ["Int16Array", new Int16Array(1)],
      ["Int32Array", new Int32Array(1)],
      ["Float32Array", new Float32Array(1)],
      ["Float64Array", new Float64Array(1)],
      ["BigInt64Array", new BigInt64Array(1)],
      ["BigUint64Array", new BigUint64Array(1)],
    ] as const;

    for (const [name, value] of typedArrays) {
      expect(previewShadowLogValue(value)).toEqual({
        text: `${name}(${value.byteLength} bytes) [${Array.from(
          { length: value.byteLength },
          () => "00",
        ).join(" ")}]`,
        truncated: false,
      });
    }

    const oversized = Uint8Array.from({ length: 65 }, (_, index) => index);
    const oversizedPreview = previewShadowLogValue(oversized);
    expect(oversizedPreview.truncated).toBe(true);
    expect(oversizedPreview.text).toBe(
      `Uint8Array(65 bytes) [${Array.from(
        { length: 64 },
        (_, index) => index.toString(16).padStart(2, "0"),
      ).join(" ")}]${SHADOW_LOG_TRUNCATION_MARKER}`,
    );
    expect(Buffer.byteLength(oversizedPreview.text)).toBeLessThanOrEqual(SHADOW_LOG_VALUE_MAX_BYTES);
  });

  it("keeps later typed-array brands working on the Node 22.0 util.types surface", () => {
    const descriptor = Object.getOwnPropertyDescriptor(utilTypes, "isFloat16Array");
    expect(descriptor).toBeDefined();
    Reflect.deleteProperty(utilTypes, "isFloat16Array");

    try {
      expect(previewShadowLogValue(new Float64Array(1))).toEqual({
        text: "Float64Array(8 bytes) [00 00 00 00 00 00 00 00]",
        truncated: false,
      });
      expect(previewShadowLogValue(new BigUint64Array(1))).toEqual({
        text: "BigUint64Array(8 bytes) [00 00 00 00 00 00 00 00]",
        truncated: false,
      });
    } finally {
      Object.defineProperty(utilTypes, "isFloat16Array", descriptor!);
    }
  });

  it("reads binary metadata through intrinsics instead of instance overrides", () => {
    const hook = vi.fn(() => {
      throw new Error("typed-array hook invoked");
    });
    const value = Uint8Array.from([5, 6]);
    Object.defineProperties(value, {
      buffer: { get: hook },
      byteOffset: { get: hook },
      byteLength: { get: hook },
      constructor: { get: hook },
      [Symbol.iterator]: { value: hook },
    });

    expect(previewShadowLogValue(value)).toEqual({
      text: "Uint8Array(2 bytes) [05 06]",
      truncated: false,
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it("fails closed for a detached typed-array buffer", () => {
    const value = Uint8Array.from([1, 2]);
    structuredClone(value.buffer, { transfer: [value.buffer] });

    expect(previewShadowLogValue(value)).toEqual({
      text: `[unavailable]${SHADOW_LOG_TRUNCATION_MARKER}`,
      truncated: true,
    });
  });

  it("keeps unsupported exotic and class instances opaque", () => {
    class Example {
      readonly visible = true;
    }
    const values = [
      new DataView(Uint8Array.from([3, 4]).buffer),
      Uint8Array.from([5, 6]).buffer,
      /cache/giu,
      new Error("nope"),
      new Example(),
    ];

    const previews = values.map((value) => previewShadowLogValue(value));

    expect(previews).toEqual(values.map(() => ({
      text: `[Object]${SHADOW_LOG_TRUNCATION_MARKER}`,
      truncated: true,
    })));
  });

  it("bounds arrays by their indexed entry limit", () => {
    const sparse = Array.from({ length: 40 }, (_, index) => index);
    delete sparse[1];
    Object.defineProperty(sparse, "2", { get: () => 2, enumerable: true });

    const preview = previewShadowLogValue(sparse);

    expect(preview.truncated).toBe(true);
    expect(preview.text).toContain("<empty>");
    expect(preview.text).toContain("[Accessor]");
    expect(preview.text.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
  });

  it("does not invoke accessors, serializers, custom inspectors, or proxy traps", () => {
    const getter = vi.fn(() => {
      throw new Error("getter invoked");
    });
    const toJSON = vi.fn(() => {
      throw new Error("toJSON invoked");
    });
    const customInspect = vi.fn(() => {
      throw new Error("custom inspect invoked");
    });
    const value: Record<PropertyKey, unknown> = { toJSON };
    Object.defineProperty(value, "secret", { enumerable: true, get: getter });
    Object.defineProperty(value, Symbol.toStringTag, { get: getter });
    value[inspect.custom] = customInspect;
    value.self = value;

    const ownKeys = vi.fn(() => {
      throw new Error("proxy reflected");
    });
    const proxy = new Proxy({}, { ownKeys });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const regexp = /safe/g;
    Object.defineProperty(regexp, "global", { get: getter });
    const typedArray = new Uint8Array([1, 2]);
    Object.defineProperties(typedArray, {
      buffer: { get: getter },
      byteOffset: { get: getter },
      byteLength: { get: getter },
    });

    const recordPreview = previewShadowLogValue(value);
    const proxyPreview = previewShadowLogValue(proxy);
    const revokedPreview = previewShadowLogValue(revocable.proxy);
    const regexpPreview = previewShadowLogValue(regexp);
    const typedArrayPreview = previewShadowLogValue(typedArray);

    expect(recordPreview.truncated).toBe(true);
    expect(recordPreview.text).toContain("[Accessor]");
    expect(recordPreview.text).toContain("[Circular]");
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(customInspect).not.toHaveBeenCalled();
    expect(regexpPreview).toEqual({
      text: `[Object]${SHADOW_LOG_TRUNCATION_MARKER}`,
      truncated: true,
    });
    expect(typedArrayPreview).toEqual({
      text: "Uint8Array(2 bytes) [01 02]",
      truncated: false,
    });
    expect(proxyPreview.text).toBe(`[Proxy]${SHADOW_LOG_TRUNCATION_MARKER}`);
    expect(revokedPreview.text).toBe(`[Proxy]${SHADOW_LOG_TRUNCATION_MARKER}`);
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("limits its JSON-like domain to array indexes and enumerable string-keyed record fields", () => {
    const hidden = Symbol("hidden");
    const record: Record<PropertyKey, unknown> = { visible: 1 };
    Object.defineProperty(record, "nonEnumerable", { value: 2 });
    record[hidden] = 3;
    const array = [1] as unknown[] & Record<PropertyKey, unknown>;
    array.extra = 2;
    array[hidden] = 3;

    expect(previewShadowLogValue(record)).toEqual({
      text: '{"visible": 1}',
      truncated: false,
    });
    expect(previewShadowLogValue(array)).toEqual({
      text: "Array(1) [1]",
      truncated: false,
    });
  });

  it("ignores inherited enumerable fields without reporting truncation", () => {
    const inheritedFields = Array.from({ length: 65 }, (_, index) => `__dialcache_preview_${index}`);
    const preview = (() => {
      try {
        for (const [index, field] of inheritedFields.entries()) {
          Object.defineProperty(Object.prototype, field, {
            value: index,
            enumerable: true,
            configurable: true,
          });
        }
        return previewShadowLogValue({ visible: 1 });
      } finally {
        for (const field of inheritedFields) {
          delete (Object.prototype as Record<string, unknown>)[field];
        }
      }
    })();

    expect(preview).toEqual({
      text: '{"visible": 1}',
      truncated: false,
    });
  });

  it("does not render a value after an oversized property name fills the preview", () => {
    const preview = previewShadowLogValue({
      ["p".repeat(SHADOW_LOG_VALUE_MAX_BYTES)]: "must-not-appear",
    });

    expect(preview.truncated).toBe(true);
    expect(preview.text).not.toContain("must-not-appear");
    expect(preview.text.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(SHADOW_LOG_VALUE_MAX_BYTES);
  });

  it("marks detailed output complete only when every field is complete", () => {
    expect(shadowMismatchLogDetails(
      "{urn:user_id:123}#Example",
      { id: "123", version: 1 },
      { id: "123", version: 2 },
    )).toEqual({
      cacheKey: "{urn:user_id:123}#Example",
      cachedValuePreview: '{"id": "123", "version": 1}',
      sourceValuePreview: '{"id": "123", "version": 2}',
      detailsTruncated: false,
    });
  });
});

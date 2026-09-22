import { randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPRESSION_THRESHOLD_BYTES,
  DEFAULT_ZSTD_LEVEL,
  MARKER_ESCAPED_RAW,
  MARKER_ZSTD_BINARY,
  MARKER_ZSTD_UTF8,
  compressPayload,
  decompressPayload,
  escapeRawPayload,
  resolveCompressionConfig,
  type CompressionConfig,
} from "../src/internal/compression.js";

const config = (thresholdBytes: number, level = DEFAULT_ZSTD_LEVEL): Required<CompressionConfig> => {
  const resolved = resolveCompressionConfig({ thresholdBytes, level });
  if (resolved === null) {
    throw new Error("expected an enabled compression config");
  }
  return resolved;
};

describe("compression config resolution", () => {
  it("enables compression with documented defaults when unset", () => {
    expect(resolveCompressionConfig(undefined)).toEqual({
      thresholdBytes: DEFAULT_COMPRESSION_THRESHOLD_BYTES,
      level: DEFAULT_ZSTD_LEVEL,
    });
    expect(resolveCompressionConfig({})).toEqual({ thresholdBytes: 4096, level: 3 });
  });

  it("resolves false to null so the disabled state carries no fabricated values", () => {
    expect(resolveCompressionConfig(false)).toBeNull();
  });

  it("rejects null and other non-object sentinels instead of silently enabling", () => {
    for (const config of [null, true, 0, 1, "false"]) {
      expect(() => resolveCompressionConfig(config as never)).toThrowError(
        "RedisConfig.compression must be an options object, false, or undefined",
      );
    }
  });

  it("passes explicit threshold and level through", () => {
    expect(resolveCompressionConfig({ thresholdBytes: 1, level: 22 })).toEqual({
      thresholdBytes: 1,
      level: 22,
    });
  });

  it("rejects non-positive, fractional, and unsafe thresholds", () => {
    for (const thresholdBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => resolveCompressionConfig({ thresholdBytes })).toThrowError(
        "RedisConfig.compression.thresholdBytes must be a positive safe integer",
      );
    }
  });

  it("rejects levels outside the zstd range", () => {
    for (const level of [0, 23, 1.5, Number.NaN]) {
      expect(() => resolveCompressionConfig({ level })).toThrowError(
        "RedisConfig.compression.level must be an integer between 1 and 22",
      );
    }
  });
});

describe("escapeRawPayload", () => {
  it("prefixes binary payloads whose first byte collides with the envelope", () => {
    for (const first of [MARKER_ESCAPED_RAW, MARKER_ZSTD_UTF8, MARKER_ZSTD_BINARY]) {
      const raw = Buffer.concat([Buffer.from([first]), Buffer.from("tail")]);
      const escaped = escapeRawPayload(raw);
      if (!Buffer.isBuffer(escaped)) {
        throw new Error("escaped payload must be a Buffer");
      }
      expect(escaped[0]).toBe(MARKER_ESCAPED_RAW);
      expect(escaped.subarray(1).equals(raw)).toBe(true);
    }
  });

  it("leaves strings, empty Buffers, and non-colliding Buffers untouched", () => {
    expect(escapeRawPayload("payload")).toBe("payload");
    const empty = Buffer.alloc(0);
    expect(escapeRawPayload(empty)).toBe(empty);
    const plain = Buffer.from("plain binary payload");
    expect(escapeRawPayload(plain)).toBe(plain);
  });
});

describe("compressPayload", () => {
  it("returns payloads below the threshold untouched", () => {
    const payload = "a".repeat(99);
    const result = compressPayload(payload, config(100));
    expect(result).toEqual({ payload, outcome: "below_threshold", originalBytes: 99, storedBytes: 99 });
    expect(result.payload).toBe(payload);
  });

  it("escapes below-threshold binary payloads that collide with the envelope", () => {
    const raw = Buffer.concat([Buffer.from([MARKER_ZSTD_UTF8]), Buffer.from("short")]);
    const result = compressPayload(raw, config(1024));

    expect(result.outcome).toBe("below_threshold");
    expect(result.originalBytes).toBe(raw.length);
    expect(result.storedBytes).toBe(raw.length + 1);
    const restored = decompressPayload(result.payload);
    expect(restored.outcome).toBe("passthrough");
    expect(restored.payload).toEqual(raw);
  });

  it("compresses string payloads at the threshold and restores them exactly", () => {
    const payload = JSON.stringify({ blob: "dialcache ".repeat(16) });
    const result = compressPayload(payload, config(Buffer.byteLength(payload)));

    expect(result.outcome).toBe("compressed");
    expect(result.originalBytes).toBe(Buffer.byteLength(payload));
    expect(result.storedBytes).toBeLessThan(result.originalBytes);
    const stored = result.payload;
    if (!Buffer.isBuffer(stored)) {
      throw new Error("compressed payload must be a Buffer");
    }
    expect(stored[0]).toBe(MARKER_ZSTD_UTF8);
    expect(stored.length).toBe(result.storedBytes);

    expect(decompressPayload(stored)).toEqual({ payload, outcome: "decompressed" });
  });

  it("measures string thresholds in UTF-8 bytes, not UTF-16 code units", () => {
    const payload = "é".repeat(60);
    expect(payload.length).toBe(60);
    const result = compressPayload(payload, config(100));

    expect(result.originalBytes).toBe(120);
    expect(result.outcome).toBe("compressed");
    expect(decompressPayload(result.payload)).toEqual({ payload, outcome: "decompressed" });
  });

  it("marks Buffer payloads as binary and restores a Buffer", () => {
    const payload = Buffer.from("binary dialcache payload ".repeat(64));
    const result = compressPayload(payload, config(64));

    expect(result.outcome).toBe("compressed");
    const stored = result.payload;
    if (!Buffer.isBuffer(stored)) {
      throw new Error("compressed payload must be a Buffer");
    }
    expect(stored[0]).toBe(MARKER_ZSTD_BINARY);

    const restored = decompressPayload(stored);
    expect(restored.outcome).toBe("decompressed");
    expect(Buffer.isBuffer(restored.payload)).toBe(true);
    expect(restored.payload).toEqual(payload);
  });

  it("keeps incompressible payloads raw instead of growing them", () => {
    const payload = zstdCompressSync(randomBytes(4096));
    const result = compressPayload(payload, config(32));

    expect(result.outcome).toBe("not_smaller");
    expect(result.payload).toBe(payload);
    expect(result.storedBytes).toBe(payload.length);
  });

  it("escapes incompressible payloads that collide with the envelope", () => {
    // zstd-of-zstd never shrinks, so a marker-led compressed blob lands on the
    // raw path and must come back byte-exact through the escape.
    const raw = Buffer.concat([Buffer.from([MARKER_ZSTD_UTF8]), zstdCompressSync(randomBytes(4096))]);
    const result = compressPayload(raw, config(32));

    expect(result.outcome).toBe("not_smaller");
    expect(result.storedBytes).toBe(raw.length + 1);
    const restored = decompressPayload(result.payload);
    expect(restored.outcome).toBe("passthrough");
    expect(restored.payload).toEqual(raw);
  });

  it("honors the configured zstd level", () => {
    const payload = JSON.stringify({
      rows: Array.from({ length: 512 }, (_, index) => ({ index, id: `row-${index}`, flag: index % 3 === 0 })),
    });
    const fast = compressPayload(payload, config(64, 1));
    const strong = compressPayload(payload, config(64, 19));

    expect(fast.outcome).toBe("compressed");
    expect(strong.outcome).toBe("compressed");
    // Different levels produce different streams; size ordering is not
    // guaranteed on small fixtures, so only the round-trip and the fact that
    // the level reaches zstd are pinned.
    expect(Buffer.from(fast.payload).equals(Buffer.from(strong.payload))).toBe(false);
    expect(decompressPayload(fast.payload)).toEqual({ payload, outcome: "decompressed" });
    expect(decompressPayload(strong.payload)).toEqual({ payload, outcome: "decompressed" });
  });

  it("refuses to compress payloads larger than the decompression cap", () => {
    const payload = "x".repeat(2048);
    const result = compressPayload(payload, config(64), 1024);

    expect(result.outcome).toBe("write_over_limit");
    expect(result.payload).toBe(payload);
    expect(result.storedBytes).toBe(2048);
  });
});

describe("decompressPayload", () => {
  it("passes strings and unmarked Buffers through untouched", () => {
    const text = "plain payload";
    expect(decompressPayload(text)).toEqual({ payload: text, outcome: "passthrough" });

    const buffer = Buffer.from("plain binary payload");
    const result = decompressPayload(buffer);
    expect(result.outcome).toBe("passthrough");
    expect(result.payload).toBe(buffer);

    expect(decompressPayload(Buffer.alloc(0)).outcome).toBe("passthrough");
  });

  it("strips the escape prefix without decompressing", () => {
    for (const first of [MARKER_ESCAPED_RAW, MARKER_ZSTD_UTF8, MARKER_ZSTD_BINARY]) {
      const raw = Buffer.concat([Buffer.from([first]), Buffer.from("raw serializer output")]);
      const stored = escapeRawPayload(raw);
      if (!Buffer.isBuffer(stored)) {
        throw new Error("escaped payload must be a Buffer");
      }

      const restored = decompressPayload(stored);
      expect(restored.outcome).toBe("passthrough");
      expect(restored.payload).toEqual(raw);
    }
  });

  it("only strips a leading 0x00 when an envelope byte follows", () => {
    // Legacy binary output beginning 0x00 (msgpack zero, Avro zigzag zero)
    // predates escaping and must keep passing through untouched.
    const legacy = Buffer.from([MARKER_ESCAPED_RAW, 0x2a, 0x07]);
    const untouched = decompressPayload(legacy);
    expect(untouched.outcome).toBe("passthrough");
    expect(untouched.payload).toBe(legacy);

    expect(decompressPayload(Buffer.from([MARKER_ESCAPED_RAW])).payload).toEqual(
      Buffer.from([MARKER_ESCAPED_RAW]),
    );

    // The documented residual: a legacy payload whose first two bytes are both
    // envelope bytes is indistinguishable from an escaped payload and loses
    // its first byte until the entry expires.
    const residual = Buffer.from([MARKER_ESCAPED_RAW, MARKER_ZSTD_UTF8, 0x2a]);
    expect(decompressPayload(residual).payload).toEqual(Buffer.from([MARKER_ZSTD_UTF8, 0x2a]));
  });

  it("falls back to the raw payload when a marked Buffer is not zstd", () => {
    // Bodies with an invalid zstd magic are rejected by every supported Node;
    // empty and truncated bodies are version-dependent and pinned separately.
    for (const collision of [
      Buffer.concat([Buffer.from([MARKER_ZSTD_UTF8]), Buffer.from("raw serializer output")]),
      Buffer.concat([Buffer.from([MARKER_ZSTD_BINARY]), randomBytes(64)]),
    ]) {
      const result = decompressPayload(collision);
      expect(result.outcome).toBe("fallback_raw");
      expect(result.payload).toBe(collision);
    }
  });

  it("degrades marked payloads with empty or truncated bodies without throwing", () => {
    // node:zlib zstd accepts empty and truncated input on Node 22/24 (empty
    // output) and rejects both on Node 26+, so only the safety contract is
    // pinned: no throw, and fallback hands back the original payload. Both
    // shapes only occur for legacy marker-colliding entries or corruption,
    // and either outcome degrades to a swallowed miss at the cache layer.
    const compressed = compressPayload("dialcache ".repeat(1024), config(64)).payload;
    if (!Buffer.isBuffer(compressed)) {
      throw new Error("expected a compressed Buffer");
    }

    for (const input of [
      Buffer.from([MARKER_ZSTD_UTF8]),
      compressed.subarray(0, Math.floor(compressed.length / 2)),
    ]) {
      const result = decompressPayload(input);
      expect(["fallback_raw", "decompressed"]).toContain(result.outcome);
      if (result.outcome === "fallback_raw") {
        expect(result.payload).toBe(input);
      }
    }
  });

  it("pins the legacy residual: a marker followed by a valid zstd stream is misread", () => {
    // Entries written before escaping existed have no 0x00 prefix, so this
    // shape is decompressed on every Node version — including when trailing
    // bytes follow the frame (zstd silently drops them). The README documents
    // this residual and the key-versioning migration.
    const body = Buffer.from("legacy serializer body");
    const legacy = Buffer.concat([Buffer.from([MARKER_ZSTD_BINARY]), zstdCompressSync(body)]);
    expect(decompressPayload(legacy)).toEqual({ payload: body, outcome: "decompressed" });

    const withTrailer = Buffer.concat([legacy, Buffer.from("CRC!")]);
    expect(decompressPayload(withTrailer)).toEqual({ payload: body, outcome: "decompressed" });
  });

  it("returns read_over_limit and the original payload when decompression would exceed the cap", () => {
    const compressed = compressPayload("dialcache ".repeat(1024), config(64)).payload;
    if (!Buffer.isBuffer(compressed)) {
      throw new Error("expected a compressed Buffer");
    }

    const result = decompressPayload(compressed, 16);
    expect(result.outcome).toBe("read_over_limit");
    expect(result.payload).toBe(compressed);

    expect(decompressPayload(compressed).outcome).toBe("decompressed");

    // The cap is inclusive: a payload decompressing to exactly the limit is
    // readable, matching the write side's strict greater-than refusal so
    // nothing writable is unreadable at the boundary.
    const payload = "dialcache ".repeat(1024);
    expect(decompressPayload(compressed, Buffer.byteLength(payload))).toEqual({
      payload,
      outcome: "decompressed",
    });
  });

  it("never mutates the marked input payload", () => {
    const compressed = compressPayload("dialcache ".repeat(1024), config(64)).payload;
    if (!Buffer.isBuffer(compressed)) {
      throw new Error("expected a compressed Buffer");
    }
    const snapshot = Buffer.from(compressed);

    const first = decompressPayload(compressed);
    const second = decompressPayload(compressed);

    expect(compressed.equals(snapshot)).toBe(true);
    expect(first).toEqual(second);
    expect(first.outcome).toBe("decompressed");
  });
});

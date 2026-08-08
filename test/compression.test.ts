import { randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPRESSION_THRESHOLD_BYTES,
  DEFAULT_ZSTD_LEVEL,
  MARKER_ZSTD_BINARY,
  MARKER_ZSTD_UTF8,
  compressPayload,
  decompressPayload,
  resolveCompressionConfig,
} from "../src/internal/compression.js";

const config = (thresholdBytes: number, level = DEFAULT_ZSTD_LEVEL) =>
  resolveCompressionConfig({ thresholdBytes, level });

describe("compression config resolution", () => {
  it("enables compression with documented defaults when unset", () => {
    expect(resolveCompressionConfig(undefined)).toEqual({
      enabled: true,
      thresholdBytes: DEFAULT_COMPRESSION_THRESHOLD_BYTES,
      level: DEFAULT_ZSTD_LEVEL,
    });
    expect(resolveCompressionConfig({})).toEqual({
      enabled: true,
      thresholdBytes: 4096,
      level: 3,
    });
  });

  it("disables write-side compression for false", () => {
    expect(resolveCompressionConfig(false).enabled).toBe(false);
  });

  it("passes explicit threshold and level through", () => {
    expect(resolveCompressionConfig({ thresholdBytes: 1, level: 22 })).toEqual({
      enabled: true,
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

describe("compressPayload", () => {
  it("returns payloads below the threshold untouched", () => {
    const payload = "a".repeat(99);
    const result = compressPayload(payload, config(100));
    expect(result).toEqual({ payload, outcome: "below_threshold", originalBytes: 99, storedBytes: 99 });
    expect(result.payload).toBe(payload);
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

  it("falls back to the raw payload when a marked Buffer is not zstd", () => {
    for (const collision of [
      Buffer.from([MARKER_ZSTD_UTF8]),
      Buffer.concat([Buffer.from([MARKER_ZSTD_UTF8]), Buffer.from("raw serializer output")]),
      Buffer.concat([Buffer.from([MARKER_ZSTD_BINARY]), randomBytes(64)]),
    ]) {
      const result = decompressPayload(collision);
      expect(result.outcome).toBe("fallback_raw");
      expect(result.payload).toBe(collision);
    }
  });

  it("falls back to the raw payload when a marked zstd frame is truncated", () => {
    const compressed = compressPayload("dialcache ".repeat(1024), config(64)).payload;
    if (!Buffer.isBuffer(compressed)) {
      throw new Error("expected a compressed Buffer");
    }
    const truncated = compressed.subarray(0, Math.floor(compressed.length / 2));

    const result = decompressPayload(truncated);
    expect(result.outcome).toBe("fallback_raw");
    expect(result.payload).toBe(truncated);
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

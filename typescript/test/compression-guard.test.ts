import { describe, expect, it, vi } from "vitest";

import { resolveCompressionConfig } from "../src/internal/compression.js";

// Simulates a runtime whose node:zlib lacks zstd (Node 22.0-22.14, 23.0-23.7).
// Only the CJS build can reach this state at runtime — ESM consumers fail at
// import — so this pins the CJS construction-time behavior.
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, zstdCompressSync: undefined, zstdDecompressSync: undefined };
});

describe("compression on runtimes without node:zlib zstd", () => {
  it("fails fast at construction when compression is enabled", () => {
    for (const config of [undefined, {}, { thresholdBytes: 64 }] as const) {
      expect(() => resolveCompressionConfig(config)).toThrowError(
        "RedisConfig.compression requires zstd support in node:zlib (Node >= 22.15.0 or >= 23.8.0); set compression: false on older runtimes",
      );
    }
  });

  it("stays constructible with compression disabled", () => {
    expect(resolveCompressionConfig(false)).toBeNull();
  });
});

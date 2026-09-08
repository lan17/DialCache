import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DialCacheKey,
  DialCacheRedisPayloadEncodingError,
  normalizeArgs,
} from "../src/index.js";
import {
  decodeTrackedRedisReadResult,
  encodeRedisFrame,
  isRedisReadMiss,
} from "../src/redis-protocol.js";

interface KeyVector {
  readonly name: string;
  readonly input: {
    readonly namespace: string;
    readonly keyType: string;
    readonly id: string;
    readonly useCase: string;
    readonly trackForInvalidation: boolean;
    readonly args: ReadonlyArray<readonly [string, string]>;
  };
  readonly logicalKey: string;
  readonly valueKey: string;
  readonly watermarkKey: string | null;
}

interface NormalizeArgsVector {
  readonly name: string;
  readonly input: Readonly<Record<string, string | number | boolean | null>>;
  readonly undefinedSentinel?: string;
  readonly expected: ReadonlyArray<readonly [string, string]>;
}

interface FrameVector {
  readonly name: string;
  readonly createdAtMs: number;
  readonly payloadType: "string" | "binary";
  readonly payloadUtf8?: string;
  readonly payloadHex?: string;
  readonly frameHex: string;
}

interface DecodeVector {
  readonly name: string;
  readonly frameHex: string | null;
  readonly watermarkUtf8: string | null;
  readonly expected:
    | { readonly kind: "hit"; readonly createdAtMs: number; readonly payloadType: "string"; readonly payloadUtf8: string }
    | { readonly kind: "miss"; readonly reason: string; readonly observedWatermarkMs?: number }
    | { readonly kind: "payload_encoding_error" };
}

interface ProtocolVectors {
  readonly schemaVersion: number;
  readonly keyVectors: readonly KeyVector[];
  readonly normalizeArgsVectors: readonly NormalizeArgsVector[];
  readonly frameVectors: readonly FrameVector[];
  readonly trackedDecodeVectors: readonly DecodeVector[];
}

const vectors = JSON.parse(
  readFileSync(new URL("../formal/protocol-vectors.json", import.meta.url), "utf8"),
) as ProtocolVectors;

describe("formal protocol conformance vectors", () => {
  it("keeps the vector schema version explicit", () => {
    expect(vectors.schemaVersion).toBe(1);
  });

  for (const vector of vectors.keyVectors) {
    it(`constructs ${vector.name}`, () => {
      const key = new DialCacheKey(vector.input);
      expect(key.urn).toBe(vector.logicalKey);
      expect(`${key.urn}:dialcache-frame-v1`).toBe(vector.valueKey);
      expect(key.trackForInvalidation ? `${key.prefix}#watermark` : null).toBe(vector.watermarkKey);
    });
  }

  for (const vector of vectors.normalizeArgsVectors) {
    it(`normalizes args: ${vector.name}`, () => {
      const input = Object.fromEntries(
        Object.entries(vector.input).map(([name, value]) => [
          name,
          vector.undefinedSentinel !== undefined && value === vector.undefinedSentinel ? undefined : value,
        ]),
      );
      expect(normalizeArgs(input)).toEqual(vector.expected);
    });
  }

  for (const vector of vectors.frameVectors) {
    it(`encodes frame: ${vector.name}`, () => {
      const payload = vector.payloadType === "binary"
        ? Buffer.from(vector.payloadHex ?? "", "hex")
        : vector.payloadUtf8 ?? "";
      expect(encodeRedisFrame(payload, vector.createdAtMs).toString("hex")).toBe(vector.frameHex);
    });
  }

  for (const vector of vectors.trackedDecodeVectors) {
    it(`decodes tracked frame: ${vector.name}`, () => {
      const frame = vector.frameHex === null ? null : Buffer.from(vector.frameHex, "hex");
      const watermark = vector.watermarkUtf8 === null ? null : Buffer.from(vector.watermarkUtf8);

      if (vector.expected.kind === "payload_encoding_error") {
        expect(() => decodeTrackedRedisReadResult(frame, watermark)).toThrow(
          DialCacheRedisPayloadEncodingError,
        );
        return;
      }

      const result = decodeTrackedRedisReadResult(frame, watermark);
      if (vector.expected.kind === "miss") {
        expect(isRedisReadMiss(result)).toBe(true);
        expect(result).toEqual({
          kind: "miss",
          reason: vector.expected.reason,
          ...(vector.expected.observedWatermarkMs === undefined
            ? {}
            : { observedWatermarkMs: vector.expected.observedWatermarkMs }),
        });
        return;
      }

      expect(isRedisReadMiss(result)).toBe(false);
      expect(result).toEqual({
        createdAtMs: vector.expected.createdAtMs,
        payload: vector.expected.payloadUtf8,
      });
    });
  }
});
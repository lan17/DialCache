import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CacheLayer,
  DialCacheKey,
  DialCacheRedisPayloadEncodingError,
  normalizeArgs,
} from "../src/index.js";
import {
  decodeRedisReadResult,
  decodeTrackedRedisReadResult,
  encodeRedisFrame,
  isRedisReadMiss,
} from "../src/redis-protocol.js";

import { decompressPayload, escapeRawPayload } from "../src/internal/compression.js";
import { deterministicRampSample, deterministicShadowRampSample } from "../src/internal/ramp.js";

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
  readonly bigintArgs?: Readonly<Record<string, string>>;
  readonly specialArgs?: Readonly<Record<string, "-0" | "NaN" | "Infinity" | "-Infinity">>;
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
  readonly watermarkUtf8?: string | null;
  readonly expected:
    | { readonly kind: "hit"; readonly createdAtMs: number; readonly payloadType: "string" | "binary"; readonly payloadUtf8?: string; readonly payloadHex?: string }
    | { readonly kind: "miss"; readonly reason: string; readonly observedWatermarkMs?: number }
    | { readonly kind: "payload_encoding_error" };
}

interface ProtocolVectors {
  readonly schemaVersion: number;
  readonly keyVectors: readonly KeyVector[];
  readonly normalizeArgsVectors: readonly NormalizeArgsVector[];
  readonly frameVectors: readonly FrameVector[];
  readonly trackedDecodeVectors: readonly DecodeVector[];
  readonly untrackedDecodeVectors: readonly DecodeVector[];
  readonly invalidTimestampVectors: ReadonlyArray<{ name: string; input: number }>;
  readonly envelopeVectors: ReadonlyArray<{
    name: string; inputHex: string; escapedHex: string; decodedHex: string; outcome: string;
  }>;
  readonly compressedDecodeVectors: ReadonlyArray<{
    name: string; inputHex: string; payloadType: "string" | "binary"; payloadUtf8?: string; payloadHex?: string;
  }>;
  readonly rampVectors: ReadonlyArray<{
    name: string; input: KeyVector["input"]; layer: "local" | "remote" | "shadow"; sample: number;
  }>;
}

const vectors = JSON.parse(
  readFileSync(new URL("../formal/protocol-vectors.json", import.meta.url), "utf8"),
) as ProtocolVectors;

describe("formal protocol conformance vectors", () => {
  it("keeps the vector schema version explicit", () => {
    expect(vectors.schemaVersion).toBe(2);
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
      const input: Record<string, string | number | boolean | bigint | null | undefined> = Object.fromEntries(
        Object.entries(vector.input).map(([name, value]) => [
          name,
          vector.undefinedSentinel !== undefined && value === vector.undefinedSentinel ? undefined : value,
        ]),
      );
      for (const [name, text] of Object.entries(vector.bigintArgs ?? {})) input[name] = BigInt(text);
      for (const [name, text] of Object.entries(vector.specialArgs ?? {})) input[name] = Number(text);
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

  for (const [tracked, cases] of [[true, vectors.trackedDecodeVectors], [false, vectors.untrackedDecodeVectors]] as const) {
    for (const vector of cases) {
      it(`decodes ${tracked ? "tracked" : "untracked"} frame: ${vector.name}`, () => {
        const frame = vector.frameHex === null ? null : Buffer.from(vector.frameHex, "hex");
        const watermark = vector.watermarkUtf8 == null ? null : Buffer.from(vector.watermarkUtf8);
        const decode = () => tracked ? decodeTrackedRedisReadResult(frame, watermark) : decodeRedisReadResult(frame);
        if (vector.expected.kind === "payload_encoding_error") {
          expect(decode).toThrow(DialCacheRedisPayloadEncodingError);
          return;
        }
        const result = decode();
        if (vector.expected.kind === "miss") {
          expect(isRedisReadMiss(result)).toBe(true);
          expect(result).toEqual({
            kind: "miss", reason: vector.expected.reason,
            ...(vector.expected.observedWatermarkMs === undefined ? {} : { observedWatermarkMs: vector.expected.observedWatermarkMs }),
          });
        } else {
          expect(isRedisReadMiss(result)).toBe(false);
          expect(result).toEqual({
            createdAtMs: vector.expected.createdAtMs,
            payload: vector.expected.payloadType === "binary"
              ? Buffer.from(vector.expected.payloadHex!, "hex") : vector.expected.payloadUtf8,
          });
        }
      });
    }
  }

  for (const vector of vectors.invalidTimestampVectors) {
    it(`rejects timestamp: ${vector.name}`, () => {
      expect(() => encodeRedisFrame("value", vector.input)).toThrow(RangeError);
    });
  }

  for (const vector of vectors.envelopeVectors) {
    it(`handles payload envelope: ${vector.name}`, () => {
      const raw = Buffer.from(vector.inputHex, "hex");
      expect(escapeRawPayload(raw)).toEqual(Buffer.from(vector.escapedHex, "hex"));
      expect(decompressPayload(raw)).toEqual({ payload: Buffer.from(vector.decodedHex, "hex"), outcome: vector.outcome });
      expect(decompressPayload(Buffer.from(vector.escapedHex, "hex")).payload).toEqual(raw);
    });
  }

  for (const vector of vectors.compressedDecodeVectors) {
    it(`decodes compressed payload: ${vector.name}`, () => {
      expect(decompressPayload(Buffer.from(vector.inputHex, "hex"))).toEqual({
        outcome: "decompressed",
        payload: vector.payloadType === "binary" ? Buffer.from(vector.payloadHex!, "hex") : vector.payloadUtf8,
      });
    });
  }

  for (const vector of vectors.rampVectors) {
    it(`assigns deterministic cohort: ${vector.name}`, () => {
      const key = new DialCacheKey(vector.input);
      const sample = vector.layer === "shadow" ? deterministicShadowRampSample(key)
        : deterministicRampSample(key, vector.layer === "local" ? CacheLayer.LOCAL : CacheLayer.REMOTE);
      expect(sample).toBe(vector.sample);
    });
  }
});

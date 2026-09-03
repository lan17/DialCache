import type {
  DialCacheRedisClient,
  RedisInvalidationRequest,
  RedisReadResult,
  RedisReadRequest,
  RedisWriteRequest,
} from "../src/index.js";
import { MAX_TRACKED_REDIS_VALUE_TTL_MS } from "../src/internal/duration.js";
import { MIN_WATERMARK_TTL_MS } from "../src/internal/redis-scripts.js";
import {
  ceilSupportedCacheTtlMs,
  decodeRedisReadResult,
  decodeTrackedRedisReadResult,
  encodeRedisFrame,
} from "../src/redis-protocol.js";

const FRAME_VERSION = 1;
const ENCODING_OFFSET = 9;
const PAYLOAD_OFFSET = 10;
const WATERMARK_TTL_MARGIN_MS = 60_000;

interface StoredValue {
  value: Buffer;
  expiresAtMs: number;
}

export class FakeRedis implements DialCacheRedisClient {
  readonly values = new Map<string, StoredValue>();
  getCalls = 0;
  mGetCalls = 0;
  setCalls = 0;
  failGet = false;
  failSet = false;
  failWatermarkGet = false;
  getGate: Promise<void> | null = null;

  async read({ valueKey, watermarkKey }: RedisReadRequest): Promise<RedisReadResult> {
    if (watermarkKey === undefined) {
      this.getCalls += 1;
    } else {
      this.mGetCalls += 1;
    }
    await this.waitForRead();
    this.throwIfReadFails(watermarkKey !== undefined);
    return this.readPayload(valueKey, watermarkKey ?? null);
  }

  async write({
    valueKey,
    cacheTtlMs,
    value,
    createdAtMs,
  }: RedisWriteRequest): Promise<void> {
    const validatedTtlMs = ceilSupportedCacheTtlMs(cacheTtlMs);
    const storedAtMs = Date.now();
    const frame = encodeRedisFrame(value, createdAtMs === undefined ? storedAtMs : createdAtMs);
    this.setCalls += 1;
    this.throwIfWriteFails();
    this.values.set(valueKey, {
      value: frame,
      expiresAtMs: storedAtMs + validatedTtlMs,
    });
  }

  async invalidate({ watermarkKey, futureBufferMs }: RedisInvalidationRequest): Promise<void> {
    const invalidatedAtMs = Date.now();
    this.setCalls += 1;
    this.throwIfWriteFails();
    let current = 0;
    try {
      current = this.readWatermark(watermarkKey) ?? 0;
    } catch {
      current = 0;
    }
    const watermark = Math.max(current, invalidatedAtMs + futureBufferMs);
    const currentTtlMs = this.remainingTtlMs(watermarkKey);
    const desiredTtlMs = Math.max(
      currentTtlMs,
      MIN_WATERMARK_TTL_MS,
      watermark - invalidatedAtMs + MAX_TRACKED_REDIS_VALUE_TTL_MS + WATERMARK_TTL_MARGIN_MS,
    );
    this.storeWatermark(watermarkKey, watermark, desiredTtlMs);
  }

  raw(key: string): Buffer {
    const value = this.readRaw(key);
    if (value === null) {
      throw new Error(`missing value for ${key}`);
    }
    return value;
  }

  setRaw(key: string, value: string | Buffer, ttlMs = 60_000): void {
    this.values.set(key, {
      value: Buffer.isBuffer(value) ? value : Buffer.from(value),
      expiresAtMs: Date.now() + ttlMs,
    });
  }

  ttlMs(key: string): number {
    return this.remainingTtlMs(key);
  }

  readWatermarkValue(key: string): number | null {
    return this.readWatermark(key);
  }

  private async waitForRead(): Promise<void> {
    if (this.getGate !== null) {
      await this.getGate;
    }
  }

  private throwIfReadFails(watermark: boolean): void {
    if (this.failGet || (watermark && this.failWatermarkGet)) {
      throw new Error(watermark ? "watermark read failed" : "redis get failed");
    }
  }

  private throwIfWriteFails(): void {
    if (this.failSet) {
      throw new Error("redis set failed");
    }
  }

  private readPayload(valueKey: string, watermarkKey: string | null): RedisReadResult {
    const stored = this.readRaw(valueKey);
    // Real clients transfer a reply buffer; do not let a test caller mutate the
    // fake's retained frame through the decoder's zero-copy binary payload.
    const raw = stored === null ? null : Buffer.from(stored);
    return watermarkKey === null
      ? decodeRedisReadResult(raw)
      : decodeTrackedRedisReadResult(raw, this.readRaw(watermarkKey));
  }

  private storeWatermark(key: string, watermark: number, ttlMs: number): void {
    this.values.set(key, { value: Buffer.from(String(Math.ceil(watermark))), expiresAtMs: Date.now() + ttlMs });
  }

  private readWatermark(key: string): number | null {
    const raw = this.readRaw(key);
    if (raw === null) {
      return null;
    }
    const text = raw.toString("utf8");
    if (!/^\d+$/.test(text)) {
      throw new Error("Invalid DialCache watermark");
    }
    const watermark = Number(text);
    if (watermark > Number.MAX_SAFE_INTEGER) {
      throw new Error("Invalid DialCache watermark");
    }
    return watermark;
  }

  private readRaw(key: string): Buffer | null {
    const entry = this.values.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  private remainingTtlMs(key: string): number {
    const entry = this.values.get(key);
    if (entry === undefined) {
      return -2;
    }
    return Math.max(entry.expiresAtMs - Date.now(), 0);
  }
}

export function encodeFrame(value: unknown, createdAtMs = Date.now(), encoding = 0): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(createdAtMs));
  const payload = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return Buffer.concat([Buffer.from([FRAME_VERSION]), timestamp, Buffer.from([encoding]), payload]);
}

export function decodeFrame(
  raw: Buffer,
): { readonly createdAtMs: number; readonly encoding: number; readonly payload: string | Buffer } {
  if (raw.length < PAYLOAD_OFFSET || raw[0] !== FRAME_VERSION) {
    throw new Error("Invalid DialCache frame");
  }
  const encoding = raw[ENCODING_OFFSET] ?? -1;
  const payload = raw.subarray(PAYLOAD_OFFSET);
  return {
    createdAtMs: Number(readTimestamp(raw)),
    encoding,
    payload: encoding === 0 ? payload.toString("utf8") : payload,
  };
}

function readTimestamp(raw: Buffer): bigint {
  return raw.subarray(1, 9).readBigUInt64BE();
}

import { describe, expect, it, vi } from "vitest";

import type {
  DialCacheInvalidationCoordinatorListener,
  DialCacheInvalidationEventV1,
} from "../src/invalidation.js";
import { InvalidationCoordinator } from "../src/internal/invalidation-coordinator.js";
import {
  MAX_REDIS_INVALIDATION_EVENT_BYTES,
  REDIS_INVALIDATION_EVENT_VERSION,
  decodeRedisInvalidationEvent,
  isValidLocalInvalidation,
  localInvalidationFromEvent,
  redisInvalidationChannel,
  validateRedisInvalidationEvent,
} from "../src/internal/invalidation-event.js";
import { MAX_SUPPORTED_DURATION_MS } from "../src/internal/duration.js";
import { DialCacheRedisProtocolError } from "../src/redis-client.js";

const validEvent: DialCacheInvalidationEventV1 = {
  version: 1,
  namespace: "users:production",
  keyType: "user_id",
  id: "123",
  effectiveWatermarkMs: "1785300010000",
  redisNowMs: "1785300000000",
};

describe("Redis invalidation event protocol", () => {
  it("decodes the versioned event from strings and bytes", () => {
    const payload = JSON.stringify(validEvent);

    expect(decodeRedisInvalidationEvent(payload)).toEqual(validEvent);
    expect(decodeRedisInvalidationEvent(Buffer.from(payload), {
      namespace: validEvent.namespace,
      keyType: validEvent.keyType,
      id: validEvent.id,
    })).toEqual(validEvent);
    expect(localInvalidationFromEvent(validEvent)).toEqual({
      namespace: "users:production",
      keyType: "user_id",
      id: "123",
      remainingMs: 10_000,
      source: "event",
    });
  });

  it("builds one deterministic namespace channel and validates namespace braces", () => {
    expect(REDIS_INVALIDATION_EVENT_VERSION).toBe(1);
    expect(redisInvalidationChannel("users:production")).toBe(
      "dialcache:invalidation:v1:users%3Aproduction",
    );
    expect(redisInvalidationChannel("tenant*prod!(v1)")).toBe(
      "dialcache:invalidation:v1:tenant%2Aprod%21%28v1%29",
    );
    expect(() => redisInvalidationChannel("bad{namespace")).toThrow(TypeError);
  });

  it.each([
    null,
    [],
    "event",
    1,
    true,
  ])("rejects non-object event value %j", (value) => {
    expect(() => validateRedisInvalidationEvent(value)).toThrow(
      DialCacheRedisProtocolError,
    );
  });

  it("rejects missing and extra fields", () => {
    const { id: _id, ...missing } = validEvent;

    expect(() => validateRedisInvalidationEvent(missing)).toThrow(/unexpected fields/);
    expect(() => validateRedisInvalidationEvent({ ...validEvent, extra: true })).toThrow(
      /unexpected fields/,
    );
  });

  it.each([
    { ...validEvent, version: 2 },
    { ...validEvent, version: "1" },
    { ...validEvent, namespace: 1 },
    { ...validEvent, keyType: null },
    { ...validEvent, id: {} },
    { ...validEvent, namespace: "bad}namespace" },
    { ...validEvent, keyType: "bad{type" },
    { ...validEvent, id: "bad}id" },
  ])("rejects invalid versions and identities", (event) => {
    expect(() => validateRedisInvalidationEvent(event)).toThrow(
      DialCacheRedisProtocolError,
    );
  });

  it.each([
    { ...validEvent, effectiveWatermarkMs: 1 },
    { ...validEvent, effectiveWatermarkMs: "01" },
    { ...validEvent, effectiveWatermarkMs: "1.5" },
    { ...validEvent, effectiveWatermarkMs: "-1" },
    { ...validEvent, effectiveWatermarkMs: String(Number.MAX_SAFE_INTEGER + 1) },
    { ...validEvent, effectiveWatermarkMs: "100", redisNowMs: "101" },
    {
      ...validEvent,
      effectiveWatermarkMs: String(1_000 + MAX_SUPPORTED_DURATION_MS + 1),
      redisNowMs: "1000",
    },
  ])("rejects invalid timing values", (event) => {
    expect(() => validateRedisInvalidationEvent(event)).toThrow(/event timing/);
  });

  it("rejects a mismatched expected identity", () => {
    expect(() => decodeRedisInvalidationEvent(JSON.stringify(validEvent), {
      namespace: "other",
    })).toThrow(/event identity/);
    expect(() => decodeRedisInvalidationEvent(JSON.stringify(validEvent), {
      keyType: "other",
    })).toThrow(/event identity/);
    expect(() => decodeRedisInvalidationEvent(JSON.stringify(validEvent), {
      id: "other",
    })).toThrow(/event identity/);
  });

  it("rejects malformed JSON, invalid UTF-8, and oversized payloads", () => {
    expect(() => decodeRedisInvalidationEvent("{")).toThrow(/valid JSON/);
    expect(() => decodeRedisInvalidationEvent(Buffer.from([0xff]))).toThrow(/valid UTF-8/);
    expect(() => decodeRedisInvalidationEvent("x".repeat(MAX_REDIS_INVALIDATION_EVENT_BYTES + 1)))
      .toThrow(/too large/);
    expect(() => decodeRedisInvalidationEvent(
      Buffer.alloc(MAX_REDIS_INVALIDATION_EVENT_BYTES + 1),
    )).toThrow(/too large/);
  });

  it("validates backend-neutral local signals without trusting their runtime shape", () => {
    const invalidation = {
      namespace: "urn",
      keyType: "user_id",
      id: "123",
      remainingMs: 1_000,
      source: "event",
    };

    expect(isValidLocalInvalidation(invalidation, "urn")).toBe(true);
    expect(isValidLocalInvalidation(null, "urn")).toBe(false);
    expect(isValidLocalInvalidation([], "urn")).toBe(false);
    expect(isValidLocalInvalidation({}, "urn")).toBe(false);
    expect(isValidLocalInvalidation({ ...invalidation, namespace: "other" }, "urn")).toBe(false);
    expect(isValidLocalInvalidation({ ...invalidation, id: 123 }, "urn")).toBe(false);
    expect(isValidLocalInvalidation({ ...invalidation, id: "bad{id" }, "urn")).toBe(false);
    expect(isValidLocalInvalidation({ ...invalidation, remainingMs: Number.NaN }, "urn")).toBe(
      false,
    );
    expect(isValidLocalInvalidation({ ...invalidation, source: "unknown" }, "urn")).toBe(false);
  });
});

describe("backend-neutral invalidation coordinator", () => {
  it("delivers current health, synchronous fan-out, transitions, and removal", () => {
    const coordinator = new InvalidationCoordinator("urn");
    const first = listener();
    const second = listener();

    const removeFirst = coordinator.addListener(first.value);
    coordinator.addListener(second.value);
    expect(first.states).toEqual([["unavailable", undefined]]);
    expect(second.states).toEqual([["unavailable", undefined]]);

    coordinator.ready();
    const invalidation = {
      namespace: "urn",
      keyType: "user_id",
      id: "123",
      remainingMs: 50,
      source: "event" as const,
    };
    expect(coordinator.invalidate(invalidation)).toBe(true);
    expect(first.invalidations).toEqual([invalidation]);
    expect(second.invalidations).toEqual([invalidation]);

    removeFirst();
    removeFirst();
    expect(coordinator.invalidate({ ...invalidation, id: "456" })).toBe(true);
    expect(first.invalidations).toHaveLength(1);
    expect(second.invalidations).toHaveLength(2);

    const error = new Error("subscriber unavailable");
    coordinator.unavailable(error);
    coordinator.unavailable(new Error("duplicate state"));
    coordinator.ready();
    coordinator.dispose();
    coordinator.dispose();
    expect(second.states).toEqual([
      ["unavailable", undefined],
      ["ready", undefined],
      ["unavailable", error],
      ["ready", undefined],
      ["disposed", undefined],
    ]);
  });

  it("isolates listener exceptions from sibling listeners", () => {
    const coordinator = new InvalidationCoordinator("urn");
    const sibling = listener();
    coordinator.addListener({
      onInvalidation: () => {
        throw new Error("listener failed");
      },
      onStateChange: () => {
        throw new Error("listener failed");
      },
    });
    coordinator.addListener(sibling.value);

    expect(() => coordinator.ready()).not.toThrow();
    expect(() => coordinator.invalidate({
      namespace: "urn",
      keyType: "user_id",
      id: "123",
      remainingMs: 0,
      source: "provisional",
    })).not.toThrow();
    expect(sibling.invalidations).toHaveLength(1);
  });

  it("does not deliver stale fan-out after a listener reentrantly disposes", () => {
    const transitionCoordinator = new InvalidationCoordinator("urn");
    let disposeOnReady = false;
    transitionCoordinator.addListener({
      onInvalidation: () => undefined,
      onStateChange: (state) => {
        if (disposeOnReady && state === "ready") {
          transitionCoordinator.dispose();
        }
      },
    });
    const transitionSibling = listener();
    transitionCoordinator.addListener(transitionSibling.value);

    disposeOnReady = true;
    transitionCoordinator.ready();

    expect(transitionCoordinator.state).toBe("disposed");
    expect(transitionSibling.states).toEqual([
      ["unavailable", undefined],
      ["disposed", undefined],
    ]);

    const invalidationCoordinator = new InvalidationCoordinator("urn");
    invalidationCoordinator.ready();
    invalidationCoordinator.addListener({
      onInvalidation: () => invalidationCoordinator.dispose(),
      onStateChange: () => undefined,
    });
    const invalidationSibling = listener();
    invalidationCoordinator.addListener(invalidationSibling.value);

    expect(invalidationCoordinator.invalidate({
      namespace: "urn",
      keyType: "user_id",
      id: "123",
      remainingMs: 0,
      source: "event",
    })).toBe(true);

    expect(invalidationCoordinator.state).toBe("disposed");
    expect(invalidationSibling.states).toEqual([
      ["ready", undefined],
      ["disposed", undefined],
    ]);
    expect(invalidationSibling.invalidations).toEqual([]);
  });

  it("decodes subscriber bytes once and moves unavailable on protocol failure", () => {
    const coordinator = new InvalidationCoordinator(validEvent.namespace);
    const recording = listener();
    coordinator.addListener(recording.value);
    coordinator.ready();

    coordinator.receive(JSON.stringify(validEvent));
    expect(recording.invalidations).toEqual([localInvalidationFromEvent(validEvent)]);

    const protocolError = vi.fn();
    coordinator.addListener({
      onInvalidation: () => undefined,
      onStateChange: (state, error) => {
        if (state === "unavailable") {
          protocolError(error);
        }
      },
    });
    expect(() => coordinator.receive(Buffer.from([0xff]))).not.toThrow();
    expect(coordinator.state).toBe("unavailable");
    expect(protocolError).toHaveBeenCalledWith(expect.any(DialCacheRedisProtocolError));
  });

  it("rejects wrong channels and invalid local signals conservatively", () => {
    const coordinator = new InvalidationCoordinator(validEvent.namespace);
    coordinator.ready();

    coordinator.receive(JSON.stringify(validEvent), "wrong-channel");
    expect(coordinator.state).toBe("unavailable");

    coordinator.ready();
    coordinator.invalidate({
      namespace: validEvent.namespace,
      keyType: validEvent.keyType,
      id: validEvent.id,
      remainingMs: MAX_SUPPORTED_DURATION_MS + 1,
      source: "event",
    });
    expect(coordinator.state).toBe("unavailable");

    coordinator.ready();
    coordinator.invalidate({
      namespace: "wrong",
      keyType: validEvent.keyType,
      id: validEvent.id,
      remainingMs: 0,
      source: "event",
    });
    expect(coordinator.state).toBe("unavailable");
  });

  it("ignores messages and registrations safely after disposal", () => {
    const coordinator = new InvalidationCoordinator(validEvent.namespace);
    coordinator.dispose();
    const recording = listener();

    const remove = coordinator.addListener(recording.value);
    expect(coordinator.receive(JSON.stringify(validEvent))).toBe(false);
    expect(coordinator.invalidate(localInvalidationFromEvent(validEvent))).toBe(false);
    coordinator.ready();
    coordinator.unavailable(new Error("late health callback"));
    remove();

    expect(coordinator.state).toBe("disposed");
    expect(recording.states).toEqual([["disposed", undefined]]);
    expect(recording.invalidations).toEqual([]);
  });
});

function listener(): {
  readonly value: DialCacheInvalidationCoordinatorListener;
  readonly states: Array<readonly [string, unknown]>;
  readonly invalidations: unknown[];
} {
  const states: Array<readonly [string, unknown]> = [];
  const invalidations: unknown[] = [];
  return {
    states,
    invalidations,
    value: {
      onInvalidation: (invalidation) => invalidations.push(invalidation),
      onStateChange: (state, error) => states.push([state, error]),
    },
  };
}

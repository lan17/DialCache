import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CacheLayer, DialCache, DialCacheKeyConfig } from "../src/index.js";
import { FakeRedis } from "./fake-redis.js";

type ActionName =
  | "init"
  | "bumpSource"
  | "outsideCall"
  | "requestLocalPair"
  | "localCall"
  | "coalescedLocalPair"
  | "remoteCall"
  | "invalidateRemote"
  | "remoteReadFailureCall";

interface Snapshot {
  sourceVersion: number;
  lastResult: number;
  outsideLoaderCalls: number;
  requestLoaderCalls: number;
  localLoaderCalls: number;
  coalescedLoaderCalls: number;
  remoteLoaderCalls: number;
  localCached: boolean;
  localValue: number;
  coalescedCached: boolean;
  coalescedValue: number;
  remoteReadable: boolean;
  remoteValue: number;
  redisReads: number;
  redisWrites: number;
}

interface TraceState {
  action: ActionName;
  state: Snapshot;
}

const localOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
    ramp: { [CacheLayer.LOCAL]: 100 },
  });

const remoteOnly = () =>
  new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 },
    ramp: { [CacheLayer.REMOTE]: 100 },
  });

const requestOnly = () => new DialCacheKeyConfig({ requestLocal: true });

class ConformanceDriver {
  readonly redis = new FakeRedis();
  readonly dialcache = new DialCache({ redis: { client: this.redis } });

  sourceVersion = 1;
  lastResult = 0;
  outsideLoaderCalls = 0;
  requestLoaderCalls = 0;
  localLoaderCalls = 0;
  coalescedLoaderCalls = 0;
  remoteLoaderCalls = 0;
  localCached = false;
  localValue = 0;
  coalescedCached = false;
  coalescedValue = 0;
  remoteReadable = false;
  remoteValue = 0;

  private wallClockMs = Date.parse("2026-09-08T12:00:00.000Z");

  async apply(action: ActionName): Promise<void> {
    if (action === "init") return;

    // Give sequential protocol actions distinct wall-clock timestamps. This is
    // an environment scheduling choice, not a DialCache semantic guarantee.
    this.wallClockMs += 1;
    vi.setSystemTime(this.wallClockMs);

    switch (action) {
      case "bumpSource":
        this.sourceVersion += 1;
        return;
      case "outsideCall":
        this.lastResult = await this.dialcache.getOrLoad(
          async () => {
            this.outsideLoaderCalls += 1;
            return this.sourceVersion;
          },
          {
            keyType: "user_id",
            useCase: "ConformanceOutside",
            key: "123",
            defaultConfig: localOnly(),
          },
        );
        return;
      case "requestLocalPair": {
        const options = {
          keyType: "user_id",
          useCase: "ConformanceRequest",
          key: "123",
          defaultConfig: requestOnly(),
        } as const;
        const values = await this.dialcache.enable(async () => {
          const first = await this.dialcache.getOrLoad(async () => {
            this.requestLoaderCalls += 1;
            return this.sourceVersion;
          }, options);
          const second = await this.dialcache.getOrLoad(async () => {
            this.requestLoaderCalls += 1;
            return this.sourceVersion;
          }, options);
          return [first, second] as const;
        });
        expect(values[1]).toBe(values[0]);
        this.lastResult = values[1];
        return;
      }
      case "localCall":
        this.lastResult = await this.dialcache.enable(async () =>
          await this.dialcache.getOrLoad(async () => {
            this.localLoaderCalls += 1;
            this.localCached = true;
            this.localValue = this.sourceVersion;
            return this.sourceVersion;
          }, {
            keyType: "user_id",
            useCase: "ConformanceLocal",
            key: "123",
            defaultConfig: localOnly(),
          }),
        );
        return;
      case "coalescedLocalPair": {
        const gate = deferred<void>();
        const options = {
          keyType: "user_id",
          useCase: "ConformanceCoalesced",
          key: "123",
          defaultConfig: localOnly(),
        } as const;
        const values = await this.dialcache.enable(async () => {
          const leader = this.dialcache.getOrLoad(async () => {
            this.coalescedLoaderCalls += 1;
            this.coalescedCached = true;
            this.coalescedValue = this.sourceVersion;
            await gate.promise;
            return this.sourceVersion;
          }, options);
          const follower = this.dialcache.getOrLoad(async () => {
            this.coalescedLoaderCalls += 1;
            return this.sourceVersion;
          }, options);
          await Promise.resolve();
          gate.resolve();
          return await Promise.all([leader, follower]);
        });
        expect(values[1]).toBe(values[0]);
        this.lastResult = values[1];
        return;
      }
      case "remoteCall":
        this.lastResult = await this.remoteCall(false);
        return;
      case "invalidateRemote":
        await this.dialcache.invalidateRemote("user_id", "123");
        this.remoteReadable = false;
        return;
      case "remoteReadFailureCall":
        this.redis.failGet = true;
        try {
          this.lastResult = await this.remoteCall(true);
        } finally {
          this.redis.failGet = false;
        }
        return;
    }
  }

  snapshot(): Snapshot {
    return {
      sourceVersion: this.sourceVersion,
      lastResult: this.lastResult,
      outsideLoaderCalls: this.outsideLoaderCalls,
      requestLoaderCalls: this.requestLoaderCalls,
      localLoaderCalls: this.localLoaderCalls,
      coalescedLoaderCalls: this.coalescedLoaderCalls,
      remoteLoaderCalls: this.remoteLoaderCalls,
      localCached: this.localCached,
      localValue: this.localValue,
      coalescedCached: this.coalescedCached,
      coalescedValue: this.coalescedValue,
      remoteReadable: this.remoteReadable,
      remoteValue: this.remoteValue,
      redisReads: this.redis.mGetCalls,
      redisWrites: this.redis.setCalls,
    };
  }

  private async remoteCall(expectReadFailure: boolean): Promise<number> {
    const beforeWrites = this.redis.setCalls;
    const beforeLoaders = this.remoteLoaderCalls;
    const result = await this.dialcache.enable(async () =>
      await this.dialcache.getOrLoad(async () => {
        this.remoteLoaderCalls += 1;
        return this.sourceVersion;
      }, {
        keyType: "user_id",
        useCase: "ConformanceRemote",
        key: "123",
        trackForInvalidation: true,
        defaultConfig: remoteOnly(),
      }),
    );

    if (expectReadFailure) {
      expect(this.redis.setCalls).toBe(beforeWrites);
      return result;
    }

    if (this.redis.setCalls > beforeWrites) {
      this.remoteReadable = true;
      this.remoteValue = result;
    } else if (this.remoteLoaderCalls === beforeLoaders) {
      // A source-free tracked read was an accepted remote hit.
      this.remoteReadable = true;
    }
    return result;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function decodeItf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeItf);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record["#bigint"] === "string") return Number(record["#bigint"]);
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, decodeItf(child)]));
}

function readItfTrace(path: string): TraceState[] {
  const parsed = decodeItf(JSON.parse(readFileSync(path, "utf8"))) as {
    states?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(parsed.states)) throw new Error(`Invalid ITF trace: ${path}`);
  return parsed.states.map((state, index) => {
    const action = state["mbt::actionTaken"];
    const modelState = state.s;
    if (typeof action !== "string") {
      if (index === 0) return { action: "init", state: modelState as Snapshot };
      throw new Error(`Missing mbt::actionTaken in ${path} state ${index}`);
    }
    if (modelState === null || typeof modelState !== "object") {
      throw new Error(`Missing model state in ${path} state ${index}`);
    }
    return { action: (action === "" ? "init" : action) as ActionName, state: modelState as Snapshot };
  });
}

function loadTraces(): TraceState[][] {
  const generatedDir = process.env.DIALCACHE_MBT_TRACE_DIR;
  if (generatedDir !== undefined) {
    const root = resolve(generatedDir);
    return readdirSync(root)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => readItfTrace(resolve(root, name)));
  }
  const smoke = JSON.parse(readFileSync(resolve("formal/conformance-smoke.json"), "utf8")) as {
    states: TraceState[];
  };
  return [smoke.states];
}

describe("Quint model-based conformance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const [traceIndex, trace] of loadTraces().entries()) {
    it(`replays trace ${traceIndex}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
      const driver = new ConformanceDriver();

      for (const [stepIndex, step] of trace.entries()) {
        await driver.apply(step.action);
        expect(
          driver.snapshot(),
          `trace ${traceIndex} step ${stepIndex} action ${step.action}`,
        ).toEqual(step.state);
      }
    });
  }
});

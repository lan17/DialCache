import { AsyncLocalStorage } from "node:async_hooks";

import { vi } from "vitest";

import {
  DialCache, DialCacheKey, DialCacheKeyConfig, FallbackTimeoutError,
  type DialCacheConfig, type RedisReadRequest, type RedisReadResult,
  type RedisWriteRequest, type RedisInvalidationRequest, type Serializer,
} from "../../src/index.js";
import { encodeFrame, FakeRedis } from "../fake-redis.js";

export type Policy = ConstructorParameters<typeof DialCacheKeyConfig>[0];
export interface Fixture {
  policy: Policy;
  tracked?: boolean;
  fallbackTimeoutMs?: number | null;
  readTimeoutMs?: number;
  localMaxSize?: number;
  shadowMaxInFlight?: number;
  recovery?: "allow" | "deny" | "default";
}
export interface Faults {
  read: boolean; write: boolean; dump: boolean; load: boolean; policy: boolean;
  holdReads: boolean; holdWrites: boolean; holdDumps: boolean; holdLoads: boolean; holdPolicies: boolean;
}
export type Input =
  | { op: "begin"; key?: string; scope?: string; outside?: boolean; disabled?: boolean }
  | { op: "resolve"; loader: number; value?: number }
  | { op: "reject"; loader: number }
  | { op: "advance"; ms: number; deliverTimers?: boolean }
  | { op: "seed"; key?: string; value?: number; ageMs?: number; frameHex?: string; ttlMs?: number }
  | { op: "invalidate"; key?: string; futureBufferMs?: number }
  | { op: "policy"; value: Policy }
  | { op: "faults"; value: Partial<Faults> }
  | { op: "release"; effect: "read" | "write" | "dump" | "load" | "policy"; index: number }
  | { op: "openScope"; id: string; parent?: string; disabled?: boolean }
  | { op: "closeScope"; id: string };

export type CallResult = { status: "pending" } | { status: "value"; value: number | "undefined" }
  | { status: "error"; error: string };
export interface Observation {
  calls: CallResult[];
  loaders: number;
  reads: number;
  writes: number;
  invalidations: number;
  maintenance: string[];
  loads: number;
  dumps: number;
  policyCalls: number;
  writeTtls: number[];
  shadow: string[];
  recovery: string[];
}
export function emptyObservation(): Observation {
  return { calls: [], loaders: 0, reads: 0, writes: 0, invalidations: 0, maintenance: [],
    loads: 0, dumps: 0, policyCalls: 0, writeTtls: [], shadow: [], recovery: [] };
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return {
    promise, get settled() { return settled; },
    resolve(value: T) { if (settled) throw new Error("Effect already settled"); settled = true; resolvePromise(value); },
    reject(error: unknown) { if (settled) throw new Error("Effect already settled"); settled = true; rejectPromise(error); },
  };
}
type Gate = ReturnType<typeof deferred<void>>;
type Scope = { run: <T>(fn: () => T) => T; gate: Gate; lifetime: Promise<void> };

// Only external effects are gated. We never access DialCache's maps, flights,
// or resolved policy, and no expected observation is passed to this class.
export class BehaviorDriver {
  private readonly observed = emptyObservation();
  private readonly loaders: Array<ReturnType<typeof deferred<number | undefined>>> = [];
  private readonly sourceErrors: Error[] = [];
  private readonly timeoutErrors: unknown[] = [];
  private readonly scopes = new Map<string, Scope>();
  private readonly effects = { read: new Map<number, Gate>(), write: new Map<number, Gate>(),
    dump: new Map<number, Gate>(), load: new Map<number, Gate>(), policy: new Map<number, Gate>() };
  private readonly faults: Faults = { read: false, write: false, dump: false, load: false, policy: false,
    holdReads: false, holdWrites: false, holdDumps: false, holdLoads: false, holdPolicies: false };
  private runtimePolicy: Policy = {};
  private readonly maintenanceError = new Error("Controlled mutation failure");
  readonly redis: FakeRedis;
  readonly cache: DialCache;

  constructor(private readonly fixture: Fixture, overrides: DialCacheConfig = {}) {
    const owner = this;
    this.redis = new class extends FakeRedis {
      override async read(request: RedisReadRequest): Promise<RedisReadResult> {
        const index = owner.observed.reads++;
        if (owner.faults.holdReads) await owner.hold("read", index);
        if (owner.faults.read) throw new Error("Controlled read failure");
        return super.read(request);
      }
      override async write(request: RedisWriteRequest): Promise<void> {
        const index = owner.observed.writes++;
        owner.observed.writeTtls.push(request.cacheTtlMs);
        // A native adapter stamps the complete frame before its SET is delayed.
        const stamped = { ...request, createdAtMs: request.createdAtMs ?? Date.now() };
        if (owner.faults.holdWrites) await owner.hold("write", index);
        if (owner.faults.write) throw owner.maintenanceError;
        await super.write(stamped);
      }
      override async invalidate(request: RedisInvalidationRequest): Promise<void> {
        owner.observed.invalidations++;
        if (owner.faults.write) throw owner.maintenanceError;
        await super.invalidate(request);
      }
    }();
    const noop = () => undefined;
    this.cache = new DialCache({
      redis: { client: this.redis, readTimeoutMs: fixture.readTimeoutMs ?? 50, compression: false },
      ...(fixture.localMaxSize === undefined ? {} : { localMaxSize: fixture.localMaxSize }),
      ...(fixture.shadowMaxInFlight === undefined ? {} : { shadowMaxInFlight: fixture.shadowMaxInFlight }),
      ...(fixture.recovery === undefined || fixture.recovery === "default" ? {}
        : { shouldAttemptStaleRecovery: () => fixture.recovery === "allow" }),
      cacheConfigProvider: async () => {
        const index = this.observed.policyCalls++;
        if (this.faults.holdPolicies) await this.hold("policy", index);
        if (this.faults.policy) throw new Error("Controlled policy failure");
        return new DialCacheKeyConfig(this.runtimePolicy);
      },
      metrics: { request: noop, miss: noop, disabled: noop, error: noop, invalidation: noop,
        observeGet: noop, observeFallback: noop, observeSerialization: noop, observeSize: noop,
        shadowValidation: ({ outcome }) => { this.observed.shadow.push(outcome); },
        staleRecovery: ({ outcome }) => { this.observed.recovery.push(outcome); } },
      ...overrides,
    });
  }

  private readonly serializer: Serializer<number | undefined> = {
    dump: async (value) => {
      const index = this.observed.dumps++;
      if (this.faults.holdDumps) await this.hold("dump", index);
      if (this.faults.dump) throw new Error("Controlled serialization failure");
      return value === undefined ? "undefined" : JSON.stringify(value);
    },
    load: async (raw) => {
      const index = this.observed.loads++;
      if (this.faults.holdLoads) await this.hold("load", index);
      if (this.faults.load) throw new Error("Controlled deserialization failure");
      const text = raw.toString();
      return text === "undefined" ? undefined : JSON.parse(text) as number;
    },
  };

  async apply(input: Input): Promise<void> {
    switch (input.op) {
      case "begin": {
        const index = this.observed.calls.length;
        this.observed.calls.push({ status: "pending" });
        const call = () => this.cache.getOrLoad(() => {
          const gate = deferred<number | undefined>();
          this.loaders.push(gate);
          this.sourceErrors.push(new Error(`Source failure ${this.sourceErrors.length}`));
          this.observed.loaders++;
          return gate.promise;
        }, { keyType: "id", key: input.key ?? "1", useCase: "Behavior", serializer: this.serializer,
          trackForInvalidation: this.fixture.tracked ?? false,
          defaultConfig: new DialCacheKeyConfig(this.fixture.policy),
          fallbackTimeoutMs: this.fixture.fallbackTimeoutMs === undefined ? 10 : this.fixture.fallbackTimeoutMs });
        const execute = () => input.disabled ? this.cache.disable(call) : call();
        const result = input.scope !== undefined ? this.scope(input.scope).run(execute)
          : input.outside ? execute() : this.cache.enable(execute);
        void result.then(
          (value) => { this.observed.calls[index] = { status: "value", value: value === undefined ? "undefined" : value }; },
          (error: unknown) => { this.observed.calls[index] = { status: "error", error: this.classifyError(error) }; },
        );
        break;
      }
      case "resolve": this.loader(input.loader).resolve(input.value); break;
      case "reject": this.loader(input.loader).reject(this.sourceErrors[input.loader]); break;
      case "advance":
        if (input.deliverTimers === false) vi.setSystemTime(Date.now() + input.ms);
        else await vi.advanceTimersByTimeAsync(input.ms);
        break;
      case "seed":
        this.redis.setRaw(this.valueKey(input.key), input.frameHex === undefined
          ? encodeFrame(input.value === undefined ? "undefined" : JSON.stringify(input.value), Date.now() - (input.ageMs ?? 0))
          : Buffer.from(input.frameHex, "hex"), input.ttlMs ?? 60_000);
        break;
      case "invalidate":
        try {
          await this.cache.invalidateRemote("id", input.key ?? "1", input.futureBufferMs ?? 0);
          this.observed.maintenance.push("ok");
        } catch (error) {
          if (error !== this.maintenanceError) throw error;
          this.observed.maintenance.push("mutation_error");
        }
        break;
      case "policy": this.runtimePolicy = input.value; break;
      case "faults": Object.assign(this.faults, input.value); break;
      case "release": {
        const gate = this.effects[input.effect].get(input.index);
        if (gate === undefined) throw new Error(`No pending ${input.effect} ${input.index}`);
        gate.resolve();
        this.effects[input.effect].delete(input.index);
        break;
      }
      case "openScope": {
        if (this.scopes.has(input.id)) throw new Error(`Duplicate scope ${input.id}`);
        const gate = deferred<void>();
        let run!: Scope["run"];
        const body = async () => {
          // Capture the driver's execution context inside the public scope.
          // Other runtimes can retain their explicit request-context token.
          const captured = AsyncLocalStorage.snapshot();
          run = (fn) => captured(fn);
          await gate.promise;
        };
        const open = () => input.disabled ? this.cache.disable(body) : this.cache.enable(body);
        const lifetime = input.parent === undefined ? open() : this.scope(input.parent).run(open);
        this.scopes.set(input.id, { run, gate, lifetime });
        break;
      }
      case "closeScope": {
        const scope = this.scope(input.id);
        scope.gate.resolve();
        await scope.lifetime;
        // Retain the captured context to exercise detached work after closure.
        break;
      }
      default: { const unknown: never = input; throw new Error(`Unknown input: ${JSON.stringify(unknown)}`); }
    }
    // Drain ready executor work while unresolved external gates remain held.
    // No guessed number of Promise turns and no advancing deadline time.
    await vi.advanceTimersByTimeAsync(0);
  }

  snapshot(): Observation { return structuredClone(this.observed); }

  async dispose(): Promise<void> {
    Object.assign(this.faults, { holdReads: false, holdWrites: false, holdDumps: false, holdLoads: false, holdPolicies: false });
    for (const scope of this.scopes.values()) if (!scope.gate.settled) scope.gate.resolve();
    for (const gates of Object.values(this.effects)) for (const gate of gates.values()) if (!gate.settled) gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    for (const loader of this.loaders) if (!loader.settled) loader.resolve(0);
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
  }

  private scope(id: string): Scope {
    const scope = this.scopes.get(id);
    if (scope === undefined) throw new Error(`Unknown scope ${id}`);
    return scope;
  }
  private loader(index: number) {
    const loader = this.loaders[index];
    if (loader === undefined) throw new Error(`No loader ${index}`);
    return loader;
  }
  private hold(effect: keyof BehaviorDriver["effects"], index: number): Promise<void> {
    const gate = deferred<void>();
    this.effects[effect].set(index, gate);
    return gate.promise;
  }
  private valueKey(key = "1"): string {
    return `${new DialCacheKey({ keyType: "id", id: key, useCase: "Behavior", trackForInvalidation: this.fixture.tracked ?? false }).urn}:dialcache-frame-v1`;
  }
  private classifyError(error: unknown): string {
    const source = this.sourceErrors.indexOf(error as Error);
    if (source >= 0) return `source:${source}`;
    if (error instanceof FallbackTimeoutError) {
      let index = this.timeoutErrors.indexOf(error);
      if (index < 0) { index = this.timeoutErrors.length; this.timeoutErrors.push(error); }
      return `timeout:${index}`;
    }
    return `unexpected:${String(error)}`;
  }
}

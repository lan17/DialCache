import { AsyncLocalStorage } from "node:async_hooks";

type RequestLocalReadResult<T> = { readonly status: "hit"; readonly value: T } | { readonly status: "miss" };

/** @internal */
export class RequestLocalCache {
  readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly values = new Map<string, unknown>();
  private closed = false;

  read<T>(key: string): RequestLocalReadResult<T> {
    if (this.closed || !this.values.has(key)) {
      return { status: "miss" };
    }
    return { status: "hit", value: this.values.get(key) as T };
  }

  set<T>(key: string, value: T): void {
    if (!this.closed) {
      this.values.set(key, value);
    }
  }

  close(): void {
    this.closed = true;
    this.values.clear();
    this.inFlight.clear();
  }
}

interface RequestHolder {
  closed: boolean;
  requestLocalCache?: RequestLocalCache;
}

interface ContextStore {
  readonly enabled: boolean;
  readonly holder: RequestHolder | null;
}

const contextStorage = new WeakMap<DialCacheContext, AsyncLocalStorage<ContextStore>>();

export class DialCacheContext {
  constructor() {
    contextStorage.set(this, new AsyncLocalStorage<ContextStore>());
  }

  isEnabled(): boolean {
    const store = storageFor(this).getStore();
    return store?.enabled === true && store.holder?.closed === false;
  }

  enable<T>(fn: () => T | Promise<T>): Promise<T> {
    const currentHolder = this.liveHolder();
    if (currentHolder !== null) {
      return this.run({ enabled: true, holder: currentHolder }, fn);
    }

    const holder: RequestHolder = { closed: false };
    return this.runOutermost(holder, fn);
  }

  disable<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.run({ enabled: false, holder: this.liveHolder() }, fn);
  }

  private liveHolder(): RequestHolder | null {
    const holder = storageFor(this).getStore()?.holder;
    return holder !== undefined && holder !== null && !holder.closed ? holder : null;
  }

  private async runOutermost<T>(holder: RequestHolder, fn: () => T | Promise<T>): Promise<T> {
    try {
      return await this.run({ enabled: true, holder }, fn);
    } finally {
      holder.closed = true;
      holder.requestLocalCache?.close();
      delete holder.requestLocalCache;
    }
  }

  private async run<T>(store: ContextStore, fn: () => T | Promise<T>): Promise<T> {
    return await storageFor(this).run(store, async () => await fn());
  }
}

/** @internal */
export function getOrCreateRequestLocalCache(context: DialCacheContext): RequestLocalCache | null {
  const store = storageFor(context).getStore();
  const holder = store?.holder;
  if (store?.enabled !== true || holder === null || holder === undefined || holder.closed) {
    return null;
  }

  holder.requestLocalCache ??= new RequestLocalCache();
  return holder.requestLocalCache;
}

function storageFor(context: DialCacheContext): AsyncLocalStorage<ContextStore> {
  return contextStorage.get(context)!;
}

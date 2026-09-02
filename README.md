# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

Fine-grained TypeScript caching with explicit enabled contexts, request-local memoization, process-local and Redis TTL caching, opt-in stale-on-error recovery, stable key construction, runtime rollout controls, request coalescing, adapter-based observability, and Redis watermark-based targeted invalidation.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [How caching works](#how-caching-works)
- [Enabled context](#enabled-context)
- [Defining cached functions](#defining-cached-functions)
  - [One-shot inline cache blocks](#one-shot-inline-cache-blocks)
- [Keys, ids, and extra dimensions](#keys-ids-and-extra-dimensions)
- [Runtime config and ramp controls](#runtime-config-and-ramp-controls)
- [Cache layers](#cache-layers)
  - [Request-local cache](#request-local-cache) · [Process-local cache](#process-local-cache) · [Redis-backed TTL cache](#redis-backed-ttl-cache) · [Stale on source error](#stale-on-source-error) · [Remote read deadlines](#remote-read-deadlines-and-async-liveness) · [Serialization](#serialization) · [Compression](#compression) · [Shadow validation](#shadow-validation)
- [Cached-value ownership](#cached-value-ownership)
- [Targeted invalidation and watermarks](#targeted-invalidation-and-watermarks)
- [Request coalescing](#request-coalescing)
  - [Fallback deadlines](#fallback-deadlines) · [Coalescing state](#coalescing-state)
- [Metrics](#metrics)
- [Maintainers](#maintainers)

## Install

```bash
pnpm add dialcache
# Choose a Redis client when using the remote layer:
pnpm add redis@~4.7.1
# or
pnpm add @valkey/valkey-glide@^2.0.0
# Add a metrics client only when using its adapter:
pnpm add prom-client@^15.1.3
# or
pnpm add hot-shots@^17.0.0
```

DialCache requires Node.js with zstd support in `node:zlib`: 22.15.0 or newer
within the 22.x line, or 23.8.0 and newer (23.0–23.7 lack zstd and are
excluded). Production deployments should use a
[currently supported LTS release](https://nodejs.org/en/about/previous-releases).

## Quick start

```ts
import { DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache();

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: DialCacheKeyConfig.enabled(60),
  },
);

// Caching is OFF outside an enable() scope (see "Enabled context"), so this runs the fn uncached:
await getUser("123");

// Inside enable(), reads are cached:
const user = await dialcache.enable(() => getUser("123"));
```

## How caching works

The wrapped function is the **fallback**: it runs whenever no active cache layer returns a value, whether because layers missed, were disabled, or failed open.

When caching is enabled, reads flow through:

```text
request-local cache -> process-local cache -> Redis cache -> fallback function
```

- Request-local hits return the value memoized in the current outermost `enable()` scope.
- Results from the lower chain are memoized request-locally when that layer is enabled.
- Process-local hits return immediately.
- Process-local misses try Redis and populate the process-local cache on a Redis hit.
- Redis misses call the fallback and attempt to write one complete Redis frame. When stale-on-error is opted in, the initial Redis read may retain a logically expired frame as a recovery candidate. An eligible fallback rejection can return that snapshot without another Redis read. An active untracked process-local layer may publish successful fallback results directly. For tracked keys, invocations that reach the Redis read/write path suppress direct process-local publication after fallback until a later validated Redis hit can warm it; local-only, remote-policy-disabled, and ramped-down paths remain governed by their local policy and may publish locally.
- Selected Redis keys can execute non-serving [shadow work](#shadow-validation) that validates hits and fills semantic misses, even before Redis is allowed to serve callers.
- Initial Redis read failures and timeouts are logged, counted in metrics, and fail open without attempting stale recovery. Redis write failures also fail open. `invalidateRemote` requires a configured Redis client; missing configuration and Redis failures are logged, counted, and rethrown so callers do not assume invalidation succeeded.
- Cache-key construction and config-provider failures also fail open and run the fallback uncached.
- A missing effective process-local/Redis TTL disables that layer by policy; a configured TTL with no ramp defaults to 100%. Disabled layers record a disabled reason and fall through to the next layer/fallback.

Caching as a whole is only active inside an enabled context, described next.

## Enabled context

Caching is **off by default** and only active inside a `dialcache.enable(...)` scope. This is deliberate: it lets you turn caching **off in write paths** so a stale read can't be cached around a write. DialCache uses Node `AsyncLocalStorage` to keep enabled state scoped to the current asynchronous call chain.

**Enable once at your request boundary** (e.g. a middleware that wraps read-request handling) so individual call sites don't each need it; wrap mutation handlers in `disable()`:

```ts
await dialcache.enable(async () => {
  await getUser("123"); // cached

  await dialcache.disable(async () => {
    await updateUser("123", patch); // reads here are uncached
  });

  await getUser("123"); // cached again
});
```

- Default is disabled — `cached()` and `getOrLoad()` calls made **outside** any `enable()` scope simply run their loader uncached (no error), so wrap your read paths to actually cache.
- Enabled state is async-scope-local, not process-global.
- Nested `enable` / `disable` scopes restore the previous behavior when the callback completes. Nested `enable()` calls reuse the outer request-local scope rather than creating a new one.

## Defining cached functions

Use `cached(fn, options)` for an extracted, reusable function. The wrapped callable has the same parameters and always returns a `Promise`. For a one-shot calculation that should remain inline, use [`getOrLoad()`](#one-shot-inline-cache-blocks).

| Option | Required | Description |
| --- | --- | --- |
| `keyType` | yes | The kind of id the key addresses (e.g. `"user_id"`). Together with the id, the invalidation unit for tracked entries. |
| `useCase` | yes | Identifies the individual cache: part of the stored key and the metrics label. |
| `cacheKey` | yes | Selector over `fn`'s parameters; returns a bare id or `{ id, args }`. |
| `defaultConfig` | no | `DialCacheKeyConfig` baseline policy that runtime config overlays field by field (see [Runtime config](#runtime-config-and-ramp-controls)). |
| `serializer` | when the return type is not statically JSON-compatible | Per-function `Serializer<T>` for Redis values (see [Serialization](#serialization)). |
| `shadowComparator` | no | Synchronous application-level equality for shadow validation; defaults to Node's strict deep equality. |
| `trackForInvalidation` | no (default `false`) | Opts this use case's Redis entries into watermark-based targeted invalidation. |
| `shouldAttemptStaleRecovery` | no | Synchronous source-error classifier for this use case; replaces the instance or built-in classifier (see [Stale on source error](#stale-on-source-error)). |
| `fallbackTimeoutMs` | no (default `60_000`) | Fallback deadline in milliseconds, at most 2,147,483,647; `null` disables it (see [Fallback deadlines](#fallback-deadlines)). |

`cached()` validates `useCase` at registration: a duplicate within one `DialCache` instance throws `UseCaseIsAlreadyRegisteredError`. Both APIs reject the internal name `watermark` with `UseCaseNameIsReservedError`.

### One-shot inline cache blocks

`getOrLoad(load, options)` runs one zero-argument loader through the same policy, cache layers, coalescing, invalidation, metrics, serialization, deadlines, and fail-open behavior as `cached()`. It is useful when only part of a larger function should be cached and the loader needs to capture local values:

```ts
// Reuse the caller-owned defaults; getOrLoad() snapshots them per invocation.
const profileCacheDefaults = DialCacheKeyConfig.enabled(60);

const profile = await dialcache.getOrLoad(
  async () => {
    const user = await db.getUser(userId);
    return renderProfile(user, locale);
  },
  {
    keyType: "user_id",
    useCase: "BuildProfile",
    key: { id: userId, args: { locale } },
    defaultConfig: profileCacheDefaults,
  },
);
```

The options match `cached()` except that the direct `key` replaces the `cacheKey` selector. `defaultConfig`, `fallbackTimeoutMs`, and the selected stale-recovery classifier are validated and captured for each invocation. Outside an enabled scope, DialCache invokes `load` directly without constructing a key, resolving runtime policy, or invoking the classifier.

`getOrLoad()` does not register its `useCase`, so repeated calls should reuse one stable, deployment-defined name such as `"BuildProfile"`. Keep it bounded: never derive `useCase` from a user, request, id, or other high-cardinality input because it is part of both cache identity and metrics labels. Put those values in `key` instead.

Every captured value that can change the result belongs in the bare id or `{ id, args }` key. Concurrent same-key calls may share one caller's in-flight loader and cached value, so all call sites for that identity must also agree on value meaning and serialization. Prefer `cached()` when a loader is reusable; prefer `getOrLoad()` when the calculation is intentionally local to one call site.

## Keys, ids, and extra dimensions

For `cached()`, the key comes from the required `cacheKey` selector whose parameters are inferred from `fn`. `getOrLoad()` accepts the same bare id or `{ id, args }` shape directly through `key`:

The selected or direct key is the value identity contract. It must include every input dimension that can affect the returned value; otherwise distinct calls can reuse the same cached value or share the same in-flight fallback through default-on request coalescing.

```ts
const searchPosts = dialcache.cached(
  (userId: string, page: number, filter: string) => db.searchPosts(userId, page, filter),
  {
    keyType: "user_id",
    useCase: "SearchPosts",
    cacheKey: (userId, page, filter) => ({ id: userId, args: { page, filter } }),
    defaultConfig: DialCacheKeyConfig.enabled(60),
  },
);
await dialcache.enable(() => searchPosts("u1", 2, "active"));
```

`DialCacheConfig.namespace` is the logical cache namespace and the first component of every key. It defaults to `"urn"`, producing keys such as `urn:user_id:123#GetUser`. Set a stable application-specific value when multiple applications may use the same Redis deployment:

```ts
const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: redisClient },
});
```

That produces Redis keys beginning with `users-api:...`, or `{users-api:...}` for invalidation-tracked values. `namespace` is DialCache's single cache-identity and key-partitioning setting: it participates in request-local, process-local, Redis, coalescing, deterministic ramp, invalidation, and metrics. It may not contain `{` or `}` because DialCache reserves those characters for Redis Cluster hash tags. Use a namespace to express any required application or environment separation, such as `production-users-api`.

- **`keyType` + `id` is the invalidation unit for tracked Redis entries.** `dialcache.invalidateRemote("user_id", "123", futureBufferMs)` writes one watermark for that user; any `trackForInvalidation` Redis entry with the same `keyType` and `id` is refreshed across all `args` variants when Redis is read. `invalidateRemote` does not evict existing request-local or process-local entries (see [Targeted invalidation](#targeted-invalidation-and-watermarks)), and untracked Redis entries do not consult the watermark. `useCase` identifies the individual cache (it's the metrics label and part of the stored key).
- **`args` are part of the cache key** — different `args` produce different entries — but invalidation is by `id` only.
- **Scalar key equality is string-based.** Runtime type is not an identity dimension: for matching surrounding dimensions, numeric `1`, string `"1"`, and bigint `1n` identify the same key; argument values `null` and `"null"` also match. `-0` matches `0`, and an `undefined` argument is omitted. If a deployment changes the logical meaning represented by a scalar, change an explicit identity dimension such as `keyType`, `useCase`, or an argument name/value.
- **Non-key inputs** (for example a db handle) are parameters ignored by a `cacheKey` selector or values captured by a `getOrLoad()` loader. They still reach non-coalesced executions, but concurrent same-key cache misses share the leader's execution unless the use case disables coalescing, so do not omit values like auth context, locale, or cancellation behavior unless sharing one result is correct.
- **Methods:** pass `obj.method.bind(obj)` (or `(...a) => obj.method(...a)`) — a bare `obj.method` reference loses `this`.

Changing the namespace value intentionally creates a cold-cache boundary across every layer. Old and new keyspaces do not share Redis values or invalidation watermarks. During an overlapping deployment, an invalidation handled by one version is invisible to the other, which can continue serving a stale tracked value until its value TTL expires. If remote invalidation correctness matters, a normal rolling deployment is unsafe: use a coordinated no-overlap cutover, or an operational bridge that prevents both versions from serving remote cache across mutations (for example, temporarily disable and clear remote caching during the transition). After the cutover, provision for fallback/refill load and allow old Redis keys to expire by TTL.

## Runtime config and ramp controls

Instance-wide behavior is set through the `DialCache` constructor:

| `DialCacheConfig` option | Default | Description |
| --- | --- | --- |
| `namespace` | `"urn"` | Logical cache namespace and first key component (see [Keys, ids, and extra dimensions](#keys-ids-and-extra-dimensions)). |
| `redis` | none | `{ client: DialCacheRedisClient, readTimeoutMs?: number, serializer?: Serializer<unknown>, compression?: CompressionConfig \| false }`; enables the Redis layer with a 50 ms default read deadline, an optional instance-default serializer, and default-on zstd payload compression (see [Redis-backed TTL cache](#redis-backed-ttl-cache), [Serialization](#serialization), and [Compression](#compression)). |
| `localMaxSize` | `10_000` | Global process-local entry cap; `0` disables process-local storage. Nonnegative safe integer. |
| `shadowMaxInFlight` | `1` | Maximum scheduled or active shadow jobs per `DialCache` instance, including uncancellable underlying work. Positive safe integer; excess work is dropped without queuing. |
| `cacheConfigProvider` | none | Resolves runtime config per enabled invocation as a sparse overlay on the function's `defaultConfig`; `null` applies no overrides. |
| `shouldAttemptStaleRecovery` | only `FallbackTimeoutError` | Synchronous instance-default source-error classifier. A per-use-case callback replaces it. |
| `metrics` | disabled | A `DialCacheMetricsAdapter` (see [Metrics](#metrics)). |
| `logger` | `console` | Receives operational cache failures and opted-in confirmed shadow mismatch warnings (`debug`, `warn`, `error`). Synchronous throws and rejections from returned promises or thenables are isolated without being awaited. |

Per-invocation cache policy is a `DialCacheKeyConfig`: per-layer `ttlSec` and `ramp` maps keyed by `CacheLayer.LOCAL` (process-local) and `CacheLayer.REMOTE` (Redis), a `requestLocal` boolean, a `coalesce` boolean (see [Request coalescing](#request-coalescing)), an optional `staleOnErrorMaxAgeSec`, an optional `remoteReadTimeoutMs`, and an optional `shadow` group. `ShadowConfig` contains the independent shadow `ramp` percentage plus the default-off `logMismatches` control.

Every cached definition or `getOrLoad()` invocation can provide an optional per-use-case `defaultConfig`. It is the baseline policy, and the `cacheConfigProvider` result is a sparse field-level overlay on that baseline. For cache enablement fields, precedence is runtime config, then `defaultConfig`, then DialCache's disabled baseline. For the remote-read deadline, precedence is runtime `remoteReadTimeoutMs`, `defaultConfig.remoteReadTimeoutMs`, `redis.readTimeoutMs`, then the 50 ms library default.

The disabled baseline sets `requestLocal` to false, leaves the process-local and Redis TTLs and stale-on-error maximum unset, and sets `shadow.ramp` to 0% with mismatch logging false. A shared layer with no effective TTL is disabled by policy. When a shared layer has an effective TTL but no effective ramp, its ramp defaults to 100%. Shadow work remains disabled unless `shadow.ramp` is explicitly greater than zero.

`DialCacheKeyConfig` preserves an omitted `requestLocal` as `undefined` so the overlay can distinguish omission from an explicit `false`; the effective value still defaults to false after resolution. An omitted `coalesce` is preserved the same way, and its effective value defaults to true, so request coalescing stays on unless a use case explicitly opts out. An omitted `staleOnErrorMaxAgeSec` inherits an earlier value in a sparse runtime overlay and otherwise leaves recovery off; `0` explicitly disables an inherited stale policy.

A provider result of `null` (or defensive `undefined`) applies no overrides. An empty `DialCacheKeyConfig` and omitted runtime fields also inherit the baseline. Top-level fields, cache-layer leaves, and leaves inside `shadow` merge independently; an explicit `false` logging flag overrides an inherited `true`. Use explicit values to override inherited policy: `requestLocal: false` disables request-local caching, `staleOnErrorMaxAgeSec: 0` disables stale recovery, and a layer ramp of `0` disables that shared layer. `DialCacheKeyConfig.disabled()` is the complete new-cache-invocation kill switch in one call: request-local, stale recovery, and shadow work off, shadow logging off, and both shared layers ramped to 0. It leaves `coalesce` unset: with every layer off there is no in-flight sharing to disable, and a use case ramped back up at runtime coalesces again unless it explicitly opts out. It does not cancel already-admitted work, and explicit maintenance operations such as `invalidateRemote()` remain available. To stop new cache-invocation Redis reads and fills while preserving other runtime settings, explicitly set both `ramp.remote` and `shadow.ramp` to `0`; the remote ramp alone stops serving but does not override an inherited nonzero shadow ramp.

DialCache validates `defaultConfig` when `cached()` registers a definition and whenever `getOrLoad()` is invoked: TTLs must be positive safe integers no greater than 31,536,000 seconds (a fixed 365-day duration), a positive stale-on-error maximum must be a safe integer in the same range and strictly greater than the remote TTL, remote-read deadlines must be positive safe integers within their documented limit, layer and shadow ramps must be finite percentages from 0 to 100, layer maps and `shadow` must be objects, and `requestLocal`, `coalesce`, and `shadow.logMismatches` must be booleans when present. `0` is the one valid non-positive stale maximum and explicitly disables recovery. Invalid defaults are rejected immediately.

Each registration or one-shot invocation captures an immutable internal snapshot of `defaultConfig`; mutating the supplied config or its maps later does not change that operation's baseline. Runtime policy changes belong in the provider's returned overlay.

Runtime TTL and ramp leaves are used as supplied instead of falling back to valid default leaves. A TTL outside the same 1-to-31,536,000-second range disables that layer with `invalid_ttl`; a nonnumeric, non-finite, or out-of-range ramp disables it with `invalid_ramp`. Valid ramps include both `0` and `100`. Other layers can still run, and invalid leaves also record a `config_resolution` error so provider garbage is alertable separately from intentional ramp-downs. A malformed runtime config object, layer-map shape, `requestLocal` value, `coalesce` value, explicit `remoteReadTimeoutMs`, or removed top-level `shadowRamp` fails config resolution for the invocation, records `config_error`, and executes the fallback uncached without attempting Redis. An invalid runtime `staleOnErrorMaxAgeSec` is narrower: DialCache records `config_resolution`, disables recovery for that invocation, and preserves an otherwise valid fresh Redis policy. The public `DialCacheKeyConfig` constructor and static defaults likewise reject `shadowRamp` immediately; migrate it to `shadow.ramp`.

An invalid runtime `shadow.ramp` does not affect the cache result or disable an otherwise valid Redis policy. If normal traversal reaches an otherwise shadow-eligible Redis path, DialCache skips shadow work and records a `config_resolution` error. An invalid runtime `shadow.logMismatches` likewise preserves the cache result, Redis policy, shadow result, and shadow metric while suppressing the warning. DialCache validates this diagnostic leaf only after the metrics hook, exact-key cohort, and capacity gates admit shadow work, then records one remote `config_resolution` error for that admitted resolution.

`cacheConfigProvider` is called for every enabled cache invocation before DialCache performs any cache lookup. Keep it cheap, cache any remote/config-store reads inside the provider, and avoid work that would erase the benefit of a cache hit.

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  cacheConfigProvider: async (key) => {
    if (key.useCase === "GetUser") {
      return new DialCacheKeyConfig({
        // Sparse override: inherit both TTLs and the local ramp from defaultConfig.
        ramp: { [CacheLayer.REMOTE]: 25 },
        // Independently sample Redis keys for detached validation/fill.
        shadow: {
          ramp: 5,
          // Emit one warning with a bounded key and native-JSON value strings.
          logMismatches: true,
        },
        // Can be changed by the provider at runtime for this use case.
        remoteReadTimeoutMs: 35,
        // Sparse override of the maximum retained age; use 0 to turn recovery off.
        staleOnErrorMaxAgeSec: 1_800,
      });
    }
    return null; // apply no overrides; use the cached function's baseline
  },
});

const getUser = dialcache.cached((userId: string) => db.fetchUser(userId), {
  keyType: "user_id",
  useCase: "GetUser",
  cacheKey: (userId) => userId,
  defaultConfig: new DialCacheKeyConfig({
    // Omitted ramps default to 100% because these layers have TTLs.
    ttlSec: { [CacheLayer.LOCAL]: 30, [CacheLayer.REMOTE]: 300 },
    // Keep Redis data for up to one hour and serve it only after a source error.
    staleOnErrorMaxAgeSec: 3_600,
  }),
});
```

`ramp` values are percentages from 0 to 100. `0` disables the layer, `100` enables it, and intermediate values are deterministically sampled by cache key and layer, so the same key is consistently sampled in or out of a partial rollout across calls and instances. The assignment algorithm is owned by DialCache and remains stable across releases. Applications that need an externally coordinated cohort can use `cacheConfigProvider` to return a sparse per-key ramp override of `0` or `100`. DialCache fetches and resolves one config snapshot per enabled invocation. Provider errors do not activate defaults: they fail open, record `config_error`, and execute the fallback function uncached.

`shadow.ramp` uses the same inclusive 0–100 percentage domain but is independent of cache-layer serving ramps. Omission and `0` disable shadow work; `100` selects every eligible Redis key; intermediate values assign each exact cache key to a stable shadow cohort across calls and instances. A valid remote policy can therefore use `ramp.remote: 0` with a nonzero `shadow.ramp` to exercise and populate Redis without serving from it. A nonzero value explicitly authorizes detached native writes after semantic shadow misses; later tracked reads remain watermark-aware, while untracked reads retain ordinary TTL-based last-writer-wins behavior. It does not create another `CacheLayer`, activate Redis without a valid remote TTL, or make a request-local/process-local hit continue to Redis.

Remote serving and shadow sampling use independent deterministic cohorts. Equal partial percentages do not imply the same keys, so a partial shadow cohort does not guarantee that every key admitted by a later partial serving ramp was warmed or validated. Use `shadow: { ramp: 100 }` when every otherwise eligible invocation must exercise the non-serving Redis path before a serving-ramp increase.

## Cache layers

### Request-local cache

Set `requestLocal: true` to memoize resolved values for the lifetime of the outermost `enable()` scope:

```ts
import { DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache();
const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
  },
);
```

`requestLocal` is a runtime boolean rather than a TTL/ramp-controlled `CacheLayer`. The `cacheConfigProvider` can turn it on or off for each invocation. `DialCacheKeyConfig.enabled(ttlSec)` enables only process-local and Redis caching, so request-local caching must be selected explicitly.

DialCache resolves the runtime config once per enabled invocation and uses it for the entire lookup. When the effective `requestLocal` value is false, the invocation skips request-local lookup and storage without deleting an entry already memoized in the scope. A later invocation that enables request-local caching can reuse that entry.

The outermost `enable()` call owns the request-local lifetime, and nested `enable()` calls reuse that scope. Request-local state is allocated lazily, only when an invocation enables the layer, so scopes that use only process-local or Redis caching do not allocate it.

Wrap the complete Node HTTP handler so the request-local scope matches the handler's lifetime:

```ts
import { createServer } from "node:http";

const server = createServer((req, res) => {
  void dialcache
    .enable(async () => {
      const user = await getUser(readUserId(req));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(user));
    })
    .catch((error: unknown) => handleRequestError(error, res));
});
```

Request-local storage has no capacity limit, eviction, or overflow mode. Entries are retained until the outermost `enable()` callback settles. Use it for short-lived scopes with bounded key cardinality; split long-running streams or large batch jobs into smaller scopes when necessary.

### Process-local cache

The process-local layer (`CacheLayer.LOCAL`) uses one LRU per `DialCache` instance. It keeps at most 10,000 entries by default across all use cases while retaining each entry's configured TTL. Set `localMaxSize` to a nonnegative safe integer to change the global entry cap; `0` disables process-local storage:

```ts
const dialcache = new DialCache({ localMaxSize: 25_000 });
```

The limit counts entries rather than estimating JavaScript object memory. Recently read entries stay resident ahead of less recently used entries when the limit is reached.

### Redis-backed TTL cache

The Redis layer supports standalone Redis, Valkey, and Redis Cluster. Connect the underlying client, then wrap it with the bundled adapter:

```ts
import { createClient } from "redis";
import { DialCache } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";

const redisClient = createClient({
  url: process.env.REDIS_URL,
  disableOfflineQueue: true,
  commandsQueueMaxLength: 1_000,
  socket: { connectTimeout: 2_000 },
});
await redisClient.connect();

const dialcache = new DialCache({
  namespace: "users-api",
  redis: {
    client: createNodeRedisDialCacheClient(redisClient),
    // Optional instance default; omit to use DialCache's 50 ms default.
    readTimeoutMs: 100,
  },
});

async function shutdown(): Promise<void> {
  // Stop new work and await every outstanding request-path call and invalidation first.
  // Detached shadow work is best-effort and has no drain handle.
  await redisClient.quit();
}
```

`redis.client` is required when Redis is configured and accepts the semantic `DialCacheRedisClient` interface. `redis.readTimeoutMs` is optional and sets the instance default for remote reads; omit it to use 50 ms. Create and connect the underlying client before constructing `DialCache`. Node-redis users wrap that connected client with `createNodeRedisDialCacheClient` as shown above; the adapter issues native reads and writes and manages invalidation's `EVALSHA`/`EVAL` dispatch internally. The helper requires node-redis's promise API and does not support `legacyMode`, whose callback surface is incompatible with the required promise-based binary-command contract.

Valkey GLIDE users pass an already-created standalone or cluster client and its
module namespace to the GLIDE adapter:

```ts
import * as valkeyGlide from "@valkey/valkey-glide";
import { DialCache } from "dialcache";
import { createValkeyGlideDialCacheClient } from "dialcache/valkey-glide";

const glideClient = await valkeyGlide.GlideClient.createClient({
  addresses: [{ host: "127.0.0.1", port: 6379 }],
  requestTimeout: 2_000,
  advancedConfiguration: { connectionTimeout: 2_000 },
});
const redisClient = createValkeyGlideDialCacheClient(glideClient, valkeyGlide);
const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: redisClient },
});

function shutdown(): void {
  // After draining request-path calls and invalidations, close GLIDE; the
  // adapter is stateless. Detached shadow work is best-effort and has no
  // drain handle.
  glideClient.close();
}
```

Pass the same GLIDE 2.x module namespace that created the client. The adapter
uses that namespace's `GlideClient` and `GlideClusterClient` identities,
the standalone `Batch` constructor, and `Decoder.Bytes` without importing a
GLIDE runtime itself. Cluster reads route `MGET` directly and do not require
`ClusterBatch`. The helper accepts a direct official client instance and
fails during construction when the client came from another module instance or
is hidden behind a forwarding wrapper, because it cannot safely infer that
wrapper's topology. Custom wrappers can implement `DialCacheRedisClient`
directly.

The application owns the complete Redis lifecycle. It creates and connects the underlying client and passes the semantic adapter to DialCache. During shutdown, stop starting DialCache-backed work and await every promise returned by a cached function, `getOrLoad()`, or `invalidateRemote()`, including calls still running fallbacks that may later write Redis. A read that crossed DialCache's wait deadline may still be active inside the client, so use client-native telemetry and shutdown controls to drain or terminate that work before closing the connection. DialCache only borrows `redis.client`; it has no close or drain method and never disposes or closes caller resources.

Awaiting those public promises does not drain detached shadow work. Shadow scheduling and deadline timers are unreferenced and completion is not guaranteed during shutdown; Redis operations, source reads, serializers, and asynchronous telemetry already started by shadow work remain caller-owned and may still be active. Stop new work before closing their dependencies and accept that an in-flight shadow fill may have been dispatched even if its final outcome is lost during teardown. DialCache does not add a shutdown hook or keep the process alive to deliver best-effort outcomes.

Neither adapter owns additional resources or native script handles, so the application simply closes the underlying client after draining work.

Reads use native `GET` for untracked entries and one atomic `MGET` for each tracked value-and-watermark pair. The adapters validate and decode the returned frame in the Node process. Tracked reads are deliberately routed to primaries so a lagging replica cannot hide an invalidation watermark. Bundled adapters return bounded classified misses: `RedisReadMiss { reason }` when no trustworthy refill fence exists, or `RedisWatermarkMiss { kind: "watermark_miss", reason, observedWatermarkMs }` when the same tracked snapshot carried a valid numeric watermark. Redis `nil` is `value_absent`; only a complete supported tracked frame rejected at or below the watermark is `watermark_fenced`; and short or unsupported frames, and malformed watermark metadata paired with a present frame, are `unclassified`. Cause remains independent from the fence, so an absent value can still carry `observedWatermarkMs` and suppress a later refill. Legacy custom `null` results remain correct and are reported as `unclassified`. After a read settles, DialCache evaluates a decoded frame against the observing application's `Date.now()`. Without stale-on-error, the read accepts only nonnegative ages strictly below the effective remote TTL `F`. With a positive recovery maximum `M`, that same initial read is bounded by `M`: ages below `F` deserialize and serve normally, while ages from `F` through strictly below `M` remain raw as a possible source-error recovery candidate. Future-dated frames fail closed before deserialization and emit the bounded offset observation described under [Metrics](#metrics). A shadow confirmation read still observes a future offset but retains the payload only for supersession comparison; it can never serve that frame.

Writes are native too, so the payload never crosses the Redis-to-Lua boundary. Conditional tracked refills follow the two-sample fence described under [targeted invalidation](#targeted-invalidation-and-watermarks): a preflight can avoid payload preparation, while an admitted fill uses a final dispatch-adjacent timestamp so serialization time does not consume its logical TTL. Ordinary, untracked, missing/malformed-watermark, and legacy-adapter misses leave optional `RedisWriteRequest.createdAtMs` absent, preserving the adapter-side `Date.now()` sample immediately before dispatch. Every dispatched write issues one `SET valueKey frame PX cacheTtlMs` containing the complete version-1 frame; only tracked reads include the watermark key. With stale-on-error enabled, the requested physical TTL is `M` instead of `F`. `M` remains the configured logical recovery ceiling even when it exceeds one hour. Core separately caps every tracked Redis value's physical TTL at one hour, so such a tracked candidate may be evicted by expiry before it reaches logical age `M`; untracked Redis and local TTLs retain their configured limits. Each dispatched tracked write whose requested TTL exceeds that cap emits `error="tracked_ttl_clamped"`. The write never reads, creates, or extends a watermark. A dispatched frame can still be fenced if the watermark advances after the read snapshot. Same-key writes are ordinary Redis last-writer-wins operations, with no Lua, pipeline, or transaction on the write path.

The network shape remains one top-level Redis command and one round trip per semantic read (`GET` or `MGET`) and one `SET` per dispatched write. Stale recovery reuses the frame returned by that initial command and never adds a second Redis read, including after a source rejection. Retaining a raw candidate instead consumes process memory until that source attempt settles, once per distinct in-flight key (same-key coalesced callers share it). Conditional refill suppression reuses the existing tracked `MGET` result and adds no command or round trip. DialCache does not call Redis `TIME` or maintain a Redis-clock offset. Use the maintainer benchmarks below to measure the target Redis/Valkey version, payload distribution, and high-cardinality in-flight memory exposure.

Native commands retain Redis's wrong-type behavior. An untracked `GET` surfaces `WRONGTYPE`; tracked `MGET` represents a wrong-type member as a missing value. A wrong-type tracked value is therefore `value_absent`; when the paired watermark is a valid numeric string, the result also carries that independent refill fence, while an absent or wrong-type watermark yields the ordinary zero-baseline behavior. A wrong-type watermark is indistinguishable from an absent watermark to `MGET`; it does not prevent or alter native value writes. The next explicit invalidation replaces that wrong-type key with a valid string watermark. Other script read failures remain errors and cannot bypass the monotonic update.

Node-redis forces tracked cluster commands to the slot primary. GLIDE uses an explicit primary route in cluster mode; in standalone mode it sends `MGET` through a one-command non-atomic batch because direct read commands follow the client's replica-read preference. Standalone batches use the primary, and `MGET` itself provides the atomic snapshot without consuming caller-owned `WATCH` state. The GLIDE helper distinguishes those modes from the direct client's runtime identity and rejects ambiguous clients instead of silently choosing a route.

Invalidation is the only remaining Lua operation. Both adapters dispatch it as `EVALSHA` by the script source's SHA1 and retry a rejected dispatch once by re-sending the source as `EVAL`. The script is idempotent: its watermark advances monotonically and its TTL only widens, so a duplicate execution after an ambiguous failure is harmless. Reply-domain violations are deterministic and are not retried. If the retry also fails, GLIDE attaches the original rejection as `cause` when possible; node-redis surfaces the retry rejection unmodified because disconnect failures may be shared across callers. A healed retry is indistinguishable from first-attempt success in DialCache metrics. Monitor server-side `INFO commandstats` for unexpected `EVAL` volume or rejected `EVALSHA` calls.

Command-restricted Redis ACLs must allow native `GET`, `MGET`, and `SET`, plus `EVALSHA` and `EVAL` for invalidation recovery. If script-invoked commands are checked separately, the invalidation script needs `GET`, `SET`, and `PTTL`. Redis `TIME`, `MULTI`, `EXEC`, `WATCH`, `UNLINK`, and `SCRIPT LOAD` are not used by DialCache. Conditional refill suppression reuses the existing tracked `MGET` result and adds no command or round trip. The integration matrix covers Redis 6.2 and Valkey 8.

#### Stale on source error

Stale-on-error is an opt-in Redis policy with two ages:

- `F = ttlSec.remote` is the logical fresh lifetime. Every ordinary Redis read enforces `F`, regardless of whether recovery is enabled.
- `M = staleOnErrorMaxAgeSec` is the configured logical recovery-age ceiling. When configured, Redis requests physical retention through `M`, but ordinary reads still treat the frame as a miss at age `F`. `M` is not clipped for tracked use cases; their Redis value TTL is separately capped at one hour, so a retained frame can physically disappear before reaching `M`.

`F` and `M` bound only Redis serving. Request-local and process-local hits occur earlier in the chain and follow their own scope or TTL lifetimes. A Redis frame can be nearly `F` old when it warms the process-local cache and then receive a full local TTL, so setting the local TTL to `F` or lower does not make `F` a strict end-to-end age limit. Disable those earlier layers when that global bound is required.

With a positive `M`, the initial Redis command admits frames up to `M` and classifies them in the Node process. A frame with `0 <= age < F` is deserialized and served as a normal hit. A frame with `F <= age < M` records an `expired` Redis miss but retains its raw payload while DialCache calls the source of truth. A missing, future-dated, watermark-fenced, or `age >= M` frame is a miss with no retained candidate; the `age >= M` case also reports `expired`. A fresh frame that fails initial deserialization is likewise not eligible to be reconsidered as stale.

If the source rejects, DialCache first applies a synchronous `shouldAttemptStaleRecovery(error)` classifier. Precedence is per-use-case `cached()`/`getOrLoad()` option, then the `DialCache` instance option, then the built-in policy. The built-in policy authorizes only `error instanceof FallbackTimeoutError`, whether the error came from this invocation's deadline or propagated from a nested/source operation. An override replaces the lower-precedence policy rather than composing with it, so an application override that should preserve timeout recovery must include that case itself. Custom predicates should narrowly admit transient, retriable infrastructure failures. They should deny authoritative domain outcomes such as auth, permission, entitlement, or revocation failures; deletion or not-found results; and validation or programmer errors. Use a per-use-case classifier when particular data requires a stricter policy than the instance default. A supplied policy must be a function; DialCache validates it at instance construction, cached-wrapper registration, or `getOrLoad()` invocation. During classification, a callback throw, thenable, or non-boolean result fails closed; DialCache consumes a rejecting thenable, logs the classifier failure, and preserves the original source rejection. Calls outside an enabled context never invoke the classifier.

When the classifier returns `true`, DialCache consults only the frame retained from the initial read and issues no additional Redis command. It requires `0 <= Date.now() - createdAtMs < M` both before and after lazy deserialization/decompression, so crossing `M` during an asynchronous serializer load cannot serve. A valid candidate suppresses the source rejection for that caller. A missing or expired candidate, or a candidate that cannot deserialize/decompress, rethrows the exact original source rejection.

```ts
import { CacheLayer, DialCacheKeyConfig, FallbackTimeoutError } from "dialcache";

const getUser = dialcache.cached((userId: string) => db.fetchUser(userId), {
  keyType: "user_id",
  useCase: "GetUserWithStaleRecovery",
  cacheKey: (userId) => userId,
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.REMOTE]: 60 }, // F: normal reads serve for 60 seconds
    staleOnErrorMaxAgeSec: 300,          // M: recovery requires age < 5 minutes
  }),
  // This replaces the built-in classifier, so retain its timeout case explicitly.
  shouldAttemptStaleRecovery: (error) =>
    error instanceof FallbackTimeoutError || isRetriableDatabaseError(error),
});
```

Omitting `staleOnErrorMaxAgeSec` keeps recovery off and inherits a configured default when used in a sparse runtime overlay. An explicit `0` disables it. A positive `M` requires an enabled remote TTL and must satisfy `0 < F < M <= 31_536_000`; invalid static defaults throw, while an invalid runtime overlay records `config_resolution`, disables only stale recovery for that invocation, and leaves valid ordinary Redis reads active. The effective config snapshot is fixed for the invocation: its initial read uses that snapshot's `F`, `M`, and remote-read deadline even if the provider changes while the source call is in flight. `cached()` captures its selected classifier when the wrapper is registered; `getOrLoad()` captures one for each invocation.

The retained frame is a snapshot. For a tracked key, the initial primary-routed `MGET` atomically applies the watermark that existed with the value at read time, so an invalidation completed before that read fences the candidate. An invalidation completed after the read does not revoke the already-retained bytes. Concurrent refreshes, deletions, expiry, and eviction after the initial read are likewise not observed for either tracked or untracked candidates. Opting a tracked use case into stale recovery therefore permits recovery to weaken its usual strict freshness guarantee during this source-error path; applications that cannot tolerate that behavior should leave recovery disabled or deny the error in their classifier.

Recovery does not write Redis, populate the process-local cache, schedule shadow validation, or emit the shadow value-age observation. When request-local caching is enabled, the recovered value is memoized only in that outer `enable()` scope. This prevents an outage response from becoming a new shared cache value.

Default coalescing applies to the whole sequence, so same-key followers share one initial read, one retained candidate, one source rejection, and one recovery decision. With `coalesce: false`, each concurrent caller instead performs its own initial read, retains its own candidate, and runs its own source call and independent fallback deadline; request-local memoization can still serve later sequential calls after a recovered value settles. High-cardinality delayed source failures can therefore retain one raw payload per distinct in-flight key until the source settles.

Each classifier-authorized recovery check emits exactly one optional `staleRecovery` outcome: `served`, `miss`, or `deserialization_error`. It does not add another ordinary `request`, `observeGet`, `miss`, or cache-read error: the initial Redis operation is the one caller-serving telemetry trail. `served` additionally emits the optional stale-recovery value-age observation, measured at actual return time in seconds; `miss` and `deserialization_error` emit no age. Existing fallback-duration and fallback-error telemetry still records the source rejection even when recovery serves. Recovery never adds a raw exception or key to metric labels.

This feature keeps the existing frame-v1 Redis keys; it does not create a second stale key or change the TypeScript shape of `DialCacheRedisClient` or `RedisReadRequest`. Its timestamp behavior is nevertheless breaking for custom clients: ordinary untracked reads previously treated `createdAtMs` as informational, while they now require the real frame timestamp to satisfy logical `F` (and recovery uses it for `M`). Custom clients that returned a constant must return a valid epoch-millisecond stamp before upgrading. Roll out the DialCache version that enforces logical `F` everywhere before enabling writers that retain values to `M`. A pre-feature reader trusts physical expiry and could otherwise serve a retained frame normally between `F` and `M`. Once any write uses physical `M`, treat that keyspace as a downgrade barrier until every such key has expired or been explicitly removed; disabling recovery on current readers is safe because they still enforce `F`, but reintroducing an older reader is not.

The `F` and `M` comparisons follow the [application-process clock contract](#targeted-invalidation-and-watermarks) used by all serving timestamps. Choose both ages with the deployment's observed clock skew in mind. Redis physical expiry bounds key storage and whether a read can acquire a candidate; it does not revoke a snapshot already retained by the process. That snapshot remains eligible only while the return-time check satisfies `age < M`, even if Redis expires, deletes, or evicts the key after the initial read.

#### Remote read deadlines and async liveness

DialCache bounds every active Redis read. The effective timeout is resolved per use case and per invocation: runtime `remoteReadTimeoutMs`, then `defaultConfig.remoteReadTimeoutMs`, then optional instance `redis.readTimeoutMs`, then 50 ms. Values must be positive safe integers no greater than 2,147,483,647. There is no unbounded escape hatch for remote reads.

When the deadline expires, DialCache aborts the optional `RedisReadContext.signal`, records one `cache_read_timeout` error, logs a `RedisReadTimeoutError`, and starts the source fallback. Late read fulfillment or rejection is consumed and ignored. A read failure or timeout never triggers a post-fallback Redis write; an untracked active process-local miss may retain the source value, while a tracked key suppresses local publication because the failed read did not establish watermark safety.

Same-key followers share the leader's remaining remote-read budget. The timer covers the one semantic Redis read, not config resolution, serializer load, fallback work, Redis writes, or invalidation. `fallbackTimeoutMs` starts separately when the source fallback begins. With stale-on-error enabled, the initial read may retain a raw candidate through that fallback; recovery reuses it and creates no second Redis-read budget.

The bundled node-redis adapter passes the signal through per-command options, which can remove queued work where supported. Aborting after dispatch does not unsend a command or prove that Redis stopped executing it. GLIDE's current adapter commands have no per-invocation signal, so a read may continue after DialCache has fallen back. Keep client-native connection, retry, queue, and response budgets in place; they bound underlying resource lifetime while DialCache's deadline bounds caller wait time.

Writes, invalidations, async `cacheConfigProvider` calls, and custom serializer methods still need finite application-owned budgets. Client support differs: GLIDE's `requestTimeout` bounds every command's reply wait, while node-redis has no per-command deadline — its queue and reconnect controls bound admission and dispatch only (see the invalidation-retry paragraph above), so bound node-redis mutations at the connection layer rather than per call. Do not put mutations behind a bare `Promise.race`: rejecting the outer promise neither removes queued work nor proves whether a dispatched mutation executed.

#### Serialization

The core Redis boundary is the client-agnostic `DialCacheRedisClient` interface. Writes accept serialized values as `string | Buffer`; reads return `RedisReadResult`, which is a `DecodedRedisFrame` — the decoded `string | Buffer` payload plus the frame header's writer-client `createdAtMs` — `RedisReadMiss { reason }`, `RedisWatermarkMiss { kind: "watermark_miss", reason, observedWatermarkMs }`, or `null`. The interface does not expose client commands or wire encodings. A decoded frame's timestamp is correctness-relevant: custom clients must return the frame's valid nonnegative safe-integer epoch timestamp rather than a constant. `RedisWriteRequest` contains `valueKey`, `cacheTtlMs`, `value`, and optional `createdAtMs`, and `write()` returns `void`; watermark ownership remains exclusive to tracked reads and invalidation. Core supplies `createdAtMs` only after a discriminated watermark miss passes both the preflight and final checks; the supplied value is the final dispatch-adjacent sample. A custom client that continues returning only `DecodedRedisFrame | null` remains correct and source-compatible, but its `null` misses are reported as `unclassified` and do not enable the known-fenced refill optimization. A custom client that returns a classified miss with the watermark discriminant and a valid `observedWatermarkMs` opts into that optimization and must encode a supplied `RedisWriteRequest.createdAtMs` exactly so the final fence decision and stored frame cannot diverge. Older typed watermark-miss shapes remain accepted at runtime and normalize a missing or invalid reason to `unclassified`.

The shared `encodeRedisFrame`, `decodeRedisFrame`, `decodeRedisReadResult`, `decodeTrackedRedisFrame`, and `decodeTrackedRedisReadResult` helpers, the `validateRedisSetReply` and `validateRedisScriptInvalidationReply` reply helpers, the `ceilSupportedCacheTtlMs` TTL guard, and the invalidation Lua source are available from `dialcache/redis-protocol`. A custom write chooses `const createdAtMs = request.createdAtMs === undefined ? Date.now() : request.createdAtMs`, calls `encodeRedisFrame(request.value, createdAtMs)`, and sends one `SET valueKey frame PX cacheTtlMs` after validating the TTL. The fallback clock covers ordinary core writes and direct callers that omit the optional field; supplied values must not be resampled or replaced, and invalid runtime values must still be rejected by the frame encoder. A custom untracked read can pass its native reply to `decodeRedisReadResult`; a custom tracked read atomically obtains `[value, watermark]` from the primary and passes both replies to `decodeTrackedRedisReadResult`. Those typed helpers preserve the exact bounded reason and carry any valid observed fence on the discriminated variant, while the backward-compatible frame helpers collapse misses to `null` and preserve the established `DecodedRedisFrame | null` surface. A missing watermark is treated as zero for valid frames; malformed numeric watermark metadata is `unclassified`, except that a native `nil` value remains `value_absent`. Invalidation passes `KEYS = [watermarkKey]` and `ARGV = [futureBufferMs, invalidatedAtMs]`, with one stable client timestamp reused across retries. Custom adapters can throw the root-exported `DialCacheRedisPayloadError`, `DialCacheRedisPayloadEncodingError`, and `DialCacheRedisProtocolError` classes to distinguish malformed replies, unsupported encodings, and reply-domain violations. DialCache records bounded `cache_read`, `cache_write`, or `invalidation` metrics by failure site.

Decoded hits keep the existing `{ payload, createdAtMs }` shape. Caller-serving logical-age rejections emit `expired`; future-time and deserialization rejections emit `unclassified`. Neither acquires a refill fence; conditional refills remain limited to adapter-level misses carrying a valid observed watermark.

Redis values use a compact binary frame:

```text
byte 1      format version: 1
bytes 2-9   uint64 big-endian: writer application time in epoch milliseconds
byte 10     payload encoding (0 = UTF-8, 1 = raw binary)
bytes 11... serialized payload (optionally zstd-compressed; see Compression)
```

Adapters build complete frames in the Node process with `encodeRedisFrame` and decode them with Node buffer primitives. `RedisReadMiss` and the backward-compatible `RedisWatermarkMiss` exist only across the in-process semantic adapter boundary; neither is a new Redis value. The version-1 value-envelope format, Redis value-key derivation, decimal watermark encoding, tracked `MGET`, and dispatched `SET` are unchanged. That wire compatibility does not make old tracked state safe to carry across the protocol cutover: old watermark lifetimes were derived for the old write protocol.

Redis physical TTL bounds how long the stored key remains available to future reads. A completed read owns its returned frame, so later expiry, deletion, or eviction cannot revoke that in-process snapshot. The frame timestamp enforces logical `F`/`M` age, future-frame rejection, and shadow value-age observability. `payload` is produced by the operation's serializer, or by `JsonSerializer` by default. Custom serializers can return either `string` or `Buffer`. Payloads stored raw keep their exact serialized bytes: strings are stored as UTF-8 and Buffers byte-for-byte without base64 expansion, except that binary output beginning with a [compression envelope byte](#compression) (`0x00`–`0x02`) gains a one-byte escape prefix on the wire. Payloads at or above the compression threshold may instead be stored as a zstd envelope (see [Compression](#compression)), so wire bytes for large values are not the serializer's output. Adapters return the frame payload as-is; the envelope — including restoring a compressed string's representation before `serializer.load` — is interpreted by the core above them.

DialCache uses native `JSON.stringify` and `JSON.parse` by default. There is no runtime validation pass, so the default adds no traversal beyond JSON serialization itself. A top-level `undefined` result is supported with an internal sentinel.

When `serializer.load` rejects a Redis payload, DialCache records a `serialization_load` error, counts the read as a remote cache miss, runs the fallback, and attempts to replace the rejected payload. A validating custom serializer can therefore treat an incompatible cached value as a refreshable miss without adding a schema version to the cache key.

`JsonSerializer` validates JSON syntax only. It cannot detect that a structurally valid payload came from an incompatible application value schema. Applications that keep the same `useCase` across deployments must keep default-JSON values backward compatible. For an incompatible change, either provide a serializer whose `load` method validates and rejects the old shape, or change `useCase` to isolate the new cache entries. On the caller-serving Redis path, mutually incompatible validating serializers in a mixed deployment can repeatedly reject and replace each other's values; correctness is preserved, but expect additional fallback and Redis-write load until the rollout converges. Shadow work reports a non-null payload that fails `load` as `deserialization_error` and never replaces it.

When a cached function or inline loader's resolved return type is statically JSON-compatible, `serializer` remains optional. This includes JSON primitives, arrays, plain object/interface shapes, optional object fields, and a top-level `undefined`. Types known not to survive the default round trip require a typed `Serializer<T>`:

```ts
import { DialCache, type Serializer } from "dialcache";

const dialcache = new DialCache();
const dateSerializer: Serializer<Date> = {
  dump: (value) => value.toISOString(),
  load: (value) => new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value),
};

const getUpdatedAt = dialcache.cached(
  (userId: string) => db.fetchUpdatedAt(userId),
  {
    keyType: "user_id",
    useCase: "GetUpdatedAt",
    cacheKey: (userId) => userId,
    serializer: dateSerializer,
  },
);
```

The compile-time guard rejects known incompatible shapes such as `Date`, `Map`, `Set`, `bigint`, symbols, functions, Buffers, typed arrays, method-bearing class instances, required nested `undefined`, `unknown`, and `any`. It applies to every `cached()` declaration and `getOrLoad()` invocation because active layers are selected at runtime. A global Redis serializer is not parameterized by each returned type, so it cannot discharge this requirement; non-JSON operations must select a typed serializer.

This guard is deliberately conservative and is not a proof of runtime data. TypeScript cannot detect non-finite numbers, cyclic/shared references, runtime getter or `toJSON` behavior, or data-only class instances that look like plain objects. Opaque, generic, or deeply recursive types may also require an explicit serializer. Providing `Serializer<T>` (including an explicitly typed `JsonSerializer<T>`) is a trusted caller assertion; DialCache does not serialize-and-deserialize again to validate it.

#### Protocol cutover

The old and new tracked-write protocols must not coexist. Before enabling this release for a namespace, stop and drain every old writer and invalidator plus in-flight fallbacks, shadow work, Redis client queues, and other operations that can still write tracked state. Then purge every tracked value — complete or placeholder — and every watermark in the affected namespace. A full namespace flush is the simplest option when the Redis deployment is dedicated; untracked complete values may be retained.

Alternatively, keep all traffic disabled until every old tracked value and watermark has expired naturally. That is safe only when the maximum remaining lifetime of both classes is bounded, no watermark is persistent, and the wait covers the old release's maximum value TTL and future-buffer-derived watermark TTL. This library intentionally does not implement the external deployment gate.

#### Compression

DialCache transparently compresses serialized Redis payloads with zstd (level 3, via `node:zlib`) when they are at least 4096 serialized bytes, and stores the compressed form only when it is smaller than the raw stored form. Compression sits below the serializer and above the Redis client, so serializers, adapters, and the frame layout are unaffected. A refill already known to be fenced is rejected before `serializer.dump` reaches this layer, avoiding compression and large intermediate payload/frame allocation as well as the native `SET`. The first byte of a binary frame payload written by a release with payload compression is an envelope byte: `0x01` marks a compressed UTF-8 string and `0x02` compressed binary output, each followed by the zstd frame, while `0x00` is an escape prefix for raw binary serializer output whose own first byte is `0x00`–`0x02` (readers strip the prefix and never decompress it; the escape applies even with `compression: false`). Payloads below the threshold are otherwise stored byte-identical to earlier DialCache releases; only binary output beginning with an envelope byte gains the one-byte escape.

Decompressed payloads are capped at 512 MiB, mirrored on the write side by refusing to compress anything larger, so no writable entry is unreadable and a corrupt or hostile entry cannot force a giant synchronous allocation. zstd runs synchronously on the event loop: at level 3 it stays cheaper than the adjacent `JSON.stringify`/`parse` at every size (~2 ms to compress 2 MiB), but cost rises steeply with level — measured ~250 ms for 1 MiB at level 19 and ~1.5 s for 2 MiB at level 22 — so treat high levels as an informed opt-in and watch the compression timer metric.

Compression is on by default and configured per instance next to the serializer:

```ts
const dialcache = new DialCache({
  redis: {
    client: redisClient,
    // Defaults shown; pass compression: false to store every payload uncompressed.
    compression: { thresholdBytes: 4096, level: 3 },
  },
});
```

Reads always decompress marked payloads regardless of this setting, so disabling compression never orphans previously written entries. The escape prefix makes decoding exact for every entry written by a release with the envelope, whatever bytes a custom serializer emits. Entries written by older releases have no envelope, which leaves a bounded residual until they expire: a legacy binary payload beginning `0x01`/`0x02` is handed back untouched when zstd rejects it (`fallback_raw`), but one whose remaining bytes parse as a zstd stream is misread, and a legacy payload whose first two bytes are both in `0x00`–`0x02` loses its first byte to the escape strip. If a custom binary serializer can emit such output, bump its use case or key type when upgrading so old entries are simply misses.

Rolling upgrades and rollbacks degrade to misses, not errors, but are visible in metrics: during a mixed-fleet window, readers on releases without payload compression fail `serializer.load` on compressed entries, producing a transient `serialization_load` error spike (and shadow `deserialization_error` outcomes) plus refill churn until the fleet converges — expected noise, worth an alerting note. For a zero-noise upgrade with string/JSON serializers, deploy this release with `compression: false` first, then enable it once the fleet converges; binary serializers with envelope-colliding output still write escaped bytes in phase one, so rely on key versioning there instead. Rolling back to a release without the envelope degrades compressed and escaped entries to refreshable misses the same way, presuming `serializer.load` rejects the foreign bytes — a permissive binary decoder could misread an escaped payload instead, the same caveat as the forward residuals above. On runtimes without `node:zlib` zstd (Node below 22.15, and 23.0–23.7), ESM consumers cannot load the package at all (the import fails), while CommonJS consumers fail at construction when compression is enabled; `compression: false` is the working configuration there for CommonJS only.

Each write records a bounded compression outcome (`compressed`, `below_threshold`, `not_smaller`, or `write_over_limit`) and, when compressed, a compressed-to-original size ratio; reads record `decompressed`, `fallback_raw`, or `read_over_limit` (`write_over_limit` is a capacity signal; `read_over_limit` a corruption/integrity signal). Compression and decompression latency is observed separately with an `operation` label (see [Metrics](#metrics)). Payload sizes are reported at both stages: the size histogram observes serializer output (pre-compression, the distribution to consult when tuning `thresholdBytes`), and the stored-size histogram observes what was actually written after compression and escaping — the difference between their sums is the bytes compression saved.

#### Shadow validation

Shadow mode runs a sampled, detached Redis path for tracked or untracked keys without allowing that path to serve the caller. A Redis hit is compared with the source of truth (SoT); a semantic Redis miss can be filled from the caller-accepted SoT value. Redis serving and shadow execution are independent, and shadowing is opt-in per use case through `shadow.ramp`:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: redisClient },
  // A bundled or custom adapter with shadowValidation support is required.
  metrics,
  // At most one scheduled or running shadow job by default; tune deliberately.
  shadowMaxInFlight: 4,
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    // Optional: make Redis reads watermark-aware; writes remain complete-frame SETs.
    trackForInvalidation: true,
    // Optional: override strict deep equality with use-case semantics.
    shadowComparator: (cached, source) =>
      cached.id === source.id && cached.version === source.version,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 300 },
      // Exercise and populate Redis without serving it to callers.
      ramp: { [CacheLayer.REMOTE]: 0 },
      shadow: {
        ramp: 5,
        // Default-off warning with a bounded key and native-JSON value strings.
        // Enable only after approving the logger and data-handling policy.
        logMismatches: true,
      },
    }),
  },
);
```

Shadow work is eligible only when a valid remote TTL/policy exists, its effective `shadow.ramp` selects the exact cache key, a configured metrics adapter implements `shadowValidation`, and capacity is available. Tracked and untracked Redis keys are both eligible; each keeps its existing read mode and uses the common complete-frame write path. Logging is supplemental to the metric; enabling `logMismatches` does not activate shadow work without the metrics hook. The bundled Prometheus and Datadog adapters implement that hook. There are two paths:

- When remote serving is enabled and produces a Redis hit, DialCache retains the exact serialized payload that supplied the caller as `C0`.
- When the remote policy is valid but disabled specifically by `ramped_down`, DialCache starts a detached Redis read for `C0` using the key's existing tracked or untracked mode. Its result can be validated or used to decide whether a semantic miss may be filled, but can never supply the caller or populate an in-memory layer.

A missing or invalid remote policy, config-provider failure, absent Redis client, disabled call, omitted metrics hook, zero/omitted shadow ramp, cohort exclusion, capacity rejection, or earlier request-local/process-local hit does not launch a shadow-only Redis path. Shadow work begins only if normal traversal reaches the Redis layer. A normally enabled remote miss already follows the caller's ordinary fallback-and-fill path and does not launch a duplicate shadow fill.

On a served hit, DialCache returns the already-decoded cached value before starting the SoT read or any confirmation work. On a ramped-down path, the caller invokes and awaits its normal configured fallback exactly once and receives only that result; detached work reuses the same accepted `S` instead of calling the loader again. The caller never awaits shadow `C0`, comparison, confirmation `C1`, shadow serialization, or fill. Slow, failed, or timed-out shadow work cannot delay, reject, or change the caller result.

The detached job uses this bounded algorithm:

1. Obtain the original Redis payload as `C0` using the key's existing tracked or untracked read mode.
2. If `C0` is missing, wait for the caller's successfully accepted `S` after its configured fallback boundary. For a discriminated tracked watermark miss, sample a preflight timestamp before serialization: emit `fill_fenced` and stop without invoking `serializer.dump`, compression, or Redis when that timestamp is at or before the observed watermark. Otherwise prepare the serialized payload, sample a final timestamp dispatch-adjacent, and recheck the watermark. Emit `fill_fenced` without dispatching `SET` if the final timestamp is at or before the watermark; otherwise attempt one normal Redis write using the resolved TTL and that exact final timestamp. For a classified miss without a valid observed fence, or a legacy `null` miss, attempt the ordinary write without supplying a core timestamp, preserving adapter-side sampling. Before the whole-job deadline, emit `filled` when Redis accepts the write or `fill_error` when serialization or the write fails. A tracked fill can still be physically stored yet remain fenced if the watermark advances after `C0`.
3. If `C0` is non-null, obtain `S`, deserialize an isolated snapshot of `C0`, and run the default or custom semantic comparator. Any non-null `C0` is observation-only: DialCache never repairs or overwrites it, including when deserialization fails.
4. If `C0` and `S` match semantically, emit `match` without another Redis read.
5. Otherwise, reread Redis directly in the same mode as `C1`, bypassing request-local and process-local cache.
6. If `C1` is missing under the normal value/watermark protocol or differs byte-for-byte from `C0`, emit `superseded`; if it is identical, emit `mismatch`. A future-dated `C1` records its offset but remains available for this payload comparison, so a reader-clock step does not change the verdict.
7. If the confirmation read fails or reaches its Redis-read deadline, emit `confirmation_error`.

Here a semantic miss means the Redis read returned a classified `RedisReadMiss`, a discriminated `RedisWatermarkMiss`, or legacy `null`; it does not include a non-null payload that later fails deserialization. A physical frame rejected by its watermark (for tracked reads), timestamp domain, logical-age check, or future-time check is therefore a miss. Only a watermark miss with a valid observed fence can produce `fill_fenced`; its independent reason can still be `value_absent`, `watermark_fenced`, or `unclassified` (`expired` is decided by DialCache after decoding and never carries a fence). Misses without a trustworthy fence and legacy `null` retain normal refill behavior. A caller fallback rejection or timeout never becomes accepted `S` and never starts the fill.

Both detached Redis reads use the effective `remoteReadTimeoutMs` and the key's normal native `GET` or `MGET` protocol. The initial `C0` observation enforces the logical remote TTL `F`; the non-serving `C1` confirmation bypasses logical age solely to determine whether the original payload bytes were superseded. Every dispatched semantic-miss fill uses the same serializer, resolved physical TTL, complete-frame `SET`, and two-sample conditional-refill rules as the caller path; when stale-on-error is active, it requests physical retention through `M` while serving reads still enforce `F`. Misses without a valid observed fence preserve the ordinary adapter-side timestamp sample. Tracked `C0` and `C1` reads remain watermark-aware and are routed to primaries by the bundled adapters. The fill itself never issues another watermark read or mutates the watermark; `fill_fenced` is decided against the watermark from the original `C0` snapshot and adds no round trip. Untracked reads use the ordinary one-key read route, which has no shadow-specific primary guarantee. Strings compare exactly, Buffers compare by bytes, and string/Buffer pairs compare by their UTF-8 bytes. DialCache does not deserialize `C1`, compare it with `S`, or chase another version.

The detached scheduler, Redis-read deadline timers, and overall shadow deadline timer are unreferenced, so they do not keep an otherwise idle process alive. Detachment is asynchronous work on the Node event loop, not a worker thread: synchronous source, serializer, or comparator work can still occupy the event loop after the request path has been released.

Detached execution retains the original `cached()` argument references or `getOrLoad()` loader closure; DialCache cannot generically clone them. Treat object arguments, captured source-selection state, and the returned `S` as immutable, or snapshot them before invoking DialCache. Mutating them after the caller continues can compare or serialize a value that no longer corresponds to the already-built key.

`shadowMaxInFlight` is a per-instance positive safe integer and defaults to `1`. It counts admitted jobs until shadow-owned Redis/source/serializer/comparator work settles, including detached reads or dispatched writes whose DialCache deadline already elapsed. The optional `C1` and semantic-miss fill remain in the original slot. On a ramped-down path, shadow work shares the caller's SoT promise; once the shadow deadline expires, the raw caller-owned loader may continue without retaining the shadow slot, including when `fallbackTimeoutMs` is `null`. DialCache also suppresses another job for the same exact key while shadow-owned work remains active. There is no queue: exact-key duplicates and work above the instance cap are dropped and reported as `dropped`. Separate instances have independent limits, so this is not a fleet-wide source-of-truth or Redis concurrency cap.

Each job has one monotonic deadline across detached `C0`, the SoT result, serializer work, comparison, optional `C1`, and semantic-miss fill. Served-hit timing begins when its detached validation callback starts. On a ramped-down path, timing begins immediately before the caller's SoT invocation so synchronous source work that runs before admission still consumes the same budget. Each Redis read also has its effective read deadline. A finite `fallbackTimeoutMs` is reused as the overall shadow budget. When `fallbackTimeoutMs` is `null`, the normal fallback remains intentionally unbounded, but detached shadow work still uses a 60-second budget. Once timeout delivery marks a job abandoned, DialCache releases retained `C0` references and prevents later phases from starting.

JavaScript promises and Redis writes do not provide a general cancellation or transaction boundary. Work already dispatched may continue and keeps the shadow slot until it settles. A write rejection, `fill_error`, or shadow `timeout` after dispatch does not prove that Redis was unchanged; the command may have executed before its result became unavailable. Conversely, `filled` means the semantic client returned success before the shadow deadline, not that the value is still present. `fill_fenced` is stronger but narrower evidence: one of DialCache's local fence checks skipped dispatch against the valid watermark observed by `C0`; it does not prove that Redis stayed unchanged afterward. Give dependencies finite native budgets and treat shadow outcomes as best-effort operational evidence.

A `match` means application-level value equality:

- By default, DialCache uses Node's `util.isDeepStrictEqual`. Plain-object property insertion order does not affect the result; values, array order, prototypes, constructors, Buffers, Maps, Sets, and other supported structures remain strictly compared.
- An optional typed `shadowComparator(cachedValue, sourceValue)` on `cached()` or `getOrLoad()` can define narrower domain equality, such as ignoring a volatile timestamp. It must synchronously return a boolean and must be deterministic, side-effect-free, non-mutating, and bounded.
- A comparator throw or non-boolean return is `comparison_error`, never `mismatch`. An accidental promise is not accepted as a comparison result; DialCache consumes its settlement while retaining the shadow slot, subject to the same detached deadline.

DialCache retains the semantic frame returned by the Redis client — its `string | Buffer` payload and `createdAtMs` — but never exposes it to the comparator. After the source read completes, detached work calls the same effective serializer's `load` method to create an independent cached snapshot, then compares that snapshot with the raw value returned by the source loader. It does not reuse the cached object already returned to a served-hit caller, so caller mutation cannot contaminate validation. No payload copy, shadow deserialization, deep comparison, or hash is added to the served-hit request path.

The effective serializer's `load` method therefore runs a second time for a sampled served hit and once in detached work for a shadow-only hit. It must be repeatable, non-mutating, and return independently usable values. On a semantic miss, its `dump` method may run after the caller has received `S`, so `S` must remain immutable through detached serialization. A custom `DialCacheRedisClient` must return an operation-owned frame whose string/Buffer payload contents remain stable after `read()` settles. Comparing the deserialized cached snapshot with the raw source value intentionally detects lossy serialization; use a custom comparator only when such normalization or ignored fields are valid use-case semantics.

Shadow metrics use the bounded outcomes `match`, `mismatch`, `superseded`, `filled`, `fill_fenced`, `fill_error`, `redis_error`, `source_error`, `deserialization_error`, `comparison_error`, `confirmation_error`, `timeout`, and `dropped`. `redis_error` applies to the initial shadow-only `C0` read and `confirmation_error` applies to `C1`. A semantic `C0` miss is an ordinary `miss{layer="remote_shadow"}` and terminates with `filled`, `fill_fenced`, `fill_error`, `source_error`, or `timeout` rather than a second shadow outcome for the miss itself. Labels never contain cache ids, values, payloads, Redis keys, or raw exception text.

A `match` or `mismatch` verdict additionally records the validated value's age through the optional `observeShadowValueAge` adapter hook: the observing process's epoch clock minus the writer-stamped frame's `createdAtMs` (the served `C0` frame, or the detached `C0` frame on a ramped-down path), in seconds, clamped at zero. The age is captured at verdict time, so a mismatch age lands one confirmation read after the comparison itself. A confirmed `mismatch` age therefore measures how long the stale value had been readable when validation caught it. Because writer and observer are different application processes, their clock offset makes the age coarse operational evidence rather than a precise measurement. Outcomes that deliver no verdict on a retained value — including `superseded`, `filled`, `fill_fenced`, and every error or timeout outcome — record no age. The hook does not gate shadow eligibility; only `shadowValidation` does.

Confirmed-mismatch logging is separately opt-in through `shadow.logMismatches`; it never replaces the required `shadowValidation` metric or emits for a mismatch candidate that becomes `superseded`. The single warning contains `cacheNamespace`, `useCase`, `keyType`, `outcome: "mismatch"`, `cacheKey`, `cachedValueJson`, and `sourceValueJson`. `cacheKey` is the logical DialCache URN capped at 2 KiB, not the physical Redis storage key. DialCache independently applies native `JSON.stringify` to the deserialized cached snapshot and raw source value supplied to the comparator, then caps each resulting string at 8 KiB. A byte-clipped field ends in `...[truncated]`, counted inside its cap. If native JSON throws or returns `undefined`, the corresponding JSON field is `null`; the other side is still attempted. DialCache does not compute a textual diff or call the configured serializer again for logging.

Mismatch logging is intentionally default-off. Logical URNs can contain ids and arguments, while cached and source values may contain secrets or personal data; truncation is not redaction. DialCache creates the JSON strings only after terminal mismatch confirmation and never passes the raw compared-value references to the logger. Native JSON semantics apply: getters and `toJSON` methods may run, unsupported values may be omitted or normalized, and cycles or `bigint` can make a field unavailable. Stringification is synchronous, and the 8 KiB caps apply only after `JSON.stringify` returns; they do not bound input traversal, hook execution, event-loop time, or the intermediate JSON string. Enable mismatch logging only for trusted, reasonably bounded values and with an approved logger, redaction, transport, access, and retention policy.

The byte caps apply before logger framing or escaping, so they do not guarantee a final transport event below a sink-specific limit; the metadata fields are not size-clamped. A detail-construction failure degrades to the metadata-only warning. Logger throws and rejected promises or thenables remain isolated from cache and shadow correctness.

Detached Redis reads, serializer loads/dumps, payload sizes, and read/write errors use the existing layer label with `layer="remote_shadow"`. This distinguishes non-serving Redis cost from caller-path `layer="remote"` telemetry without adding a metric or label. The established `observeGet{layer="remote"}` boundary includes caller-path deserialization, while `observeGet{layer="remote_shadow"}` ends when the deadline-bounded Redis read result settles; detached serializer work and any later raw-client settlement are outside that timer. The request-path read that supplied a served `C0` keeps `layer="remote"`, and a ramped-down caller keeps `disabled{layer="remote", reason="ramped_down"}`. No `disabled{layer="remote_shadow"}` event is emitted for ineligible or dropped work; `dropped` remains the terminal shadow outcome. Confirmation reads use the same `remote_shadow` value, with `superseded` or `confirmation_error` describing their role.

The command amplification is bounded: a selected served hit adds one SoT read and adds `C1` only for a semantic mismatch candidate; a selected ramped-down hit adds detached `C0`, reuses the caller's existing SoT read, and likewise adds `C1` only for a candidate; a selected ramped-down miss adds detached `C0` and at most one fill in the key's existing mode. A fenced tracked fill adds no `SET`, and a preflight fence also avoids payload preparation; no path adds a fence-check command. `superseded` means only that the original observation could not be confirmed. `mismatch` means the exact `C0` payload survived another Redis read after the SoT disagreement; it is not a cross-system atomic snapshot or a guarantee that the mismatch persists. For an untracked key it is also not proof of primary freshness or invalidation safety.

The initial `C0` read and later fill are not atomic. A discriminated miss with a valid observed watermark can suppress a fill against the `C0` fence regardless of the independent miss reason, but an allowed fill is still a normal overwrite, not a compare-and-set or write-if-still-missing operation: another writer can populate Redis after the semantic miss and be overwritten by the shadow fill, or a later invalidation can fence it. For tracked keys, the next atomic value-and-watermark read still rejects a frame whose client timestamp is at or before the watermark, so size `futureBufferMs` to cover the complete SoT, serialization, client queue, network, write interval, and fleet clock-skew budget when stale-serving protection matters. An untracked shadow fill has no such read fence and retains the ordinary TTL-based last-writer-wins contract; because it is detached, an older accepted source value may be written after a concurrent source mutation and remain until expiry. Shadow mode never repairs a frame returned as a non-null semantic `C0`; a physical frame rejected by normal tracked-read semantics is a miss and may be overwritten with a fresh TTL unless its observed fence still rejects the refill. Shadow work never invalidates, evicts local state, or changes the value returned to the caller.

A served-hit sample invokes the wrapped function or inline loader as an additional source read, so that loader must be safe to call for observation. A ramped-down sample reuses the caller's ordinary invocation and does not add another SoT call.

For valid policies, shadow-specific source calls, cache-path Redis traffic, returned values, and metrics are unchanged when `shadow` is omitted or `shadow.ramp` is `0`. Shadow policy is grouped under `DialCacheKeyConfig.shadow`; consumers of the former flat ramp field must migrate to `shadow: { ramp }`. The public constructor, static defaults, and runtime provider results reject the removed field. `DialCacheKeyConfig.disabled()` explicitly disables the shadow ramp and mismatch logging. `shadowComparator` remains a typed `cached()` / `getOrLoad()` option because it defines stable use-case equality, while `shadowMaxInFlight` remains a per-instance concurrency limit. The semantic-miss bootstrap adds no additional ramp knob, Redis protocol operation, metric instrument, or label key; enabling shadowing authorizes the same Redis write described above. Untracked keys participate when they have a nonzero effective shadow ramp and an observable metrics hook. Exported unions include `remote_shadow` in `MetricLayer` and `superseded`, `filled`, `fill_fenced`, `fill_error`, `redis_error`, and `confirmation_error` in `ShadowValidationOutcome`. TypeScript consumers with exhaustive switches or `Record` values must include those cases, and dashboards restricted to `layer="remote"` intentionally exclude detached traffic.

## Cached-value ownership

Treat values returned by cached functions or `getOrLoad()` as immutable. DialCache does not clone or freeze values stored in request-local or process-local memory. Mutating a cached object can therefore be observed by later callers in the same request, callers in other requests that hit the process-local cache, or callers that coalesced onto the same in-flight result.

This contract includes nested objects and arrays, `Map`, `Set`, `Buffer`, typed arrays, and class instances. Redis deserialization can produce a different reference from an in-memory hit, so reference identity is layer-dependent and is not part of the API contract; never rely on a specific layer cloning a value before mutation.

If a caller needs a mutable value, copy it explicitly before changing it:

```ts
const sharedUser = await getUser("123");
const editableUser = structuredClone(sharedUser);
editableUser.displayName = "New name";
```

Use a narrower copy when its semantics are sufficient; the ownership boundary is the caller's responsibility.

## Targeted invalidation and watermarks

Mutable Redis-backed use cases can opt into targeted invalidation by setting `trackForInvalidation: true` in the options and calling `dialcache.invalidateRemote(keyType, id, futureBufferMs)` after writes. `invalidateRemote` requires `DialCacheConfig.redis`; local-only caching remains supported, but this explicit remote maintenance operation rejects when Redis is absent. The buffer is an application-owned safety value; DialCache cannot choose a universally safe nonzero value:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: createNodeRedisDialCacheClient(redisClient) },
});

// Chosen from this application's clock-skew bound and measured worst-case source/fallback timings.
const USER_INVALIDATION_BUFFER_MS = 5_000;

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetMutableUser",
    cacheKey: (userId) => userId,
    trackForInvalidation: true,
    // Strongly invalidated mutable data should disable request-local and process-local caching.
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 300 },
      ramp: { [CacheLayer.REMOTE]: 100 },
    }),
  },
);

await updateUser("123", patch);
await dialcache.invalidateRemote("user_id", "123", USER_INVALIDATION_BUFFER_MS);
```

Invalidation writes a Redis watermark at `{encodedNamespace:encodedKeyType:encodedId}#watermark`. Tracked Redis cache entries use the same Redis Cluster hash tag, for example `{users-api:user_id:123}?locale=en#GetMutableUser:dialcache-frame-v1`, so the value key and watermark key live in the same slot. Key components are percent-encoded before joining so delimiters inside IDs or args cannot collide with delimiters in the key format. Components may not contain `{` or `}` because those characters would corrupt the hash tag.

The internal `:dialcache-frame-v1` suffix identifies values written with DialCache's binary protocol. Watermarks are stored as decimal timestamps.

A complete supported Redis frame with a positive safe-integer `createdAtMs` at or below a valid observed watermark is a `watermark_fenced` tracked miss. `invalidateRemote(keyType, id, futureBufferMs)` proposes the invalidating process's `Date.now()` plus the buffer, and Lua keeps the greater of that proposal and the existing watermark. A tracked read obtains value and watermark in one primary-routed `MGET`; a missing watermark is the zero baseline, malformed or out-of-range decimal state is `unclassified` for a present frame, while a `nil` value stays `value_absent`. A zero-stamped tracked frame is also `unclassified`, not evidence of watermark invalidation. Redis also returns `nil` for a wrong-type member of `MGET`, so a wrong-type watermark has the same zero-baseline behavior as an absent one until the next explicit invalidation repairs it. When the same snapshot contains a valid numeric watermark and an adapter-level semantic miss, the bundled adapter returns `RedisWatermarkMiss { kind: "watermark_miss", reason, observedWatermarkMs }`. The reason remains independent: a missing value is `value_absent` while carrying the same refill fence, and only a complete supported frame actually rejected by the watermark is `watermark_fenced`. After the fallback succeeds, DialCache samples a preflight timestamp before serialization. If it is at or before `observedWatermarkMs`, fallback still returns normally but the replacement is skipped before serializer/compression/frame work and `SET`. Otherwise DialCache prepares the payload, samples a final dispatch-adjacent timestamp, and rechecks the same watermark. A final timestamp at or before the watermark suppresses `SET`; an admitted write encodes that exact final timestamp so serialization time does not consume the stored value's logical TTL. Classified misses without a valid observed fence and legacy custom adapters that return `null` retain normal refill behavior. Native `MGET` must still transfer the full stored frame before Node can apply the fence verdict, so a future window can repeatedly transfer a large fenced payload even when replacement work is suppressed. A tracked invocation that reaches the Redis read/write path does not publish its fallback directly to process-local cache; a later validated Redis hit may warm it. Local-only, remote-policy-disabled, and ramped-down paths remain governed by local policy, while request-local memoization remains unconditional. A ramped-out invocation without shadow work does not consult Redis; selected tracked shadow reads remain watermark-aware.

All serving timestamps come from application-process epoch clocks; DialCache does not call Redis `TIME`, estimate an offset, or compensate for skew. Participating application nodes therefore need external clock synchronization and monitoring. Healthy managed node pools commonly stay close, but Kubernetes does not guarantee a maximum offset, and pauses or NTP faults can be much larger than normal millisecond-scale skew. Relative clock differences shift logical expiry early or late, while frames dated after a reader clock fail closed until that clock catches up. Operation durations and deadlines continue to use the monotonic `performance.now()` clock.

Watermarks are invalidation state, not disposable cache entries. The Redis deployment must preserve them for their derived TTL: use `noeviction` or an equivalent guarantee for deployments that rely on the read-time fence, and choose persistence and failover guarantees appropriate to the application's consistency requirements. If a watermark is lost, a tracked read treats it as zero and may serve an existing frame that the lost watermark had fenced. Alert on memory headroom and rejected writes under `noeviction`; if another eviction policy is used, also alert on `evicted_keys`. Redis replication is asynchronous by default, and DialCache does not issue `WAIT` or provide strong consistency across failover.

Tracked Redis value TTLs are capped at one hour; a dispatched write configured above the cap records `tracked_ttl_clamped`. Only invalidation creates or updates a watermark. Its TTL is `max(existing TTL, 2 hours, watermark - invalidatedAtMs + 1 hour + 1 minute)`; an existing persistent watermark stays persistent. Reads and writes never extend it. Under the documented clock-skew and in-flight-work bounds, this makes every finite watermark outlive every value it can fence, including a maximum future-buffer proposal. Raising the tracked-value cap or shrinking the watermark floor is a protocol transition that requires another no-overlap gate, drain, and purge; changing both constants in one new binary cannot lengthen watermarks already written by an older invalidator.

`futureBufferMs` must be a nonnegative safe integer no greater than 31,536,000,000 (a fixed 365-day duration). The default is zero, but zero provides no stale-serving protection once a writer timestamp advances past the watermark. Every production invalidation should pass a named, application-owned nonzero value based on that application's measured or conservatively bounded timings; there is no universally safe library value.

Let `Dmax` be the maximum elapsed time from invalidation sampling until a stale pre-mutation `SET` can become visible in Redis, `S` the maximum writer-clock lead over the invalidator across participating application nodes, and `M` an operational margin. Callers that require stale-serving protection must satisfy `futureBufferMs >= Dmax + S + M`. Bound `Dmax` through source visibility or replication lag, the remaining tail of any fallback that may observe the pre-mutation value, `serializer.dump`, Redis client queueing or reconnect/offline-queue delay, network transit, and Redis execution and visibility. An unbounded offline queue or retry path makes a finite `Dmax` impossible. Invalidate only after the source mutation commits. The dangerous skew direction is a fast writer and slow invalidator: an undersized buffer can let delayed stale work receive a timestamp above the watermark and remain readable until expiry or another invalidation. The reverse direction is conservative. Overestimating the buffer still increases fallback load and full-payload `MGET` transfer on hot large-value keys. While a candidate remains behind a valid observed watermark, bundled and correctly opted-in adapters now avoid serializer/compression work plus full-frame `SET`, replication, and AOF churn; that work resumes once the candidate advances beyond the observed fence, and legacy `null` adapters continue the normal write path. The optimization does not delay or suppress returning fallback values to callers.

The fixed one-minute watermark-TTL margin is retention slack after the covered visibility bound; it is not a substitute for `Dmax`. The operational contract should include the full post-sample dispatch tail in `Dmax` rather than relying on that slack.

This is a read-time timing contract rather than a cancellation or acquisition fence. The buffer makes covered frames unreadable. A typed miss can locally avoid a replacement already known to be fenced, but it does not cancel previously dispatched work, prevent a later watermark advance from fencing an allowed `SET`, or force fallback to read from an authoritative source.

The version-1 value envelope, Redis keys, and decimal watermarks remain wire-format-compatible. The adapter contract and Lua surface are not source-compatible: `write()` is now void and has no `watermarkKey`; the stamp script, placeholder helpers, and `DialCacheRedisPlaceholderLostError` are removed; `dialcacheRedisScripts` and `DialCacheNodeRedisScripts` are removed because node-redis manages invalidation dispatch internally; `ValkeyGlideRuntime` no longer requires `ClusterBatch`; invalidation is the only script; `fill_blocked` is removed from `ShadowValidationOutcome`; and `tracked_ttl_clamped` is added to `MetricErrorKind`, so exhaustive switches and `Record<MetricErrorKind, ...>` values must add it. The conditional-refill addition itself does not change the Redis wire format, key format, Lua surface, command types, or round-trip shape; it may suppress an otherwise-dispatched `SET`. `RedisReadResult` is widened with classified `RedisReadMiss` results, and the bundled adapters now return `RedisReadMiss` or `RedisWatermarkMiss` instead of `null` for every semantic miss, so code that compares a bundled adapter's `read()` result to `null` must be updated; the prior `RedisWatermarkMiss` remains source-compatible, and a custom adapter returning the legacy `DecodedRedisFrame | null` also remains correct. `RedisWriteRequest.createdAtMs` is optional for source compatibility and direct callers may omit it; adapters returning a typed miss with a valid observed watermark must honor a supplied value exactly. `fill_fenced` is added to `ShadowValidationOutcome`, so exhaustive switches and `Record<ShadowValidationOutcome, ...>` values must include it. The Prometheus future-timestamp histogram now uses a dedicated skew-oriented bucket schema, which is incompatible with an existing same-name collector registered with the former default buckets. Follow the externally gated [protocol cutover](#protocol-cutover) before deployment. Deploy the future-timestamp metric and external node-clock alerts first. The metric is only a workload-shaped smoke detector: it cannot detect co-skewed readers and writers, an ahead invalidator, watermark skew hidden by a fenced miss, or which node is wrong.

Targeted invalidation is remote-only and enforced by Redis watermarks. `invalidateRemote` does not evict existing request-local or process-local entries. Strongly invalidated mutable data should disable request-local and process-local caching (or use a very short process-local TTL only when stale reads are acceptable).

## Request coalescing

DialCache coalesces in-flight work at the lifetime of the first active cache layer:

- When request-local caching is enabled, same-key callers in one outermost `enable()` scope share request-scoped in-flight work before the request-local lookup. Its resolved value is then memoized for later sequential calls in that scope.
- When process-local or Redis caching is enabled, same-key callers share in-flight work within one `DialCache` instance before the first active shared layer. This is reported as `scope="process"`, still applies when request-local caching is off, and can combine leaders from separate request scopes using the same instance.

```ts
await dialcache.enable(async () => {
  // Same cold key, concurrent calls: one fallback execution, one shared result.
  const [a, b] = await Promise.all([getUser("456"), getUser("456")]);
});
```

With Redis configured, an instance-scoped leader that misses the process-local cache runs one bounded Redis read and, on a normal miss, the fallback/cache write; followers share its remaining read budget and await the same result. On a shadow-selected served Redis hit, only that leader can schedule detached validation, so followers do not multiply source reads. Process-local-only misses share the leader's fallback/cache write. This protects Redis and the source of truth from a thundering herd on hot keys.

Coalescing only applies when at least one cache layer is active and the use case's resolved `coalesce` policy has not disabled it. Calls outside `enable()` are true pass-through. Calls where request-local, process-local, and Redis serving are all disabled are uncached and uncoalesced, even if shadowing independently schedules detached Redis work; same-key shadow deduplication drops duplicate jobs but does not combine caller fallbacks. Because these calls were initially enabled, the fallback deadline below still applies.

Because coalescing is keyed by the selected or direct key, concurrent calls with the same key share the leader's execution. Any function argument or captured value omitted from the key must be safe to share this way; include inputs such as locale, auth context, or cancellation behavior when they can change the returned value or whether the underlying loader should run separately.

The per-use-case `coalesce` boolean (default true) turns this sharing off. `coalesce: false` in a `defaultConfig` or runtime overlay disables both scopes: same-key concurrent callers each perform their own layer reads with their own full remote-read budget, their own fallback with an independent [fallback deadline](#fallback-deadlines), and their own cache writes — request-local and process-local publication is last-writer-wins, every Redis write is one complete-frame last-writer-wins `SET`, and tracked Redis reads later apply their usual watermark fence. Request-local memoization of settled values still serves later sequential calls in the same scope. Use it when the key intentionally omits per-caller inputs that must not be shared, or when callers must not inherit a leader's failure, `FallbackTimeoutError`, or stale-recovery result. Disabling coalescing reintroduces the thundering-herd exposure described above, emits `request`/`miss`/latency metrics once per caller instead of once per flight, never emits `dialcache_coalesced_counter`, and keeps `getCoalescingState()` idle for that use case. With shadow work enabled, each un-coalesced caller may attempt to schedule detached validation; same-key shadow deduplication and `shadowMaxInFlight` still bound admitted jobs and drop the excess, but source reads are no longer combined.

### Fallback deadlines

Once an initially enabled invocation starts its fallback, DialCache applies a 60-second monotonic deadline by default. Set `fallbackTimeoutMs` once on a cached wrapper or on each `getOrLoad()` invocation to choose a positive integer deadline in milliseconds, up to 2,147,483,647, or set it to `null` to preserve an intentionally unbounded fallback:

```ts
import { FallbackTimeoutError } from "dialcache";

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUserWithDeadline",
    cacheKey: (userId) => userId,
    defaultConfig: DialCacheKeyConfig.enabled(60),
    fallbackTimeoutMs: 2_000,
  },
);

try {
  await dialcache.enable(() => getUser("123"));
} catch (error) {
  if (error instanceof FallbackTimeoutError) {
    logger.warn("source lookup exceeded its DialCache budget", {
      useCase: error.useCase,
      timeoutMs: error.timeoutMs,
    });
  }
}
```

The timer starts only when the fallback begins, including after a remote-read deadline has elapsed. When coalescing is enabled (the default), same-key followers share the process or request-local leader's remaining budget and timeout outcome; pass-through invocations where every layer is disabled, and callers whose use case disables `coalesce`, have independent timers. A timeout produces `FallbackTimeoutError`, which the built-in stale-recovery classifier authorizes when the initial Redis read retained a candidate within `M`; otherwise callers receive the error. Cache hits create no fallback timer. Calls that were initially outside an enabled context remain true pass-through and are not timed out, even when the operation configures `fallbackTimeoutMs`.

Deadline delivery requires the JavaScript event loop to make progress. It cannot preempt a synchronous fallback prefix or other event-loop blocking, so rejection can arrive later than the configured duration; when control returns, DialCache checks the monotonic deadline before accepting the result. The deadline timer remains referenced until the fallback settles or times out. Consequently, an abandoned enabled fallback can keep an otherwise idle short-lived process alive until that deadline; shutdown code should drain outstanding DialCache work rather than discarding its promises.

Timing out rejects the source attempt with `FallbackTimeoutError`; the DialCache chain either serves an authorized retained candidate or rejects with that exact error, then clears its flight normally. A later fallback resolution is ignored, so that timed-out invocation cannot become the accepted `S` for a shadow fill or proceed to ordinary serializer, Redis, or local-cache publication. The underlying function is not canceled and may continue its own I/O or side effects; give the source operation its own native timeout or `AbortSignal` whenever possible. `fallbackTimeoutMs: null` disables this guard and makes finite fallback settlement entirely application-owned. Use the `null` escape hatch only after intentionally accepting that liveness risk. It does not create an unbounded detached shadow operation: [shadow validation](#shadow-validation) still uses a 60-second whole-job budget.

Timeout failures retain the bounded metrics classification `error="fallback"` with `in_fallback="true"`; the typed error provides the timeout details without adding high-cardinality labels.

### Coalescing state

`getCoalescingState()` returns a detached, point-in-time snapshot of process-scoped flights owned by that `DialCache` instance:

```ts
const state = dialcache.getCoalescingState();

state.process.activeLeaders;
state.process.activeFollowers;
state.process.oldestLeaderAgeMs; // null when idle
```

A leader is one exact cache key currently tracked by the instance-scoped coalescer. A follower is each later invocation that joined that pending leader; the initiating invocation is not counted as a follower. Followers remain counted until their leader settles because abandoning a JavaScript promise is not observable. Request-local flights are deliberately excluded because their lifecycle is bounded by the outer `enable()` scope. Use cases that disable `coalesce` never register process flights and never appear in the snapshot. `oldestLeaderAgeMs` uses a monotonic clock and is computed when the snapshot is requested.

There is no library-wide flight cap or age-based replacement. A registry cap would bound only DialCache metadata while overflow or eviction could still create unbounded source work and unsafe duplicate publication. Finite operation deadlines provide eventual cleanup; application admission control and backpressure remain responsible for bounding simultaneous distinct-key work. Monitor leader count and oldest age to verify that those budgets hold in production.

## Metrics

Metrics are disabled unless a `DialCacheMetricsAdapter` is passed to the constructor. `new DialCache()` does not import a metrics backend, register collectors, or emit metrics.

### Prometheus

Install `prom-client` separately, create the registry your application owns, and pass the explicit Prometheus adapter to DialCache:

```bash
pnpm add prom-client@^15.1.3
```

```ts
import { Registry } from "prom-client";
import { DialCache } from "dialcache";
import { createPrometheusDialCacheMetrics } from "dialcache/prometheus";

const registry = new Registry();
const dialcache = new DialCache({
  namespace: "users-api",
  metrics: createPrometheusDialCacheMetrics({
    registry,
    prefix: "myapp_", // myapp_dialcache_request_counter, etc.
  }),
});

app.get("/metrics", async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
```

The adapter requires a caller-owned `Registry`; it never uses the global default registry and does not clear or otherwise own the registry lifecycle. Multiple adapters with the same registry and prefix reuse existing collectors when their type, help, labels, histogram buckets, and exemplar mode match. Adapter construction fails before registering anything if a same-name collector has an incompatible schema; use a unique prefix or a separate registry to resolve the collision. In particular, `dialcache_miss_counter` now has five labels rather than four, so an old four-label collector under the same registry and prefix is incompatible. Old and new DialCache versions cannot share that in-process registry/prefix; the old-schema collision fails before any partial registration.

The Prometheus adapter emits:

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `dialcache_request_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `dialcache_miss_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache misses, classified by one required bounded reason |
| `dialcache_disabled_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache skips (`context`, `policy_disabled`, `invalid_ttl`, `invalid_ramp`, `ramped_down`, `config_error`) |
| `dialcache_error_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache/fallback errors and the bounded `tracked_ttl_clamped` configuration signal |
| `dialcache_invalidation_counter` | Counter | `cache_namespace`, `key_type`, `layer` | Invalidation calls for the layers touched |
| `dialcache_coalesced_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `scope` | Coalesced requests split by `request_local` or `process` scope |
| `dialcache_shadow_validation_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `outcome` | Sampled Redis shadow-job outcomes |
| `dialcache_shadow_value_age_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `outcome` | Age in seconds of the validated Redis value at shadow verdict time, recorded for `match` and `mismatch` |
| `dialcache_future_timestamp_offset_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Positive offset in seconds for a valid frame dated after the observing process clock |
| `dialcache_stale_recovery_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `outcome` | Classifier-authorized stale-recovery checks: `served`, `miss`, or `deserialization_error` |
| `dialcache_stale_recovery_value_age_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `outcome` | Actual return-time age in seconds of a retained value, recorded only for `served` |
| `dialcache_compression_counter` | Counter | `cache_namespace`, `use_case`, `key_type`, `layer`, `outcome` | Payload compression outcomes: writes record `compressed`, `below_threshold`, `not_smaller`, or `write_over_limit`; reads record `decompressed`, `fallback_raw`, or `read_over_limit` |
| `dialcache_get_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `dialcache_fallback_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Elapsed time until the underlying function settles or timeout rejection is delivered |
| `dialcache_serialization_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency |
| `dialcache_size_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes, before compression |
| `dialcache_stored_size_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Stored Redis payload size in bytes, after compression and escaping |
| `dialcache_compression_ratio_histogram` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Compressed-to-original payload size ratio for compressed writes |
| `dialcache_compression_timer` | Histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Payload compression and decompression latency in seconds |

`dialcache_miss_counter` remains one miss counter, not a parallel reason or compatibility counter. Its required `reason` is exactly one of:

| `reason` | Meaning |
| --- | --- |
| `value_absent` | The layer had no retrievable value, including never-populated, physically expired, evicted, Redis `nil`, and tracked-`MGET` wrong-type-as-null states. Request-local and local misses always report this reason. |
| `expired` | A complete supported frame with a valid, non-future timestamp was present, but its logical age against the reader's clock reached the effective remote TTL `F`. This includes `F <= age < M` frames retained as stale-on-error recovery candidates and frames at or beyond `M`; with stale-on-error configured it is the routine steady-state expiry reason. |
| `watermark_fenced` | A complete supported tracked frame with a positive safe-integer timestamp was rejected because it was at or before a valid observed invalidation watermark; this happens before deserialization and does not assert that the payload would deserialize. |
| `unclassified` | The miss was real but cannot be attributed to any prior category, including legacy/custom Redis `null`, short or unsupported frames, malformed watermark metadata paired with a present frame, invalid or future timestamps, and caller-side deserialization failures. |

This is an intentional Prometheus schema migration. During a mixed-fleet rollout, old scraped miss series lack `reason` while new ones carry it. For existing total-miss queries and miss/request ratios, aggregate away `reason` and scrape labels on both sides—for example, `sum by (cache_namespace, use_case, key_type, layer) (rate(dialcache_miss_counter[5m])) / sum by (cache_namespace, use_case, key_type, layer) (rate(dialcache_request_counter[5m]))`. Reason-aware dashboards should group explicitly by `reason`.

The future-timestamp histogram uses dedicated buckets from millisecond-scale skew through multi-hour clock faults. It records one positive offset after a valid frame is decoded. Caller-serving and initial shadow reads then reject that frame; confirmation reads retain it only for payload-equality classification. Invalid or non-finite timestamp values miss without entering histogram sums. The same future frame can be observed repeatedly. Alert against the deployment's allocated skew budget, not every millisecond-level sample.

`policy_disabled` means that a process-local or Redis layer has no effective TTL after runtime overlays are applied. It is an intentional policy outcome, including the default when `defaultConfig` is omitted, rather than a configuration-loading failure.

Every metric carries `cache_namespace`, including disabled-context, key-construction, coalescing, shadow-validation, stale-recovery, and invalidation paths that do not have a constructed key. Its value is `DialCacheConfig.namespace`, defaulting to `urn`. The `layer` label is `request_local`, `local` (process-local), `remote` (caller-serving Redis), or `remote_shadow` (detached, non-serving Redis work); `noop` means no cache layer was reached. Detached reads, serializer work, payload sizes, and Redis read/write errors use `remote_shadow`, while the dedicated bounded shadow `outcome` records the terminal job result. Stale recovery reuses caller-serving Redis work from the initial read, so its dedicated counter and value-age histogram need no `layer` label. The bounded `scope` label on `dialcache_coalesced_counter` distinguishes request-local from instance-scoped single-flight work. `scope="process"` coordinates calls only within one `DialCache` instance; separate instances in the same process do not share in-flight state.

### Datadog

Install `hot-shots` separately, create the DogStatsD client your application owns, and pass it to the Datadog adapter:

```bash
pnpm add hot-shots@^17.0.0
```

```ts
import StatsD from "hot-shots";
import { DialCache } from "dialcache";
import { createDatadogDialCacheMetrics } from "dialcache/datadog";

const dogStatsD = new StatsD({
  host: process.env.DD_AGENT_HOST,
  globalTags: { service: "users-api", env: process.env.DD_ENV ?? "development" },
  errorHandler: (error) => logger.warn("DogStatsD error", { error }),
});

const dialcache = new DialCache({
  namespace: "users-api", // cache identity and cache_namespace tag
  metrics: createDatadogDialCacheMetrics({
    client: dogStatsD,
    observationMetricType: "distribution",
    namespace: "dialcache", // metric-name prefix: dialcache.request.count, etc.
  }),
});

// After outstanding cache operations finish during application shutdown:
dogStatsD.close();
```

`hot-shots` is the supported and tested client, but the adapter depends only on the exported `DatadogDogStatsDClient` structural interface. DialCache does not import or install `hot-shots`, create a client, flush buffers, close sockets, or otherwise own the client lifecycle.

`observationMetricType` is required. `"distribution"` is recommended when latency and size percentiles must aggregate across hosts; enable the desired distribution percentiles and aggregations in Datadog. Choose `"histogram"` when host-level histogram aggregation matches your existing Datadog setup. The choice applies uniformly to every observation metric, including durations, sizes, ratios, ages, and timestamp offsets. Both modes produce Datadog custom metrics. Distribution volume scales with unique tag-value combinations: Datadog counts five baseline aggregations per combination, and enabling percentile aggregations adds five more. Review [Datadog's custom-metrics billing guidance](https://docs.datadoghq.com/account_management/billing/custom_metrics/) before rollout. Do not send both types under the same namespace: when changing types, use a new namespace during migration so one metric identity never mixes histogram and distribution points.

`DatadogMetricsOptions.namespace` is the metric-name namespace and defaults to `dialcache`. It is separate from `DialCacheConfig.namespace`, the logical cache namespace emitted as the `cache_namespace` tag. The Datadog metric namespace must start with a letter and contain only letters, numbers, underscores, and dot-separated non-empty segments. The adapter rejects invalid metric namespaces and final metric names longer than 200 characters rather than relying on client-side normalization. A `hot-shots` `prefix` is applied after the adapter constructs the name, so include that prefix when checking the final length and avoid combining it with the metric namespace accidentally. Client-level `globalTags` are appended by `hot-shots`; the table below lists the tags added by the adapter.

The Datadog adapter emits exact increments of `1` for counters and preserves seconds and bytes without unit conversion:

| Metric | Type | Tags | Description |
| --- | --- | --- | --- |
| `dialcache.request.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache-layer requests that reached an enabled layer |
| `dialcache.miss.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache misses, classified by one required bounded reason |
| `dialcache.disabled.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `reason` | Cache skips by bounded reason |
| `dialcache.error.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `error`, `in_fallback` | Cache/fallback errors and the bounded `tracked_ttl_clamped` configuration signal |
| `dialcache.invalidation.count` | Count | `cache_namespace`, `key_type`, `layer` | Invalidation calls for the layers touched |
| `dialcache.coalesced.count` | Count | `cache_namespace`, `use_case`, `key_type`, `scope` | Coalesced requests by sharing scope |
| `dialcache.shadow.count` | Count | `cache_namespace`, `use_case`, `key_type`, `outcome` | Sampled Redis shadow-job outcomes |
| `dialcache.shadow.value_age` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `outcome` | Age in seconds of the validated Redis value at shadow verdict time, recorded for `match` and `mismatch` |
| `dialcache.future_timestamp_offset` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Positive offset in seconds for a valid frame dated after the observing process clock |
| `dialcache.stale_recovery.count` | Count | `cache_namespace`, `use_case`, `key_type`, `outcome` | Classifier-authorized stale-recovery checks: `served`, `miss`, or `deserialization_error` |
| `dialcache.stale_recovery.value_age` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `outcome` | Actual return-time age in seconds of a retained value, recorded only for `served` |
| `dialcache.compression.count` | Count | `cache_namespace`, `use_case`, `key_type`, `layer`, `outcome` | Payload compression outcomes: writes record `compressed`, `below_threshold`, `not_smaller`, or `write_over_limit`; reads record `decompressed`, `fallback_raw`, or `read_over_limit` |
| `dialcache.get.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Cache get latency in seconds |
| `dialcache.fallback.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Elapsed time until the underlying function settles or timeout rejection is delivered |
| `dialcache.serialization.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Redis serializer dump/load latency in seconds |
| `dialcache.serialization.size` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Serialized Redis payload size in bytes, before compression |
| `dialcache.stored.size` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Stored Redis payload size in bytes, after compression and escaping |
| `dialcache.compression.ratio` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer` | Compressed-to-original payload size ratio for compressed writes |
| `dialcache.compression.duration` | Distribution or histogram | `cache_namespace`, `use_case`, `key_type`, `layer`, `operation` | Payload compression and decompression latency in seconds |

`dialcache.miss.count` remains one metric and adds the same required bounded `reason` tag: `value_absent`, `expired`, `watermark_fenced`, or `unclassified`. During a mixed-fleet rollout, older points have no `reason` tag and newer points do; keep total-miss dashboards ungrouped by `reason`, and group by it only for the reason breakdown. The four bounded values increase steady-state custom-metric combinations by at most 4x per pre-existing miss-tag tuple (only `remote` and `remote_shadow` tuples can carry every reason; request-local and local misses are always `value_absent`), so account for that added cardinality and the temporary mixed tag sets in Datadog billing and monitor design.

Observer throws and rejections from returned promises or thenables are isolated by DialCache's fail-open metrics boundary. Buffered transport failures that are not represented by a returned thenable happen outside that boundary, so configure the DogStatsD client's error handling and shutdown behavior as part of application ownership.

### Error categories

The `error` label reports where an operation failed rather than copying the thrown value's class or `Error.name`:

| `error` | Meaning |
| --- | --- |
| `key_construction` | The cache-key selector or `DialCacheKey` construction failed |
| `config_resolution` | Runtime or layer configuration, or ramp resolution, failed |
| `cache_read` | A local-cache or Redis read failed |
| `cache_read_timeout` | A Redis read exceeded its effective remote-read deadline |
| `cache_write` | A local-cache or Redis write failed |
| `serialization_load` | Deserializing a Redis payload failed |
| `serialization_dump` | Serializing a value for Redis failed |
| `compression` | zstd compression failed while preparing a Redis write |
| `invalidation` | Writing an invalidation watermark failed |
| `fallback` | The wrapped application function failed or exceeded its DialCache deadline |
| `unknown` | Reserved for an otherwise unclassified future failure site |

These values are defined by the backend-neutral core and are identical for every metrics adapter. Raw thrown values, error names, messages, timeout values, cache IDs, arguments, and Redis keys are never included in metric labels. Operational errors are still passed to the configured logger where the existing failure path logs them. `in_fallback` remains the explicit cache-plumbing-versus-application distinction.

### Custom adapters

For other telemetry backends, implement `DialCacheMetricsAdapter` and pass the adapter through `new DialCache({ metrics })`. Every backend-neutral label object exposes the logical namespace as camel-case `cacheNamespace`; adapters should map it to their backend's `cache_namespace` label/tag. This field is present even when no key or cache layer was reached. `miss()` now receives `MissMetricLabels`, which extends unchanged `CacheMetricLabels` with the required bounded `reason`; every other callback keeps its existing label shape. Custom adapters whose `miss` parameter is typed as the broader `CacheMetricLabels` can ignore the new property, but direct callers, exact label snapshots, exhaustive reason handling, and adapters that reject or forward unknown fields must migrate to accept or map it. Implement the optional `shadowValidation` method to enable shadow work as well as record its outcomes; omitting it leaves all shadow work disabled even when `shadow.ramp` is nonzero or mismatch logging is enabled. The optional `observeShadowValueAge` method records the validated value's age in seconds for `match` and `mismatch` outcomes; omitting it skips only that observation without affecting shadow eligibility. The optional `observeFutureTimestampOffset` method receives existing bounded cache labels plus the exact positive offset in seconds; omitting it does not change read decisions: serving and initial-shadow reads still miss, while confirmation reads still retain the frame for payload comparison. The optional `staleRecovery` method records one bounded terminal outcome for each classifier-authorized recovery check; omitting it disables only that observation, not recovery itself. The optional `observeStaleRecoveryValueAge` method records the actual return-time age in seconds only when recovery serves; omitting it skips only that observation. Every metrics callback is fire-and-forget: DialCache isolates synchronous throws and consumes rejections from returned promises or thenables, but never awaits or drains observer work. Miss classification adds no new refill-fencing paths and preserves serving eligibility, invalidation, stale-recovery policy, and shadow outcomes. Omit `metrics` to disable metrics.

## Maintainers

### Cache-path benchmark

From a repository checkout, run the semantic microbenchmark after installing dependencies:

```bash
pnpm benchmark:request-local
```

The command builds `dist` before reporting ten scenarios: sequential request-local hits, sequential process-local hits, enabled bounded fallbacks, request-local coalescing fan-out, process coalescing fan-out, remote-read-deadline coalescing fan-out, tracked Redis hits with shadow omitted, tracked Redis hits deterministically outside a partial shadow ramp, a ramped-down warm-hit confirmation, and a ramped-down semantic-miss fill. Both shadow scenarios prove that the caller completes before detached Redis work. The benchmark is a maintainer tool and is not included in the published package. It asserts fallback counts, Redis behavior, coalescing state, timer cleanup, returned values, exactly-once SoT reuse, and conditional confirmation/fill without applying a timing threshold. Override its work sizes with `DIALCACHE_BENCH_ITERATIONS` and `DIALCACHE_BENCH_FANOUT`.

### Redis write benchmark

With an otherwise idle Redis reachable at `REDIS_URL` (default `redis://127.0.0.1:6379`, e.g. `docker run --rm -p 6379:6379 redis:6.2`), measure the local build's write path. The benchmark resets global command statistics between cases, so use a disposable or dedicated instance:

```bash
pnpm benchmark:redis-write
```

The command builds `dist`, then runs sequential native writes at 100 B, 10 KiB, 100 KiB, and 1 MiB payloads. It reports `SET`, script, and `TIME` calls per operation, server-side `SET` cost from `INFO commandstats`, and client-side p50/p95 latency. Semantic assertions require exactly one `SET`, zero scripts, and zero `TIME` calls per write. Because operations are sequential, the benchmark validates command shape and single-operation latency; it does not measure saturated concurrent throughput or maximum write capacity. Like the cache-path benchmark it is a maintainer tool, is not part of the published package, and applies no timing threshold — absolute numbers depend on the machine, engine, and load, so compare runs only within one environment. Scale iteration counts with `DIALCACHE_BENCH_WRITE_SCALE`.

### Stale-on-error benchmark

With Redis reachable at `REDIS_URL`, exercise the native-read design and a representative compressible payload:

```bash
pnpm benchmark:stale-on-error
```

The benchmark warms isolated keys, verifies that physical retention uses `M`, and reports fresh end-to-end hits, native reads of a retained frame, end-to-end stale recovery, and same-key coalesced recovery. It asserts exactly one adapter read per stale-recovery flight. A separate high-cardinality scenario holds delayed source calls open with distinct incompressible raw payloads, then reports process memory before retention, while every candidate is retained, and after recovery. Run the built script with `node --expose-gc scripts/benchmark-stale-on-error.mjs` for less noisy memory snapshots. It snapshots `INFO commandstats` and network byte counters around each scenario without resetting shared server statistics, and reports command, server-CPU, network, and client-throughput signals per operation. Semantic assertions cover compression, exact source/recovery/read counts, and returned values; timing and memory remain informational with no pass/fail threshold. Override work sizes with `DIALCACHE_BENCH_STALE_ITERATIONS`, `DIALCACHE_BENCH_STALE_FANOUT`, `DIALCACHE_BENCH_STALE_PAYLOAD_BYTES`, `DIALCACHE_BENCH_STALE_MEMORY_KEYS`, `DIALCACHE_BENCH_STALE_MEMORY_PAYLOAD_BYTES`, and `DIALCACHE_BENCH_STALE_MEMORY_SOURCE_DELAY_MS`.

### Releasing

Publishing starts by manually running the `Release` workflow from current `main`. After the package checks pass, Semantic Release selects the next version from Conventional Commits since the highest stable `vX.Y.Z` tag. While the package is pre-1.0, breaking changes bump minor — their `BREAKING CHANGE:` footers still drive full release notes without forcing 1.0.0 — `feat` bumps minor, and every other normal PR-title type (`fix`, `perf`, `docs`, `style`, `refactor`, `test`, `build`, `chore`, `ci`, and `revert`) bumps patch. The highest required bump wins. Major bumps return when 1.0.0 is cut; `release.config.mjs` implements this table and must change together with this section.

The workflow opens a `release: <version>` PR whose only change is the matching `package.json` version. `release` is a reserved Conventional Commit type configured not to request another release, so the version-control commit does not cause an extra bump. GitHub marks workflow runs for a PR opened with `GITHUB_TOKEN` as approval-required; approve those runs, review the PR, and squash-merge it normally through the protected branch.

The merge triggers the publish job. Before any release side effect, it verifies current `main`, the release commit subject, the one-file diff, the package version, the absent tag, and Semantic Release's independently calculated version and commit. It then reruns the package checks and asks Semantic Release to create the matching Git tag, publish the public npm package with provenance, and publish the GitHub release.

The repository must enable **Allow GitHub Actions to create and approve pull requests** under Actions workflow permissions. This workflow uses that capability only to create the version PR; it never approves or merges one, and no ruleset bypass actor or persistent release credential is required.

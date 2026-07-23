# Configuration and cache layers

[Back to the README](../README.md)

This guide covers reusable cached functions, one-shot inline loaders, cache
identity, runtime policy, request-local and process-local behavior, and
cached-value ownership. For the shared remote layer, see
[Redis and Valkey](redis.md).

## Defining cache operations

### Reusable cached functions

`cached(fn, options)` wraps a function; the wrapped callable has the same
parameters and always returns a `Promise`.

| Option | Required | Description |
| --- | --- | --- |
| `keyType` | yes | The kind of id the key addresses, such as `"user_id"`. Together with the id, this is the invalidation unit for tracked entries. |
| `useCase` | yes | Identifies the individual cache. It is part of the stored key and a metrics label. |
| `cacheKey` | yes | Selects a bare id or `{ id, args }` from `fn`'s parameters. |
| `defaultConfig` | no | Provides the `DialCacheKeyConfig` baseline that runtime config overlays field by field. |
| `serializer` | when the return type is not statically JSON-compatible | Selects a per-function `Serializer<T>` for Redis values; see [Serialization](redis.md#serialization). |
| `trackForInvalidation` | no; default `false` | Opts this use case's Redis entries into watermark-based [targeted invalidation](invalidation.md). |
| `fallbackTimeoutMs` | no; default `60_000` | Sets the fallback deadline in milliseconds, up to 2,147,483,647. `null` disables it; see [Fallback deadlines](coalescing.md#fallback-deadlines). |

`useCase` is validated when the function is registered. A duplicate within one
`DialCache` instance throws `UseCaseIsAlreadyRegisteredError`, and the internal
name `watermark` throws `UseCaseNameIsReservedError`.

### One-shot inline loaders

`getOrLoad(load, options)` runs one zero-argument synchronous or asynchronous
loader through the same cache layers, runtime policy, coalescing, invalidation,
metrics, serialization, and deadline behavior as `cached()`. Cache-plumbing
failures fall through to the loader; loader failures still reject and clear
their tracked flight:

```ts
const profile = await dialcache.enable(() =>
  dialcache.getOrLoad(
    async () => {
      const user = await db.getUser(userId);
      return renderProfile(user, locale);
    },
    {
      keyType: "user_id",
      useCase: "BuildProfile",
      key: { id: userId, args: { locale } },
      defaultConfig: DialCacheKeyConfig.enabled(60),
    },
  ),
);
```

The options match `cached()` except that the direct `key` replaces the
`cacheKey` selector. `defaultConfig` and `fallbackTimeoutMs` are validated and
snapshotted for each invocation. Outside an enabled scope, DialCache calls
`load` directly without constructing a key or resolving runtime policy.

`getOrLoad()` does not register its `useCase` or detect duplicates, but it still
rejects the reserved internal name `"watermark"`.

Repeated calls should reuse one stable, deployment-defined name such as
`"BuildProfile"`. Never derive it from a user, request, id, or other
high-cardinality input because it is part of both cache identity and metrics
labels. Put those values in `key` instead.

Every captured value that can change the result belongs in the bare id or
`{ id, args }` key. Concurrent same-key calls may share one caller's in-flight
loader and cached value, so all call sites for that identity must also agree on
value meaning and serialization.

Prefer `cached()` for reusable loaders and `getOrLoad()` for calculations
intentionally local to one call site.

## Keys, ids, and extra dimensions

For `cached()`, the required `cacheKey` selector receives the wrapped
function's inferred parameters. `getOrLoad()` accepts the same bare id or
`{ id, args }` shape directly through `key`:

```ts
const searchPosts = dialcache.cached(
  (userId: string, page: number, filter: string) =>
    db.searchPosts(userId, page, filter),
  {
    keyType: "user_id",
    useCase: "SearchPosts",
    cacheKey: (userId, page, filter) => ({
      id: userId,
      args: { page, filter },
    }),
    defaultConfig: DialCacheKeyConfig.enabled(60),
  },
);

await dialcache.enable(() => searchPosts("u1", 2, "active"));
```

The selected or direct key is the value-identity contract. It must include
every input dimension that can affect the returned value. Otherwise, distinct
calls can reuse the same cached value or share the same in-flight fallback
through request coalescing.

### Namespace

`DialCacheConfig.namespace` is the logical cache namespace and the first
component of every key. It defaults to `"urn"`, producing keys such as
`urn:user_id:123#GetUser`.

Set a stable application-specific value when applications or environments may
share one Redis deployment:

```ts
const dialcache = new DialCache({
  namespace: "production-users-api",
  redis: { client: dialCacheRedisClient },
});
```

That produces Redis keys beginning with `production-users-api:...`, or
`{production-users-api:...}` for invalidation-tracked values. `namespace` is
DialCache's single cache-identity and key-partitioning setting. It participates
in request-local, process-local, Redis, coalescing, deterministic ramp,
invalidation, and metrics.

A namespace may not contain `{` or `}` because DialCache reserves those
characters for Redis Cluster hash tags.

### Identity rules

- **`keyType` plus `id` is the invalidation unit for tracked Redis entries.**
  `dialcache.invalidateRemote("user_id", "123", futureBufferMs)` writes one
  watermark for that user. Any tracked Redis entry with the same `keyType` and
  `id` is refreshed across all `args` variants when Redis is read. Untracked
  entries do not consult the watermark. Invalidation does not evict existing
  request-local or process-local entries.
- **`args` are part of the cache key.** Different arguments produce different
  entries, but targeted invalidation is by id rather than by argument.
- **Scalar equality is string-based.** For matching surrounding dimensions:
  - numeric `1`, string `"1"`, and bigint `1n` identify the same key; and
  - argument values `null` and `"null"` match, `-0` matches `0`, and an
    `undefined` argument is omitted.

  If a deployment changes the logical meaning represented by a scalar, change
  an explicit identity dimension such as `keyType`, `useCase`, or an argument
  name or value.
- **Non-key inputs still reach the loader.** A database handle can be a normal
  function parameter ignored by `cacheKey` or a value captured by a
  `getOrLoad()` loader. Concurrent same-key misses share the leader's
  execution. Do not omit values such as `AbortSignal`, auth context, locale, or
  other request-scoped inputs unless sharing one result is correct.
- **Methods need a receiver.** Pass `obj.method.bind(obj)` or
  `(...args) => obj.method(...args)`; a bare `obj.method` reference loses
  `this`.

### Changing a namespace

Changing `namespace` intentionally creates a cold-cache boundary across every
layer. Old and new keyspaces do not share Redis values or invalidation
watermarks.

During an overlapping deployment, an invalidation handled by one version is
invisible to the other. The other version can continue serving a stale tracked
value until its value TTL expires. If remote invalidation correctness matters,
a normal rolling namespace change is unsafe.

Use a coordinated no-overlap cutover, or an operational bridge that prevents
both versions from serving remote cache across mutations. For example,
temporarily disable and clear remote caching during the transition. After the
cutover, provision for fallback and refill load, and allow old Redis keys to
expire by TTL.

## Runtime config and ramp controls

Instance-wide behavior is set through the `DialCache` constructor:

| `DialCacheConfig` option | Default | Description |
| --- | --- | --- |
| `namespace` | `"urn"` | Logical cache namespace and first key component. |
| `redis` | none | `{ client, readTimeoutMs?, serializer? }`; enables the [remote layer](redis.md). Remote reads default to a 50 ms deadline. |
| `localMaxSize` | `10_000` | Global process-local entry cap. `0` disables process-local storage. Must be a nonnegative safe integer. |
| `cacheConfigProvider` | none | Resolves runtime config per enabled invocation as a sparse overlay on the operation's `defaultConfig`; `null` applies no overrides. |
| `metrics` | disabled | A `DialCacheMetricsAdapter`; see [Observability](observability.md). |
| `logger` | `console` | Receives operational cache failures through `debug`, `warn`, and `error`. |

Per-invocation policy is a `DialCacheKeyConfig`: per-layer `ttlSec` and `ramp`
maps keyed by `CacheLayer.LOCAL` and `CacheLayer.REMOTE`, a `requestLocal`
boolean, and an optional `remoteReadTimeoutMs`.

### Baseline and overlay precedence

Every cached definition or `getOrLoad()` invocation can provide an optional
per-use-case `defaultConfig`. That is the baseline policy. The
`cacheConfigProvider` result is a sparse field-level overlay on it.

Enablement fields use this precedence:

```text
runtime field -> defaultConfig field -> DialCache disabled baseline
```

The disabled baseline sets `requestLocal` to `false` and leaves the
process-local and remote TTLs unset. A shared layer with no effective TTL is
disabled by policy. A shared layer with an effective TTL but no effective ramp
defaults to a 100% ramp.

The remote-read deadline has two additional fallbacks:

```text
runtime remoteReadTimeoutMs
  -> defaultConfig.remoteReadTimeoutMs
  -> redis.readTimeoutMs
  -> 50 ms
```

This value bounds how long DialCache waits for an active Redis or Valkey read.
It can be tuned per use case at runtime, but it cannot be disabled.

`DialCacheKeyConfig` preserves an omitted `requestLocal` as `undefined`, so the
overlay can distinguish omission from an explicit `false`. Its effective value
still defaults to `false` after resolution.

A provider result of `null`, or a defensive `undefined`, applies no overrides.
An empty `DialCacheKeyConfig` and omitted runtime fields also inherit the
baseline.

Use explicit values to replace inherited policy:

- `requestLocal: false` disables request-local caching;
- a shared-layer ramp of `0` disables that layer; and
- `DialCacheKeyConfig.disabled()` turns request-local off and ramps both shared
  layers to `0`.

### Validation and snapshots

DialCache validates `defaultConfig` when `cached()` registers a definition and
whenever `getOrLoad()` is invoked:

- TTLs must be positive safe integers;
- ramps must be finite percentages from 0 to 100;
- layer maps must be objects;
- `requestLocal` must be a boolean when present; and
- remote-read deadlines must be positive safe integers no greater than
  2,147,483,647 milliseconds.

Invalid instance `redis.readTimeoutMs` values throw during `DialCache`
construction. Invalid defaults are rejected when `cached()` registers a
definition or `getOrLoad()` is invoked. `null`, zero, fractional, non-finite,
string, and larger timeout values are invalid; remote reads have no unbounded
escape hatch.

Each registration or one-shot invocation captures an immutable internal
snapshot, so mutating the supplied config or its maps later does not change
that operation's baseline. Runtime policy changes belong in the provider's
returned overlay.

Runtime TTL and ramp leaves are used as supplied rather than falling back to
valid default leaves:

- an invalid TTL disables that layer with `invalid_ttl`;
- a nonnumeric or non-finite ramp disables it with `invalid_ramp`;
- a finite runtime ramp retains a defensive clamp to 0 through 100; and
- other valid layers can continue to run.

Invalid leaves also record a `config_resolution` error, distinguishing provider
garbage from an intentional ramp-down. A malformed runtime config object,
layer-map shape, `requestLocal`, or `remoteReadTimeoutMs` value fails config
resolution for the whole invocation. DialCache records `config_resolution`,
marks the no-layer path `config_error`, and runs the fallback without a Redis
read or write.

### Provider behavior

`cacheConfigProvider` is called for every enabled cache invocation before any
cache lookup. Keep it cheap, cache remote or config-store reads inside the
provider, and give asynchronous work a finite application-owned deadline.

DialCache fetches and resolves one config snapshot per enabled invocation.
Provider errors do not activate defaults: they fail open, record
`config_error`, and execute the fallback uncached.

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  redis: {
    client: dialCacheRedisClient,
    readTimeoutMs: 75,
  },
  cacheConfigProvider: async (key) => {
    if (key.useCase === "GetUser") {
      return new DialCacheKeyConfig({
        // Sparse override: inherit both TTLs and the local ramp.
        ramp: { [CacheLayer.REMOTE]: 25 },
        // Per-use-case override of the instance's 75 ms read deadline.
        remoteReadTimeoutMs: 35,
      });
    }
    return null;
  },
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: new DialCacheKeyConfig({
      // Omitted ramps default to 100% because these layers have TTLs.
      ttlSec: {
        [CacheLayer.LOCAL]: 30,
        [CacheLayer.REMOTE]: 300,
      },
    }),
  },
);
```

Ramp values are thresholds from 0 to 100. `0` disables the layer, `100` enables
it for every key, and an intermediate value selects keys whose DialCache-owned
deterministic bucket for the full cache key and layer is below that threshold.

For a fixed cache identity and layer, increasing a ramp only adds keys and
decreasing it only removes keys; it does not reshuffle existing membership.
Local and remote cohorts are layer-specific.

Ramps select key cohorts, not requests or load, so a ramp of `10` does not
guarantee 10% of calls, especially for a small or skewed key population.
DialCache keeps the assignment stable across releases.

Applications that need an externally coordinated cohort can use
`cacheConfigProvider` to return a sparse per-key ramp override of `0` or `100`.

Ramping down bypasses affected entries; it does not evict them, so a later
ramp-up can reuse entries that remain valid.

## Request-local cache

Set `requestLocal: true` to memoize resolved values for the lifetime of the
outermost `enable()` scope:

```ts
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

`requestLocal` is a runtime boolean rather than a TTL/ramp-controlled
`CacheLayer`. The provider can turn it on or off for each invocation.
`DialCacheKeyConfig.enabled(ttlSec)` enables only process-local and remote
caching, so request-local caching must be selected explicitly.

The resolved config applies to the whole invocation. When `requestLocal` is
false, the invocation skips request-local lookup and storage without deleting a
value already memoized in the scope. A later invocation that enables it can
reuse that value.

The outermost `enable()` call owns the request-local lifetime; nested `enable()`
calls reuse the same scope. State is allocated lazily, so scopes that use only
process-local or remote caching do not allocate it.

Wrap the complete Node HTTP handler so the scope matches the request:

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

Request-local storage has no capacity limit, eviction, or overflow mode. Values
are retained until the outermost callback settles. Use it for short-lived
scopes with bounded key cardinality. Split long-running streams or large batch
jobs into smaller scopes.

## Process-local cache

The process-local layer, `CacheLayer.LOCAL`, uses one LRU per `DialCache`
instance. It keeps at most 10,000 entries by default across all use cases while
retaining each entry's configured TTL.

Set `localMaxSize` to a nonnegative safe integer to change the global entry cap.
`0` disables process-local storage:

```ts
const dialcache = new DialCache({ localMaxSize: 25_000 });
```

The limit counts entries rather than estimating JavaScript object memory.
Recently read entries stay resident ahead of less recently used entries when
the limit is reached.

## Cached-value ownership

Treat values returned by cached functions or `getOrLoad()` as immutable.
DialCache does not clone or freeze values stored in request-local or
process-local memory.
Mutating a cached object can be observed by:

- later callers in the same request;
- callers in other requests that hit the process-local cache; and
- callers that coalesced onto the same in-flight result.

This contract includes nested objects and arrays, `Map`, `Set`, `Buffer`, typed
arrays, and class instances. Redis deserialization can produce a different
reference from an in-memory hit, so reference identity is layer-dependent and
is not part of the API contract.

Copy a value explicitly before changing it:

```ts
const sharedUser = await getUser("123");
const editableUser = structuredClone(sharedUser);
editableUser.displayName = "New name";
```

Use a narrower copy when its semantics are sufficient. The ownership boundary
remains the caller's responsibility.

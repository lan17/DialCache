# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

DialCache is a read-through cache for TypeScript services on Node.js. Use it for
database lookups, service reads, and other work whose results can be reused.
Give it a key and a loader, either by wrapping a function with `cached()` or
inline with `getOrLoad()`, and it returns a cached result or runs the loader.

- Three layers: request-local memoization, a process-local LRU, and Redis or
  Valkey.
- Per-use-case policy: layers, TTLs, and rollout ramps, changeable at runtime
  through a configuration provider.
- Keys organized by entity, such as `urn:user_id:123#GetUser`, so one
  `invalidateRemote()` call invalidates every tracked Redis result for that
  entity.
- By default, concurrent same-key calls share one in-progress read, and cache
  failures fall back to the loader.
- Opt-in: stale-on-error serves a retained Redis value when the source fails
  with an error you allow; shadow validation checks Redis values against the
  source and can warm Redis before it serves callers.
- Prometheus and Datadog adapters report requests, misses by reason, errors,
  and latency.

Caching is off by default and runs only inside an `enable()` scope.

[Documentation](https://lan17.github.io/DialCache/)
· [Getting started](https://lan17.github.io/DialCache/getting-started.html)
· [API reference](https://lan17.github.io/DialCache/api.html)

## Usage

```bash
npm install dialcache
```

Requires Node.js `>=22.15.0 <23.0.0 || >=23.8.0`.
Redis and telemetry clients are optional; install them separately as needed.

Save this as `example.mts`:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache();

// Replace this loader with your database or service read.
async function fetchUser(userId: string) {
  console.log("Loading from source:", userId);
  return { id: userId, name: "Ada" };
}

const getUser = dialcache.cached(fetchUser, {
  keyType: "user_id",
  useCase: "GetUser",
  cacheKey: (userId) => userId,
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
  }),
});

await dialcache.enable(async () => {
  await getUser("123"); // Loads from source and caches the result.
  await getUser("123"); // Reuses the value for up to 60 seconds.

  // Same cache, inline: a key and a loader instead of a wrapped function.
  const inline = {
    keyType: "user_id",
    useCase: "GetUserInline",
    key: "456",
    defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 } }),
  };
  await dialcache.getOrLoad(() => fetchUser("456"), inline); // Loads from source.
  await dialcache.getOrLoad(() => fetchUser("456"), inline); // Reuses the value.
});

await getUser("123"); // Outside enable(): loads from source again.
```

Run it directly with Node:

```bash
node --experimental-strip-types example.mts
```

This prints three `Loading from source` lines: user 123 for the first enabled
read, user 456 for the first inline read, and user 123 again for the call
outside `enable()`. The repeated reads inside the scope reuse cached values.

`fetchUser` is the loader, the function that reads from the source. `getUser` is
the cached function that DialCache returns; call it wherever you would have
called `fetchUser`. `getOrLoad()` takes the same kind of loader inline with a
direct `key` and does not register a use case, so any number of call sites can
share one name, and calls that share a key share cached entries. In both forms,
`keyType`, `useCase`, and the key make up the cache identity, so include every
input that changes the result. The getting-started guide covers
[when to prefer each form](https://lan17.github.io/DialCache/getting-started.html#keep-a-calculation-inline).

The example caches only in process memory. A TTL with no ramp turns that layer
on for every key inside the scope, and the LRU holds 10,000 entries by default.
In a service, wrap each request's reads in one `enable()` call; every cached
function called inside it shares that scope.

Results containing `Date`, `bigint`, or other non-JSON-compatible values need an
explicit [typed serializer](https://lan17.github.io/DialCache/redis.html#typed-serializer-requirement),
even when you cache only in memory.

## Cache layers

Inside `enable()`, a call checks each active layer in order and stops at the
first hit. A miss at every layer runs the loader:

```text
request-local → process-local → Redis / Valkey → your loader
```

| Layer | Shares values across | Lifetime | Typical use |
| --- | --- | --- | --- |
| Request-local | Calls in one outer `enable()` scope | Until that scope settles | Avoid repeated reads within a request |
| Process-local | Requests using one `DialCache` instance | TTL, bounded by LRU capacity | Avoid repeated reads between requests |
| Remote | Application instances using the same Redis keyspace | TTL, with optional invalidation tracking | Reuse reads across processes |

Layers combine. A Redis hit warms the process-local cache, and a request-local
layer memoizes whatever the layers below it return. The
[read-path guide](https://lan17.github.io/DialCache/concepts.html) lists exactly
what is stored after each kind of hit or miss.

When a layer is active, concurrent calls for the same key share one in-progress
call by default. Ten callers asking for the same user at the same moment cause
at most one read of the source, and the other nine receive that result. Sharing
is scoped to the request or to the process, depending on which layers are
active. Set `coalesce: false` when callers must not share. The
[coalescing guide](https://lan17.github.io/DialCache/coalescing.html) explains
what a waiting caller inherits, including errors and deadlines.

## Changing policy at runtime

Each use case's `defaultConfig` is its baseline. A `cacheConfigProvider` on
the instance can override individual fields on every enabled call, so you can
roll a cache out, tune it, or turn it off without touching the function. This
example registers a cached function with its local cache ramped to zero, then
opens it to a 10% cohort of keys:

```ts
const policies = new Map<string, DialCacheKeyConfig>();
const cache = new DialCache({
  cacheConfigProvider: (key) => policies.get(key.useCase) ?? null,
});

const readUser = cache.cached(fetchUser, {
  keyType: "user_id",
  useCase: "ReadUser",
  cacheKey: (userId) => userId,
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
    ramp: { [CacheLayer.LOCAL]: 0 },
  }),
});

// Use a 10% ramp and keep the baseline TTL.
policies.set("ReadUser", new DialCacheKeyConfig({
  ramp: { [CacheLayer.LOCAL]: 10 },
}));

await cache.enable(() => readUser("123"));

// Stop cache use and new shadow work for this use case.
policies.set("ReadUser", DialCacheKeyConfig.disabled());
```

In a service, your configuration system feeds the map. A ramp selects a stable
set of keys rather than a share of traffic, so a 10% cohort can serve more or
less than 10% of calls. Raising the ramp adds keys to the cohort. Lowering it
removes keys without reshuffling the rest.

Policy changes apply to new calls. They do not evict cached values or cancel
calls already in progress, and a shorter TTL affects local and Redis entries
differently. Read [how TTL changes affect each layer](https://lan17.github.io/DialCache/configuration.html#changing-policy-on-a-running-service)
before using a runtime change to tighten freshness.

With Redis configured, shadow validation can compare cached values with the
source on a sample of reads, and fill misses, before Redis serves any caller.
Serving and shadow ramps are independent, so turning serving off does not stop
shadow work. `disabled()` stops both for new calls.

[Runtime configuration](https://lan17.github.io/DialCache/configuration.html)
· [Shadow validation](https://lan17.github.io/DialCache/shadow-validation.html)

## Freshness and invalidation

By default a cached value lives until its TTL expires. For data that changes, a
use case can opt into tracked invalidation. After a write commits, call
`invalidateRemote()` for the entity. Tracked Redis reads of that entity then
reject values written before the invalidation, extended by a buffer you choose
to cover clock skew and in-progress writes. Values already in process memory,
and callers already waiting on an in-progress read, can still return the
earlier value. The
[invalidation guide](https://lan17.github.io/DialCache/invalidation.html#independent-fence-checks)
shows how to give every call its own check.

Stale-on-error makes the opposite trade. When the source fails, it can return
the value Redis still holds even though that value's TTL has passed, up to a
maximum age you set. It is off by default. Its built-in policy treats only
`FallbackTimeoutError` as recoverable; you can supply your own classifier. A
value retained for recovery is not revoked by a later invalidation.

Cached objects are shared references. Copy one before you modify it.

[Invalidation](https://lan17.github.io/DialCache/invalidation.html)
· [Stale-on-error](https://lan17.github.io/DialCache/stale-on-error.html)
· [Key design](https://lan17.github.io/DialCache/configuration.html#keys-ids-and-extra-dimensions)

## Failures

Cache access fails open. If a Redis read fails, the call runs the loader. If a
cache write fails, the loader's result is still returned. Loader errors reject
unless stale-on-error serves a value. `invalidateRemote()` failures reject, so
your application knows the invalidation did not happen.

DialCache puts separate deadlines on Redis reads and on the loader. It does not
time out configuration providers, serializers, Redis writes, or invalidation;
give those their own limits. See
[liveness](https://lan17.github.io/DialCache/coalescing.html#application-owned-budgets).

## Metrics

Metrics are optional. The [Prometheus and Datadog adapters](https://lan17.github.io/DialCache/observability.html)
report requests, miss reasons, errors, latency, and outcomes for shadow validation
and stale recovery. Custom backends can implement the same adapter interface.

## Reference

The [reference](https://lan17.github.io/DialCache/) covers setup, behavior, APIs,
and operational details. It can also be
[read as Markdown on GitHub](https://github.com/lan17/DialCache/tree/main/docs).

| Task | Guide |
| --- | --- |
| Add caching to a service | [Getting started](https://lan17.github.io/DialCache/getting-started.html) |
| Understand what runs on a hit, miss, or error | [How DialCache works](https://lan17.github.io/DialCache/concepts.html) |
| Look up methods, options, and exports | [API reference](https://lan17.github.io/DialCache/api.html) |
| Set keys, layers, TTLs, and rollout policy | [Configuration](https://lan17.github.io/DialCache/configuration.html) |
| Connect Redis or Valkey; customize serialization | [Redis and Valkey](https://lan17.github.io/DialCache/redis.html) |
| Understand shared work and deadlines | [Coalescing and liveness](https://lan17.github.io/DialCache/coalescing.html) |
| Build dashboards and diagnose misses | [Observability](https://lan17.github.io/DialCache/observability.html) |
| Upgrade, validate, or contribute | [Upgrading](https://lan17.github.io/DialCache/upgrading.html) · [Maintainer guide](https://lan17.github.io/DialCache/maintainers.html) |

MIT licensed. See [LICENSE](https://github.com/lan17/DialCache/blob/main/LICENSE).

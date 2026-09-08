# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

DialCache is a caching library for TypeScript on Node.js. Wrap a function with
`cached()`, or hand `getOrLoad()` a key and a loader, and the result is cached.
You decide, per use case, where results live, for how long, and for which keys.
Those decisions can change while the service runs. Behind the scenes, DialCache
handles the parts that usually go wrong: hot keys, cache outages, stale data,
and risky rollouts.

- **Multi-layer:** request-local memoization, a process-local LRU, and Redis or
  Valkey, in any combination.
- **Runtime policies per use case:** layers, TTLs, and rollout ramps, changeable
  while the service runs through a configuration provider.
- **Targeted invalidation:** keys are organized by entity, such as
  `urn:user_id:123#GetUser`, so one `invalidateRemote()` call invalidates every
  tracked Redis result for that entity.
- **Coalescing and fail-open by default:** concurrent same-key calls share one
  in-progress read, and cache failures fall back to the loader.
- **Opt-in resilience:** stale-on-error serves a retained Redis value when the
  source fails with an error you allow; shadow validation checks Redis against
  the source and can warm it before it serves callers.
- **Observability:** Prometheus and Datadog adapters report requests, misses by
  reason, errors, and latency.

Caching is off until you turn it on. It runs only inside an `enable()` scope, so
a write path never fills a cache unless you enable it there.

[Documentation](https://lan17.github.io/DialCache/)
· [Getting started](https://lan17.github.io/DialCache/getting-started.html)
· [API reference](https://lan17.github.io/DialCache/api.html)

## Usage

```bash
npm install dialcache
```

Requires Node.js `>=22.15.0 <23.0.0 || >=23.8.0`. Redis and telemetry clients
are optional; install them separately as needed.

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache();

// The loader: your database or service read.
async function fetchUser(userId: string) {
  console.log("Loading from source:", userId);
  return { id: userId, name: "Ada" };
}

// The cached function. Call it wherever you would call fetchUser.
const getUser = dialcache.cached(fetchUser, {
  keyType: "user_id", // Entity kind; with the id, the unit of invalidation.
  useCase: "GetUser", // Operation name; part of the key and metric labels.
  cacheKey: (userId) => userId, // Include every input that changes the result.
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { [CacheLayer.LOCAL]: 60 },
  }),
});

// In a service, wrap each request's reads in one enable() call.
await dialcache.enable(async () => {
  await getUser("123"); // Loads from source and caches the result.
  await getUser("123"); // Reuses the value for up to 60 seconds.

  // Inline form: a direct key instead of cacheKey, and no registration.
  // Call sites that share a key share cached entries.
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

Layers combine: a Redis hit warms the process-local cache, and the request-local
layer memoizes whatever the layers below return. The
[read-path guide](https://lan17.github.io/DialCache/concepts.html) lists what is
stored after each kind of hit or miss.

Concurrent calls for the same key share one in-progress read by default, so ten
callers asking for the same user at once cause at most one source read. Set
`coalesce: false` to opt out. The
[coalescing guide](https://lan17.github.io/DialCache/coalescing.html) covers what
a waiting caller inherits, including errors and deadlines.

## Changing policy at runtime

Each use case's `defaultConfig` is its baseline; a `cacheConfigProvider` on the
instance overrides individual fields on every enabled call. This example starts
with local caching ramped to zero, then opens it to a 10% cohort of keys:

```ts
// Your configuration system feeds this map.
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

A ramp selects a stable set of keys, not a share of traffic: raising it adds
keys to the cohort, and lowering it removes keys without reshuffling the rest.
Policy changes apply to new calls only. They do not evict cached values, and
[a shorter TTL affects local and Redis entries differently](https://lan17.github.io/DialCache/configuration.html#changing-policy-on-a-running-service).

With Redis configured, shadow validation compares cached values with the source
on a sample of reads and fills misses before Redis serves any caller. Serving
and shadow ramps are independent; `disabled()` stops both.

[Runtime configuration](https://lan17.github.io/DialCache/configuration.html)
· [Shadow validation](https://lan17.github.io/DialCache/shadow-validation.html)

## Freshness and invalidation

A cached value lives until its TTL expires. For data that changes, a use case
can opt into tracked invalidation: after a write commits, call
`invalidateRemote()` for the entity, and tracked Redis reads reject values
written before it. In-memory hits and in-progress reads can still return the
earlier value; the
[invalidation guide](https://lan17.github.io/DialCache/invalidation.html#independent-fence-checks)
shows how to give every call its own check.

Stale-on-error, off by default, returns the value Redis still holds past its TTL
when the source fails with an error you allow, up to a maximum age you set. The
built-in policy accepts only `FallbackTimeoutError`. A value retained for
recovery is not revoked by a later invalidation.

Cached objects are shared references. Copy one before you modify it.

[Invalidation](https://lan17.github.io/DialCache/invalidation.html)
· [Stale-on-error](https://lan17.github.io/DialCache/stale-on-error.html)
· [Key design](https://lan17.github.io/DialCache/configuration.html#keys-ids-and-extra-dimensions)

## Failures

Cache access fails open: a failed Redis read runs the loader, and a failed cache
write still returns the loader's result. Loader errors reject unless
stale-on-error serves a value, and `invalidateRemote()` failures always reject.

DialCache puts separate deadlines on Redis reads and on the loader. It does not
time out configuration providers, serializers, Redis writes, or invalidation;
see [liveness](https://lan17.github.io/DialCache/coalescing.html#application-owned-budgets).

## Metrics

Optional [Prometheus and Datadog adapters](https://lan17.github.io/DialCache/observability.html)
report requests, misses by reason, errors, latency, and outcomes for shadow
validation and stale recovery. Custom backends implement the same adapter
interface.

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

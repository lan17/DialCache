# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

DialCache is a TypeScript caching library for Node.js. It wraps a function and
caches its result within a request, in a process-local LRU, or in Redis or Valkey.

Caching is off by default. Outside an `enable()` scope, the wrapped function
just calls its loader. Inside the scope, each use case's configuration decides
which cache layers to use. TTLs and rollout settings can change at runtime
without rewriting the reader.

[Documentation](https://lan17.github.io/DialCache/)
· [Getting started](https://lan17.github.io/DialCache/getting-started.html)
· [API reference](https://lan17.github.io/DialCache/api.html)

## Usage

```bash
npm install dialcache
```

Requires Node.js `>=22.15.0 <23.0.0 || >=23.8.0`.
Redis and telemetry clients are installed separately if you use them.

Save this as `example.mts`. It creates one `DialCache` instance and reuses the
wrapped reader:

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
});

await getUser("123"); // Outside enable(): loads from source again.
```

Run it directly with Node:

```bash
node --experimental-strip-types example.mts
```

This prints `Loading from source: 123` twice: once for the first enabled read,
then again for the uncached call. The second enabled read reuses the value.

This example uses only the process-local layer. A TTL with no ramp enables that
layer for every key inside the scope. The LRU holds at most 10,000 entries by
default. In a service, place `enable()` around a request's reads so nested
readers inherit the same asynchronous scope.

Results containing `Date`, `bigint`, or other non-JSON-compatible values need an
explicit [typed serializer](https://lan17.github.io/DialCache/redis.html#typed-serializer-requirement),
even when you cache only in memory.

For a loader defined at the call site,
[`getOrLoad()`](https://lan17.github.io/DialCache/api.html#getorload) takes a
zero-argument function and a direct key. It uses the same cache behavior without
registering a reusable reader.

## Cache layers

When an enabled call reaches an active layer, a hit returns immediately. A miss
continues down the chain:

```text
request-local → process-local → Redis / Valkey → your loader
```

| Layer | Shares values across | Lifetime | Typical use |
| --- | --- | --- | --- |
| Request-local | Calls in one outer `enable()` scope | Until that scope settles | Avoid repeated reads within a request |
| Process-local | Requests using one `DialCache` instance | TTL, bounded by LRU capacity | Avoid repeated reads between requests |
| Remote | Application instances using the same Redis keyspace | TTL, with optional invalidation tracking | Reuse reads across processes |

Use any combination. Redis hits can warm an active process-local cache; results
from the lower chain can be memoized within the request. Tracked Redis reads
have additional publication rules to keep a fallback from bypassing an
invalidation fence. The [read-path guide](https://lan17.github.io/DialCache/concepts.html)
describes what gets stored after each kind of hit or miss.

When a cache layer is active, concurrent calls with the same key share in-flight
work by default. That sharing is scoped to a request or a `DialCache` instance,
depending on the active layers.
Use `coalesce: false` when callers need independent executions. The
[coalescing guide](https://lan17.github.io/DialCache/coalescing.html) covers which
results, errors, and deadlines a follower inherits.

## Runtime configuration

A reader's `defaultConfig` is its baseline. `cacheConfigProvider` can override
individual fields on each enabled invocation. For example, register a reader
with local caching ramped to zero, then change the ramp while the instance runs:

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

The map can be populated from your application's existing configuration system.
A ramp selects a stable set of keys, so a 10% cohort can account for more or
less than 10% of traffic. Increasing a ramp adds keys to the same cohort.
Decreasing it removes keys without reshuffling the rest.

With Redis configured, shadow validation can sample reads, compare cached values
with the source, and fill misses while Redis serving is off. Serving and shadow
ramps are independent: turning serving off does not stop shadow work.
`disabled()` disables both for new invocations.

Policy changes govern new invocations; they do not evict existing values or
cancel shared work. The reference explains
[how TTL changes affect each layer](https://lan17.github.io/DialCache/configuration.html#changing-policy-on-a-running-service).

[Runtime configuration](https://lan17.github.io/DialCache/configuration.html)
· [Shadow validation](https://lan17.github.io/DialCache/shadow-validation.html)

## Freshness and invalidation

For mutable data, a reader can track Redis invalidation by entity. Advance the
entity's watermark with `invalidateRemote()` after the source mutation commits.
A tracked Redis read checks the value and watermark together. In-memory hits
and coalesced callers can reuse an earlier observation. The
[invalidation guide](https://lan17.github.io/DialCache/invalidation.html#independent-fence-checks)
shows how to give each invocation its own fence check.

Stale-on-error can return a retained Redis snapshot after selected source
failures, subject to a maximum age. It is off by default. When enabled, its
built-in error policy accepts only `FallbackTimeoutError`; applications can
supply a different classifier. Later invalidation does not revoke a snapshot
already retained for recovery.

Include every input that affects the result in the cache key. In-memory values
and coalesced results are shared references, so copy an object before modifying
it.

[Invalidation](https://lan17.github.io/DialCache/invalidation.html)
· [Stale-on-error](https://lan17.github.io/DialCache/stale-on-error.html)
· [Key design](https://lan17.github.io/DialCache/configuration.html#keys-ids-and-extra-dimensions)

## Failures and metrics

Cache access fails open. A failed Redis read falls back to the loader; a failed
cache write does not discard a successful loader result. Source errors still
reject unless stale recovery serves a value. Explicit invalidation failures
also reject.

Redis reads and source fallbacks have separate deadlines. Providers, serializers,
writes, and the underlying clients need application-owned time limits; see
[liveness](https://lan17.github.io/DialCache/coalescing.html#application-owned-budgets).

Metrics are optional. The [Prometheus and Datadog adapters](https://lan17.github.io/DialCache/observability.html)
report requests, miss reasons, errors, latency, and shadow and recovery outcomes.
Custom backends can implement the same adapter interface.

## Reference

The [reference](https://lan17.github.io/DialCache/) covers setup, behavior, APIs,
and operational details. It can also be
[read as Markdown on GitHub](https://github.com/lan17/DialCache/tree/main/docs).

| Topic | Guide |
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

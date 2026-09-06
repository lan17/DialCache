# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

**Speed up reads. Stay in control.**

DialCache brings request-local, in-process, and Redis caching to the TypeScript
functions you already use. Wrap a reader once, then decide where caching runs,
which keys use it, and how results stay fresh.

Start with an in-memory cache. Add Redis or Valkey when you need a shared layer.
Roll each use case out to a stable cohort of keys, observe the results, and
adjust the policy while your service runs. Your loader stays the same.

[**Read the documentation →**](https://github.com/lan17/DialCache/blob/main/docs/index.md)
· [Getting started](https://github.com/lan17/DialCache/blob/main/docs/getting-started.md)
· [API reference](https://github.com/lan17/DialCache/blob/main/docs/api.md)

## Why DialCache?

A cache changes more than latency: it changes how often your source runs, what
concurrent callers share, and when a reader sees a mutation. DialCache makes
those choices explicit:

- **Choose the boundary.** Caching runs only inside `enable()`. Outside that
  scope, your reader goes straight to its source.
- **Choose the layers.** Memoize within one request, reuse values across
  requests with a bounded LRU, or share them across instances through Redis.
- **Roll out gradually.** Set TTLs and independent local, remote, and shadow
  ramps per use case through a runtime configuration provider.
- **Handle hot keys and slow dependencies.** Concurrent same-key reads share
  in-flight work by default. Redis reads and source fallbacks have separate
  deadlines; cache failures fall back to your loader.
- **Check freshness.** Invalidate tracked Redis entries by entity, or compare
  cached values with the source using sampled, detached shadow validation.
- **See what happens.** Prometheus, Datadog, and custom adapters report cache
  requests, miss reasons, errors, latency, and feature outcomes.

DialCache is a library for Node.js services. You supply the data loader and, if
needed, a connected Redis client and a runtime policy source. It fits database
lookups, service reads, and reusable computations whose results can be cached.

## Try it

```bash
npm install dialcache
```

Requires Node.js `>=22.15.0 <23.0.0 || >=23.8.0`.
Redis and telemetry clients are optional dependencies you install separately.

Create one `DialCache` instance and reuse the wrapped reader:

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

This example uses only the process-local layer. A TTL with no ramp enables that
layer for every key inside the scope. The LRU holds at most 10,000 entries by
default. In a service, place `enable()` around a read-request handler so nested
readers inherit the same asynchronous scope.

Prefer an inline loader? [`getOrLoad()`](https://github.com/lan17/DialCache/blob/main/docs/api.md#getorload)
uses the same behavior with a direct key:

```ts
const user = await dialcache.enable(() =>
  dialcache.getOrLoad(() => fetchUser("456"), {
    keyType: "user_id",
    useCase: "InlineGetUser",
    key: "456",
    defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
  }),
);
```

[Continue the getting-started guide →](https://github.com/lan17/DialCache/blob/main/docs/getting-started.md)

## One reader, three cache layers

When an enabled call reaches an active layer, a hit returns immediately. A miss
continues down the chain:

```text
request-local → process-local → Redis / Valkey → your loader
```

| Layer | Shares values across | Lifetime | Typical use |
| --- | --- | --- | --- |
| Request-local | Calls in one outer `enable()` scope | Until that scope settles | Avoid repeated reads within a request |
| Process-local | Requests using one `DialCache` instance | TTL, bounded by LRU capacity | Keep hot values close to your code |
| Remote | Application instances using the same Redis keyspace | TTL, with optional invalidation tracking | Reuse reads across a service fleet |

Use any combination. Redis hits can warm an active process-local cache; results
from the lower chain can be memoized within the request. Tracked Redis reads
have additional publication rules to keep a fallback from bypassing an
invalidation fence.

[Understand the read path and freshness boundaries →](https://github.com/lan17/DialCache/blob/main/docs/concepts.md)

## Turn the dial while your service runs

Keep a baseline next to each reader and supply a sparse runtime override through
`cacheConfigProvider`. This example starts a local cache at zero:

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

// Admit a stable 10% key cohort. The baseline TTL is inherited.
policies.set("ReadUser", new DialCacheKeyConfig({
  ramp: { [CacheLayer.LOCAL]: 10 },
}));

await cache.enable(() => readUser("123"));

// Stop cache use and new shadow work for this use case.
policies.set("ReadUser", DialCacheKeyConfig.disabled());
```

The map illustrates the integration point; your application can populate policy
from its existing configuration system. Ramps select **keys**, so a 10% cohort
can account for more or less than 10% of traffic. Increasing a ramp adds keys to
the same cohort. Decreasing it removes keys without reshuffling the rest.

With Redis configured, serving and shadow ramps work independently. You can
sample reads and fills in shadow mode before allowing Redis to serve callers.
Turning serving off does not stop shadow work; `disabled()` disables both for
new invocations.

[Runtime configuration](https://github.com/lan17/DialCache/blob/main/docs/configuration.md)
· [Shadow validation](https://github.com/lan17/DialCache/blob/main/docs/shadow-validation.md)

## Freshness is a policy you choose

For mutable data, opt a reader into **targeted Redis invalidation** and advance
its entity watermark after the source mutation commits. The next tracked Redis
read checks the value and watermark together. Existing in-memory values have
their own lifetimes, so use the remote layer alone when reads must observe that
fence.

For selected source failures, **stale-on-error** can return a retained Redis
snapshot within a maximum age. It is off by default; when enabled, its built-in
error policy admits only `FallbackTimeoutError`. The reference explains how to
choose a classifier and what a snapshot means when invalidation races with a
source call.

Good cache keys include every input that affects the result. Cached objects are
shared references: treat them as immutable. Cache access fails open, while
explicit invalidation failures reject so your application can handle them.

[Invalidation](https://github.com/lan17/DialCache/blob/main/docs/invalidation.md)
· [Stale-on-error](https://github.com/lan17/DialCache/blob/main/docs/stale-on-error.md)
· [Key design](https://github.com/lan17/DialCache/blob/main/docs/configuration.md#keys-ids-and-extra-dimensions)

## Explore the reference

The [documentation home](https://github.com/lan17/DialCache/blob/main/docs/index.md)
provides a guided reading order and a topic map. Each feature guide starts with
its purpose and setup, then explains execution, edge cases, and API details.

| I want to… | Read |
| --- | --- |
| Add caching to a service | [Getting started](https://github.com/lan17/DialCache/blob/main/docs/getting-started.md) |
| Understand what runs on a hit, miss, or error | [How DialCache works](https://github.com/lan17/DialCache/blob/main/docs/concepts.md) |
| Look up methods, options, and exports | [API reference](https://github.com/lan17/DialCache/blob/main/docs/api.md) |
| Set keys, layers, TTLs, and rollout policy | [Configuration](https://github.com/lan17/DialCache/blob/main/docs/configuration.md) |
| Connect Redis or Valkey; customize serialization | [Redis and Valkey](https://github.com/lan17/DialCache/blob/main/docs/redis.md) |
| Understand shared work and deadlines | [Coalescing and liveness](https://github.com/lan17/DialCache/blob/main/docs/coalescing.md) |
| Build dashboards and diagnose misses | [Observability](https://github.com/lan17/DialCache/blob/main/docs/observability.md) |
| Upgrade, validate, or contribute | [Upgrading](https://github.com/lan17/DialCache/blob/main/docs/upgrading.md) · [Maintainer guide](https://github.com/lan17/DialCache/blob/main/docs/maintainers.md) |

MIT licensed. See [LICENSE](https://github.com/lan17/DialCache/blob/main/LICENSE).

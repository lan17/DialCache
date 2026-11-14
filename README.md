# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![crates.io](https://img.shields.io/crates/v/dialcache.svg)](https://crates.io/crates/dialcache)
[![PyPI version](https://img.shields.io/pypi/v/dialcache.svg)](https://pypi.org/project/dialcache/)

DialCache is a read-through caching library for TypeScript, Go, Rust and Python.
It has three layers: request-local, process-local and Redis.

You register each cached read as a use case. Each use case has its own:

- **Configuration** — layers, TTLs and rollout ramps, changed at runtime.
- **Metrics** — requests, misses by reason and errors, labeled by use case and layer.
- **Invalidation** — one call per `keyType` and id fences every use case keyed by that id.

Caching is off until a call runs inside `enable()`. On a cache failure, DialCache
calls the loader. Stale-on-error and shadow validation are opt-in per use case.

[Documentation](https://lan17.github.io/DialCache/)
· [Getting started](https://lan17.github.io/DialCache/getting-started.html)
· [API reference](https://lan17.github.io/DialCache/api.html)

<a id="changing-policy-at-runtime"></a>

## Example

The example is TypeScript. The [documentation](https://lan17.github.io/DialCache/)
has the same examples in Go, Rust and Python.

```ts
import { DialCache, DialCacheKeyConfig } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";
import { createPrometheusDialCacheMetrics } from "dialcache/prometheus";

// fetchUser, redisClient, registry, flags and writeLagMs are your application's objects.
const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: createNodeRedisDialCacheClient(redisClient) },
  metrics: createPrometheusDialCacheMetrics({ registry }),
  // Runtime configuration. Runs before each enabled call; omitted fields inherit.
  cacheConfigProvider: (key) => {
    const override = flags.get(`dialcache.${key.useCase}`); // e.g. { ramp: { remote: 10 } }
    return override ? new DialCacheKeyConfig(override) : null;
  },
});

// Register the use case once. Call getUser at read sites.
const getUser = dialcache.cached(fetchUser, {
  useCase: "GetUser", // The name in keys and metric labels.
  keyType: "user_id", // The entity kind; the invalidation group.
  cacheKey: (userId) => userId, // Every input that changes the result.
  trackForInvalidation: true,
  defaultConfig: new DialCacheKeyConfig({
    ttlSec: { local: 60, remote: 600 },
    ramp: { remote: 0 }, // Redis stays off until a runtime override raises the ramp.
  }),
});

// In a service, wrap each request's reads in one enable() call.
await dialcache.enable(async () => {
  await getUser("123"); // Miss: calls fetchUser and stores the result.
  await getUser("123"); // Hit.
});

// After a committed write, fence every tracked use case keyed by this user.
// writeLagMs: your bound on stale loads that were still in flight at the write.
await dialcache.invalidateRemote("user_id", "123", writeLagMs);
```

**Metrics.** Each use case reports under its own labels:

```text
dialcache_request_counter{cache_namespace="users-api",use_case="GetUser",key_type="user_id",layer="local"} 2
dialcache_miss_counter{cache_namespace="users-api",use_case="GetUser",key_type="user_id",layer="local",reason="value_absent"} 1
dialcache_disabled_counter{cache_namespace="users-api",use_case="GetUser",key_type="user_id",layer="remote",reason="ramped_down"} 1
```

**Runtime configuration.** Set the flag `dialcache.GetUser` to
`{ "ramp": { "remote": 10 } }`. From the next call, Redis serves a stable 10% of
the keys of `GetUser`. No deploy. Raise the ramp to `100` when the metrics look
right. A change applies to new calls; it does not evict values.

**Invalidation.** `invalidateRemote("user_id", "123", writeLagMs)` writes one
watermark. On its next Redis read, each tracked use case with `keyType: "user_id"`
rejects values for user `123` stamped at or before the watermark. Local hits are
not fenced. A caller that joins a load in flight can get a value that load read
before the invalidation.
[Targeted invalidation](https://lan17.github.io/DialCache/invalidation.html)
covers the buffer and these boundaries.

Results that contain `Date`, `bigint` or other non-JSON values need an explicit
[typed serializer](https://lan17.github.io/DialCache/redis.html#typed-serializer-requirement),
also for in-memory caching. Cached objects are shared references; copy before you
modify. [`getOrLoad()`](https://lan17.github.io/DialCache/api.html#getorload) gives
the same cache path to an inline loader and a direct key.

## Safe to roll out

- **Off by default.** Caching runs only inside an `enable()` scope. `disable()`
  restores pass-through for nested mutation work and evicts nothing.
- **Fail-open.** A cache error runs the loader. A configuration provider error
  runs the loader uncached. An invalid configuration field disables only its
  layer or feature; valid layers continue. Metrics record each case.
- **Coalescing.** Concurrent same-key calls share one loader execution when a
  cache layer is active. Set `coalesce: false` for independent execution.
- **Stale-on-error (opt-in).** For selected source errors, DialCache serves a
  retained Redis value up to a maximum age.
- **Shadow validation (opt-in).** DialCache compares a sample of keys with the
  source in the background. The caller does not wait for it.

## Languages

| Language | Status | Implementation | Guide |
| --- | --- | --- | --- |
| TypeScript | Reference implementation | [`typescript/`](typescript/) | [TypeScript and npm](typescript/README.md) |
| Go | Experimental | [`go/`](go/) | [Go guide](go/README.md) |
| Rust | Experimental | [`rust/`](rust/) | [Rust guide](rust/README.md) · [crates.io](https://crates.io/crates/dialcache) |
| Python | Experimental | [`python/`](python/) | [Python guide](python/README.md) · [PyPI](https://pypi.org/project/dialcache/) |

One [Quint specification](formal/README.md) defines the behavior. Every
implementation replays the same histories generated from it.

## Install TypeScript

```bash
npm install dialcache
```

Requires Node.js 22.15.0 or newer within 22.x, or 23.8.0 and newer, for
`node:zlib` zstd support. Use a
[supported LTS release](https://nodejs.org/en/about/previous-releases) in production.
Install a [Redis or Valkey client](https://lan17.github.io/DialCache/redis.html)
and a [metrics client](https://lan17.github.io/DialCache/observability.html)
when using those integrations.

<a id="enabled-scope"></a>
<a id="cache-layers"></a>

## How reads work

Inside an enabled call, the first active layer with a hit returns the value:

```text
request-local → process-local → Redis / Valkey → loader
```

| Layer | Shared across | Lifetime |
| --- | --- | --- |
| Request-local | Calls in one outer `enable()` scope | Until that scope settles |
| Process-local | Requests using one `DialCache` instance | Insertion TTL, bounded by LRU capacity |
| Remote | Instances sharing the Redis keyspace | Physical TTL and logical age checks; optional watermarks |

A local hit does not read Redis, so it bypasses the invalidation watermark. A
Redis hit can warm an active local layer.
[How DialCache works](https://lan17.github.io/DialCache/concepts.html) covers the
read path, publication rules and freshness boundaries.

<a id="reference"></a>

## Documentation

| Topic | Guide |
| --- | --- |
| First reader and enabled scope | [Getting started](https://lan17.github.io/DialCache/getting-started.html) |
| Result identity and invalidation groups | [Keys and identity](https://lan17.github.io/DialCache/keys.html) |
| Defaults, overrides, and policy changes | [Configuration and rollout](https://lan17.github.io/DialCache/configuration.html) |
| Watermarks and mutation handling | [Targeted invalidation](https://lan17.github.io/DialCache/invalidation.html) |
| Recovery from selected source failures | [Stale-on-error](https://lan17.github.io/DialCache/stale-on-error.html) |
| Sampling and comparison against the source | [Shadow validation](https://lan17.github.io/DialCache/shadow-validation.html) |
| Shared execution and deadlines | [Coalescing and liveness](https://lan17.github.io/DialCache/coalescing.html) |
| Methods, options, and exports | [API reference](https://lan17.github.io/DialCache/api.html) |
| Native implementations and shared behavior contracts | [TypeScript guide](typescript/README.md) · [Go guide](go/README.md) · [Rust guide](rust/README.md) · [Python guide](python/README.md) · [Quint specification](formal/README.md) · [Worked walkthrough](formal/guides/WALKTHROUGH.md) |

The [documentation index](https://lan17.github.io/DialCache/) also links to client
setup, observability, and upgrades. Everything is
[readable as Markdown on GitHub](https://github.com/lan17/DialCache/tree/main/docs).

## Development

[![TypeScript coverage](https://img.shields.io/codecov/c/github/lan17/DialCache/main?flag=typescript&label=TypeScript%20coverage)](https://codecov.io/gh/lan17/DialCache)
[![Go coverage](https://img.shields.io/codecov/c/github/lan17/DialCache/main?flag=go&label=Go%20coverage)](https://codecov.io/gh/lan17/DialCache)
[![Rust coverage](https://img.shields.io/codecov/c/github/lan17/DialCache/main?flag=rust&label=Rust%20coverage)](https://codecov.io/gh/lan17/DialCache)
[![Python coverage](https://img.shields.io/codecov/c/github/lan17/DialCache/main?flag=python&label=Python%20coverage)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

Run `make check` from the repository root for the routine checks of every language;
[Validation and evidence](formal/guides/VALIDATION.md) lists the toolchains and the other
lanes. [Development process](DEVELOPMENT_PROCESS.md) explains how a change travels from a
request to a merged commit, the [maintainer guide](MAINTAINERS.md) covers validation,
benchmarks, and releases, and [Writing shared documentation](WRITING-DOCS.md) explains how
to change `docs/`, which is published as the reference for people who use DialCache.

MIT licensed. See [LICENSE](https://github.com/lan17/DialCache/blob/main/LICENSE).

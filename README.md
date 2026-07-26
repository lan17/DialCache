# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

**Roll out backend caching like a feature—not a leap of faith.**

**DialCache is** a TypeScript library for caching database and service reads
inside Node.js backends. It routes reusable async functions and inline loaders
through one read-through path with request-local memoization, a bounded
in-process LRU, and optional Redis or Valkey caching.

The “dial” is per-use-case runtime control. Start with caching off, dial the
process-local and remote layers up for stable cohorts of keys, and dial them
back down without changing the loader.

**DialCache is not** a frontend data cache, cache server, Redis or Valkey
client, or runtime configuration service. It supplies the cache path and
rollout controls; your application still decides what is safe to cache and
owns loader behavior, connections, runtime configuration, keys, TTLs,
invalidation policy, and resource budgets.

## Safety comes from explicit controls

- **Off by default.** Outside `dialcache.enable(...)`, calls go straight to the
  loader without building a key, resolving policy, accessing a cache, or
  coalescing work.
- **Gradual and reversible.** Start the process-local or remote layer at `0`,
  expand it by a stable subset of keys, and turn every cache layer off through
  runtime policy.
- **Fail-open cache path.** Cache-plumbing failures fall through to the loader
  instead of replacing a usable result. Explicit invalidation failures still
  surface to the caller.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Dial caching up or down](#dial-caching-up-or-down)
- [How the read path works](#how-the-read-path-works)
- [Core concepts](#core-concepts)
- [Production checklist](#production-checklist)
- [Reference guides](#reference-guides)

## Install

```bash
npm install dialcache
```

DialCache requires Node.js 22.0.0 or newer. Production deployments should use a
[currently supported LTS release](https://nodejs.org/en/about/previous-releases).

Redis, Valkey, Prometheus, and Datadog integrations are optional and keep their
clients application-owned:

- [Redis and Valkey setup](https://github.com/lan17/DialCache/blob/main/docs/redis.md)
- [Prometheus and Datadog setup](https://github.com/lan17/DialCache/blob/main/docs/observability.md)

## Quick start

Most services create one long-lived `DialCache` instance and reuse it across
the process. It owns one process-local LRU and one process-coalescing scope;
create separate instances only when those resources should be isolated:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache();

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
    }),
  },
);

// Outside enable(), this is a true pass-through to db.fetchUser:
await getUser("123");

// Inside enable(), the first call loads and the second reuses the cached value:
const user = await dialcache.enable(async () => {
  await getUser("123"); // db.fetchUser, then populate process-local cache
  return await getUser("123"); // process-local hit
});
```

`cached(fn, options)` preserves the function's parameters and returns a
Promise-based wrapper. The configuration above enables only the process-local
layer with a 60-second TTL; its omitted ramp defaults to `100`. Request-local
memoization and the remote layer remain off.

For a one-shot calculation that should remain inline,
[`getOrLoad()`](https://github.com/lan17/DialCache/blob/main/docs/configuration.md#one-shot-inline-loaders)
accepts a
zero-argument loader and a direct key through the same cache contract.

Enable caching once at a read-request boundary instead of at every call site.
Keep nested mutation work uncached with `disable()`:

```ts
await dialcache.enable(async () => {
  const user = await getUser("123");

  await dialcache.disable(async () => {
    await updateUser("123", patch);
  });
});
```

Enabled state follows the current asynchronous call chain through Node
`AsyncLocalStorage`; it is not process-global. Nested scopes restore the
previous state when their callbacks settle.

`disable()` prevents cache access during its callback; it does not evict values
cached before a mutation. Use the appropriate invalidation or TTL policy before
serving later reads of mutable data.

### From local trial to production

A typical adoption path is:

1. start with the process-local cache shown above;
2. add [Prometheus or Datadog](https://github.com/lan17/DialCache/blob/main/docs/observability.md)
   before increasing production exposure; and
3. extend the policy with a remote TTL and a remote ramp of `0`, using an
   application-owned runtime configuration source; then
4. add [Redis or Valkey](https://github.com/lan17/DialCache/blob/main/docs/redis.md)
   and ramp a stable subset of keys as described next.

## Dial caching up or down

Every cache operation can declare a stable `defaultConfig`. An optional
`cacheConfigProvider` returns a sparse runtime overlay for the current key, so
policy can change independently of the loader.

The example below focuses on runtime policy. Remote ramp settings take effect
only when a Redis or Valkey client is configured.

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const runtimePolicies = new Map<string, DialCacheKeyConfig>();

const dialcache = new DialCache({
  cacheConfigProvider: (key) => runtimePolicies.get(key.useCase) ?? null,
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: {
        [CacheLayer.LOCAL]: 60,
        [CacheLayer.REMOTE]: 60,
      },
      ramp: {
        [CacheLayer.LOCAL]: 0,
        [CacheLayer.REMOTE]: 0,
      },
    }),
  },
);

// Start with the local 10% ramp cohort; keep the remote layer off.
runtimePolicies.set(
  "GetUser",
  new DialCacheKeyConfig({
    ramp: {
      [CacheLayer.LOCAL]: 10,
      [CacheLayer.REMOTE]: 0,
    },
  }),
);

// Later, ramp the process-local and remote layers to 100%.
runtimePolicies.set(
  "GetUser",
  new DialCacheKeyConfig({
    ramp: {
      [CacheLayer.LOCAL]: 100,
      [CacheLayer.REMOTE]: 100,
    },
  }),
);

// Reverse the rollout without changing getUser.
runtimePolicies.set("GetUser", DialCacheKeyConfig.disabled());
```

The zero-ramp baseline is the safety net: if the provider has no matching
entry, both layers remain off.

In production, the provider can read from an application-owned dynamic config
client instead of an in-memory map. DialCache resolves one policy snapshot per
enabled invocation.

The process-local and remote layers each need an effective TTL. With a TTL but
no ramp, a layer defaults to `100`; a ramp of `0` disables it, `100` selects
every key, and an intermediate value selects a stable key cohort.

Ramps select key cohorts, not requests or load, so `10` does not guarantee 10%
of calls. Increasing or decreasing a ramp preserves membership for keys that
remain inside the threshold, and local and remote cohorts are layer-specific.
DialCache keeps the assignment stable across releases.

Ramping down, including with `DialCacheKeyConfig.disabled()`, bypasses existing
entries rather than deleting them; a later ramp-up can reuse entries that
remain valid.

Request-local caching is controlled separately by the `requestLocal` boolean.
`DialCacheKeyConfig.disabled()` sets it to `false` and ramps both the
process-local and remote layers to `0`.

See [Configuration and cache layers](https://github.com/lan17/DialCache/blob/main/docs/configuration.md)
for sparse-overlay precedence, provider failure behavior, externally
coordinated cohorts, remote-read deadlines, and layer validation.

## How the read path works

Inside an enabled scope, active layers are checked in order:

```text
request-local -> process-local LRU -> Redis or Valkey -> source loader
```

The wrapped function or inline loader is the fallback and remains the source of
the returned value when every active layer misses or a cache operation fails
open.

- A request-local hit returns the value memoized in the current outermost
  `enable()` scope.
- A process-local hit returns from the `DialCache` instance's bounded LRU.
- A process-local miss can read Redis and populate the process-local cache.
- A remote miss runs the fallback and attempts to populate the active cache
  layers.
- A remote read failure or timeout runs the fallback without a second Redis
  operation. Tracked invalidation adds a stricter
  [publication rule](https://github.com/lan17/DialCache/blob/main/docs/invalidation.md#read-and-write-behavior).
- Same-key concurrent work is coalesced at the lifetime of the first active
  layer.

When all layers are disabled by policy, an initially enabled call remains
uncached and uncoalesced, but its fallback deadline still applies. A call that
started outside an enabled scope remains a true pass-through and does not get a
DialCache deadline.

## Core concepts

### Cache operations and keys

`cached(fn, options)` defines both a callable and the value-identity contract:

| Option | Required | Purpose |
| --- | --- | --- |
| `keyType` | yes | Names the kind of id and, with `id`, the invalidation unit for tracked Redis entries. |
| `useCase` | yes | Identifies this individual cache in stored keys and metrics. |
| `cacheKey` | yes | Selects the bare id or `{ id, args }` from the function parameters. |
| `defaultConfig` | no | Supplies the baseline policy overlaid by runtime config. |
| `serializer` | for statically non-JSON return types | Defines the Redis representation for this operation's value. |
| `trackForInvalidation` | no | Opts the remote entries into watermark-based targeted invalidation. |
| `fallbackTimeoutMs` | no | Sets the fallback deadline; defaults to `60_000`, and `null` disables it. |

Use `getOrLoad(load, options)` when a one-shot calculation should remain inline.
It follows the same cache, policy, coalescing, invalidation, serialization, and
deadline contracts, but takes a direct `key` instead of a `cacheKey` selector.
It does not register `useCase`, so repeated calls should reuse one stable,
deployment-defined name.

The selected or direct key must include every input dimension that can affect
the returned value. Same-key concurrent calls may share the leader's execution,
so ignored function arguments or captured values such as auth context, locale,
or cancellation behavior must truly be safe to share.

Set a stable, application-specific `namespace` when applications or
environments share Redis:

```ts
const dialcache = new DialCache({
  namespace: "production-users-api",
  redis: { client: dialCacheRedisClient },
});
```

See [Configuration and cache layers](https://github.com/lan17/DialCache/blob/main/docs/configuration.md)
for key encoding, secondary arguments, namespace changes, serializers, and
value ownership.

### Cache layers

| Layer | Scope | Primary use |
| --- | --- | --- |
| Request-local | Outermost `enable()` scope | Memoize repeated reads during one bounded request or job. |
| Process-local | One `DialCache` instance | Serve hot values from a bounded in-process LRU. |
| Redis or Valkey | Shared remote store | Reuse TTL-cached values across processes and hosts. |

Each invocation uses one resolved policy snapshot for all three layers.
Request-local storage has no capacity limit, so use it only for short-lived
scopes with bounded key cardinality. Process-local values count toward one
instance-wide entry cap. Remote values use a serializer selected by the cache
operation or the Redis configuration.

Cached in-memory values are shared by reference. Treat every returned value as
immutable, or copy it explicitly before mutation.

### Targeted invalidation

Mutable Redis-backed use cases can opt into watermark-based invalidation with
`trackForInvalidation: true`, then call:

```ts
await updateUser("123", patch);
await dialcache.invalidateRemote(
  "user_id",
  "123",
  USER_INVALIDATION_BUFFER_MS,
);
```

Invalidation is deliberately remote-only. It does not evict existing
request-local or process-local values, so strongly invalidated mutable data
should disable those layers or tolerate their TTL-bounded staleness.

The buffer must be a named, application-owned nonzero value sized for clock
skew and the full stale-work window. See
[Targeted invalidation](https://github.com/lan17/DialCache/blob/main/docs/invalidation.md)
before enabling it in production.

### Request coalescing and fallback deadlines

Concurrent callers with the same cache key share active work within the first
active cache scope: one outer request for request-local caching, or one
`DialCache` instance when process-local or remote caching is active. This
mitigates hot-key stampedes inside that scope; it is not cross-process
coordination.

Same-key followers share the leader's remaining remote-read budget. The
fallback deadline starts separately only if and when the source loader begins.

Enabled fallbacks have a 60-second monotonic deadline by default. Timing out
rejects the DialCache chain and prevents the late result from being published,
but it does not cancel the underlying function. Give source operations their
own native timeout or `AbortSignal`.

See [Coalescing and fallback liveness](https://github.com/lan17/DialCache/blob/main/docs/coalescing.md)
for exact sharing, deadline, cleanup, and admission-control contracts.

### Observability

Metrics are disabled unless a `DialCacheMetricsAdapter` is supplied. First-party
adapters support caller-owned Prometheus registries and Datadog DogStatsD
clients. Bounded labels report layer requests, misses, disabled reasons,
coalescing scopes, serialization work, and cache versus fallback failures.

See [Observability](https://github.com/lan17/DialCache/blob/main/docs/observability.md)
for installation, collector schemas, metric names, and custom adapters.

## Production checklist

Before ramping a use case:

- enable DialCache only around read paths, and keep mutation paths inside
  `disable()` or outside the enabled boundary;
- verify that every selected or direct key includes each value and execution
  dimension that is unsafe to share;
- begin at `0` or a small deterministic key cohort, monitor source load, cache
  errors, hit rate, latency, remote-read and fallback timeouts, and coalescing
  state, then increase in controlled steps;
- keep a runtime path to `DialCacheKeyConfig.disabled()`;
- choose an effective DialCache remote-read deadline, and configure
  resource-native budgets for the underlying Redis work, config providers,
  serializers, and source operation;
- use a conservative `localMaxSize` and bounded request-local scopes;
- treat cached values as immutable;
- verify serializer compatibility across mixed application versions; and
- for tracked invalidation, synchronize promotion-eligible Redis clocks,
  preserve watermark keys for their derived TTL with `noeviction` or an
  equivalent guarantee, choose suitable persistence and failover behavior, and
  size a nonzero buffer from measured or conservatively bounded timings.

## Reference guides

- [Configuration and cache layers](https://github.com/lan17/DialCache/blob/main/docs/configuration.md) — definitions, keys,
  runtime overlays, request-local and process-local behavior, and value
  ownership.
- [Redis and Valkey](https://github.com/lan17/DialCache/blob/main/docs/redis.md) — node-redis and GLIDE setup, lifecycle,
  liveness, binary protocol, and serialization.
- [Targeted invalidation](https://github.com/lan17/DialCache/blob/main/docs/invalidation.md) — watermarks, Redis Cluster
  placement, clock assumptions, and buffer sizing.
- [Coalescing and fallback liveness](https://github.com/lan17/DialCache/blob/main/docs/coalescing.md) — sharing scopes,
  deadlines, state inspection, cleanup, and backpressure.
- [Observability](https://github.com/lan17/DialCache/blob/main/docs/observability.md) — Prometheus, Datadog, metric schemas,
  error categories, and custom adapters.
- [Maintainer guide](https://github.com/lan17/DialCache/blob/main/docs/maintainers.md) — benchmarks and the protected release
  workflow.

DialCache is licensed under the
[MIT License](https://github.com/lan17/DialCache/blob/main/LICENSE).

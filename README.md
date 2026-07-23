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

- **Off by default.** Outside `dialcache.enable(...)`, both cached wrappers and
  inline loaders are true pass-throughs: DialCache does not build a key,
  resolve config, access a cache, or coalesce the call. Inside an enabled
  scope, a layer still needs an effective policy before it participates.
- **Gradual and reversible rollout.** Configure TTL and ramp independently for
  the process-local and remote layers. A ramp of `0` is off, `100` is fully on,
  and `DialCacheKeyConfig.disabled()` is the all-layer policy kill switch.
- **Fail-open cache path.** Key, config, cache-read, and serialization-load
  failures fall through to the source loader. Cache-write,
  serialization-dump, logging, and metrics failures do not replace an otherwise
  usable fallback result. Explicit remote invalidation failures are rethrown so
  callers never assume a mutation was made safe when it was not.
- **Bounded defaults.** The process-local cache has a 10,000-entry default cap,
  active remote reads have a 50-millisecond default deadline, and enabled
  fallback executions have a 60-second default deadline. The read deadline
  bounds DialCache's wait, not necessarily the underlying Redis command;
  applications still need resource-native budgets for client work, config
  providers, serializers, and source I/O.

Use DialCache when you want to:

- add caching to database or service reads without scattering cache get/set
  plumbing across call sites;
- begin with one layer or a small deterministic key cohort, observe it, and
  expand or reverse the rollout per use case;
- combine request-local, process-local, and shared caching behind one key and
  policy contract; or
- coalesce hot-key misses, invalidate related Redis entries, and emit bounded
  cache metrics without rebuilding those mechanisms for every function.

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
pnpm add dialcache
```

DialCache requires Node.js 22.0.0 or newer. Production deployments should use a
[currently supported LTS release](https://nodejs.org/en/about/previous-releases).

Redis, Valkey, Prometheus, and Datadog integrations are optional and keep their
clients application-owned:

- [Redis and Valkey setup](https://github.com/lan17/DialCache/blob/main/docs/redis.md)
- [Prometheus and Datadog setup](https://github.com/lan17/DialCache/blob/main/docs/observability.md)

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

// Outside enable(), this is a true pass-through to db.fetchUser:
await getUser("123");

// Inside enable(), the active cache layers participate:
const user = await dialcache.enable(() => getUser("123"));
```

`cached(fn, options)` preserves the function's parameters and returns a
Promise-based wrapper. `DialCacheKeyConfig.enabled(60)` gives the process-local
and remote layers a 60-second baseline TTL; the remote layer participates only
when a Redis or Valkey client is configured.

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

## Dial caching up or down

Every cache operation can declare a stable `defaultConfig`. An optional
`cacheConfigProvider` returns a sparse runtime overlay for the current key, so
policy can change independently of the loader:

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
    defaultConfig: DialCacheKeyConfig.enabled(60),
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

// Later, ramp both shared layers to 100%.
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

In production, the provider can read from an application-owned dynamic config
client instead of an in-memory map. DialCache resolves one policy snapshot per
enabled invocation. Keep the provider cheap and give any asynchronous work its
own finite budget.

For the process-local and remote layers:

- a missing effective TTL disables that layer by policy;
- a configured TTL with no ramp defaults to `100`;
- `0` disables the layer;
- `100` enables the layer for every key; and
- an intermediate ramp uses DialCache's deterministic key-and-layer
  assignment.

Ramps select key cohorts, not requests or load, so `10` does not guarantee 10%
of calls. Increasing or decreasing a ramp preserves membership for keys that
remain inside the threshold, and local and remote cohorts are layer-specific.
DialCache keeps the assignment stable across releases.

If an application needs an externally coordinated cohort, its
`cacheConfigProvider` can return a per-key ramp override of `0` or `100`.
Ramping down, including with `DialCacheKeyConfig.disabled()`, bypasses existing
entries rather than deleting them; a later ramp-up can reuse entries that
remain valid.

Request-local caching is controlled separately by the `requestLocal` boolean.
`DialCacheKeyConfig.disabled()` sets it to `false` and ramps both shared layers
to `0`. Provider errors do not silently activate the baseline: the invocation
records a config error and runs the source loader uncached.

Remote-read waiting is runtime-controlled too. An overlay
`remoteReadTimeoutMs` takes precedence over the operation's `defaultConfig`,
then the instance's `redis.readTimeoutMs`, then the 50-millisecond core default.
Remote reads always have a finite positive deadline.

See [Configuration and cache layers](https://github.com/lan17/DialCache/blob/main/docs/configuration.md)
for sparse-overlay precedence, validation, and layer behavior.

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
- A remote miss runs the fallback and attempts to populate active shared
  layers.
- A remote read failure or timeout runs the fallback without a second Redis
  operation. An untracked result may still populate process-local cache; a
  tracked result does not, because watermark safety was not established.
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
`DialCache` instance for the shared layers. This mitigates hot-key stampedes
inside that scope; it is not cross-process coordination.

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

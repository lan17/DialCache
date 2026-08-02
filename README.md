# DialCache

[![npm version](https://img.shields.io/npm/v/dialcache.svg)](https://www.npmjs.com/package/dialcache)
[![Codecov](https://codecov.io/gh/lan17/DialCache/branch/main/graph/badge.svg)](https://codecov.io/gh/lan17/DialCache)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lan17/DialCache/badge)](https://scorecard.dev/viewer/?uri=github.com/lan17/DialCache)

**Read-through caching with the controls production systems need.**

DialCache is a TypeScript read-through caching library for database and service
reads in production Node.js applications.

Wrap a reusable function with `cached()` or keep a loader inline with
`getOrLoad()`; when the active cache layers miss, DialCache calls your loader
and publishes the result to whichever request-local, bounded process-local,
and optional Redis or Valkey layers are active.

Around that core path, DialCache provides patterns that high-scale services
otherwise have to build themselves: request coalescing, per-use-case runtime
policy, deterministic ramp-up and ramp-down, detached shadow validation,
fail-open cache access, targeted invalidation, serialization, deadlines, and
backend-neutral metrics.

The “dial” is the runtime policy: start a use case at zero, expand local or
remote caching to stable key cohorts, and reverse the rollout without changing
the loader.

DialCache is a backend application library—not a frontend data cache, cache
server, Redis or Valkey client, or configuration control plane. Your service
owns the loader, clients, dynamic configuration source, cache identity, TTLs,
invalidation windows, admission control, and resource budgets.

## Safety comes from explicit controls

- **Off by default.** Outside `dialcache.enable(...)`, calls go straight to the
  loader without building a key, resolving policy, accessing a cache, or
  coalescing work.
- **Gradual and reversible.** Start process-local and remote ramps at `0`,
  expand either to a stable key cohort, and turn every cache layer back off
  through runtime policy.
- **Fail-open cache path.** Cache-plumbing failures fall through to the loader
  instead of replacing a usable result. Explicit invalidation failures still
  surface to the caller.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Dial caching up or down](#dial-caching-up-or-down)
- [Validate Redis before serving it](#validate-redis-before-serving-it)
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

A typical adoption path treats the quick start as local verification, not as
the initial production rollout policy:

1. verify the loader, key, and process-local behavior in development;
2. before production, add
   [Prometheus or Datadog](https://github.com/lan17/DialCache/blob/main/docs/observability.md)
   and an application-owned runtime policy that sets both shared serving ramps
   and `shadow.ramp` to `0`;
3. add a remote TTL and
   [Redis or Valkey](https://github.com/lan17/DialCache/blob/main/docs/redis.md)
   while the remote serving ramp remains `0`;
4. for tracked use cases, optionally
   [validate and fill Redis in shadow mode](https://github.com/lan17/DialCache/blob/main/docs/shadow-validation.md)
   without serving it; and
5. increase process-local, shadow, and remote cohorts independently while
   monitoring their load and outcomes.

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
      shadow: { ramp: 0 },
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
    shadow: { ramp: 0 },
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
    shadow: { ramp: 0 },
  }),
);

// Reverse the rollout without changing getUser.
runtimePolicies.set("GetUser", DialCacheKeyConfig.disabled());
```

In this example, the zero-ramp `defaultConfig` is the safety net: if the
provider has no matching entry, both shared serving layers and shadow work
remain off.

In production, the provider can read from an application-owned dynamic config
client instead of an in-memory map. DialCache resolves one policy snapshot per
enabled `cached()` or `getOrLoad()` invocation.

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
`DialCacheKeyConfig.disabled()` sets it to `false`, sets `shadow.ramp` to `0`
and `shadow.logMismatches` to `false`, and ramps both the process-local and
remote layers to `0`.

A remote serving ramp of `0` alone does not override an inherited nonzero
`shadow.ramp`; set both ramps to `0` to stop new invocation-driven Redis reads
and fills.

See [Configuration and cache layers](https://github.com/lan17/DialCache/blob/main/docs/configuration.md)
for sparse-overlay precedence, provider failure behavior, externally
coordinated cohorts, remote-read deadlines, and layer validation.

## Validate Redis before serving it

For invalidation-tracked use cases, shadow mode can exercise Redis before Redis
is allowed to serve callers. On a selected tracked Redis hit, DialCache returns
the cached value first, then compares a fresh decoding of the retained payload
with a detached source read.

When the remote serving ramp excludes a selected key, shadow work reuses the
caller's source result to inspect Redis and can fill a clean miss.

Shadow work never supplies, delays, or rejects the caller. It is separately
sampled by `shadow.ramp`, bounded per instance by `shadowMaxInFlight`, and
disabled unless the metrics adapter implements the shadow outcome hook.

Shadow validation can add source and Redis work, remains best-effort during
shutdown, and requires tracked keys plus a valid remote TTL.

Confirmed mismatch warnings are separately opt-in through
`shadow.logMismatches`. They can include logical cache keys and JSON-serialized
values: the fields are capped, not redacted, so enable them only for trusted,
bounded values under an approved logging and data-handling policy.

See [Shadow validation and Redis bootstrap](https://github.com/lan17/DialCache/blob/main/docs/shadow-validation.md)
for eligibility, rollout design, comparison semantics, command amplification,
deadlines, metrics, invalidation, and lifecycle requirements.

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
- Selected tracked keys can schedule detached shadow work after a Redis serving
  hit or when the Redis serving ramp excludes the key. Shadow work never serves
  the caller; it can validate a hit or fill a clean miss.
- A caller-path remote read failure or timeout runs the fallback without a
  second caller-path Redis operation. Tracked invalidation adds a stricter
  [publication rule](https://github.com/lan17/DialCache/blob/main/docs/invalidation.md#read-and-write-behavior).
- Same-key concurrent work is coalesced within the scope of the first active
  layer.

When all serving layers are disabled by policy, an initially enabled call
remains uncached and uncoalesced even if selected shadow work runs
independently; its fallback deadline still applies. A call that started outside
an enabled scope remains a true pass-through and does not get a DialCache
deadline or shadow work.

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
| `shadowComparator` | no | Defines synchronous application-level equality for shadow validation; strict deep equality is the default. |
| `trackForInvalidation` | no | Opts the remote entries into watermark-based targeted invalidation. |
| `fallbackTimeoutMs` | no | Sets the fallback deadline; defaults to `60_000`, and `null` disables it. |

Use `getOrLoad(load, options)` when a one-shot calculation should remain inline.
It follows the same cache, policy, coalescing, invalidation, serialization, and
deadline contracts, but takes a direct `key` instead of a `cacheKey` selector.
For repeated inline calls that represent the same operation, reuse one stable,
deployment-defined `useCase`.

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

Shadow validation uses detached Redis work but is not another serving
`CacheLayer`. Its sampling, capacity, deduplication, deadline, and metrics
contracts are independent of request coalescing and the remote serving ramp.

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

`invalidateRemote()` is an explicit remote maintenance operation and requires
this `DialCache` instance to have a Redis or Valkey client. Without one, it
rejects instead of reporting a no-op as successful.

Invalidation is deliberately remote-only. It does not evict existing
request-local or process-local values, so strongly invalidated mutable data
should disable those layers or tolerate their TTL-bounded staleness.

The buffer must be a named, application-owned nonzero value no greater than
365 days, sized for clock skew and the full stale-work window. See
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
clients. Their fixed schemas report layer requests, misses, disabled reasons,
coalescing scopes, serialization work, shadow outcomes, and cache versus
fallback failures.

Keep application-owned namespaces, use-case names, and key types stable and
low-cardinality. Optional confirmed-mismatch warnings are value-bearing logs,
not metrics, and require separate data-handling review.

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
- verify serializer compatibility across mixed application versions;
- before enabling shadow mode, confirm the loader is safe for an extra
  observational read, preserve immutable inputs and results, bound concurrency,
  and monitor added load and outcomes;
- before enabling shadow mismatch logging, approve how logical keys and
  serialized values are redacted, transported, accessed, and retained;
- plan shutdown around detached shadow work and application-owned dependencies; and
- for tracked invalidation, use synchronized Redis clocks, durable non-evictable
  watermarks, and an application-sized nonzero buffer.

## Reference guides

- [Configuration and cache layers](https://github.com/lan17/DialCache/blob/main/docs/configuration.md) — definitions, keys,
  runtime overlays, request-local and process-local behavior, and value
  ownership.
- [Redis and Valkey](https://github.com/lan17/DialCache/blob/main/docs/redis.md) — node-redis and GLIDE setup, lifecycle,
  liveness, binary protocol, and serialization.
- [Shadow validation and Redis bootstrap](https://github.com/lan17/DialCache/blob/main/docs/shadow-validation.md) —
  non-serving rollout, eligibility, comparison, clean-miss filling, capacity,
  deadlines, metrics, mismatch diagnostics, and lifecycle.
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

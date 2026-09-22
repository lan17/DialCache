# TypeScript integration

[Shared guides](../index.md) · [Getting started](../getting-started.md) · [API reference](../api.md)

The TypeScript implementation is the executable reference for DialCache's
portable behavior. The shared feature guides apply across ports; this page
explains the Node.js binding.

## Installation and runtime

```bash
npm install dialcache
```

Supported Node.js versions are `>=22.15.0 <23.0.0 || >=23.8.0`. The package ships
ESM and CommonJS entry points plus TypeScript declarations. Applications own
Redis and telemetry clients; integrations are optional subpath imports.

The [getting-started example](../getting-started.md#wrap-a-reader) is imported
from an executed native example. For a standalone script, the package
[README](https://github.com/lan17/DialCache/blob/main/typescript/README.md) contains a complete example.

## Request scope and operations

Create a long-lived `DialCache`, register readers with `cached`, and wrap read
request handling in `enable(async () => ...)`. `AsyncLocalStorage` carries the
enabled state through nested async calls. `disable` temporarily derives a
pass-through region. When the outer callback settles, retained async context
stops enabling new work and can no longer accept request-local publication.

`getOrLoad` runs an inline operation without registering its use case. Readers
always return promises. Keep the source arguments and captured state immutable
when detached shadow work can use them later.

## Policy and errors

`DialCacheKeyConfig` supplies static defaults and sparse runtime overlays from
`cacheConfigProvider`. TTL and recovery fields use seconds; read and source
deadlines use milliseconds. Omission inherits; `false` and `0` are explicit
values. `DialCacheKeyConfig.disabled()` stops new cache and shadow admission
without canceling work or evicting data.

Static option validation throws. Cache plumbing errors fail open to the source;
source throws and rejections retain their identity. `FallbackTimeoutError`
identifies the library's source deadline. Explicit `invalidateRemote` returns a
promise whose failure must be handled by maintenance code.

A deadline cannot preempt synchronous JavaScript. Bound dependency work and
avoid blocking the event loop. Timeout rejection does not cancel the source.

## Values and codecs

Objects in memory and coalesced results share references. Treat them as
immutable. The default `JsonSerializer` supports JSON and a top-level undefined
marker, but does not preserve prototypes, dates, cycles or arbitrary class
instances. Non-JSON-compatible result types require a typed `Serializer<T>` even
when the initial policy enables only memory caching; runtime policy may add
Redis later. See [serialization](../redis.md#serialization).

When sharing Redis with other ports, agree on the value schema. Rust maps the
undefined marker to JSON null, and Go/Rust JSON strings do not support unpaired
UTF-16 surrogate code units. Successful decoding does not prove schema agreement.

## Integrations

- [Redis and Valkey](../redis.md): `dialcache/node-redis` and `dialcache/valkey-glide` wrap connected application-owned clients.
- [Observability](../observability.md): `dialcache/prometheus` uses a supplied registry; `dialcache/datadog` uses a supplied DogStatsD client.
- [Shadow validation](../shadow-validation.md#comparison-semantics): the default comparator is Node's `util.isDeepStrictEqual`; provide `shadowComparator` for domain equality.

The site and generated API reference follow repository `main`. Use release-tag
source and the installed package's declarations for an older release.

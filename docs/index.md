# DialCache documentation

DialCache adds configurable read-through caching to TypeScript functions in
Node.js services. This reference explains the system from the outside in:
first the read path, then the policies that control it, then individual APIs
and integration contracts.

## Start here

1. [Getting started](getting-started.md) — run a small example, choose a scope,
   and connect a reader to runtime policy.
2. [How DialCache works](concepts.md) — follow a call through enablement, cache
   layers, coalescing, and the source loader.
3. [Configuration](configuration.md) — define identities, select layers, and
   change TTLs and stable rollout cohorts.

## Features and behavior

| Topic | What it explains |
| --- | --- |
| [Redis and Valkey](redis.md) | Connect clients, understand native reads and writes, choose serializers and compression, and implement an adapter |
| [Targeted invalidation](invalidation.md) | Refresh tracked entities, size the future buffer, and understand clocks, watermarks, and local-cache boundaries |
| [Stale-on-error](stale-on-error.md) | Retain a Redis snapshot for selected source failures, choose age limits, and understand recovery races |
| [Shadow validation](shadow-validation.md) | Compare Redis with the source and fill misses without serving shadow results |
| [Coalescing and liveness](coalescing.md) | Share same-key work, configure deadlines, and inspect in-flight state |
| [Observability](observability.md) | Set up Prometheus or Datadog, interpret metrics, and implement custom telemetry |

## Reference and operations

| Topic | What it explains |
| --- | --- |
| [API reference](api.md) | Public methods, operation options, configuration defaults, errors, and import paths |
| [Upgrading](upgrading.md) | Protocol cutovers, longer Redis retention, serializer compatibility, and metric migrations |
| [Maintainer guide](maintainers.md) | Local validation, documentation, benchmarks, and releases |

These pages describe the code on this branch, based on `v0.23.2`. Documentation
on `main` follows the repository; use the matching
[release tag](https://github.com/lan17/DialCache/tags) when checking an older
installation. The package's TypeScript declarations are the exact type source.

[Project overview](https://github.com/lan17/DialCache#readme)
· [npm package](https://www.npmjs.com/package/dialcache)
· [Source code](https://github.com/lan17/DialCache)

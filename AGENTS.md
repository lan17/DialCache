# AGENTS.md

## Project overview

DialCache is a TypeScript caching library with explicit request-scoped enablement, local and Redis layers, runtime rollout controls, request coalescing, detached Redis shadow validation and bootstrap, targeted invalidation, and adapter-based observability.

## Structure

```text
README.md              # Adoption guide, safety model, and reference routing
docs/                  # Focused user-facing configuration and operations guides
src/
  index.ts              # Public root entry point (barrel)
  dialcache.ts          # Main DialCache API and cached-function wrapper
  errors.ts             # Public core error classes (DialCacheError hierarchy)
  config.ts             # Public configuration and rollout types
  context.ts            # AsyncLocalStorage-based enabled context
  key.ts                # Structured cache keys and Redis hash tags
  metrics.ts            # Backend-neutral metrics adapter contract
  prometheus.ts         # Optional Prometheus adapter
  datadog.ts            # Optional Datadog (DogStatsD) adapter
  redis-client.ts       # Client-independent semantic Redis interface and its public error classes
  node-redis.ts         # node-redis adapter and script registration
  valkey-glide.ts       # Valkey GLIDE adapter (standalone and cluster)
  redis-protocol.ts     # Public frame codec and Lua protocol exports
  serializer.ts         # Serializer contract and JSON implementation
  internal/             # Cache layers, runtime config, payload compression, and mutation Lua scripts
test/                   # Unit and Redis integration tests
```

## Critical behavior

- Caching is disabled by default and enabled only inside `dialcache.enable(...)`.
- Disabled calls are true pass-through and must not build keys, resolve config, or coalesce work.
- Active same-key work is coalesced before the first active cache layer, using
  request scope for request-local caching and process scope for shared layers,
  unless the use case's resolved `coalesce` policy disables it.
- Shadow validation is opt-in, detached work for tracked and untracked remote
  caches that never supplies or delays the caller; it has separate sampling,
  capacity, deadline, invalidation, and observability contracts.
- Shadow policy is grouped under `DialCacheKeyConfig.shadow`. Mismatch logging
  is default-off diagnostic output; its size limits are not redaction.
- Cache plumbing fails open; explicit maintenance operations surface mutation failures.
- `invalidateRemote()` requires a configured Redis client and rejects when the
  client is absent or the watermark mutation fails.
- Tracked Redis values and invalidation watermarks share a Redis Cluster hash tag.
- Tracked reads run on primaries so replica lag cannot hide invalidation.
- A tracked write's placeholder frame (version byte 0) is unreadable on both
  read paths until the stamp script promotes it, and the stamp promotes only
  the placeholder carrying its own per-write nonce.
- A SET failure is the tracked write's outcome even when the stamp settled.
- Local entries are process-local and are not synchronously invalidated across instances.

## Conventions

- Preserve strict TypeScript settings and public abstraction boundaries.
- Keep the README focused on evaluation and adoption. Put complete operational
  contracts in a focused `docs/` guide and link it from the relevant README
  summary.
- Keep Redis client-specific behavior in adapters; core code depends on `DialCacheRedisClient`.
- Public exports belong in the root or an explicit integration entry point such
  as `src/node-redis.ts`, `src/valkey-glide.ts`, `src/prometheus.ts`,
  `src/datadog.ts`, or `src/redis-protocol.ts`.
- Use `corepack pnpm` for project commands.

## Validation

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:package
corepack pnpm test:integration
```

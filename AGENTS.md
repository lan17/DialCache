# AGENTS.md

## Project overview

DialCache has TypeScript, Go, Rust and Python implementations with explicit request-scoped enablement, local and Redis layers, runtime rollout controls, request coalescing, targeted invalidation, and adapter-based observability.

## Structure

```text
README.md              # Landing page and documentation entry point
docs/                  # User guides and API reference
typescript/             # Published npm package, README and build configuration
  src/
    index.ts            # Public root entry point (barrel)
    dialcache.ts        # Main DialCache API and cached-function wrapper
    errors.ts           # Public core error classes (DialCacheError hierarchy)
    config.ts           # Public configuration and rollout types
    context.ts          # AsyncLocalStorage-based enabled context
    key.ts              # Structured cache keys and Redis hash tags
    metrics.ts          # Backend-neutral metrics adapter contract
    prometheus.ts       # Optional Prometheus adapter
    datadog.ts          # Optional Datadog (DogStatsD) adapter
    redis-client.ts     # Client-independent semantic Redis interface and its public error classes
    node-redis.ts       # node-redis adapter and invalidation dispatch
    valkey-glide.ts     # Valkey GLIDE adapter (standalone and cluster)
    redis-protocol.ts   # Public frame codec and Lua protocol exports
    serializer.ts       # Serializer contract and JSON implementation
    internal/           # Cache layers, runtime config, payload compression, and invalidation Lua script
  test/                 # Unit, Redis integration and shared-corpus replay tests
  examples/             # Executable native documentation examples
  scripts/              # Package checks and TypeScript benchmarks
go/                     # Go module and public API (stable import path)
  internal/dialcache/    # Go implementation and native/shared-corpus tests
rust/                   # Rust crate, public cache and adapters, shared-corpus replay (tests/conformance.rs)
python/                 # Async Python package, borrowed Redis adapter, native tests and shared-corpus replay
formal/                 # Quint behavioral source of truth, contracts and portable vectors
scripts/                # Shared documentation tools
package.json            # Private shared tooling and TypeScript command dispatch
pnpm-workspace.yaml     # TypeScript package membership and shared dependency policy
pnpm-lock.yaml          # Shared workspace dependency lockfile
```

## Critical behavior

- Caching is disabled by default and enabled only inside `dialcache.enable(...)`.
- Disabled calls are true pass-through and must not build keys, resolve config, or coalesce work.
- Active same-key work is coalesced before the first active cache layer, using
  request scope for request-local caching and process scope for shared layers,
  unless the use case's resolved `coalesce` policy disables it.
- Cache plumbing fails open; explicit maintenance operations surface mutation failures.
- Tracked Redis values and invalidation watermarks share a Redis Cluster hash tag.
- Tracked reads run on primaries so replica lag cannot hide invalidation.
- Every Redis value write is one native `SET` of a complete version-1 frame
  stamped from the writer process's clock; Redis value writes never create or
  extend watermarks.
- A tracked read atomically reads the value and watermark from the primary and
  serves the frame only when `createdAtMs` is strictly greater than the
  watermark. A missing watermark is the zero baseline.
- Local entries are process-local and are not synchronously invalidated across instances.

## Conventions

- Preserve strict TypeScript settings and public abstraction boundaries.
- Keep the root README focused on evaluation and language entry points, and
  `typescript/README.md` suitable for npm consumers. Document complete feature
  behavior in `docs/` and link it from `docs/index.md`.
- Keep Redis client-specific behavior in adapters; core code depends on `DialCacheRedisClient`.
- Public TypeScript exports belong in `typescript/src/index.ts` or an explicit integration entry point such as `typescript/src/node-redis.ts`, `typescript/src/prometheus.ts`, or `typescript/src/redis-protocol.ts`.
- Public Go exports belong in `go/api.go`, `go/adapters.go`, or `go/protocol.go`.
  Keep implementation and same-package tests in `go/internal/dialcache/`;
  public examples and API compatibility checks use the root Go package.
- Use `corepack pnpm` for project commands.
- Run shared `make` targets and pnpm commands from the repository root; the
  private workspace package dispatches native TypeScript commands. Keep npm
  package paths and exports independent of the repository's `typescript/` prefix.
- For documentation work, follow `docs/authoring.md`. Maintain shared behavior
  prose once, import executable native examples by named region, and keep real
  language differences in `LanguageContent` notes or the short native guides.
  `make docs` generates all native references and checks snippet sources and
  internal links; it requires the pinned Go and Rust toolchains, Python and Node.
  Run changed native examples with assertions (including Redis when relevant).
- Start formal work at `formal/README.md`. `formal/WALKTHROUGH.md` follows one
  contract through Quint, generated inputs and the native language replays;
  `formal/AUTHORING.md` explains how to extend that chain. Read the relevant
  model and profile bindings before opening large generated JSON artifacts.
- For formal specification changes, follow `formal/AUTHORING.md`: keep models
  readable as behavior definitions, share helpers with identical meaning, retain
  independent property checks, and register executable evidence in the catalogs.
- Define portable behavior in Quint first. Require consequential generated
  witnesses and replay the same histories in TypeScript, Go, Rust and Python; keep
  native API, wire and integration tests for their explicit boundaries.
- Use the shared behavioral testbed for portable features and bug fixes, with
  TypeScript as the executable reference. Follow the workflow in
  `formal/AUTHORING.md` and preserve discovered bugs as deterministic regressions.
  Extend formal infrastructure when it closes a concrete coverage gap, corrects
  misleading evidence, or makes tests easier to author, understand or run.

## Validation

```bash
corepack pnpm install --frozen-lockfile
make check
make integration
```

`make check-rust` runs the Rust crate's fmt, clippy, unit, vector, scenario and
smoke checks; `make formal-rust` completes its replay of the generated corpus.
For Python, create `python/.venv` with Python 3.11 or later and install
`python/.venv/bin/python -m pip install -e './python[test,redis]'`.
`make check-python` runs native, wire and committed smoke tests;
`make integration-python` provisions isolated Redis/Valkey/Cluster servers;
`make formal-python` runs the prepared generated corpus and completion checks.
Set `PYTHON` to use another prepared interpreter. Python's package has no Node
runtime dependency; the shared replay and validation tools require Node 24.
Use `make formal` for complete Quint model checks, corpus generation and every
port's full replay, then `make mutations` for assertion-strength checks.
`make ci` runs all validation in the required order. `make help` lists targets
and prerequisites; `formal/README.md` documents the fast PR and full-validation
workflows. Full behavior/model/replay changes require full validation before
merge; smoke tests cannot satisfy the full conformance gate.

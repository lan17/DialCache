# DialCache for Rust

DialCache organizes caching into use cases, with runtime control and
observability for each one. This crate is the Rust port. It behaves like the
[TypeScript library](https://github.com/lan17/DialCache/blob/main/typescript/README.md)
and the [Go port](https://github.com/lan17/DialCache/blob/main/go/README.md):
all three replay the same formally generated histories through their public
APIs.

**TypeScript is the reference implementation. Rust and Go are experimental.**

- **Off by default:** a call caches only inside an enabled request `Scope`.
- **Multi-layer:** request-local → process-local → Redis.
- **Runtime policies per use case:** layers, TTLs and rollout ramps.
- **Targeted invalidation:** one call per entity for its tracked Redis results.
- **Coalescing:** same-key reads share one source call when a layer is active.
- **Fail-open:** cache failures fall back to the source.
- **Stale-on-error (opt-in):** a retained Redis value when the source fails.
- **Shadow validation (opt-in):** background checks of Redis against the source.
- **Observability:** Prometheus and Datadog exporters with shared metric names.

[Shared guides](https://lan17.github.io/DialCache/)
· [Rust integration guide](https://lan17.github.io/DialCache/languages/rust)
· [API reference](https://docs.rs/dialcache)

## Install

```sh
cargo add dialcache
cargo add tokio --features macros,rt-multi-thread,time
```

The crate needs Rust 1.85 or later. The `redis` feature needs Rust 1.88
because of the locked `redis` 1.x dependency. CI pins 1.98.1 in
`rust/rust-toolchain.toml`, which rustup honors when cargo runs inside `rust/`.

| Feature | Enables |
| --- | --- |
| `tokio` (default) | `TokioRuntime`: detached work and timers on the current Tokio runtime |
| `redis` | `RedisAdapter` over the `redis` crate (add `redis` with its `tokio-comp` feature) |
| `prometheus` | `PrometheusObserver` on a `prometheus::Registry` |
| `test-util` | `testing::TestExecutor`: a deterministic executor with a virtual clock |

Structured values need `serde` with `derive`. Datadog needs no feature:
`DatadogObserver` sends through a caller-supplied `DogStatsdClient`.

## Usage

```rust
use std::sync::Arc;

use dialcache::{BoxError, DialCache, Identity, KeySpec, Operation, Policy};

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    // Startup: build one cache per process and register each use case once.
    let cache = DialCache::builder().namespace("my-app").build()?;
    let display_name = cache
        .use_case::<u64, String>("user", "displayName") // key type, use case
        .policy(Policy::default().request_local(true).local_ttl_sec(30))
        .key(|id: &u64| KeySpec::new(id)) // every input that changes the result
        .source(|_scope, id| async move {
            // The loader: replace with the database or API read.
            Ok(format!("User {id}"))
        })
        .register()?;

    // Request handler: open one scope and pass it to every cached call.
    let request = cache.enable_guard();
    let name: Arc<String> = display_name.get(request.scope(), 42).await?;
    let again = display_name.get(request.scope(), 42).await?; // hit: same Arc
    assert!(Arc::ptr_eq(&name, &again));

    // Inline form: a key and a loader, no registration.
    let email: Arc<String> = cache
        .get_or_load(
            request.scope(),
            Operation::new(Identity::new("user", 42, "email"))
                .policy(Policy::default().request_local(true)),
            |_scope| async { Ok("ada@example.com".to_owned()) },
        )
        .await?;
    println!("Hello, {name} <{email}>!");
    drop(request); // Closes the request scope; the Arcs stay usable.

    // Without a scope, calls go straight to the source.
    let fresh = display_name.get_uncached(42).await?;
    assert_eq!(*fresh, *name);
    Ok(())
}
```

Rules that apply to every cached call:

- Build the cache inside a running Tokio runtime with its time driver; building
  outside one returns `ConfigError`. `TokioRuntime::from_handle` selects a
  runtime explicitly.
- Values come back as `Arc<T>` shared between callers: treat them as immutable.
  `T: Clone` is never required.
- Keep one Rust type per key. A memory entry of another type is a miss, and a
  coalesced caller that asked for another type gets a type error.
- A source may run again later for shadow validation, so it must be safe to
  call repeatedly.
- Dropping the future returned by `get` cancels nothing: the source call, cache
  writes and other callers keep their contracts.

Two complete programs live in
[`rust/examples`](https://github.com/lan17/DialCache/tree/main/rust/examples):
`basic` (a struct value, an async source, two request scopes) and `redis`
(application-owned timeouts, tracked Redis caching, invalidation).

```sh
cd rust
cargo run --example basic
REDIS_URL=redis://127.0.0.1/ cargo run --features redis --example redis
```

## Request scopes

Caching is off until a request opens a scope. Pass that scope to every cached
call made for the request, including calls a source makes. Closing the scope
ends the request-local cache: retained `Scope` clones pass through to their
sources, and late work cannot write into the closed request's cache.

- `enable_guard()` opens the scope and returns a guard. `guard.scope()` is the
  handle; dropping the guard closes the scope.
- `enable(|scope| async { ... })` is the closure form. The scope closes when
  the future completes or is dropped.
- `enable_in(&scope, ...)` and `disable_in(&scope, ...)` derive nested scopes
  that share the request's cache. Wrap mutations in `disable_in` so a write
  path cannot cache a read it is about to make stale.
- `Scope::outside()` is the pass-through scope for work that belongs to no
  request, and `get_uncached(args)` calls the source directly.

## Policy

A `Policy` is a use case's static baseline. `Policy::default()` enables no
layer; each leaf turns one thing on.

| Leaf | Meaning |
| --- | --- |
| `request_local(bool)` | Reuse results within one request scope |
| `local_ttl_sec(n)` / `remote_ttl_sec(n)` | Process-local and Redis lifetimes in whole seconds, 1 or more; omitted keeps the layer off |
| `local_ramp(pct)` / `remote_ramp(pct)` | Stable cohort of keys served from each layer, 0 to 100; omitted serves every key |
| `coalesce(bool)` | Share one source call among same-key callers; on unless set to false |
| `stale_on_error_max_age_sec(n)` | Serve a retained Redis value up to this age when the source fails |
| `remote_read_timeout_ms(n)` | Redis read deadline before falling through to the source |
| `shadow(ShadowPolicy)` | `ramp` picks the shadow cohort; `log_mismatches` warns once per confirmed mismatch |

`Policy::enabled(ttl)` sets both TTLs to `ttl` with full ramps.
`Policy::disabled()` turns every layer, recovery and shadow off explicitly,
which makes it a useful runtime overlay. `Policy::from_json` and `to_json` use
the TypeScript JSON shape.

### Changing policy at runtime

`policy_provider` on the builder runs once per enabled call and returns a
sparse `RuntimePolicy` overlay. `RuntimePolicy::from(policy)` converts a typed
`Policy`.

- `Ok(None)` inherits the baseline.
- A present leaf replaces the baseline's; an omitted leaf inherits. That
  includes `request_local` and `coalesce`, so a TTL-only overlay keeps the
  flags.
- An invalid TTL or ramp disables only that layer. An invalid flag or read
  deadline bypasses caching for that call.
- Changes apply to new calls. Nothing already cached is evicted and nothing
  already admitted is cancelled.

### Instance defaults

| Setting | Default | Where to change it |
| --- | --- | --- |
| Namespace (key prefix) | `urn` | `namespace` on the builder |
| Process-local capacity (LRU) | 10,000 entries | `local_capacity` |
| Redis read deadline | 50 ms | `remote_read_timeout_ms` |
| Source deadline | 60 s | `budget(SourceBudget)` on the use case: `Millis(n)` or `Unbounded` |
| Concurrent shadow jobs | 1 | `shadow_max_in_flight` |
| Compression | zstd level 3 above 4,096 bytes | `compression(CompressionConfig)` or `disable_compression` |

Invalid builder configuration returns `ConfigError` from `build`; invalid use
case configuration is returned by `register` before any call runs.

## Errors and deadlines

- Source errors surface as `Error::Source(Arc<dyn Error>)`. Every coalesced
  caller receives the same `Arc`, so `Arc::ptr_eq` identifies one failure.
- A source deadline returns `Error::FallbackTimeout` and does not cancel the
  source.
- A panic in a source, codec, policy provider or comparator becomes
  `Error::Panic`.
- Cache plumbing fails open: a Redis or codec failure falls through to the
  source. Maintenance calls return their errors: `Error::Remote` from the
  adapter, `Error::MissingRemote` when no remote is configured.
- Observer and logger failures never change a cache, source or maintenance
  result.

## Keys

`KeySpec::new(id)` and `Identity::new(key_type, id, use_case)` accept strings,
integers and floats, including references such as `&u64`. Integers keep their
exact decimal text and floats use JavaScript number spelling (`f32` is promoted
to `f64`), so one identity produces the same Redis key in every language. For
other ID types pass `id.to_string()` or implement `IntoKeyId`.

`KeySpec::arg` adds secondary dimensions under the same scalar rules, and
`normalize_args` orders their names by UTF-16 code units. Entries shared across
languages need the same namespace, key dimensions, codec and policy. See
[Keys and identity](https://lan17.github.io/DialCache/keys.html).

## Redis and invalidation

```sh
cargo add dialcache --features redis
cargo add redis --features tokio-comp
```

`RedisAdapter` wraps a caller-owned `redis` connection: `ConnectionManager`,
`MultiplexedConnection` or a cluster connection. The application owns
connection setup, timeouts, retries and concurrency limits; the
[Redis example](https://github.com/lan17/DialCache/blob/main/rust/examples/redis.rs)
shows one configuration. On a cluster, tracked reads go to the slot primary.

Key layout, wire format and the invalidation script are shared with TypeScript
and Go, so all three read and write each other's entries. Custom `Remote`
implementations follow the
[custom-client contract](https://lan17.github.io/DialCache/redis.html#custom-client-contract).

Mark a use case `.tracked(true)` to make its Redis results invalidatable by
entity. After committing a source mutation:

```rust,ignore
cache.invalidate("user", 42, 0).await?;
```

`invalidate` records an entity-wide cutoff (a watermark) in Redis. Tracked
results of that entity written before the cutoff stop being served, across
every use case and argument variant. The last argument is a future buffer in
milliseconds; zero adds none.

`invalidate` changes Redis only: request-local and process-local entries in
every process keep their normal lifetimes. An inline operation in another
namespace is invalidated through `invalidate_identity`, which ignores the
identity's `tracked` flag:

```rust,ignore
let identity = Identity::new("user", 42, "displayName").namespace("tenant-b");
cache.invalidate_identity(identity, 0).await?;
```

An empty namespace inherits the instance's. See
[Targeted invalidation](https://lan17.github.io/DialCache/invalidation.html)
and [Redis and Valkey](https://lan17.github.io/DialCache/redis.html).

## Values, codecs and compression

`JsonCodec` (serde_json) is the default. `Codec<T>` is asynchronous; `FromSync`
adapts a synchronous `SyncCodec`. TypeScript's `undefined` sentinel decodes as
JSON `null`, so an `Option<T>` reads it as `None`. For remote writes the engine
calls `Codec::encode_owned` with the `Arc<T>`; the default delegates to
`encode(&T)`, and overriding it hands a non-`Clone` value to a background job
without copying.

Compression is on by default. `disable_compression` writes raw while reads
still accept compressed entries; the wire contract requires interoperable
decompression, not identical bytes.

Heavy work stays off the async threads. Payloads of 64 KiB or more, any
compression at levels 10 to 22, and all decompression run through
`Runtime::spawn_blocking` on a bounded CPU executor shared by every instance:
two workers, two queued jobs.

Admission never waits. When the executor is full, a read falls through to the
source and a write is skipped, with the source result preserved. Custom
runtimes may supply their own bounded executor.

Application codecs schedule their own work. The default JSON codec and
`FromSync` run inline, so very large values can occupy an async worker.

## Observability

`Observer` receives every diagnostic as a typed `Event`, and `MetricKind` maps
each event to the metric names, labels and values TypeScript and Go export.
Shadow validation exists only to be observed: a shadow job runs only when the
observer returns true from `observes_shadow_outcomes`, as the bundled exporters
do.

- `PrometheusObserver` (feature `prometheus`) registers its collectors on a
  `prometheus::Registry` under an optional prefix. Clone one observer for every
  instance exporting to the same registry; registering the same names twice is
  `PrometheusError::Conflict`.
- `DatadogObserver` sends the same metrics through a caller-supplied
  `DogStatsdClient`; `DatadogOptions` selects histogram or distribution and a
  namespace.
- `Logger` receives structured `LogEvent`s and defaults to the `log` facade.
  Stale-recovery decode warnings omit error text that could contain cached
  values; a custom `Logger` can inspect the original error.
- Mismatch logging (`ShadowPolicy::log_mismatches`) is opt-in and bounded. A
  confirmed mismatch is previewed through the use case's `preview` (JSON by
  default, 8 KiB prefix) on the CPU executor; when the executor is full, the
  mismatch is logged without previews.

See [Observability](https://lan17.github.io/DialCache/observability.html) for
the metric catalog.

## Runtime, clock and tests

`Runtime` supplies detached task admission, timers and `spawn_blocking`;
`Clock` separates wall time from elapsed time. The defaults are `TokioRuntime`,
which captures the runtime handle current at `build`, and `SystemClock`, which
reads on the same whole-millisecond ticks local expiry uses.
`SystemClock::with_sources` applies that to caller-supplied time sources.

With `test-util`, `testing::TestExecutor` runs detached work until nothing is
left to run and delivers timers only when the test advances time. The
conformance suite is built on it.

Three guarantees hold under shutdown and eviction:

- When the cache outlives its runtime and a shared source call is dropped
  before it finishes, the callers waiting on it get an error instead of hanging.
- Local storage hands evicted entries back to the cache, so a value's
  destructor never runs under a cache lock.
- A shadow job keeps its slot until its CPU work finishes or is discarded,
  including after a deadline or runtime shutdown.

## Differences from TypeScript and Go

- An explicit `Scope` replaces TypeScript's implicit async context and Go's
  `context.Context`.
- Values are `Arc<T>`; sources return `Result<T, BoxError>`.
- The default shadow comparator is `PartialEq`, so `NaN` differs from itself
  where the TypeScript default treats it as equal. Supply a comparator for such
  domains.
- Local storage failures surface through the `LocalStore` trait rather than a
  clock fault.
- Prometheus collectors are shared by cloning the observer, not by registering
  the same names twice.

## Validation

The behavior contract is a set of
[Quint](https://github.com/informalsystems/quint) models under
[`formal/`](https://github.com/lan17/DialCache/blob/main/formal/README.md).
Every port replays the same generated histories, named regressions, fixed
scenarios and protocol vectors through its public API.

Run the Make targets from the repository root. CI pins Rust 1.98.1, Go 1.27.1,
Node 24 and pnpm 10.33.0. The conformance tests use a shared Node replay
coordinator, but the crate itself has no Node dependency.

```sh
make check-rust        # fmt, clippy, unit tests, protocol vectors, fixed scenarios, committed smoke histories
make integration-rust  # Redis, Valkey and Cluster servers through Docker, plus every invalidation vector
make formal-rust       # Complete Rust replay of the generated corpus (after make formal-generate)
make mutations-rust    # Require the harness to catch every fault in formal/rust-mutations.json
make formal            # Quint checks, corpus generation, then TypeScript, Go and Rust replay
```

`cargo test --all-features --test conformance` replays the committed smoke
histories, fixed scenarios and protocol vectors. Environment selectors narrow
or extend that run:

- `DIALCACHE_*_TRACE_DIR` and `DIALCACHE_*_TRACE_FILE` replay a directory or
  one history, under the same names Go uses.
- `DIALCACHE_WITNESS_EVIDENCE_DIR` binds the shared witness evidence for a
  complete replay.
- `DIALCACHE_RUST_REPORT` names the JSONL assertion report the completion
  checker reads. Reports and traces are kept in `.formal-traces/`.

```sh
DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json" \
  cargo test --manifest-path rust/Cargo.toml --all-features --test conformance
```

The [formal guide](https://github.com/lan17/DialCache/blob/main/formal/README.md#generating-and-replaying-behavior),
the [walkthrough](https://github.com/lan17/DialCache/blob/main/formal/WALKTHROUGH.md#run-this-example)
and the [fault catalog](https://github.com/lan17/DialCache/blob/main/formal/SEMANTIC-COVERAGE.md)
cover reproducing a trace, mutation measurement and what each lane certifies.
These are finite checks of the documented contract, not proof over every input
or schedule. Real-server integration is a separate lane, as in the other ports,
and not part of the completion claim (see `formal/profiles.json`).

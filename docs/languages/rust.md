# Rust integration

[Shared guides](../index.md) · [Getting started](../getting-started.md) · [API reference](../api.md)

The Rust port uses explicit request scopes, `Arc<T>` values and asynchronous
operations while following the shared behavioral contract.

## Installation and runtime

Rust releases use the same version as npm and Go through the
[release workflow](../maintainers.md#releasing). After the first crates.io
publication, install a released version with `cargo add dialcache`. Before that
first publication, or to use an unreleased checkout, use a path dependency:

```toml
[dependencies]
dialcache = { path = "../DialCache/rust" }
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time"] }
serde = { version = "1", features = ["derive"] }
```

Adjust the path to your checkout. The core crate requires Rust 1.85 or later;
the current `redis` dependency requires 1.88. The repository pins its CI toolchain
in `rust/rust-toolchain.toml`. Available registry versions are listed on
[crates.io](https://crates.io/crates/dialcache); docs.rs builds their API references.

Build the cache inside a live Tokio runtime with the time driver enabled. The
default `TokioRuntime` captures that handle. `TokioRuntime::from_handle` permits
an explicit runtime, and the public `Runtime` trait supports other integrations.

The [getting-started example](../getting-started.md#wrap-a-reader) is imported
from an executed native test. A complete standalone example is available in
[`rust/examples/basic.rs`](https://github.com/lan17/DialCache/blob/main/rust/examples/basic.rs):

```bash
cd rust
cargo run --example basic
```

## Request scope and operations

Create a long-lived `DialCache`, define a typed reader with `use_case`, and call
`register` once. Its source receives a `Scope` and arguments and returns a future
resolving to `Result<T, BoxError>`. `get_or_load` accepts an inline `Operation<T>`
without registration.

`enable_guard` opens a request scope. Pass `request.scope()` to each reader;
dropping the guard closes it. `enable` offers a callback form. `enable_in` and
`disable_in` derive nested scopes; `Scope::outside()` runs without caching.
Retained scope clones no longer enable caching after the outer scope closes.

## Policy and errors

Static `Policy` builders use whole seconds for TTL/recovery ages and milliseconds
for remote-read deadlines. The runtime `policy_provider` returns an optional
`RuntimePolicy`; `Ok(None)` inherits. Converting a typed policy into an overlay
preserves omitted leaves. Explicit false and zero remain distinct from omission.

`SourceBudget::Default` gives the source 60 seconds;
`SourceBudget::Millis(n)` chooses a finite budget and `Unbounded` removes it.
These are operation settings, not runtime-overlay leaves. Configuration and
registration return native errors before work begins.

Source errors appear as `Error::Source(Arc<dyn Error>)`; coalesced callers share
that error instance. A source deadline produces `Error::FallbackTimeout` and
does not cancel raw source work. Dropping a caller's returned future also does
not cancel the execution or other followers. Explicit `invalidate` errors are
returned to the maintenance caller. Cache plumbing fails open.

## Identity and values

`KeySpec` and `Identity` normalize supported primitive IDs with the shared
number spelling; `normalize_args` sorts argument names by UTF-16 code units.
Use strings or implement `IntoKeyId` for custom IDs. The same key must have the
same value meaning and compatible codec in every reader.

Results are `Arc<T>` and do not require `T: Clone`. Treat values as immutable;
interior mutation is visible to other holders. A settled memory entry of another
Rust type misses; an incompatible follower joining a live flight returns a type
error. Keep value types consistent within a keyspace.

`JsonCodec` uses serde_json. The TypeScript undefined sentinel becomes JSON null,
so `Option<T>` reads it as `None`; Rust does not preserve a separate undefined
value. JSON strings support Unicode scalar values, not unpaired UTF-16
surrogates. Custom async `Codec<T>` implementations handle other domains;
`FromSync` adapts a synchronous codec without automatically offloading it.

## Integrations

Enable the `redis` feature for `RedisAdapter`, which wraps caller-owned `redis`
crate connections, including connection managers, multiplexed connections and
Cluster connections. Tracked reads explicitly select a primary for
`ClusterConnection`; standalone/Sentinel handles must already target the primary.
See [Redis and Valkey](../redis.md) for connection and lifecycle requirements.

`Observer` receives typed events. Bundled `PrometheusObserver` (feature
`prometheus`) and `DatadogObserver` provide the shared metrics. Clone one
Prometheus observer when sharing a registry: registering the same names twice
is a conflict. Shadow admission requires an observer that opts into shadow
outcomes. See [observability](../observability.md).

The default shadow comparator uses `PartialEq`, whose treatment of native values
can differ from TypeScript; for example, NaN differs from itself. Supply a domain
comparator when appropriate. [Shadow validation](../shadow-validation.md)
describes this boundary.

Large compression jobs and all zstd decompression use a bounded CPU executor.
Application codecs choose their own scheduling. See [compression](../redis.md#compression)
for thresholds and fail-open behavior on executor saturation.

## Conformance

Run `make check-rust` from the repository root for native and committed smoke
checks. The crate has no Node dependency; repository conformance tooling uses
Node to replay the same histories as the other ports. The
[formal guide](https://github.com/lan17/DialCache/blob/main/formal/README.md)
explains complete validation and reproducing one history.

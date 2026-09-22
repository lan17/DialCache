# DialCache for Rust

Read the [shared behavior guides](https://lan17.github.io/DialCache/) and
[Rust integration guide](https://lan17.github.io/DialCache/languages/rust).
The site uses one explanation per feature with selected native examples and notes.

Rust implements the same portable behavior as the TypeScript library and the
Go port: explicit request enablement, request/local/Redis layers,
deterministic rollout, sparse runtime policy, request and process coalescing,
tracked invalidation, source and read deadlines, stale recovery, dark and
served-hit shadow validation, compression, and failure-isolated observability.

The [Quint models](../formal/README.md) are the behavioral source of truth.
The Rust conformance harness replays the same sampled histories and named
public-action regressions as the other ports, plus the fixed scenarios and
Quint-derived protocol vectors, through the shared Node replay coordinator.
These are finite checks of the documented contract, not proof of every
possible input or schedule.

## Use

The core crate requires Rust 1.85 or later; the `redis` feature requires Rust
1.88 with the currently locked Redis dependency. CI pins 1.98.1 through
`rust/rust-toolchain.toml`, which rustup honors when cargo runs inside `rust/`.
Applications own their Redis connection and its timeout, retry and
resource budgets. The default runtime is the tokio runtime that is current
while the cache is built.

```rust
use std::sync::Arc;
use dialcache::{BoxError, DialCache, KeySpec, Policy};

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    let cache = DialCache::builder().namespace("my-app").build()?;
    let display_name = cache
        .use_case::<u64, String>("user", "displayName")
        .policy(Policy::default().request_local(true).local_ttl_sec(30))
        .key(|id: &u64| KeySpec::new(id))
        .source(|_scope, id| async move {
            // Replace this with your database or API call.
            Ok(format!("User {id}"))
        })
        .register()?;

    let request = cache.enable_guard();
    let name: Arc<String> = display_name.get(request.scope(), 42).await?;
    println!("Hello, {name}!");
    Ok(())
}
```

A policy enables no cache layers by default. The example opts into request
caching and a 30-second process-local cache; register the use case once at
startup and create a scope for each request. `Arc<T>` shares one cached value
without requiring `T: Clone`. Settled memory entries holding another Rust type
are misses; compatible remote JSON may still decode into the requested type.
Simultaneous calls sharing a key also share one source result, so an incompatible
coalesced follower returns a type error. Use a consistent value type per key.

Run the complete [basic example](./examples/basic.rs), which demonstrates a
structured value, an asynchronous source and reuse across two request scopes:

```sh
cd rust
cargo run --example basic
```

The [Redis example](./examples/redis.rs) configures application-owned connection
and command timeouts, enables tracked Redis caching and demonstrates
invalidation. With a Redis server running:

```sh
REDIS_URL=redis://127.0.0.1/ cargo run --features redis --example redis
```

The examples use the crate's existing dependencies. Applications also need
`tokio` with `macros`, `rt-multi-thread` and `time` enabled; structured JSON
values use `serde` with its `derive` feature. The Redis example additionally
needs the `redis` crate with `tokio-comp`, and DialCache's `redis` feature.

Caching is disabled by default. `DialCache::enable` (closure form) or
`DialCache::enable_guard` (RAII form) opens the outermost enabled scope and
hands out a `Scope`; pass it to every cached call made on behalf of that
request, including calls made inside a source. Completing the callback or
dropping the guard closes the scope: retained `Scope` clones no longer enable
caching and late work cannot publish into the request memo.
`DialCache::enable_in` and `DialCache::disable_in` derive nested scopes that
share the outer request memo. `Scope::outside()` is the pass-through scope of
work that runs on behalf of no request.

`use_case` registers a typed use case once per instance and returns a
`UseCase<Args, T>` handle; `get_or_load` runs one inline `Operation<T>` without
registration. Both snapshot the static policy and the source budget before any
asynchronous work. Values come back as `Arc<T>`: shared by reference, treat
them as immutable. Both `UseCase<Args, T>` and `Operation<T>` can be cloned
without requiring `T: Clone`. Use case `watermark` is reserved. `coalescing_state`
reports actual process leaders, followers and the oldest leader age.

Sources are `Fn(Scope, Args) -> Future<Output = Result<T, BoxError>>`. They may
run again later for served-hit shadow validation, so they must be reusable.
Source errors surface as `Error::Source(Arc<dyn Error>)`; every coalesced
caller receives the same shared instance, so `Arc::ptr_eq` identifies one
failure. A source deadline returns `Error::FallbackTimeout` and does not cancel
the source. Dropping the future returned by `get` never cancels the execution:
sources, publications and other callers keep their contracts.

`Identity::new`, `KeySpec::new` and `DialCache::invalidate` accept strings,
integers and floats, including shared references such as `&u64`. Their `IntoKeyId` conversion
preserves string IDs and exact decimal integers; floats use JavaScript number
spelling, including negative zero and exponents (`f32` is promoted to `f64`).
For custom displayable IDs, pass
`id.to_string()` or implement `IntoKeyId`. `KeySpec::arg` also accepts all
primitive integer and float types, preserving exact integer text and promoting
`f32` to `f64`, as well as borrowed inputs such as `&String` and `&u64`.
`normalize_args` applies the shared scalar spelling to secondary dimensions and
orders names by UTF-16 code units so the same identity produces the same Redis
key in every language.
Use the same namespace, key dimensions, codecs and policy across languages when
sharing entries.

## Configuration and effects

`Policy` holds the static leaves: whole-second TTLs (`local_ttl_sec`,
`remote_ttl_sec`), serving ramps, `request_local`, `coalesce`,
`stale_on_error_max_age_sec`, `remote_read_timeout_ms` and `shadow`.
`Policy::from_json` accepts the TypeScript JSON-shaped configuration.
`Policy::enabled(ttl)` and `Policy::disabled()` are the two static helpers.
A `policy_provider` returns a sparse `RuntimePolicy` overlay once per enabled
invocation; `Ok(None)` inherits, present leaves replace operation leaves, and
invalid leaves have the narrower consequences defined in Quint (an invalid TTL
or ramp disables only that layer; an invalid flag or read deadline bypasses
caching for the call).

Convert a typed policy with `RuntimePolicy::from(policy)` or `policy.into()`.
Omitted leaves remain absent, including `request_local` and `coalesce`, so a
TTL-only overlay preserves the operation's flags. `Policy::to_json` uses the
same sparse representation; library defaults are applied during resolution.

Defaults are namespace `urn`, local capacity 10,000, 50 ms remote reads,
60,000 ms source calls (`SourceBudget::Default`; `SourceBudget::Unbounded`
disables the deadline), sharing enabled, and shadow capacity one. Policy omits
all cache layers by default. Invalid constructor configuration returns
`ConfigError` from `build`; invalid operation configuration is returned before
execution.

`Remote` supplies atomic primary snapshots, complete client-stamped frame
writes and surfaced invalidation errors. Writes are one native `SET`;
invalidation dispatches `EVALSHA` and retries once with `EVAL`. No value write
creates or extends a watermark. `DialCache::invalidate` affects shared remote
authority; other processes' local entries and already acquired snapshots
retain the documented lifetime rules. Inline operations with an explicit namespace
can invalidate that same entity through `invalidate_identity`:

```rust,ignore
let identity = Identity::new("user", 42, "displayName")
    .namespace("tenant-b").tracked(true);
// After committing the source mutation:
cache.invalidate_identity(identity, 0).await?;
```

An empty namespace inherits the cache instance's namespace. Invalidation covers
all tracked use cases and argument variants for that namespace, entity type and
ID; the identity's `tracked` flag does not restrict the maintenance operation.

`Clock` separates wall time from elapsed time; `Runtime` supplies detached
task admission and timers. The defaults are `SystemClock` (aligned to the
process-wide millisecond grid used by local expiry) and `TokioRuntime`, which
captures the current tokio runtime handle when the cache is built: building
outside a tokio context is a `ConfigError`, and `TokioRuntime::from_handle`
selects a runtime explicitly. The runtime needs its time driver.
`SystemClock::with_sources` runs the same grid alignment over caller-supplied
time sources. The `test-util` feature ships `testing::TestExecutor`, a
deterministic single-threaded executor with a virtual clock that runs the
cache's detached work to quiescence on demand and delivers timers only when a
test advances time; the conformance harness is built on it, and its
local-clock replay builds `SystemClock` over the virtual clock.

Detached work is registered RAII-style: if a runtime drops a leader task
before it settles (the cache outlived a shut-down runtime), its flight is
unregistered and its followers receive an error instead of waiting forever.
Local storage hands removed entries back to the cache so a value's destructor
never runs while a cache lock is held.

## Values, codecs and observability

`JsonCodec` (serde_json) is the default; `Codec<T>` is asynchronous, and
`FromSync` adapts a synchronous `SyncCodec`. The TypeScript `undefined`
sentinel decodes as JSON `null`, so `Option<T>` destinations read it as
`None`. Compression defaults to a 4,096-byte threshold and zstd level 3;
`disable_compression` stores payloads raw while reads still accept compressed
entries. The wire contract requires interoperable decompression, not identical
compressed bytes. The async engine dispatches payload compression at 64 KiB or
larger (and compression at levels 10–22 once the configured threshold is met)
and every zstd decompression through `Runtime::spawn_blocking`. Small raw
payloads remain inline; synchronous protocol helpers remain synchronous.

The default CPU executor is shared across cache instances: two worker threads
and two queued jobs. Admission never waits for queue space. Saturation or worker
creation failure fails open: a read falls through to the source, and a failed
compression skips the write while preserving the source result. Custom runtimes
may supply their own bounded CPU executor. `StepRuntime` queues these jobs on its
controlled executor for deterministic tests. A shadow job retains its capacity
until its admitted CPU work finishes or is discarded, including after a deadline
or async runtime shutdown. Codecs supplied by the application still choose their
own scheduling; `FromSync` does not offload application serialization.

For remote writes, the engine calls `Codec::encode_owned` with the existing
`Arc<T>`. Its default implementation delegates to `encode(&T)`, so existing
codecs work unchanged. Override `encode_owned` to send a non-`Clone` value to a
background CPU job without copying it or changing the cached value type.
`decode` already receives an owned `Payload`. Application codecs own admission
and the lifetime of jobs they start; those jobs do not inherit the library's
shadow-capacity token. Default JSON encoding/decoding and `FromSync` remain
synchronous, so large values can occupy an async worker.

`Observer` receives every public diagnostic as a typed `Event`. Shadow
validation exists only to be observed, so a job is admitted only when the
observer opts in through `observes_shadow_outcomes`; the bundled exporters do.
`Logger` receives structured `LogEvent`s and defaults to the `log` facade.
Default stale-recovery decode warnings omit error text that could contain cached
values; JSON errors retain their category and line/column location. A custom
`Logger` can inspect the original error when application-controlled details are
needed.
Mismatch logging is opt-in, confirmed, bounded, and previews values through
the operation's `preview` (JSON for serde values). Default JSON previews retain
only an 8 KiB prefix while checking the entire serialization for errors. Preview
callbacks run through the bounded CPU executor after confirmation; they may run
on a worker thread. Queue rejection omits value previews but still logs the
confirmed mismatch. Diagnostic work holds shadow capacity until it finishes,
including after runtime shutdown. Observer and logger failures never change a
cache, source or maintenance result.

`MetricKind` maps every event to the metric names, labels and values shared
with the TypeScript and Go exporters. `PrometheusObserver` (feature
`prometheus`) registers the nineteen collectors on a `prometheus::Registry`
under an optional prefix; clone one observer for every instance that exports
to the same registry, because the `prometheus` crate cannot hand back an
existing collector and a second registration of the same names is a
`PrometheusError::Conflict`. `DatadogObserver` sends the same metrics through
a caller-supplied `DogStatsdClient`, with `DatadogOptions` choosing histogram
or distribution and a namespace.

`RedisAdapter` (feature `redis`) implements `Remote` over the `redis` crate
for `ConnectionManager`, `MultiplexedConnection` and cluster connections,
routing tracked reads to slot primaries and sharing the invalidation script
and frame codec with the other ports. The `redis_integration` test replays
every invalidation vector against real Redis, Valkey and Cluster servers,
and reads/writes shared entries with the production TypeScript adapter in both
directions. Both ports construct keys independently, including numeric rounding
boundaries; the payload tests cover JSON, binary escaping, compression and
invalidation by either language. The tests are `#[ignore]`d, and
`make integration-rust` runs them where Docker is available.

## Validation and reproducing a trace

Use the repository [Make targets](../Makefile) from its root. CI pins Rust
1.98.1, Go 1.27.1, Node 24 and pnpm 10.33.0. Rust conformance tests use the
shared Node replay coordinator for command mappings and assertions; the crate
itself has no Node dependency.

```sh
make check-rust        # fmt, clippy, unit tests, protocol vectors, fixed scenarios and committed smoke histories
make integration-rust  # Real Redis, Valkey and Cluster servers through Docker, plus every invalidation vector
make formal            # Quint model checks, full corpus, then TypeScript, Go and Rust replay
make formal-rust       # Complete prepared Rust replay of the generated corpus
make mutations-rust    # Measure the Rust fault catalog (formal/rust-mutations.json) against the replay
```

`make mutations-rust` applies each catalogued single-site fault to an isolated
copy of the crate and requires the conformance harness to detect it
(`DIALCACHE_RUST_SUITE=generated` for the Quint-generated evidence,
`DIALCACHE_RUST_SUITE=fixed` for the fixed scenarios); see
[SEMANTIC-COVERAGE.md](../formal/SEMANTIC-COVERAGE.md).

Without overrides, `cargo test --all-features --test conformance` replays the
committed smoke histories, every fixed scenario and every protocol vector.
The same `DIALCACHE_*_TRACE_DIR` / `_TRACE_FILE` selectors as Go replay a
directory or one history; `DIALCACHE_WITNESS_EVIDENCE_DIR` binds the shared
witness evidence and `DIALCACHE_RUST_REPORT` names the JSONL assertion report
the completion checker consumes. Reports and traces are kept in
`.formal-traces/`.

```sh
DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json" \
  cargo test --manifest-path rust/Cargo.toml --all-features --test conformance
```

`tests/settlement_control.rs` is the no-settle control required of every
port: a driver that reports observations before the settlement drain fails
every behavior-driver-backed smoke history.

## Adaptations

- Explicit `Scope` handles replace the implicit async context of TypeScript
  and the `context.Context` of Go.
- Values are `Arc<T>`; sources return `Result<T, BoxError>`.
- The default shadow comparator is `PartialEq`; `NaN` therefore differs from
  itself where the TypeScript default treats it as equal.
- Local storage failures are exposed through the `LocalStore` trait rather
  than a clock fault.
- Prometheus collectors are shared by cloning the observer rather than by
  registering the same names twice.
- The behavior driver checks source/write causality after every command.
  Its test runtime carries driver-owned invocation identities across detached
  tasks, independently attributing each write to its actual source callback.
- The core replay, the exporters and the Redis adapter follow their Go
  counterparts; real-server integration is a separate lane, as in the other
  ports, and not part of the completion claim (see `formal/profiles.json`).

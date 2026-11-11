# DialCache for Rust

Read the [shared behavior guides](https://lan17.github.io/DialCache/) and
[Rust integration guide](https://lan17.github.io/DialCache/languages/rust).
The site uses one explanation per feature with selected native examples and notes.

Rust implements the same portable behavior as the TypeScript library and the
Go port: explicit request enablement, request/local/Redis layers,
deterministic rollout, sparse runtime policy, request and process coalescing,
tracked invalidation, source and read deadlines, stale recovery, dark and
served-hit shadow validation, compression, and failure-isolated observability.

## Use

The core crate requires Rust 1.85 or later; the `redis` feature requires Rust
1.88 with the currently locked Redis dependency. The crate has no Node.js
dependency.
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

Run the complete [basic example](https://github.com/lan17/DialCache/blob/main/rust/examples/basic.rs), which demonstrates a
structured value, an asynchronous source and reuse across two request scopes:

```sh
cd rust
cargo run --example basic
```

The [Redis example](https://github.com/lan17/DialCache/blob/main/rust/examples/redis.rs) configures application-owned connection
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
invocation; `Ok(None)` inherits and present leaves replace operation leaves.
An invalid TTL or ramp disables only that layer; an invalid flag or read
deadline bypasses caching for the call.

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
test advances time.

If the runtime shuts down before shared work finishes, waiting callers
receive an error rather than waiting forever.

## Values, codecs and observability

`JsonCodec` (serde_json) is the default; `Codec<T>` is asynchronous, and
`FromSync` adapts a synchronous `SyncCodec`. The TypeScript `undefined`
sentinel decodes as JSON `null`, so `Option<T>` destinations read it as
`None`. Compression defaults to a 4,096-byte threshold and zstd level 3;
`disable_compression` stores payloads raw while reads still accept compressed
entries. The wire contract requires interoperable decompression, not identical
compressed bytes. Custom runtimes must support `Runtime::spawn_blocking`
for compression and decompression. Synchronous protocol helpers remain
synchronous.

The default CPU executor is shared across cache instances: two worker threads
and two queued jobs. Admission never waits for queue space. Saturation or worker
creation failure fails open: a read falls through to the source, and a failed
compression skips the write while preserving the source result. Shadow mismatch
warnings share this executor with caller reads: rendering a warning's content
and running its `mismatch_diff` hook queue beside the zstd decompression of
cache hits, so a burst of warnings can reject a compressed hit and send that
read to the source. Each instance runs at most `shadow_max_in_flight` shadow
jobs (default 1), so that setting and the number of instances in the process
bound how many warnings contend. Custom runtimes
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
Mismatch logging is opt-in, confirmed and bounded. `ShadowPolicy::mismatch_logging`
chooses the warning's content: `value` logs the JSON of both values, and
`diff` at `MismatchDiff::Paths` logs RFC 6901 pointers to the differing
fields, which `MismatchDiff::Values` extends with what each side holds there;
`log_mismatches: Some(true)` is shorthand for both. Values are compared with
`PartialEq` or the operation's comparator; only the logged fields derive from
the values' `serde` JSON, which `Operation::new` and `register` render. A
`with_codec` or `register_custom` operation has none, so it logs value fields
through its `preview` and differences through its `mismatch_diff` hook. A
`preview` you set replaces the JSON for the whole warning, so the differences
of an operation with one also come only from the hook; setting `preview` to
`None` logs no values and leaves the differences to the hook as well. The
differences are computed over each value's whole rendering, so their cost
grows with the value's size. Rendering and hooks run through the bounded CPU executor after
confirmation; they may run on a worker thread. A failure leaves the field
unavailable and names its cause in the warning, and every warning attempt
emits one `ShadowMismatchLogging` event with its outcome. Queue rejection
still logs the metadata warning. Diagnostic work holds shadow capacity until
it finishes, including after runtime shutdown. Observer and logger failures
never change a cache, source or maintenance result.

`MetricKind` maps every event to the metric names, labels and values shared
with the TypeScript and Go exporters. `PrometheusObserver` (feature
`prometheus`) registers the twenty collectors on a `prometheus::Registry`
under an optional prefix; clone one observer for every instance that exports
to the same registry, because the `prometheus` crate cannot hand back an
existing collector and a second registration of the same names is a
`PrometheusError::Conflict`. `DatadogObserver` sends the same metrics through
a caller-supplied `DogStatsdClient`, with `DatadogOptions` choosing histogram
or distribution and a namespace.

`RedisAdapter` (feature `redis`) implements `Remote` over the `redis` crate
for `ConnectionManager`, `MultiplexedConnection` and cluster connections,
routing tracked reads to slot primaries. Redis entries and invalidation are
interoperable with the other ports.

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

## Development

Run the checks from the repository root: `make check-rust` runs formatting, clippy and the native tests,
`make formal-rust` replays the generated corpus, and `make integration-rust`
runs the real-server checks. [Validation and evidence](https://github.com/lan17/DialCache/blob/main/formal/guides/VALIDATION.md) lists the
prerequisites and the other lanes.

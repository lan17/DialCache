# Rust integration

[Shared guides](../index.md) · [Getting started](../getting-started.md) · [API reference](../api.md)

The Rust port uses explicit request scopes, `Arc<T>` values and asynchronous
operations while following the shared behavioral contract.

## Installation and runtime

Rust releases use the same version number as the npm, Go and Python packages
(see [Upgrading](../upgrading.md)). After the first crates.io publication, install a released version with `cargo add dialcache`. Before that
first publication, or to use an unreleased checkout, use a path dependency:

```toml
[dependencies]
dialcache = { path = "../DialCache/rust" }
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time"] }
serde = { version = "1", features = ["derive"] }
```

Adjust the path to your checkout. The core crate requires Rust 1.85 or later;
the current `redis` dependency requires 1.88. The crate has no Node.js runtime
dependency. Available registry versions are listed on
[crates.io](https://crates.io/crates/dialcache); docs.rs builds their API references.

Build the cache inside a live Tokio runtime with the time driver enabled. The
default `TokioRuntime` captures that handle. `TokioRuntime::from_handle` permits
an explicit runtime, and the public `Runtime` trait supports other integrations.

See the [getting-started example](../getting-started.md#wrap-a-reader) for a
complete reader, or run the
[standalone example](https://github.com/lan17/DialCache/blob/main/rust/examples/basic.rs):

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

`ShadowPolicy::mismatch_logging` selects confirmed-mismatch warning content.
Its built-in difference computation walks the `serde_json` renderings of an
operation built with `Operation::new` or `register`; a `mismatch_diff` hook
replaces it, and is the only source of differences for an operation whose
`preview` is custom or `None`, or one built with `with_codec`. See
[confirmed mismatch logging](../shadow-validation.md#confirmed-mismatch-logging).

Application codecs control their own scheduling. See
[compression](../redis.md#compression) for thresholds and fail-open behavior
when compression or decompression capacity is exhausted.

## Application-owned limits

<LanguageContent language="rust">

These four recipes use existing APIs. They add no library defaults and protect
an application only after it adopts them. Choose limits for your workload.
The complete [executable examples](https://github.com/lan17/DialCache/blob/main/rust/tests/docs_examples.rs)
include imports, test dependencies and assertions.

### Source and policy work

Acquire source capacity inside the registered source, not around `get`.
The permit then remains held when a caller stops waiting or the cache source
deadline expires. The same source guard applies to uncached and shadow calls.
Use non-waiting admission to avoid an unbounded queue of waiting callers.

This example uses a semaphore as a test dependency. Replace that wait with
source I/O that has its own finite budget:

<<< @/../rust/tests/docs_examples.rs#rust-source-budget{rust}

The application's one-second timeout drops this dependency future and releases
its permit. It does not prove cancellation of work in a client-owned task or at
the server. If your client starts separate tasks, keep the permit with the task
that owns the resource until it finishes, and bound its native queue and I/O.
A caller timeout only ends that caller's wait. None of these timers can preempt
blocking synchronous code.

Admission and dependency timeout errors are `Error::Source`, not
`Error::FallbackTimeout`. If stale recovery should accept one of these errors,
classify that specific error with `should_recover`; do not accept every source
failure.

Prefer a cheap local configuration snapshot. When a provider must await I/O,
bound that work separately: policy resolves before source sharing and before
the source timer starts.

<<< @/../rust/tests/docs_examples.rs#rust-provider-budget{rust}

A provider error runs the source uncached; it does not enable baseline caching.
Keep the source guard active on that path. `Ok(None)` means inherit, not
configuration failure.

### Complete mutation calls

Wrap the remote adapter before passing it to the cache builder. This example
forwards the original read request and cancellation context, and gives each
write or invalidation one 200 ms wait budget:

<<< @/../rust/tests/docs_examples.rs#rust-mutation-budget{rust}

For `RedisAdapter`, the invalidation budget covers both `EVALSHA` and its `EVAL`
retry. Keep the client's own finite connection, command and queue limits as
well. No breaker bypasses invalidation. A timed-out write preserves the source
result; a timed-out invalidation returns an error to its caller.

Timeout drops the adapter future, not an already accepted server command. A
mutation can still happen after the error, so its outcome is unknown until
verified. This budget excludes earlier serialization and compression; give an
asynchronous custom codec its own settlement bound. It is not a total-call
deadline.

### Values and request scopes

Use a value domain with a known bound on retained data, and validate remote
decodes as well as source results. This example stores only a 32-byte digest.
The codec checks the JSON payload length and the exact decoded array length:

<<< @/../rust/tests/docs_examples.rs#rust-bounded-values{rust}

The payload check runs **after** the engine's decompression. It does not prevent
decompression allocations, nor does a serialized-byte limit measure heap size.
The fixed array bounds this value type, not process memory or all temporary
allocations.

Set process-local capacity explicitly. Here `remote` is the test snapshot
adapter and `clock` is its fixed test clock; use your adapter and normal clock
in the application:

<<< @/../rust/tests/docs_examples.rs#rust-bounded-scopes{rust}

Capacity counts entries, not bytes. Request memoization has no capacity limit.
Bound simultaneous requests and keys per request, use bounded key types, and
close scopes promptly:

<<< @/../rust/tests/docs_examples.rs#rust-bounded-request{rust}

Use `request_local(false)` when request memoization is not needed. Closing a
scope releases its memo, but does not cancel source work or release `Arc`s held
by callers. Apply the source controls above as well.

### Nonblocking metric transport

`DatadogObserver` maps names, tags and units, then calls `DogStatsdClient`
synchronously. A slow client delays cache calls. This client queues packets
with `try_send`; a full or closed queue drops the packet rather than waiting:

<<< @/../rust/tests/docs_examples.rs#rust-metric-queue{rust}

Create it with `sync_channel` and a fixed capacity, then pass it to
`DatadogObserver::new`. The example also caps each packet at 512 bytes and drops
unsafe wire separators. Keep application labels stable and bounded.

A separate sender must consume the queue with finite I/O budgets. The tests use
only a loopback UDP socket with a write timeout, preserve the exporter's metric
mapping, and count send errors separately. Monitor drop and send-error counters
outside this exporter to avoid recursive reporting. Stop producers and drop
their sender handles before joining the sender at shutdown.

Queue acceptance and a successful UDP send do not prove delivery to Datadog.
This example changes neither the metric schema nor the selected histogram or
distribution mode.

</LanguageContent>

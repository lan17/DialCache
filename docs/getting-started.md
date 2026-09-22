# Getting started

[Documentation](index.md) · Next: [How DialCache works](concepts.md)

Create one long-lived cache instance and define reusable readers once. A reader's
source function remains authoritative: DialCache calls it whenever the active
layers cannot supply a value. Caching is disabled outside an enabled request
scope, and each operation must also opt into at least one layer.

Choose your language in the site selector. The behavioral explanation is shared;
examples and native integration notes follow that choice.

## Install

<LanguageContent language="typescript">

```bash
npm install dialcache
```

The package provides ESM, CommonJS and TypeScript declarations. Supported Node.js
versions are `>=22.15.0 <23.0.0 || >=23.8.0`. See the
[TypeScript guide](languages/typescript.md) for native API and serializer details.

</LanguageContent>

<LanguageContent language="go">

```bash
go get github.com/lan17/DialCache/go@latest
```

The module requires Go 1.25 or later. Pin the version selected by `go get` in your
application's `go.mod`. See the [Go guide](languages/go.md) for contexts, durations
and module-version details.

</LanguageContent>

<LanguageContent language="rust">

For a published Rust release, run `cargo add dialcache`. Before the first
crates.io publication, or for unreleased source, use a path dependency pointing
at a repository checkout's `rust/` directory:

```toml
[dependencies]
dialcache = { path = "../DialCache/rust" }
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time"] }
```

Adjust the path to your checkout. The core crate requires Rust 1.85; the `redis`
feature currently requires Rust 1.88. See the [Rust guide](languages/rust.md) for
runtime, feature and value-ownership details.

</LanguageContent>

<LanguageContent language="python">

The Python package is currently **unpublished**. Install from a repository checkout:

```sh
python3 -m pip install './python[redis]'
```

Python 3.11 or later is required. Omit the Redis extra for local-only use.
See the [Python guide](languages/python.md) for asyncio and client ownership.

</LanguageContent>

## Wrap a reader

Start with request-local caching so no Redis server or expiration timer is
needed. This example proves three observable outcomes:

1. Two calls outside an enabled scope each invoke the source.
2. Two same-key calls inside one enabled scope invoke the source once.
3. A new request scope invokes the source again.

The displayed region comes from a native test that CI executes. Its surrounding
file supplies imports and test setup; the source link opens the complete file.

<LanguageContent language="typescript">

<<< @/../typescript/examples/docs.mts#request-scope{typescript}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/typescript/examples/docs.mts)

</LanguageContent>

<LanguageContent language="go">

<<< @/../go/docs_examples_test.go#request-scope{go}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/go/docs_examples_test.go)

</LanguageContent>

<LanguageContent language="rust">

<<< @/../rust/tests/docs_examples.rs#request-scope{rust}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/rust/tests/docs_examples.rs)

</LanguageContent>

<LanguageContent language="python">

<<< @/../python/tests/test_docs_examples.py#request-scope{python}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/python/tests/test_docs_examples.py)

</LanguageContent>

The example enables only request-local storage. It has no TTL or capacity limit
and disappears when the outer scope closes. Keep requests and their key counts
bounded. Add a process-local TTL when reuse across requests is appropriate;
[the read model](concepts.md#three-lifetimes) explains all three layer lifetimes.

Include every input that can change the result in the key, including tenant,
locale or authorization dimensions. [Keys and identity](keys.md) explains how
result identity also determines shared work and invalidation groups.

## Choose the enabled scope

Put one enabled scope around each read request. Nested enabled scopes reuse the
outer request memo; a disabled region bypasses caching without deleting entries.
A scope's lifetime ends explicitly, so detached work must not assume a retained
scope keeps caching enabled forever.

<LanguageContent language="typescript">

`dialcache.enable(async () => ...)` propagates scope through Node's
`AsyncLocalStorage`. Use `dialcache.disable(() => ...)` for nested uncached work.
The outer callback settling closes its request-local memo. Registered readers
return promises and preserve their source parameters.

</LanguageContent>

<LanguageContent language="go">

`ctx, done := cache.Enable(parent)` returns the context to pass to cached readers.
Call `done()` when the request ends, usually with `defer done()`. Use
`cache.Disable(ctx)` for nested uncached work. Contexts retained after `done()`
no longer enable caching.

</LanguageContent>

<LanguageContent language="rust">

`cache.enable_guard()` returns a guard; pass `request.scope()` to each reader.
Dropping the guard closes the request memo, including retained scope clones.
`enable_in` and `disable_in` derive nested scopes; `Scope::outside()` is the
pass-through scope. Reader values are shared as `Arc<T>`.

</LanguageContent>

<LanguageContent language="python">

Use `async with cache.enable():` or `with cache.enable():` around request reads.
`cache.disable()` temporarily bypasses caching. The outer scope owns the memo;
tasks inheriting its context pass through after it closes. Values are shared
Python references and should be treated as immutable.

</LanguageContent>

Disabling caching does not invalidate stored data. After a source mutation,
freshness still depends on TTLs and [invalidation policy](invalidation.md).
Treat reused in-memory values as immutable.

## Keep a calculation inline

An inline operation uses the same cache path without registering a reusable
reader. All call sites sharing an identity must agree on value meaning and
serialization.

<LanguageContent language="typescript">

Use `dialcache.getOrLoad(loader, options)` with a direct `key` instead of the
`cacheKey` selector. See the [TypeScript API](api.md).

</LanguageContent>

<LanguageContent language="go">

Use `dialcache.GetOrLoad[T](ctx, cache, operation, loader)`. `Operation[T]` carries
the identity, policy and codec. See the [Go API](api.md).

</LanguageContent>

<LanguageContent language="rust">

Use `cache.get_or_load(scope, operation, loader)` with an `Operation<T>`.
The result is still `Arc<T>`. See the [Rust API](api.md).

</LanguageContent>

<LanguageContent language="python">

Use `await cache.get_or_load(loader, key=..., key_type=..., use_case=...,
default_config=...)` for an inline read, or `await cache.aget(key, loader, ...)`
for a structured `Key`. See the [Python API](api.md).

</LanguageContent>

## Introduce runtime policy

Keep stable defaults next to the reader and use a runtime provider for sparse
overrides. Omitted fields inherit; explicit false and zero values disable their
respective features. A provider runs once per enabled invocation before lookup,
so keep it inexpensive and bound asynchronous work.

[Configuration and rollout](configuration.md) follows an executed example that
inherits the local TTL through a sparse overlay, then explicitly disables
both configured layers. A ramp selects a stable cohort of keys, not a percentage of requests.
Policy changes do not cancel admitted work or evict existing entries.

## Add shared caching when needed

Connect an application-owned Redis client and pass its native DialCache adapter.
Add a remote TTL to participating readers; start remote serving at zero while
checking configuration and observability.

[Redis and Valkey](redis.md) covers adapters, serialization, Cluster routing and
client ownership. [Observability](observability.md) covers Prometheus and Datadog.
For mutable data, read [Targeted invalidation](invalidation.md) before enabling
remote serving. [Shadow validation](shadow-validation.md) compares Redis with the
source during a rollout.

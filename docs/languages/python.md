# Python integration

[Shared guides](../index.md) · [Package guide](https://github.com/lan17/DialCache/blob/main/python/README.md)

The experimental Python port uses awaitable operations and `contextvars` scopes
while following the shared behavioral contract. It requires Python 3.11 or
later. The shared guides import executed Python examples; the API reference is
generated from this checkout with Python's standard `pydoc` tool.

## Installation and runtime

Once the first PyPI release is available, install it with:

```sh
python3 -m pip install 'dialcache[redis]'
```

Until that release is published, install from the root of a repository checkout:

```sh
python3 -m pip install './python[redis]'
```

Omit the `redis` extra for local-only use. Run operations on one asyncio event
loop per cache instance. The application owns that loop and Redis client
connections. Synchronous loaders and serializers are accepted, but execute on
the event loop; use asynchronous implementations for blocking I/O.

## Request scope and operations

Create a long-lived `DialCache` and register readers with `@cache.cached(...)`.
The wrapper is awaitable even when the underlying loader is synchronous.
`get_or_load()` accepts an inline loader; `aget()` accepts a structured `Key`.

Use `with cache.enable():` or `async with cache.enable():` around request reads.
Nested scopes share the live outer request memo. `cache.disable()` and
`cache.enable(False)` temporarily bypass caching without clearing that memo.
Tasks inherit the scope through `contextvars`, but calls made after its outer
scope closes pass directly through. Instances have independent contexts.

The [native binding tests](https://github.com/lan17/DialCache/blob/main/python/tests/test_cache.py)
exercise both forms of identity, ordinary and canceled concurrent callers,
deadline boundaries, sparse runtime policies, and argument adaptation through
the public API.

## Identity and policy

Specify `cache_key=` for explicit identity selection or `id_arg=` for a named
function argument. An `id_arg=(name, adapter)` pair converts a native object
into a primitive entity ID. Other bound arguments, including default values,
participate in identity; `arg_adapters` converts them and `ignore_args` excludes
inputs that do not affect the result. The default use-case name is the source
function's module and qualified name. Explicit names provide stability across
refactoring.

`Policy` uses snake_case fields such as `ttl_sec`, `request_local`, and
`remote_read_timeout_ms`. Static settings are captured when registering the
reader. A synchronous or asynchronous `policy_provider` receives the structured
key and returns a sparse `Policy`, mapping, or `None`. Whole-provider `None`
inherits; an explicitly supplied `None` leaf is invalid. Runtime mappings also
accept the shared camelCase names. Omitted fields, false flags, and zero
recovery/shadow settings remain distinct.

TTL and recovery ages use integer seconds; deadlines use integer milliseconds.
`fallback_timeout_ms=None` explicitly removes the source deadline. Static
configuration errors raise `ConfigError`; malformed runtime policy follows the
shared fail-open rules.

## Values and cancellation

In-memory values are shared references. Treat them as immutable or copy before
modifying. `None` remains a present cached value. The default `JsonSerializer`
uses JSON and exposes `UNDEFINED` for the protocol's distinct undefined result;
use a custom serializer for non-JSON native values.

Canceling a caller raises `asyncio.CancelledError` for that caller without
canceling another caller's shared execution. A DialCache deadline raises
`FallbackTimeoutError`; it ends the wait and revokes late publication without
claiming to stop the underlying source operation. The Python binding does not
automatically schedule synchronous work on threads.

The default shadow comparator recursively compares JSON-like values and keeps
booleans distinct from numbers. Custom native objects may have different
equality semantics; supply `shadow_comparator` for domain-specific equality.
Shadow admission requires a metrics observer for terminal outcomes.

## Redis and observability

`dialcache.redis.RedisAdapter` borrows a `redis.asyncio.Redis` or `RedisCluster`
client configured with `decode_responses=False`. The application supplies
finite connection, socket, and retry budgets and closes the client. The adapter
requires a dedicated primary-only Cluster client for tracked atomic reads:
construct it with `read_from_replicas=False`, `load_balancing_strategy=None` where supported,
and no custom connection hook. Keep its configuration and connection mode
unchanged; create a new client instead of repurposing a previously `READONLY`
pool. Unsafe tracked reads fail open to the source. Replica-enabled clients
remain usable for untracked reads and maintenance. `invalidate_remote()` and
its `ainvalidate()` alias surface maintenance failures.

Pass a synchronous `metrics` callable or an object with `observe(event)` to
receive backend-neutral event dictionaries. Labels use the common names,
including `cacheNamespace`, `useCase`, and `keyType`. Observer failures do not
alter application results. This port currently supplies the observer contract;
applications connect it to their metrics backend.

## Sharing Redis with other languages

Follow the shared [cross-language compatibility guide](../redis.md#sharing-entries-across-languages)
for cache identity, supported values, compression and the full-client wire suite.
Python `None` represents JSON null; its top-level `UNDEFINED` sentinel is
distinct. The default `JsonSerializer` rejects nonfinite numbers (`NaN` and
infinities), while TypeScript's `JSON.stringify` converts them to `null`.
Choose an explicit `use_case` and align adapted arguments with other clients;
Python's inferred module and qualified function name may differ from their names.

## Validation

Prepare a development environment from the repository root:

```sh
python3 -m venv python/.venv
python/.venv/bin/python -m pip install -e './python[test,redis]'
corepack pnpm install --frozen-lockfile
make check-python
make integration-python
```

`check-python` executes native tests, shared wire vectors, fixed scenarios,
committed behavioral histories, and the settlement control. `integration-python`
uses isolated Redis, Valkey, and Redis Cluster servers, including the invalidation
vectors. It requires Docker. Run `make integration-wire` for the separate
four-language client suite; it also requires the pinned Go and Rust toolchains.

Generate the shared corpus with `make formal-generate`, then run
`make formal-python` for complete prepared replay and completion checks. The
[porting guide](https://github.com/lan17/DialCache/blob/main/formal/PORTING.md)
defines that evidence boundary. Passing committed smoke tests alone does not
establish complete conformance. Node 24 is a test-tool dependency, not a Python
package runtime dependency.

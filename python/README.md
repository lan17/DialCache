# DialCache for Python

An asyncio port of DialCache for Python 3.11 and later. Each use case declares
its identity and policy; an enabled request scope opts into request memoization,
local storage, Redis, and concurrent request sharing. The behavioral contract is
the repository's [portable specification](../formal/SPEC.md).

This package is developed in this repository and has not been published to PyPI.
Install it from a checkout:

```sh
python3 -m pip install './python[redis]'
```

For local-only caching, omit the `redis` extra. Zstandard is included for the
portable Redis payload format. The application owns the asyncio event loop and
any Redis client connections.

## A cached function

```python
from dialcache import DialCache, Policy

cache = DialCache(namespace="my-service")


@cache.cached(
    use_case="user-profile",
    key_type="user",
    id_arg="user_id",
    default_config=Policy(ttl_sec={"local": 5}, request_local=True),
)
async def get_profile(user_id: str) -> dict:
    return await database.fetch_profile(user_id)


async def handle_request(user_id: str) -> dict:
    async with cache.enable():
        first = await get_profile(user_id)
        second = await get_profile(user_id)  # Same request memo.
        return second
```

Calls outside `enable()` go directly to the source. They do not construct cache
keys, resolve policy, share concurrent work, or apply a DialCache source
deadline. Both `with cache.enable():` and `async with cache.enable():` are valid;
the wrapped function is always awaitable. Synchronous loaders are accepted and
run on the event loop, so use async loaders for blocking I/O.

Nested enabled scopes share the live outer request memo. A nested
`cache.disable()` temporarily bypasses caching without deleting that memo.
Closing the outer scope clears the memo and prevents late publication. Async
tasks that inherited a scope use pass-through behavior for calls made after
that scope closes. Cache instances keep independent contexts.

## Policies and runtime changes

No layer is enabled by default. A positive TTL enables that shared layer, with
a default rollout percentage of 100. Request memoization defaults to false;
concurrent same-key sharing defaults to true.

```python
policy = Policy(
    ttl_sec={"local": 5, "remote": 60},
    ramp={"remote": 25},
    request_local=True,
    coalesce=True,
    remote_read_timeout_ms=50,
    stale_on_error_max_age_sec=120,
)
```

TTLs are integer seconds from 1 through 31,536,000. Rollout percentages are
finite numbers from 0 through 100. Sampling is stable per exact key and layer,
using the same cohort algorithm as the TypeScript, Go, and Rust ports.

Pass a synchronous or asynchronous `policy_provider` to `DialCache` to resolve
runtime settings once per enabled invocation. It receives the structured key
and returns a `Policy`, a mapping, or `None`:

```python
async def policy_provider(key):
    if key.use_case == "user-profile":
        return {"ramp": {"remote": 50}}
    return None


cache = DialCache(policy_provider=policy_provider)
```

Runtime replies are sparse: an omitted field inherits the operation default.
A whole reply of `None` inherits the complete operation policy. An explicit
`None` leaf is malformed and cannot silently inherit a valid setting. Python
snake_case names and the shared corpus's camelCase mapping names are accepted.
Policy objects snapshot their input maps so later mutation cannot alter an
already admitted invocation.

`Policy.disabled()` explicitly disables inherited request memoization, local
and remote serving, recovery, and shadow work. It does not cancel work that
was already admitted or disable explicit invalidation. `Policy.enabled(ttl)`
enables local and remote TTLs; it does not opt into request memoization.

Invalid static defaults raise `ConfigError` at registration. At runtime,
invalid TTLs or ramps disable their own layer; malformed boolean switches,
read deadlines, containers, or provider failures bypass caching for that
enabled invocation. Optional recovery and shadow failures leave ordinary
serving available.

## Redis and tracked invalidation

```python
from redis.asyncio import Redis
from dialcache import DialCache, Policy
from dialcache.redis import RedisAdapter

client = Redis.from_url(
    "redis://localhost:6379",
    decode_responses=False,
    socket_connect_timeout=0.5,
    socket_timeout=0.5,
)
cache = DialCache(redis=RedisAdapter(client))


@cache.cached(
    use_case="user-profile",
    key_type="user",
    id_arg="user_id",
    track_for_invalidation=True,
    default_config=Policy(ttl_sec={"remote": 60}),
)
async def get_profile(user_id):
    return await database.fetch_profile(user_id)


async def update_profile(user_id, changes):
    await database.update_profile(user_id, changes)
    await cache.invalidate_remote("user", user_id)
```

The adapter borrows a `redis.asyncio.Redis` or `RedisCluster` client; close it
with `await client.aclose()` when your application shuts down. Configure
finite connection, socket, and retry budgets on the client. Tracked reads
atomically read the value and watermark from a primary. For tracked Cluster
reads, use a dedicated client constructed with primary-only defaults:
`read_from_replicas=False`, `load_balancing_strategy=None` where supported, and no custom
connection hook. Keep its configuration and connection mode unchanged while
borrowed. Do not repurpose a previously `READONLY` pool by resetting flags;
create a new primary-only client. Unsafe tracked reads raise `RedisProtocolError`
at the adapter boundary and ordinary cache calls fail open to the source.
Replica-enabled clients remain usable for untracked reads and maintenance.
Keys for one tracked entity share a Redis Cluster hash tag.

Each write stores a complete version-1 frame using one native `SET`. A tracked
frame is readable only if its writer timestamp is strictly greater than the
invalidation watermark. Value writes never create or extend watermarks.
Tracked physical value TTLs are capped at one hour. Invalidation raises on
mutation failure; ordinary cache plumbing fails open to the source.

Local storage is process-local. Remote invalidation does not synchronously
clear already warmed local entries or request memos on any instance. Choose
local TTLs with that explicit consistency limit in mind.

## Deadlines, recovery, and observability

The default source deadline is 60,000 ms for enabled calls. The default Redis
read deadline is 50 ms and can be overridden by operation or runtime policy.
Deadline budgets are integer milliseconds from 1 through 2,147,483,647; an
explicit `fallback_timeout_ms=None` disables the source deadline. Timing uses
the monotonic clock, while Redis frames and invalidation use wall time.

Deadline expiration stops the caller's wait. It cannot retract a source
operation or a Redis command that already started. Late results cannot
publish through an expired source execution. Caller cancellation likewise
must not cancel another caller's shared execution.

Stale recovery is optional and requires a maximum age strictly greater than
the remote TTL. A valid candidate is retained from the original remote read;
an eligible source rejection can use it only before the exclusive maximum
age. The default recovery predicate admits DialCache's own
`FallbackTimeoutError`. Recovered values may memoize in still-open request
scopes; recovery does not refresh Redis or local storage.

Pass a synchronous `metrics` callback or an object with `observe(event)` to
receive the backend-neutral diagnostic event dictionaries. Their label names
match the shared contract, including `cacheNamespace`, `useCase`, `keyType`,
and `layer`. Observer failures do not alter cache results. Local capacity
defaults to 10,000 entries; zero capacity disables storage while preserving
eligible concurrent sharing.

## Relationship to gcache

The Python API takes inspiration from [Galileo gcache](https://github.com/rungalileo/gcache):
decorated functions, argument-based identity, explicit context managers, and
pluggable serializers. DialCache follows its own portable
specification for behavior and wire compatibility.
The [API design notes](API-DESIGN.md) record the source-reviewed gcache revision
and the native API choices made for this port.

This binding exposes awaitable operations. It does not introduce a global
singleton, implicitly run synchronous I/O in a thread pool, serialize with
pickle, take ownership of Redis connections, or change the rollout cohort
randomly. Direct `put`, `delete`, and `flush` cache APIs from gcache are outside
DialCache's portable contract; writes come from successful source loads and
entity-level invalidation is explicit.

## Development and conformance

From the repository root:

```sh
python3 -m venv python/.venv
python/.venv/bin/python -m pip install -e './python[test,redis]'
python/.venv/bin/python -m pytest python/tests
```

The native tests cover Python API behavior, policy validation, scope lifetime,
local expiry, cancellation, and wire boundaries. Shared replay runs the real
Python API through the repository's Node coordinator. Its inputs and expected
observations come from the same Quint-generated histories used by the other
ports; Node is a development dependency, not a runtime dependency of the
Python library. See [the porting guide](../formal/PORTING.md) for the completion
and settlement requirements and [the feature map](../formal/FEATURE-COVERAGE.md)
for portable behavior versus native adapter obligations.

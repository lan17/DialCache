# Targeted invalidation

[Documentation](index.md) · [Keys and identity](keys.md)

One source entity can have many cached results: a user profile in several
locales, permissions, or other derived views. Targeted invalidation makes older
tracked Redis results for that entity unreadable without scanning or deleting
each key.

## Watermarks: an entity-wide cutoff

A **watermark** is a timestamp cutoff shared by an entity's tracked results.
Each cached Redis value carries a write timestamp, `createdAtMs`. After a source
mutation commits, explicit invalidation advances the entity's watermark.
Subsequent tracked Redis reads accept only values written beyond that cutoff:

```text
value.createdAtMs > watermarkMs
```

The value must also pass the normal age and payload checks. A missing watermark
is the zero baseline. The invalidation group is `(namespace, keyType, id)`;
`useCase` and `args` distinguish cached results within it:

```text
users-api / user_id / 123
    ├─ GetUser, locale=en       ─┐
    ├─ GetUser, locale=fr        ├─ checked against one watermark
    └─ GetPermissions          ─┘
```

Invalidation advances the cutoff monotonically:

```text
source mutation commits
    ↓
watermark = max(previous watermark, invalidator time + futureBufferMs)
    ↓
next tracked Redis read
    ├─ write timestamp ≤ watermark → miss → source loader
    └─ write timestamp > watermark → normal age and payload checks
```

The timestamp comes from the writer application's clock near Redis dispatch.
It is not a database version or the time the loader began. A pre-mutation load
can finish later and get a later timestamp; the
[future buffer](#choosing-futurebufferms) accounts for that bounded stale work.

This check happens on tracked Redis reads. It does not revoke local values,
existing flights, or snapshots already acquired by a caller. Choose those
[reuse boundaries](#reuse-boundaries) alongside the invalidation policy.

## Configure a tracked use case

The following native integration example uses real Redis. It warms a tracked
value, commits a source change, invalidates the entity, then verifies that a
subsequent read returns the new source value. Both local layers are disabled
and calls run sequentially after the preceding call settles, so each read makes
its own watermark observation.

<LanguageContent language="typescript">

<<< @/../typescript/examples/docs.mts#tracked-invalidation{typescript}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/typescript/examples/docs.mts)

</LanguageContent>

<LanguageContent language="go">

<<< @/../go/docs_examples_test.go#tracked-invalidation{go}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/go/docs_examples_test.go)

</LanguageContent>

<LanguageContent language="rust">

<<< @/../rust/tests/docs_examples.rs#tracked-invalidation{rust}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/rust/tests/docs_examples.rs)

</LanguageContent>

<LanguageContent language="python">

<<< @/../python/tests/test_docs_examples.py#tracked-invalidation{python}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/python/tests/test_docs_examples.py)

</LanguageContent>

The complete files provide the client, source and cleanup. The example uses a zero
buffer because it has no overlapping stale writer. That is not a production
recommendation: choose timing bounds using the next section.

<LanguageContent language="typescript">

Mark the reader with `trackForInvalidation: true` and call
`dialcache.invalidateRemote(keyType, id, futureBufferMs)` after the source commit.
Missing Redis configuration and mutation failures reject the returned promise.

</LanguageContent>

<LanguageContent language="go">

Set `Operation.Identity.Tracked` and call
`cache.Invalidate(ctx, identity, buffer)` after the source commit. The buffer
is a `time.Duration` in whole milliseconds. Missing remote configuration returns
`ErrNoRemote`; handle mutation errors as failed maintenance.

</LanguageContent>

<LanguageContent language="rust">

Set the operation's tracked identity and call
`cache.invalidate(key_type, id, future_buffer_ms).await` after the source commit.
The buffer is milliseconds. `invalidate_identity` supports an explicit identity
namespace. Handle the returned error as failed maintenance.

</LanguageContent>

<LanguageContent language="python">

Set `track_for_invalidation=True` and call
`await cache.invalidate_remote(key_type, id, future_buffer_ms)` after the source
commit. `ainvalidate()` is an alias. The buffer uses integer milliseconds.
Missing remote configuration raises `MissingRemoteError`; mutation failures
propagate to the maintenance caller.

</LanguageContent>

Invalidation works outside an enabled scope. Call it **after the source mutation
commits** and surface failures to the application's maintenance path.
[Redis setup](redis.md) covers client connections and ownership.

## Exact-key deletion versus entity invalidation

Use exact deletion when one known result must be removed, including untracked
Redis entries or local-only caching. Use entity invalidation when every tracked
argument and use-case variant of an entity must observe a timestamp fence.
They can be used together after the source mutation commits.

| Property | Exact-key deletion | Entity invalidation |
| --- | --- | --- |
| Scope | One namespace, key type, ID, use case, argument set and tracking mode | All tracked use cases and arguments of one namespace, key type and ID |
| Stores | Configured Redis value, this instance's local entry, this live request's memo | Redis entity watermark |
| Untracked results | Supported | Unchanged |
| Watermarks | Never read, changed or removed | Monotonically advanced |
| Concurrent load guarantee | Removes existing entries; an earlier load may publish again | Future tracked reads enforce the cutoff, subject to clock and in-flight-work bounds |
| Failure behavior | Unsupported adapter fails before any store changes; remote failure preserves local/memo state | Missing remote or mutation failure surfaces; existing memory entries remain |

Both maintenance operations ignore enablement. Deletion works outside a request
and inside nested disabled scopes. It never resolves runtime policy, checks TTL
or ramps, coalesces work, or creates a request memo. A missing key succeeds;
without a remote adapter, local and live request removal still run.

The delete identity must match the reader exactly, including arguments and
tracking mode. Tracking changes the key prefix. Deleting with the wrong mode
can successfully remove nothing because a missing key is not an error.

After identity validation, deletion verifies the configured adapter's capability
and counts the attempt. It awaits remote deletion first, then removes the local
entry and live request memo synchronously. Remote-first ordering prevents a
local miss from refilling from an old remote frame between those steps. A remote
error leaves memory entries intact; failures surface to the maintenance caller.
A failed dispatched command may already have executed, so retry explicitly when
appropriate. Rust custom local-store failures can surface after remote removal;
partial removal is never success.

Deletion leaves siblings, other namespaces and instances, other requests'
memos, watermarks, flights, and shadow jobs alone. Two races remain intentional:

- **Late publication:** a load admitted before deletion can finish afterward and
  repopulate the deleted key. Deletion does not cancel it or detach its flight.
- **Acquired snapshot:** a caller that already obtained a value, including bytes
  waiting for decoding or stale recovery, can return that value after deletion.

The following executable example warms an untracked local result, deletes it
within a live request, and verifies that the next read loads the changed source.
With Redis configured, the same API also removes the remote value first.

<LanguageContent language="typescript">

<<< @/../typescript/examples/docs.mts#exact-delete{typescript}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/typescript/examples/docs.mts)

</LanguageContent>

<LanguageContent language="go">

<<< @/../go/docs_examples_test.go#exact-delete{go}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/go/docs_examples_test.go)

</LanguageContent>

<LanguageContent language="rust">

<<< @/../rust/tests/docs_examples.rs#exact-delete{rust}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/rust/tests/docs_examples.rs)

</LanguageContent>

<LanguageContent language="python">

<<< @/../python/tests/test_docs_examples.py#exact-delete{python}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/python/tests/test_docs_examples.py)

</LanguageContent>

<LanguageContent language="typescript">

Call `await dialcache.delete({ keyType, useCase, key, trackForInvalidation })`.
A `GetOrLoadOptions<T>` value can be reused directly. For a registered reader,
recompute its `cacheKey` selector for the arguments; the selector itself is not
an identity. Unsupported adapters reject with `RemoteDeleteUnsupportedError`.

</LanguageContent>

<LanguageContent language="go">

Call `cache.Delete(ctx, identity)`. An empty identity namespace inherits the
instance's. The live outer request comes from `ctx` even inside `Disable`;
pass a context without that request to remove only shared stores. A configured
remote must implement the optional `RemoteDeleter` interface or the call returns
`ErrDeleteUnsupported`.

</LanguageContent>

<LanguageContent language="rust">

Call `cache.delete(&scope, identity).await`; use `Scope::outside()` without a
request. An empty identity namespace inherits the instance's. Custom remotes
opt in with `supports_delete` and `delete`, otherwise the operation returns
`Error::RemoteDeleteUnsupported`.

</LanguageContent>

<LanguageContent language="python">

Call `await cache.delete(key=..., key_type=..., use_case=...,
track_for_invalidation=False)`. Scope comes from the live context, including
inside `disable()`. Custom clients can implement `RedisDeleteClient`; a missing
`delete` method raises `RemoteDeleteUnsupportedError`.

</LanguageContent>

## Choosing `futureBufferMs`

The buffer covers stale work that can still become visible after invalidation.
The dangerous skew direction is a fast writer relative to a slow invalidator.

```text
futureBufferMs ≥ Dmax + maximum writer-clock lead + operational margin
```

`Dmax` runs from invalidation sampling until a stale pre-mutation `SET` can become
visible in Redis. Include source visibility/replication lag, remaining fallback
work, serialization, compression, client queueing and reconnect delay, network
transit, and Redis execution. An unbounded offline queue or retry path makes a
finite bound impossible.

The buffer is a nonnegative safe integer up to `31_536_000_000` milliseconds
(365 days). Its API default is zero for compatibility. Zero fences frames
stamped no later than invalidation, but provides no protection once delayed
stale work receives a later timestamp. Choose a named, application-owned value
from measured or conservative timing bounds; a sample buffer is not a universal recommendation.

A larger buffer raises fallback load. Native `MGET` still transfers existing
fenced payloads even when replacement serialization and `SET` are skipped.
The buffer does not force the loader to read an authoritative source, cancel
in-flight operations, or stop an already-dispatched write.

<a id="in-memory-layers-remain-local"></a>

## Reuse boundaries

Invalidation governs the next tracked Redis read, so other forms of reuse need
an explicit choice:

| Reuse path | Effect of remote invalidation |
| --- | --- |
| Untracked Redis entry | Does not consult the watermark |
| Request-local or process-local hit | Does not read Redis; keeps its own lifetime |
| Caller joining an existing flight | Can inherit a Redis observation made before invalidation |
| Retained stale-recovery snapshot | Later invalidation cannot revoke the acquired bytes |

### Independent fence checks

For each later invocation to make its own observation, keep tracked remote
caching active, both local layers off, `coalesce: false`, and stale recovery off.
Apply those settings in runtime overlays as well as defaults. A call starting
after invalidation then makes its own tracked read or falls back on cache failure.

Without that opt-out, a leader can read Redis before invalidation, wait in an
asynchronous serializer, and accept a new follower after invalidation. Both
callers receive the earlier observation. Already-started invocations can finish
with their snapshots even when coalescing is disabled.

The source must supply authoritative reads. Clock, buffer, and watermark
durability requirements still apply; invalidation is not a transaction with
the source mutation and does not cancel work.

## Application clock contract

Writer timestamps, invalidation proposals, and logical ages use application
epoch-millisecond clocks. DialCache does not query Redis `TIME`, calibrate an offset,
or compensate for skew. External clock synchronization and monitoring are part
of the deployment contract.

Relative skew moves logical expiry earlier or later. Frames dated after the
reading process's clock fail closed before serving. The optional future-offset
metric reports observed positive offsets, but cannot establish fleet-wide clock
health: co-skewed readers and writers, an ahead invalidator, and frames hidden
by a watermark can escape detection.

Elapsed operation durations and deadlines use the monotonic clock separately.

## Watermark durability

Watermarks are correctness state. If eviction, failover, restore, deletion, or an
external write removes a watermark, a tracked read can serve a previously fenced
value under the zero baseline.

Use `noeviction` or an equivalent preservation guarantee when relying on the
fence. Monitor memory headroom and rejected writes, and select persistence and
failover behavior consistent with the application's requirements. DialCache does
not issue `WAIT` or provide strong consistency across Redis failover.

## Protocol reference

### Read and write behavior

The bundled adapters atomically read the value and watermark with one primary
`MGET`, so replica lag cannot hide invalidation.

All value writes use one native `SET` of a complete frame stamped from the
application clock. They do not read, create, or extend watermarks. A write can
succeed physically while its frame remains unreadable under a watermark;
read-time fencing supplies that distinction.

### Conditional refills

An adapter-level tracked miss may carry `observedWatermarkMs` from the same
atomic read. After a successful fallback, DialCache uses that observation to avoid
writing a replacement already known to be fenced:

1. Sample the application clock before serialization. If the sample is at or
   below the observed watermark, skip payload preparation and the write.
2. Otherwise serialize and compress, then sample again immediately before
   dispatch. If that final timestamp is at or below the watermark, skip `SET`.
3. Otherwise send the complete frame using that exact final timestamp.

The final sample keeps serialization time out of the stored frame's logical
TTL. The first check avoids expensive serialization and compression when a fill
cannot yet clear the fence. Both checks reuse the original observation; neither
adds a Redis command.

The miss **reason** is independent from the observed fence. An absent value can
carry a valid watermark and suppress a refill. A `watermark_fenced` miss can
later refill if the timestamp advances beyond that watermark. A miss without
an observed fence follows the normal write path.

A fenced refill is skipped immediately; the call does not wait for the watermark
to pass. An admitted refill still awaits serialization and the Redis write
before returning the fallback value, so those operations need
[application-owned budgets](coalescing.md#application-owned-budgets).
The checks do not establish a transaction with a later invalidation: the
watermark can advance after the read and fence an admitted write.

### In-memory publication

If an invocation reaches the tracked Redis read/write path, its fallback is not
published directly to process-local memory. A later validated Redis hit may
warm that layer. Local-only, remote-policy-disabled, and ramped-down paths retain
their local publication behavior.

Request-local memoization remains unconditional for successful results from the
lower chain. Existing process-local and request-local entries are not evicted.
A remote ramped-out invocation without shadow work does not consult Redis.

### Shadow reads and fills

Tracked shadow reads use the same primary snapshot and fence. Semantic shadow
misses apply the same two timestamp checks before filling. A skipped fill reports
`fill_fenced`; an accepted write reports `filled`, even though a later watermark
may fence it. Shadow fills remain ordinary overwrites, not compare-and-set.

See [Shadow validation](shadow-validation.md) for admission, comparison, and
race boundaries. [Stale-on-error](stale-on-error.md) has a distinct snapshot
contract: invalidation after the initial read cannot revoke retained bytes.

### Identity and Redis Cluster placement

The invalidation unit is `(namespace, keyType, normalized id)`. It covers all tracked
`useCase` and `args` variants of that entity. Untracked entries ignore the
watermark.

```text
watermark: {users-api:user_id:123}#watermark
value:     {users-api:user_id:123}?locale=en#GetUser:dialcache-frame-v1
```

The shared hash tag puts both keys in one Redis Cluster slot. See [key encoding](keys.md#normalization-and-encoding) for
component normalization and reserved braces. Values use the binary frame suffix; watermarks are
stored as decimal timestamps.

A complete supported positive-timestamp frame rejected at or below a valid
watermark is `watermark_fenced`. A missing value is `value_absent`, even when
metadata is malformed. Malformed present watermark metadata paired with a
present frame is `unclassified`. These classifications are described in
[Observability](observability.md#miss-reasons).

Redis `MGET` treats wrong-type members as absent. A wrong-type watermark therefore
acts like the zero baseline until explicit invalidation repairs it. Preserve
ownership of the keyspace; external writes can undermine the fence.

### Watermark lifetime

DialCache caps tracked Redis value retention at **one hour**. Each dispatched write
configured above that cap records `tracked_ttl_clamped`; its logical policy is
not rewritten. Invalidation alone creates and updates watermarks.

A finite watermark is retained for at least:

```text
max(existing remaining TTL,
    2 hours,
    watermark − invalidatedAtMs + 1 hour + 1 minute)
```

An existing persistent string watermark stays persistent. Reads and value writes
do not extend it. Under the clock and in-flight-work contract, the marker outlives
every value it can fence. The fixed minute is retention slack; it does not
replace a complete `Dmax` bound.

Invalidation repairs malformed string watermarks from a zero baseline while
preserving a longer remaining TTL or persistence. A wrong-type key is instead
treated as absent and replaced with a finite, derived TTL, even if that key was
persistent. Other Redis read errors surface without replacing the prior state.

Changing the tracked-value cap or watermark floor requires another coordinated
protocol transition: new constants cannot extend markers an older invalidator
already wrote. See [Upgrading](upgrading.md#tracked-protocol-cutover).

### Failure behavior and telemetry

Invalid buffer arguments fail before dispatch. Missing Redis configuration and
invalidation I/O failures are logged, recorded with `error="invalidation"`, and
surfaced to the caller. The operation metric uses `keyType` and namespace; it does not attach
an entity id to labels.

Adapter retries reuse the original invalidation timestamp, preserve monotonicity,
and cannot shorten a longer/persistent string marker. Wrong-type repair follows
the exception above. A rejected dispatched mutation
can have executed, so an error does not prove absence of a watermark change.
See [Redis retries](redis.md#invalidation-retries-and-ambiguity).

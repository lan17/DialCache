# Targeted invalidation

[Back to the README](../README.md)

DialCache can invalidate related Redis entries without scanning or enumerating
keys. The mechanism is opt-in, remote-only, and based on per-identity Redis
watermarks.

Read this complete contract before using targeted invalidation for mutable
production data. Correctness depends on cache-layer policy, Redis clock
synchronization, and an application-owned timing buffer.

## Configure a tracked use case

Set `trackForInvalidation: true` on a Redis-backed cached function or
`getOrLoad()` operation. After the source mutation commits, call
`dialcache.invalidateRemote(keyType, id, futureBufferMs)`:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: dialCacheRedisClient },
});

// Chosen from this application's clock-skew bound and measured
// worst-case source and fallback timings.
const USER_INVALIDATION_BUFFER_MS = 5_000;

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetMutableUser",
    cacheKey: (userId) => userId,
    trackForInvalidation: true,
    // Strongly invalidated mutable data should not use in-memory layers.
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: {
        [CacheLayer.REMOTE]: 300,
      },
      ramp: {
        [CacheLayer.REMOTE]: 100,
      },
    }),
  },
);

await updateUser("123", patch);
await dialcache.invalidateRemote(
  "user_id",
  "123",
  USER_INVALIDATION_BUFFER_MS,
);
```

The buffer is an application-owned safety value. DialCache cannot choose a
universally safe nonzero default. It must be a nonnegative safe integer no
greater than `31_536_000_000` milliseconds (365 days).

`invalidateRemote()` is an explicit remote maintenance operation and requires
`DialCacheConfig.redis`. A local-only `DialCache` remains valid for normal cache
operations, but invalidation does not silently become a no-op: without Redis it
rejects a `TypeError` whose message is
`DialCache invalidateRemote requires a configured Redis client`.

## Identity and Redis Cluster placement

Invalidation writes a watermark at:

```text
{encodedNamespace:encodedKeyType:encodedId}#watermark
```

Tracked Redis values use the same Redis Cluster hash tag. For example:

```text
{users-api:user_id:123}?locale=en#GetMutableUser:dialcache-frame-v1
```

The value and watermark therefore live in the same Redis Cluster slot. Key
components are percent-encoded before joining, so delimiters inside ids or
arguments cannot collide with delimiters in the key format.

`namespace` may never contain `{` or `}`; tracked `keyType` and `id` values may
not contain them because those three components form the hash tag. `args` and
`useCase` are encoded outside the hash tag and may contain braces.

The internal `:dialcache-frame-v1` suffix identifies values written with
DialCache's binary protocol. Watermarks are stored as decimal timestamps.

`keyType` plus `id` is the invalidation unit. One watermark covers every tracked
`useCase` and `args` variant with that identity. Untracked values do not consult
it.

## Read and write behavior

A tracked read obtains the value and watermark in one atomic `MGET`. Bundled
cluster adapters explicitly route it to the slot primary; a standalone
node-redis client must already target the authoritative endpoint. A readable
frame whose Redis-stamped creation time is older than or equal to the watermark
is treated as stale and refreshed through fallback.

`invalidateRemote(keyType, id, futureBufferMs)` sets the watermark to the
greater of:

- its existing value; and
- Redis's current time plus the buffer.

While that future window is active:

1. A tracked Redis read receives the covered value and watermark, then treats
   the value as a miss.
2. The invocation runs its fallback.
3. DialCache serializes and optionally compresses the fallback value, then a
   native `SET` writes the complete payload as an unreadable placeholder.
4. A small stamp script compares Redis time with the watermark. If the window
   is still active, it unlinks the placeholder and refuses publication.
5. DialCache suppresses the corresponding process-local population, while the
   fallback value still returns to its caller.

Request-local memoization remains unconditional. A ramped-out invocation
without selected shadow work does not consult the watermark and is not fenced
by it.

This is a timing contract, not a cancellation or acquisition fence. The buffer
blocks stale fallback results from passing the tracked Redis write only while
the configured window remains active. It does not cancel the fallback or force
it to read from an authoritative source.

If a tracked remote read rejects or exceeds its deadline, DialCache cannot
establish watermark safety. It runs the fallback but skips both the Redis write
and process-local publication. This differs from a normal tracked miss, which
can attempt the fenced Redis write. Untracked fallbacks may still populate
process-local cache, and request-local memoization remains unconditional.

### Invalidated payload transfer and cleanup

The atomic `MGET` transfers the complete Redis frame before the adapter can
compare its timestamp with the watermark. Large invalidated values can
therefore consume network bandwidth—and can repeatedly exceed the remote-read
deadline—even though DialCache will not serve them.

A successful fallback that reaches the tracked stamp while the fence is active
partially mitigates this: its placeholder `SET` replaces the stale frame and
the stamp script unlinks the placeholder. Later reads then avoid transferring
the old payload.

A read error or timeout skips the write entirely, so it cannot perform this
cleanup. A fallback or write failure can likewise leave cleanup for a later
successful attempt or the value TTL.

The cleanup is not free. Every fenced write sends and temporarily stores the
complete serialized, possibly compressed payload before removing it. Include
that network transfer, Redis allocation, replication or AOF work, and stamp
round trip when estimating the load created by an oversized future buffer.

### Shadow reads and fills

[Shadow mode](shadow-validation.md) uses the same tracked protocol. A sampled
path can perform a tracked Redis read even when the remote serving ramp excludes
the key. A definitive `null` result can then attempt a tracked fill from the
caller-accepted source value, using the invocation's resolved remote TTL.

An active future watermark rejects that fill and produces the bounded
`fill_blocked` shadow outcome. It does not reject or replace the value returned
to the caller. Caller-path request-local and process-local publication remains
independent when the remote serving layer is ramped out.

The shadow read and fill are not atomic. An ordinary tracked cache write can
land between them, and either write can overwrite the other according to
arrival order when the watermark permits it. Shadow mode never repairs or
overwrites a non-null initial Redis payload; it only fills a definitive clean
miss.

## Redis clock contract

The bundled timestamp protocol assumes synchronized system clocks across every
Redis node eligible for primary promotion.

Redis does not guarantee that `TIME` is monotonic across nodes, and DialCache
does not detect or compensate for cross-node clock skew. If the assumption is
violated, failover can:

- temporarily suppress tracked cache fills; or
- allow a pre-invalidation value to remain readable until it expires or a later
  invalidation advances the watermark past its timestamp.

Monitor and bound the maximum negative clock skew across all promotion-eligible
nodes. Include that bound when sizing `futureBufferMs`.

## Watermark durability

Watermarks are invalidation state, not disposable cache entries. Redis must
preserve each marker for its derived TTL with `noeviction` or an equivalent
guarantee. Choose persistence, restore, and failover behavior that matches the
application's consistency requirements.

Losing a marker through eviction, failover, restore, or external deletion
removes its prior publication fence. A missing marker makes tracked reads miss,
but a later tracked write creates a new baseline and can publish data that a
lost future watermark would have rejected.

Redis replication is asynchronous. DialCache does not issue `WAIT` and does not
provide strong consistency across failover.

## Watermark lifetime

Tracked writes create a missing baseline watermark and ensure its TTL is at
least the value TTL plus one minute. They never shorten a longer or persistent
watermark TTL. Because cache TTLs cap at 365 days, the derived marker TTL can
reach 365 days plus the fixed one-minute margin.

Invalidation ensures the TTL covers both the requested future buffer and any
still-future existing watermark, plus one minute. It also preserves a longer or
persistent TTL. The one-minute safety margin is fixed; there is no separate
configurable or global retention floor, and reads do not extend watermark
lifetime.

## Choosing `futureBufferMs`

`futureBufferMs` must be a nonnegative safe integer no greater than
`31_536_000_000` milliseconds (365 days). The API default is zero, but zero
provides no stale-publication protection once Redis time advances.

Larger values, negative values, fractions, non-finite values, and wrong-type
values are rejected with a `RangeError` before DialCache records metrics, logs,
checks whether Redis is configured, or calls the client. An invalid buffer
therefore takes precedence over the missing-Redis `TypeError` and has no
invalidation telemetry side effects.

Every production invalidation should pass a named, application-owned nonzero
value based on measured or conservatively bounded timings. Size it to cover:

- maximum expected negative clock skew between promotion-eligible Redis nodes;
- source visibility or replication lag;
- the full remaining tail of any fallback that may already have observed the
  pre-mutation value;
- `serializer.dump`;
- synchronous compression or raw-payload escaping;
- Redis client queue and network latency for the full placeholder payload;
- the native placeholder `SET` and the tracked stamp script, including their
  ordered dispatch and settlement; and
- a safety margin.

Include the remaining lifetime of any sampled shadow fill based on a source
read that may have observed the pre-mutation state. A shadow deadline can stop
work before write dispatch, but it cannot prove that an already-dispatched
Redis command did not execute.

Account for the underlying client's queue, dispatch, retry, and settlement
bounds as well as DialCache's shadow deadline.

Invalidate only after the source mutation commits.

Underestimating the interval can allow a delayed stale fallback to repopulate
Redis after the watermark window ends. Overestimating it lengthens the tracked
Redis miss and write-suppression window, increasing fallback load without
publishing stale values.

A larger buffer does not delay or suppress returning fallback values to
callers.

## Failure behavior and telemetry

The bundled adapters dispatch invalidation with `EVALSHA` and retry a rejected
dispatch once with the script source through `EVAL`. Because its monotonic
update only advances the watermark and widens its lifetime, duplicate
execution after an ambiguous first result is safe. A successful recovery is
internal to the adapter and produces no DialCache error or retry metric. See
[Mutation retries and ambiguity](redis.md#mutation-retries-and-ambiguity) for
adapter-specific error handling.

For a valid buffer, DialCache invokes the configured invalidation metric hook
with `layer="remote"` before it checks the Redis prerequisite.

Missing configuration and Redis write failures then follow the same observable
failure path: DialCache logs `Error writing DialCache invalidation watermark`,
invokes the configured error metric hook with `useCase="watermark"`,
`layer="remote"`, `error="invalidation"`, and `inFallback=false`, then rethrows
the original error. Logger and metrics callback failures are isolated and
cannot replace that rejection.

A surfaced mutation failure is ambiguous: Redis may have advanced the
watermark before the client lost the reply. Do not interpret the rejection as
proof that nothing executed. Repeating `invalidateRemote()` after the source
mutation has committed is safe and advances or preserves the fence, but may
extend the future miss window.

## In-memory layers remain local

Targeted invalidation is remote-only. `invalidateRemote` does not evict existing
request-local or process-local entries.

Strongly invalidated mutable data should disable request-local and process-local
caching. A short process-local TTL is appropriate only when the application
explicitly accepts that bounded stale-read window.

If those layers remain enabled, their existing values can be returned without
reaching the remote watermark.

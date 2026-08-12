# Redis shadow validation

[Back to the README](../README.md)

Shadow validation lets a service exercise and inspect Redis behavior without
letting the shadow path choose the caller's result. It is useful for validating
warm entries against the source of truth and for bootstrapping clean misses
before increasing the Redis serving ramp.

Shadow mode is an operational rollout tool, not a new serving layer or a
correctness boundary. It adds source and Redis work, provides best-effort
evidence through bounded metrics, and preserves each key's ordinary tracked or
untracked Redis mode. It relies on the same serialization, deadline, consistency,
and client-lifecycle contracts as the remote layer.

## At a glance

| Path reached by the caller | Caller receives | Selected shadow work |
| --- | --- | --- |
| Serving Redis hit, tracked or untracked | The decoded Redis value | Compare a later source read with the retained payload, then confirm a mismatch candidate with one same-mode Redis read. |
| Valid remote policy, but ramped out of Redis serving | The normal source result | Read Redis later without serving it. Compare a hit, or fill a clean miss from the accepted source result. |
| Serving Redis miss | The normal source result | None. The ordinary request path already performs fallback and fill. |
| Request-local or process-local hit | The in-memory value | None. Normal traversal never reached Redis. |

Redis serving and shadow selection use independent deterministic cohorts. A
key can therefore be served without being shadowed, shadowed without being
served, selected for both, or selected for neither.

## Configure a shadow cohort

Shadow validation requires a valid remote TTL, a metrics adapter with the
optional shadow hook, and a positive `shadow.ramp`. Invalidation tracking is
optional and selects the Redis consistency mode rather than shadow eligibility:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: dialCacheRedisClient },
  metrics,
  // Per-instance cap; the default is 1.
  shadowMaxInFlight: 4,
});

const getUser = dialcache.cached(
  (userId: string) => db.fetchUser(userId),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId) => userId,
    // Optional for shadowing; adds watermark fencing to Redis reads and fills.
    trackForInvalidation: true,
    shadowComparator: (cached, source) =>
      cached.id === source.id && cached.version === source.version,
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.REMOTE]: 300 },
      // Exercise and fill Redis without allowing it to serve this cohort.
      ramp: { [CacheLayer.REMOTE]: 0 },
      shadow: { ramp: 5 },
    }),
  },
);
```

`shadow.ramp` accepts percentages from `0` through `100`. An effective value of
`0`, or omission from both baseline and runtime policy, disables shadow work;
`100` selects every otherwise eligible exact cache key.

A sparse runtime overlay that omits the field inherits the baseline.
Intermediate values select a stable key cohort across calls and instances. The
shadow bucket is independent of the remote serving bucket, so equal ramp
percentages do not select the same keys.

Use `shadow: { ramp: 100 }` when every eligible invocation should exercise the
non-serving Redis path before a later serving-ramp increase. This still
observes only keys invoked during the shadow period; it is not a full keyspace
scan or warming guarantee.

The root-exported `ShadowConfig` groups `ramp` with the default-off
`logMismatches` diagnostic policy. Runtime overlays merge those two leaves
independently: an omitted leaf inherits its baseline, while
`logMismatches: false` explicitly disables inherited logging.

The former flat `shadowRamp` field has been removed; migrate it to
`shadow.ramp`. Public construction and static defaults reject the old field,
and a raw runtime provider result containing it fails config resolution and
runs the fallback uncached rather than inheriting defaults.

## Eligibility

DialCache schedules shadow work only when all of these conditions hold:

- the call began inside an enabled DialCache scope;
- a Redis or Valkey adapter is configured;
- normal traversal reaches the remote layer;
- the resolved remote policy has a valid TTL;
- the effective `shadow.ramp` is positive and selects the exact key;
- the configured metrics adapter implements `shadowValidation`; and
- the instance has capacity and no shadow job already owns that exact key.

A remote serving ramp of `0` is eligible because it preserves a valid remote
policy while excluding the key from serving.

Missing or invalid remote policy, provider failure, an omitted metrics hook, an
invalid or zero shadow ramp, cohort exclusion, an earlier in-memory hit, or a
disabled call does not start a shadow-only Redis path.

An invalid runtime `shadow.ramp` does not disturb an otherwise valid
caller-serving Redis hit. DialCache skips shadow work and records a
`config_resolution` error.

`DialCacheKeyConfig.disabled()` sets the shadow ramp and both serving ramps to
`0`, and sets `shadow.logMismatches` to `false`, so it is the complete kill
switch for new cache invocations. It does not cancel work already admitted.

An invalid runtime `shadow.logMismatches` does not change the cache result,
shadow result, or terminal shadow metric. For an admitted job, DialCache records
one remote `config_resolution` error and suppresses the warning.

DialCache validates this diagnostic leaf only after the metrics-hook,
exact-key-cohort, and capacity gates; ineligible, cohort-excluded, and
explicitly dropped work does not report that configuration error.

### Upgrade note for untracked keys

Starting in `v0.15.0`, otherwise eligible untracked keys participate in shadow
work. A use case that already had a positive effective `shadow.ramp` can
therefore add source reads, Redis reads and fills, metrics, and opted-in logs.
Set its shadow ramp to `0` before upgrading if that work is not wanted.

See [Configuration and cache layers](configuration.md) for runtime-overlay
precedence and policy validation.

## Serving-hit and ramped-down paths

### Serving Redis hit

The request path performs its normal Redis read and deserialization in the
key's tracked or untracked mode. It returns that cached value without waiting
for shadow work and retains the exact serialized payload as `C0`.

On a later unreferenced event-loop turn, the shadow job:

1. invokes the source loader inside a disabled DialCache context;
2. deserializes `C0` again into an independent cached snapshot;
3. compares that snapshot with the source value `S`; and
4. performs a confirmation read only when the values differ.

The additional source call must be safe to run for observation. With default
coalescing, one serving Redis leader schedules at most one job for its
followers. With `coalesce: false`, each caller can attempt scheduling; exact-key
shadow deduplication admits at most one concurrent job and reports the others
as `dropped`.

### Ramped down from Redis serving

When a valid remote policy excludes the key specifically because its serving
ramp is down, the caller runs and awaits the normal source loader. Shadow work
reuses that same caller-owned promise as `S`; it does not invoke the loader a
second time.

The detached job reads Redis as `C0` in the key's existing mode. A hit is
compared with `S`. A clean miss can be filled from `S` in that same mode using
the invocation's resolved remote TTL snapshot.

The shadow Redis value never supplies the caller or populates request-local or
process-local memory. If those in-memory layers are active, only the caller's
source result can populate them.

When request-local and process-local caching are off and Redis serving is
ramped down, caller invocations remain uncached and do not gain process
coalescing merely because shadowing is enabled. Concurrent same-key callers
can each run the source; shadow deduplication independently admits one shadow
job and reports the others as `dropped`. If an in-memory serving layer is
active, `coalesce: false` likewise keeps each caller's cache path independent.

## The `C0` / `S` / `C1` algorithm

`C0` is the original Redis payload: either the payload that served the caller or
the result of the detached ramped-down read. `S` is the successfully accepted
source value. `C1` is an optional confirmation read in the same tracked or
untracked mode as `C0`.

1. Obtain `C0`.
2. If `C0` is `null`, follow the clean-miss fill path described below.
3. Otherwise, obtain `S`, deserialize a new snapshot from `C0`, and compare the
   cached and source values.
4. When they match, emit `match`; no confirmation read is needed.
5. When they differ, read Redis again as `C1` in the same mode, bypassing the
   request-local and process-local caches.
6. If `C1` is missing or its bytes differ from `C0`, emit `superseded`.
7. If `C1` is byte-identical to `C0`, emit `mismatch`.

String payloads compare by their UTF-8 bytes, Buffer payloads compare by bytes,
and a string/Buffer pair with the same UTF-8 bytes is identical for
confirmation. DialCache does not deserialize `C1`, compare it with `S`, or
chase another version.

`mismatch` therefore means that the exact observed Redis payload survived one
confirmation read after a semantic disagreement. It is not a cross-system
atomic snapshot or a guarantee that the mismatch still exists. For an
untracked key, it is also not proof of primary freshness or invalidation
safety. `superseded` means only that the original observation could not be
confirmed.

No non-null `C0` is repaired, overwritten, invalidated, or given a refreshed
TTL. That rule also applies when detached deserialization fails.

### Clean-miss fill

A clean miss means the semantic Redis read returned `null`. It does not include
a non-null payload that the serializer cannot load.

On the ramped-down path, DialCache can serialize the caller-accepted `S` and
attempt one ordinary Redis write in the key's existing mode with the resolved
TTL:

- `filled` means the client returned `true` before the shadow deadline;
- `fill_blocked` means a tracked invalidation watermark returned `false`; and
- `fill_error` means preparing the payload (serialization or compression) or
  writing it to Redis failed.

A source rejection or caller fallback timeout never produces an accepted `S`
and never starts the fill. Once serialization has finished, DialCache checks
the whole-job deadline again before dispatching the write.

The `C0` read and fill are not atomic. The fill is a normal overwrite, not a
compare-and-set or write-if-still-missing operation. Another writer can
populate Redis after `C0` misses and then be overwritten by the shadow fill.
Tracked writes retain their watermark fence. An untracked fill has no fence and
uses ordinary TTL-based last-writer-wins publication, so an older accepted
source value can overwrite a concurrent newer value and remain until expiry.

## Comparison semantics

By default, DialCache uses Node's `util.isDeepStrictEqual`. Plain-object
property insertion order does not affect equality; values, array order,
prototypes, constructors, Buffers, Maps, Sets, and other supported structures
remain strictly compared.

`shadowComparator(cachedValue, sourceValue)` can define application-level
equality, such as ignoring a volatile refresh timestamp. It is stable
use-case behavior, not runtime rollout policy. The comparator must:

- return a boolean synchronously;
- be deterministic and side-effect-free;
- avoid mutating either borrowed input; and
- complete in bounded time.

A throw or non-boolean result is `comparison_error`, not `mismatch`. An
accidental promise is not accepted as a result. DialCache consumes its
settlement so a later rejection is not unhandled, while the job remains
subject to its deadline and capacity rules.

The cached comparator input is newly deserialized from `C0`; it is not the
object already returned to a serving-hit caller. The source input is the raw
loader result. This deliberately exposes lossy serialization unless a custom
comparator declares that normalization acceptable.

## Confirmed mismatch logging

The bounded shadow outcome metric is the default diagnostic. A use case can
separately opt in to one warning for each terminal `mismatch`:

```ts
new DialCacheKeyConfig({
  shadow: {
    ramp: 5,
    logMismatches: true,
  },
});
```

Logging does not activate shadow work: the operation must still pass every
eligibility gate, including the required `metrics.shadowValidation` hook. A
warning is emitted only after `C1` is byte-identical to `C0` and the terminal
`mismatch` metric is recorded. Matches, candidates that become `superseded`,
timeouts, dropped work, and errors remain metric-only.

The warning message is `DialCache shadow validation mismatch`. Its details are:

| Field | Value |
| --- | --- |
| `cacheNamespace`, `useCase`, `keyType`, `outcome` | Stable metadata; `outcome` is always `"mismatch"`. |
| `cacheKey` | The logical DialCache URN, not the physical Redis storage key; capped at 2 KiB of UTF-8. |
| `cachedValueJson` | Native JSON for the newly deserialized `C0` comparator input; capped at 8 KiB of UTF-8. |
| `sourceValueJson` | Native JSON for the raw source comparator input; capped at 8 KiB of UTF-8. |

DialCache applies `JSON.stringify` independently to the two values. If it throws
or returns `undefined`, that field is `null` and the other side is still
attempted.

A byte-clipped string ends in `...[truncated]` within its cap without splitting
a UTF-8 sequence. DialCache never passes the raw compared-value references to
the logger, calls the configured serializer again, or computes a textual diff.

These bounds limit the fields handed to the logger, not the data DialCache must
inspect to build them:

- truncation is not redaction; the logical URN can contain ids and arguments,
  and either value can contain secrets or personal data;
- native JSON invokes getters and `toJSON`, can omit or normalize unsupported
  values, and produces `null` here for cycles, `bigint`, or other failures;
- stringification is synchronous, and the 8 KiB cap applies only after it
  returns, so it does not bound traversal, hook execution, event-loop time, or
  the intermediate string; and
- metadata, logger framing, and transport escaping are outside the field caps,
  so the final event can exceed a sink-specific size limit.

Enable mismatch logging only for trusted, reasonably bounded values and with an
approved logger, redaction, transport, access, and retention policy. An
unexpected detail-construction failure degrades to the metadata-only warning.
Synchronous logger throws and rejected promises or thenables remain isolated
from cache and shadow correctness.

## Capacity, deadlines, and detachment

`shadowMaxInFlight` is a positive safe integer on each `DialCache` instance and
defaults to `1`. It counts scheduled and running jobs. The optional `C1` read
and clean-miss fill remain part of the original slot.

There is no queue. DialCache emits `dropped` when:

- another shadow job already owns the exact cache key; or
- the instance has reached `shadowMaxInFlight`.

Separate instances have separate caps. This is not fleet-wide admission
control for Redis or the source of truth.

Each job has one monotonic deadline across the detached Redis read, source
result, serializer work, comparison, confirmation read, and clean-miss fill:

- a finite `fallbackTimeoutMs` is also the whole shadow budget;
- when `fallbackTimeoutMs` is `null`, the caller fallback is unbounded but
  shadow work still uses 60 seconds;
- serving-hit timing begins when the detached callback starts; and
- ramped-down timing begins immediately before the caller's source invocation,
  including its synchronous prefix.

Each `C0` or `C1` Redis read also uses the effective
`remoteReadTimeoutMs`. That read deadline bounds DialCache's wait, not the raw
client operation.

The scheduler, Redis-read timers, and overall shadow timer are unreferenced.
They do not keep an otherwise idle process alive. Detachment is still work on
the Node event loop, not a worker thread; synchronous source, serializer, or
comparator code can occupy the event loop after the request continues.

Deadline expiry records the applicable outcome, releases retained `C0`, and
prevents later phases from starting. It does not cancel JavaScript promises or
prove that a dispatched Redis command stopped.

Shadow-owned reads, serializer calls, comparators, and writes can therefore
retain the slot after the DialCache deadline until their underlying work
settles. On the ramped-down path, the shared source promise is caller-owned and
does not retain the shadow slot after the job abandons it.

Give every source, serializer, Redis client, and telemetry transport a finite
native resource budget. A shadow `timeout` or `fill_error` after write dispatch
does not prove Redis was unchanged. Conversely, `filled` means the client
reported success before the deadline, not that the entry is still present.

## Data ownership and custom integrations

Detached execution preserves the original `cached()` argument references or
the `getOrLoad()` loader closure. DialCache cannot generically clone captured
state. Snapshot mutable source-selection inputs before invoking DialCache so
the later source read still describes the already-built cache key.

Treat the source result `S` as immutable after return. A clean-miss serializer
may inspect it after the caller has continued.

The effective serializer has additional shadow requirements:

- `load` can run twice for a sampled serving hit;
- repeated loads of the same payload must be independent;
- `load` must not mutate a borrowed Buffer; and
- asynchronous `load` and `dump` methods need finite application-owned
  deadlines.

A custom `DialCacheRedisClient.read()` must return an operation-owned payload
whose contents remain stable after the method settles. DialCache can retain
that exact `string | Buffer` for detached deserialization and confirmation.
An adapter that pools or recycles response storage must return a dedicated
Buffer.

A custom metrics adapter must implement the optional `shadowValidation` hook
to admit shadow work. The hook remains optional at the type level so existing
adapters continue to compile; omitting it deliberately keeps shadow execution
off.

See [Redis and Valkey](redis.md) for the complete custom-client, payload,
deadline, and connection-lifecycle contracts.

## Consistency modes and race boundaries

Shadowing preserves the operation's existing Redis mode:

- **Tracked keys:** `C0` and `C1` use the watermark-aware read protocol, which
  atomically checks the value timestamp against the invalidation watermark.
  Bundled cluster adapters explicitly route these reads to the primary; a
  standalone node-redis client must already target the authoritative endpoint.
  A clean-miss fill uses the ordinary tracked write and can be rejected as
  `fill_blocked` by a future watermark.
- **Untracked keys:** `C0` and `C1` use the ordinary one-key read route without a
  watermark or shadow-specific primary guarantee. A clean-miss fill uses the
  ordinary TTL write. Compliant untracked writes do not produce
  `fill_blocked`.

Both modes use the operation's serializer and value TTL. Tracked publication
receives a Redis-time timestamp from the stamp script; an untracked write uses
an informational client-clock timestamp that untracked reads never consult.

Neither mode makes the initial `C0` read and later fill atomic. For tracked
keys, size `futureBufferMs` to cover the complete source, serialization, client
queue, network, and write interval when stale-publication protection matters.
The watermark fences only the tracked Redis write; it does not synchronously
invalidate request-local or process-local entries. Shadow mode never evicts
those layers.

See [Targeted invalidation](invalidation.md) for the tracked clock, durability,
retention, and future-buffer contracts.

### Command amplification

| Selected path | Added source work | Added Redis work |
| --- | --- | --- |
| Serving Redis hit, semantic match | One observational source read | None beyond the serving read |
| Serving Redis hit, mismatch candidate | One observational source read | One same-mode confirmation read |
| Ramped-down Redis hit, semantic match | None beyond the caller's source read | One same-mode `C0` read |
| Ramped-down Redis hit, mismatch candidate | None beyond the caller's source read | Same-mode `C0` and `C1` reads |
| Ramped-down clean Redis miss | None beyond the caller's source read | One same-mode `C0` read and at most one write |
| Serving Redis miss | None beyond the ordinary path | None beyond the ordinary read and fill |

Capacity limits bound concurrent jobs, not total work over time. Measure source
and Redis load while increasing `shadow.ramp`.

## Metrics and compatibility

Every admitted job, and every job explicitly rejected by deduplication or the
capacity cap, reports one bounded terminal outcome:

| `outcome` | Meaning |
| --- | --- |
| `match` | The deserialized `C0` and source value matched semantically. |
| `mismatch` | They differed and byte-identical `C1` confirmed the original `C0`. |
| `superseded` | They differed, but `C1` was missing or had different bytes. |
| `filled` | A clean miss was populated successfully before the deadline. |
| `fill_blocked` | A tracked invalidation watermark rejected the clean-miss fill. |
| `fill_error` | Preparing the payload (serialization or compression) or writing the clean-miss fill failed. |
| `redis_error` | The initial detached `C0` read failed or reached its read deadline. |
| `source_error` | The source loader rejected without being the caller's own DialCache fallback timeout. |
| `deserialization_error` | The retained non-null `C0` could not be deserialized. |
| `comparison_error` | The comparator threw or did not return a synchronous boolean. |
| `confirmation_error` | The `C1` read failed or reached its read deadline. |
| `timeout` | The whole shadow deadline expired, including a shared caller fallback timeout. |
| `dropped` | Exact-key deduplication or the per-instance cap rejected the job. |

Ineligible or cohort-excluded invocations do not emit a shadow outcome.
Outcome labels contain the logical cache namespace, `useCase`, and `keyType`;
they never contain ids, values, payloads, Redis keys, or exception text. The
separately opted-in mismatch warning is value-bearing and does not change this
metric-label contract.

Redis reads, serializer work, payload sizes, and Redis errors inside detached
jobs use the existing metric hooks with `layer="remote_shadow"`. This keeps
their cost separate from caller-serving `layer="remote"` traffic. The read
that supplied a serving-hit `C0` remains caller-path `remote` work, and a
ramped-down caller still reports `disabled{layer="remote",
reason="ramped_down"}`.

The dedicated shadow outcome has no `layer` label. A clean `C0` miss also
records the ordinary `miss{layer="remote_shadow"}` before the job's terminal
fill, source, or timeout outcome.

`MetricLayer` includes `remote_shadow`, and `ShadowValidationOutcome` includes
every value in the table above. TypeScript consumers with exhaustive switches
or `Record` values must handle those cases. Dashboards filtered to
`layer="remote"` intentionally exclude detached cost.

See [Observability](observability.md) for exact Prometheus and Datadog metric
names, units, labels, and the custom-adapter interface.

## Rollout checklist

Before increasing `shadow.ramp`:

- confirm the source loader is safe to invoke observationally on serving hits;
- use a valid remote TTL with the serving ramp at `0`;
- choose the Redis consistency mode deliberately: for tracked keys, configure a
  defensible `futureBufferMs`; for untracked keys, accept TTL-based
  last-writer-wins fills without invalidation or a primary-read guarantee;
- verify serializer, comparator, Redis client, source, and telemetry budgets;
- start with a small per-instance capacity and measure `dropped`;
- account for the command amplification above; and
- arrange application-owned shutdown for dependencies that can outlive the
  DialCache deadline.

Keep `shadow.logMismatches` off unless the logged key and values have been
classified and the application has approved their synchronous JSON cost,
redaction, transport, access, and retention policy.

During rollout, monitor outcome ratios together with detached source latency,
`remote_shadow` Redis errors, fill load, and ordinary source health. Treat
`mismatch` as a signal to investigate value meaning, serialization, key
identity, and source consistency—not as an automatic repair instruction.

Increase the Redis serving ramp only after the observed cohort, source load,
and invalidation behavior meet the application's acceptance criteria. To stop
new Redis serving and shadow activity through runtime policy, set both the
remote serving ramp and `shadow.ramp` to `0`.

## Shutdown

DialCache has no shadow drain or close method. Awaiting promises returned by
`cached()`, `getOrLoad()`, and `invalidateRemote()` drains request-path work,
not detached shadow jobs.

During shutdown:

1. stop admitting new DialCache-backed requests;
2. set serving and shadow ramps to `0` if runtime policy remains active;
3. await request-path cache calls and invalidations;
4. use source, Redis-client, serializer, and telemetry-native controls to drain
   or terminate their work;
5. close underlying connections after their remaining work drains.

Unreferenced shadow scheduling means the process may exit before an outcome is
delivered. Already-started source reads, serializers, Redis commands, or
telemetry can still be active, and an already-dispatched fill may have
executed even when its outcome is lost during teardown. Shadow validation is
therefore best-effort during shutdown by design.

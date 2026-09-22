# Stale-on-error

[Documentation](index.md) · [Redis and Valkey](redis.md)

Stale-on-error lets selected source failures fall back to an older Redis value.
It is off by default. When enabled, DialCache retains a raw snapshot from the
initial Redis read, tries the source, and can return that snapshot if the error
policy allows it and the value is still within its maximum age.

It performs **no second Redis read**. That keeps recovery available if Redis
becomes unavailable during the source call, but also means later invalidation,
deletion, refresh, or expiry cannot revoke the retained snapshot.

## Fresh age and maximum age

| Symbol | Configuration | Meaning |
| --- | --- | --- |
| `F` | Remote TTL | Exclusive fresh age ceiling for ordinary Redis reads |
| `M` | Maximum recovery age | Exclusive recovery age ceiling, measured from the same frame timestamp |

`M` is total age, not extra time after `F`. Positive configuration must satisfy
`0 < F < M <= 31_536_000` seconds. Both ages must be safe-integer numbers.
Omission leaves recovery off, or inherits it in a sparse runtime overlay.
Explicit `0` disables inherited recovery.

Invalid static defaults fail validation. Invalid runtime recovery policy records
`config_resolution`, disables only recovery, and preserves valid ordinary Redis
serving. A remote ramp of zero bypasses the caller-serving Redis path, including
recovery.

## Configure the ages

Use a remote TTL for ordinary freshness and a larger maximum age for recovery:

<LanguageContent language="typescript">

Set `ttlSec.remote: 60` and `staleOnErrorMaxAgeSec: 300` in
`DialCacheKeyConfig`, with a connected Redis adapter. The per-operation
`fallbackTimeoutMs` controls the source deadline; it is separate from both ages.

</LanguageContent>

<LanguageContent language="go">

Set `Policy.RemoteTTL` to `60 * time.Second` and `Policy.StaleOnErrorMaxAge`
to `dialcache.Ptr(300 * time.Second)`. A nil recovery pointer omits recovery;
a pointer to zero explicitly disables an inherited setting. Supply `WithRemote`
for the Redis adapter.

</LanguageContent>

<LanguageContent language="rust">

Use `Policy::default().remote_ttl_sec(60).stale_on_error_max_age_sec(300)`
with a connected `Remote`. The operation's `SourceBudget` controls the source
deadline separately from both ages.

</LanguageContent>

Inside an enabled scope, a frame younger than 60 seconds serves normally. From
60 seconds until strictly before 300 seconds, it can serve only after an eligible
source failure. The built-in classifier accepts the native fallback-timeout
error only.

## Follow one invocation

The initial read uses one invocation snapshot of `F`, `M`, and the read deadline.
DialCache classifies the returned frame before normal deserialization:

| Age when the initial read settles | Behavior |
| --- | --- |
| `0 <= age < F` | Deserialize and serve as an ordinary hit |
| `F <= age < M` | Record an `expired` miss, retain raw bytes, and call the source |
| `age >= M` | Record an `expired` miss and call the source with no candidate |
| Future timestamp, invalid frame, absent value, or watermark fence | Miss with no candidate |

A read error or timeout never enters recovery. A fresh frame that failed ordinary
deserialization is not reconsidered as a stale candidate.

If the source succeeds, normal refill rules apply; the retained candidate is not
deserialized. If the source rejects, DialCache calls the selected classifier. An
accepted rejection authorizes a recovery check, even when no candidate exists.

With a candidate, DialCache checks `0 <= age < M`, deserializes/decompresses lazily,
and checks the age again before returning. Crossing `M` during asynchronous
decoding prevents serving. A missing, expired, or undecodable candidate preserves
the **exact original source error**.

## Choose which errors permit recovery

The synchronous error classifier resolves in this order:

```text
operation classifier → instance classifier → native fallback-timeout error
```

An override replaces the lower policy. Include the timeout case yourself if an
application classifier should preserve it.

<LanguageContent language="typescript">

Use `shouldAttemptStaleRecovery` on the operation or instance. A common policy
accepts `error instanceof FallbackTimeoutError` plus a narrow application-defined
transient-error predicate such as `isRetriableDatabaseError(error)`.

</LanguageContent>

<LanguageContent language="go">

Use `Operation.ShouldRecover` or instance `WithStaleRecovery`. The predicate
accepts the source error; use native `errors.Is`/`errors.As` checks for the narrow
set of recoverable failures, including `FallbackTimeoutError` if desired.

</LanguageContent>

<LanguageContent language="rust">

Use the operation or builder's `should_recover` predicate. Match
`Error::FallbackTimeout` if preserving default timeout recovery, and inspect
application source errors for any additional transient failure cases.

</LanguageContent>

An application transient-error predicate should classify infrastructure failures
narrowly. Deny authoritative outcomes such as
permission or entitlement failures, revocation, deletion/not-found, validation,
and programmer errors. Use an operation override for data requiring a stricter
policy; a classifier that always returns false denies recovery for that operation.

The built-in policy also accepts a fallback-timeout error propagated from a
nested/source operation. It is not limited to the current wrapper's own timer.

A failing classifier denies recovery and preserves the original source error.
Disabled-scope calls never run the classifier. Registered readers capture it at
registration; inline operations capture it per invocation.

<LanguageContent language="typescript">

The classifier must return a synchronous boolean. Throws, thenables and
non-boolean values deny recovery and log the classifier failure; rejecting
thenables are consumed.

</LanguageContent>

<LanguageContent language="go">

The native predicate returns `(bool, error)`. A returned error or callback panic
is isolated and denies recovery; it does not replace the original source failure.

</LanguageContent>

<LanguageContent language="rust">

The native predicate returns a boolean. A callback panic is isolated and denies
recovery; it does not authorize a retained value.

</LanguageContent>

## Snapshot and invalidation boundaries

For a tracked key, the initial primary `MGET` applies the watermark that existed
with the value at read time. An invalidation completed before that read fences
the candidate. An invalidation completed afterward does **not** revoke bytes
already retained in the process.

The same snapshot behavior applies to concurrent refresh, deletion, expiry, and
eviction for tracked and untracked keys. A retained frame can still recover
until its return-time age reaches `M`, even after the Redis key disappears.
Opting tracked data into recovery therefore relaxes its usual freshness behavior
on authorized source-error paths. Leave recovery off when that is unsuitable.

A recovered value is not written to Redis, published process-locally, or used
to schedule shadow validation. If request-local caching is active, it is
memoized only in the current outer enabled scope.

## Retention, clocks, and memory

Writers request physical TTL `M` rather than `F`. Ordinary readers still enforce
logical `F`. Tracked values retain their separate one-hour physical cap: a
configured `M` above one hour remains the logical ceiling, but Redis may expire
the frame before a read can acquire it. Untracked retention is not capped at one
hour. Raising `M` does not resurrect or extend an existing Redis key.

Ages measure time since frame creation on the writer's application clock, not
the underlying data's own last-update time. Clock skew affects the comparisons;
see the [application clock contract](invalidation.md#application-clock-contract).

Earlier local layers retain their own lifetimes. A nearly expired Redis hit can
warm process-local storage with a full local TTL. For each invocation to make a
new remote frame-age check, disable both earlier layers and disable coalescing.
Otherwise, a follower can reuse the leader's earlier age check and snapshot.

Coalesced callers share one initial read, raw candidate, source attempt, and
recovery decision. With coalescing disabled, each caller retains its own bytes and
runs independently. Across distinct in-flight keys, delayed source calls can
retain substantial raw payload memory until they settle. Use application
admission controls and finite source budgets.

## Observability

Each classifier-authorized check emits one optional stale-recovery outcome:
`served`, `miss`, or `deserialization_error`. Only `served` additionally reports
value age, measured at actual return time. Classifier denial emits no recovery
outcome.

Recovery adds no ordinary Redis request, miss, or read-duration sequence; the
initial command is the single caller-serving read. Lazy deserialization and
compression observations still report their work. Source fallback duration and
error metrics still record the rejection even when recovery serves.

The optional metrics hooks do not gate recovery. See
[Observability](observability.md#stale-recovery-outcomes) for backend names.
Before enabling longer retention in an existing fleet, follow the
[readers-first upgrade](upgrading.md#stale-retention-and-downgrades).

# Upgrading

[Documentation](index.md) · [Maintainer guide](maintainers.md)

Check the installed version and the behavior being enabled before sharing a
Redis namespace across releases. A compatible frame layout does not by itself
make two implementations safe to run together.

This guide covers the transitions relevant to the implementation on `main`.
Use the [release notes](https://github.com/lan17/DialCache/releases) and matching
tagged source for the versions in your fleet.

## Tracked protocol cutover

The current protocol writes one complete client-stamped frame with native `SET`.
Older tracked writers used a placeholder and stamp script; those writers and
invalidators must not coexist with the new protocol in an active namespace.

Before enabling the new protocol:

1. Stop and drain every old writer and invalidator, including in-flight source
   fallbacks, shadow work, client queues, and operations that can still write.
2. Purge every tracked value, including complete frames and placeholders, and
   every watermark in the affected namespace.
3. Start the new fleet with its clock, buffer, and watermark-preservation
   requirements in place.

On a dedicated Redis deployment, an authorized full namespace purge is the
simplest option. Untracked complete frames may be retained. This is an external
operational procedure; DialCache does not implement a deployment gate or purge
API.

Alternatively, leave affected traffic disabled until all old tracked values
and watermarks expire. That is safe only when their maximum remaining lifetimes
are bounded, no watermark is persistent, and the wait covers both old value
retention and future-buffer-derived watermark retention.

Changing the namespace creates a cold boundary, but old and new namespaces also
have separate watermarks. Overlapping fleets need a coordinated invalidation
strategy; simply changing the string does not preserve mutable-data freshness.

The current cap of one hour for tracked values and watermark floor of two hours
are part of this protocol relationship. Raising the cap or shrinking the floor
requires another coordinated transition because old markers cannot be extended
by deploying new constants alone.

## Removed configuration fields

<LanguageContent language="typescript">

Remove these legacy properties entirely; construction rejects their own-property
presence even when the value is `undefined`:

| Older field | Replacement |
| --- | --- |
| `DialCacheConfig.urnPrefix`, `DialCacheKeyInit.urnPrefix` | `namespace` |
| `DialCacheConfig.rampSampler` | Built-in deterministic key-and-layer ramp assignment; no injected sampler |
| `DialCacheKeyConfig.shadowRamp` | `shadow.ramp` |
| `RedisConfig.keyPrefix` | The instance's `namespace` |
| `RedisConfig.createClient` | Create and connect the client in the application, then pass the semantic `client` |
| `RedisConfig.watermarkTtlSec` | Remove it; DialCache derives watermark retention |

See [Runtime validation](api.md#validation-and-snapshots) for how an
obsolete field in a provider result differs from invalid static configuration.

</LanguageContent>

<LanguageContent language="go">

Go's native option and policy types do not expose the legacy TypeScript names.
When sharing JSON configuration, migrate obsolete fields to the current shared
shape before rollout. See [configuration](configuration.md) for sparse overlays
and the [Go API](api.md) for validation errors.

</LanguageContent>

<LanguageContent language="rust">

Rust's native builders do not expose the legacy TypeScript names. When parsing
shared JSON configuration, migrate obsolete fields to the current shape before
rollout. See [configuration](configuration.md) and the [Rust API](api.md).

</LanguageContent>

<LanguageContent language="python">

Use current `Policy` snake_case fields or the accepted shared camelCase
mapping names. Legacy `shadowRamp` is rejected; migrate it to `shadow.ramp`.
See [configuration](configuration.md) and the [Python API](api.md).

</LanguageContent>

## Custom Redis adapters

A custom adapter must preserve complete-frame writes, classified primary reads,
logical timestamps and observed-fence refill suppression. A wire-compatible
payload alone does not establish that those behaviors match.

<LanguageContent language="typescript">

Migrate against the current [semantic interface](redis.md#custom-client-contract):

| Older surface | Current contract |
| --- | --- |
| Tracked placeholder and stamp helpers | `encodeRedisFrame` plus one complete-frame `SET` |
| Write request with `watermarkKey`; boolean outcome | `RedisWriteRequest` has no watermark field; `write()` returns void |
| `dialcacheRedisScripts`, `DialCacheNodeRedisScripts` | Removed; node-redis manages invalidation dispatch internally |
| `DialCacheRedisPlaceholderLostError` | Removed with the placeholder write path |
| `ClusterBatch` required by GLIDE runtime | No longer required; direct Cluster MGET routing |
| `null` or `RedisWatermarkMiss` typed misses | `RedisReadMiss { kind: "miss", reason, observedWatermarkMs? }` |
| `decodeRedisFrame`, `decodeTrackedRedisFrame` | `decodeRedisReadResult`, `decodeTrackedRedisReadResult` |

Use `isRedisReadMiss` from the root or protocol subpath to discriminate read
results. Runtime unknown results, including legacy null, become unclassified
misses and refill normally, but lose reason precision and observed-fence refill
suppression.

If an adapter returns a trustworthy `observedWatermarkMs`, it must honor a
supplied `RedisWriteRequest.createdAtMs` exactly. Direct callers may omit that
field; the adapter then samples real client time immediately before dispatch.
All decoded frames need their real writer timestamp. Constants that older
untracked adapters treated as informational fail current logical-age checks.

</LanguageContent>

<LanguageContent language="go">

Migrate against the native `Remote` interface and shared protocol helpers. A
tracked read must return the value and watermark from the same primary snapshot.
Use classified `ReadResult` misses, preserve an observed valid fence separately
from miss reason, and honor each write's application timestamp exactly. See
[custom-client contract](redis.md#custom-client-contract).

</LanguageContent>

<LanguageContent language="rust">

Migrate against `Remote` and its native request/result types. A tracked read
must return one primary snapshot; preserve observed fences on misses and honor
explicit write timestamps exactly. Use the public protocol helpers rather than
inventing alternate framing. See [custom-client contract](redis.md#custom-client-contract).

</LanguageContent>

<LanguageContent language="python">

Implement `dialcache.redis.RedisClient` with its request/result types. Return
one primary snapshot for tracked reads, preserve observed fences on misses,
and honor explicit write timestamps. Use `dialcache.protocol` helpers for wire
framing; see the [custom-client contract](redis.md#custom-client-contract).

</LanguageContent>

Invalidation is the only Lua script. It receives `[futureBufferMs,
invalidatedAtMs]`; reuse the second argument across retries of one logical
operation. See [Targeted invalidation](invalidation.md) for timing and retention.

## Stale retention and downgrades

Stale-on-error keeps the same frame keys and layout but can retain values
physically through `M` while ordinary reads enforce the shorter logical age
`F`.

Deploy readers that enforce `F` everywhere **before** enabling writers with
longer `M` retention. A pre-feature reader that trusts physical expiry can
otherwise serve retained data normally between `F` and `M`.

Once a key is written with physical `M`, do not reintroduce older readers until
all such keys expire or are explicitly removed. Turning recovery off on current
readers is safe because they still enforce `F`; it does not remove the older
readers' downgrade barrier.

A larger maximum age does not extend an existing Redis key. Tracked values
retain their one-hour physical cap, and a snapshot already retained by a process
can remain eligible within `M` after Redis expiry or invalidation.

## Compression and value schemas

Current readers always decode the compression envelope, even when new-write
compression is disabled. For string/JSON values, a readers-first deployment with
`compression: false`, followed by enabling compression after convergence, avoids
old readers encountering compressed values.

A reader without envelope support may fail `load` and refill a compressed value.
During an overlapping deployment, expect serialization failures and refill churn
unless the rollout prevents those reads. A permissive binary decoder can
misinterpret foreign bytes instead of rejecting them.

Legacy binary output can collide with envelope markers:

- A legacy `0x01`/`0x02` prefix whose remaining bytes are accepted by native zstd
  can be decoded as compressed data. Acceptance does not guarantee a complete
  valid stream; empty/truncated bodies or trailing bytes may also be accepted.
- A legacy payload beginning with `0x00` followed by `0x00`, `0x01`, or `0x02`
  can lose its first byte to the escape rule.
- New writers escape colliding raw binary prefixes even with compression off.

Version an identity dimension, such as the use case, when a custom binary
serializer can produce these collisions. A compression-off first phase alone
does not protect an old permissive reader from escaped binary values.

For application schema changes, native JSON validates syntax only. Keep values
compatible, use a serializer that validates and rejects old shapes, or move to
a new identity. Mutually incompatible validating readers can continually replace
each other's values while they overlap.

## Shadow mismatch warnings

`shadow.logMismatches` stays in every port, so no config needs a migration: a
config that sets it to `true` keeps logging every confirmed mismatch. Go and
Rust code that names the changed types needs the edits listed for that language
below.

`logMismatches` is now shorthand for
`shadow.mismatchLogging: { value: true, diff: "values" }` (`false` for both
leaves off), so its warnings also carry `cachedValueAgeSeconds`,
`mismatchPaths`, `mismatchPathCount`, and `diffJson`. The new fields derive from
the same native-JSON renderings as `cachedValueJson` and `sourceValueJson`, so
a member those renderings omit stays omitted. They are not cut at the 8 KiB
value cap, though: for a larger value, `mismatchPaths` and `diffJson` can log
differing fields past the point where `cachedValueJson` is clipped. Computing
them parses and walks both renderings in full, so each confirmed mismatch costs
more CPU time and memory, growing with the rendered size of the values and the
number of members they hold. A warning can carry up to about 40 KiB more field
bytes than before, counted before any escaping by the logger: 64 pointers of up
to 512 bytes and an 8 KiB `diffJson`.

To log only the previous fields plus `cachedValueAgeSeconds`, write
`mismatchLogging: { diff: "off" }` beside `logMismatches: true`. To log the
differing fields without values, replace `logMismatches` with
`mismatchLogging: { diff: "paths" }`: a leaf written beside
`logMismatches: true` leaves the other expanded leaf on, and a service still on
an earlier DialCache version reads only `logMismatches` from the same config.
See [Confirmed mismatch logging](shadow-validation.md#confirmed-mismatch-logging)
for how the shorthand and the leaves combine across config layers.

Each warning attempt also emits a new `shadowMismatchLogging` metric event. The
bundled Datadog adapters' `shadow_mismatch_logging.count` metric is their
longest name, which lowers the longest valid Datadog namespace from 175 to 170
characters.

<LanguageContent language="typescript">

`DialCacheKeyConfig.disabled()` now turns logging off with
`shadow.mismatchLogging: { value: false, diff: "off" }` in place of
`shadow.logMismatches: false`. On one Apple-silicon Mac, a 6.3 MB object of
150,000 members took about 0.12 seconds per warning at `diff: "paths"`, against
0.06 seconds for the value fields alone.

</LanguageContent>

<LanguageContent language="go">

`ShadowPolicy.LogMismatches` expands to `ShadowPolicy.MismatchLogging` with
`Value` true and `Diff` `MismatchDiffValues`. These changes break code that
names the old shapes:

- `ResolvedShadow.LogMismatches` is replaced by the effective leaves
  `ResolvedShadow.LogValue` and `ResolvedShadow.LogDiff`, and
  `LoggingConfigError` now covers every invalid leaf and shorthand. Unkeyed
  `ShadowPolicy` and `ResolvedShadow` literals no longer compile.
- `ShadowMismatchLogDetails`, `ShadowMismatchDetails` and
  `PreviewShadowLogJSON` are removed, since each value now renders once for
  every field; `PreviewShadowLogKey` and the `ShadowLog*` constants remain.
- `FailureIsolatedLogger` returns an already isolated logger unchanged, so a
  `Warn` panic stays observable as `logger_error`.
- Observers receive the new `shadowMismatchLogging` event kind, and the
  Prometheus adapter registers a twentieth collector,
  `dialcache_shadow_mismatch_logging_counter`.
- The default logger writes control characters, DEL, U+2028, U+2029 and bytes
  that are not UTF-8 as Go escape sequences in every line, so a line that held
  them before now reads differently.
- Mismatch-warning content, the `MismatchDiff` hook and the built-in walk now
  run while the shadow job still holds its capacity, so `WithShadowCapacity`
  bounds them and a slow hook shows up as `dropped` shadow jobs.

The value fields cost what they did before, since each side was already
rendered in full. On one Apple-silicon Mac, a 6.3 MB map of 150,000 members took
about 0.6 seconds per warning at `MismatchDiffPaths`, against about 0.5 seconds
for the value fields alone. Warning work now holds the job's shadow capacity
until it finishes, so while a slow `MismatchDiff` hook runs, jobs beyond
capacity report `dropped`.

The standard logger, used without `WithLogger`, now writes control characters,
U+2028 and U+2029 as escape sequences in every entry, so an entry that carried
a raw newline or terminal escape now stays on one line.

</LanguageContent>

<LanguageContent language="rust">

`log_mismatches: Some(true)` expands to
`mismatch_logging: Some(MismatchLogging { value: Some(true), diff: Some(MismatchDiff::Values) })`.
These changes break code that names the old shapes:

- `ShadowPolicy` gained `mismatch_logging`; add `..ShadowPolicy::default()` to
  struct literals. `Policy::disabled()` now sets `mismatch_logging` to
  `value: Some(false)` and `diff: Some(MismatchDiff::Off)` in place of
  `log_mismatches: Some(false)`.
- `ResolvedShadow::log_mismatches` is replaced by `mismatch_value` and
  `mismatch_diff`, with `logs_mismatches()`.
- `ShadowMismatchDetails` moved `cached_value_json` and `source_value_json`
  into its `values` group, gained `cached_value_age_seconds`, `diff` and
  `logging_outcome`, and no longer implements `Eq`.
- `Operation` gained `mismatch_diff` and a private field, so it can no longer
  be built with a struct literal; use `Operation::new` or
  `Operation::with_codec` and assign fields afterwards.
- `Event::ShadowMismatchLogging` and `MetricKind::ShadowMismatchLogging` are new
  variants, so exhaustive matches need an arm. `PrometheusObserver` registers
  twenty collectors, adding `dialcache_shadow_mismatch_logging_counter`.

Only an operation built with `Operation::new` or `register` and left with its
default `preview` feeds the built-in diff. A custom `preview` still replaces the
JSON in the value fields, and a `preview` set to `None` still logs no values,
but neither, nor a `with_codec` or `register_custom` operation, gets difference
fields without a `mismatch_diff` hook. Under `log_mismatches: Some(true)`, such
an operation's warnings carry the fields it cannot build as unavailable, with
`logging_outcome: render_error`, as they do for a `preview` that returns
`None`. Add a hook, or select only leaves the operation can build.

On one Apple-silicon Mac, a 6.3 MB map of 150,000 entries took about
0.09 seconds per warning at `MismatchDiff::Paths` in a release build, against
0.006 seconds for the value fields alone.

</LanguageContent>

<LanguageContent language="python">

`Policy.disabled()` now sets
`shadow={"ramp": 0, "mismatch_logging": {"value": False, "diff": "off"}}` in
place of `"log_mismatches": False`, and a policy merged from runtime overlays
carries the expanded `mismatch_logging` leaves rather than the shorthand.
`cachedValueJson` and `sourceValueJson` now escape lone surrogates as `\uXXXX`,
as `JsonSerializer` does. On one Apple-silicon Mac, a 6.3 MB dict of 150,000
members took about 0.18 seconds per warning at `"paths"`, on the event loop,
against 0.04 seconds for the value fields alone.

</LanguageContent>

## Metric migrations

Miss metrics carry a required bounded `reason`: `value_absent`, `expired`,
`watermark_fenced`, or `unclassified`. Old Prometheus collectors with four miss
labels cannot share the same in-process registry/prefix with a current
five-label collector. Rust callers should clone their existing compatible
observer instead of registering the same names a second time. The future-offset histogram also uses dedicated clock-skew
buckets; an incompatible same-name collector fails adapter construction before
partial registration. Use a separate registry or prefix where needed.

During a mixed-fleet rollout, aggregate away `reason` when comparing total misses
with total requests. For example:

```text
sum by (cache_namespace, use_case, key_type, layer) (
  rate(dialcache_miss_counter[5m])
)
/
sum by (cache_namespace, use_case, key_type, layer) (
  rate(dialcache_request_counter[5m])
)
```

Reason dashboards should group explicitly by `reason`. In Datadog, the extra
tag increases miss-series combinations by up to four per prior tuple; account
for overlapping old/new tag sets and the selected metric aggregations.

<LanguageContent language="typescript">

Update exhaustive public-union mappings: `tracked_ttl_clamped` is a
`MetricErrorKind`; `fill_blocked` is removed and `fill_fenced` is a
`ShadowValidationOutcome`. Recovery has `served`, `miss`, and
`deserialization_error` outcomes. Custom `miss` handlers now receive
`MissMetricLabels`; broader handlers may ignore the additional reason, while
exact label mappings and direct calls need to include it. The optional
`shadowMismatchLogging` hook reports a `ShadowMismatchLoggingOutcome`: `logged`,
`hook_error`, `render_error`, or `logger_error`.

</LanguageContent>

<LanguageContent language="go">

Update exhaustive event/outcome handling when the shared metric catalogue gains
a variant. `tracked_ttl_clamped`, shadow `fill_fenced`, and recovery `served`,
`miss`, `deserialization_error` must retain their shared meaning and bounded
labels. The `shadowMismatchLogging` event kind reports `logged`, `hook_error`,
`render_error`, or `logger_error`. Native Go adapter contracts are in the
[API reference](api.md).

</LanguageContent>

<LanguageContent language="rust">

Update exhaustive matches over public events, metric kinds and outcomes when
upgrading. Preserve the shared `tracked_ttl_clamped`, `fill_fenced` and recovery
outcomes, names and units. The `ShadowMismatchLogging` event reports a
`ShadowMismatchLoggingOutcome`: `logged`, `hook_error`, `render_error`, or
`logger_error`. Native types are in the [API reference](api.md).

</LanguageContent>

<LanguageContent language="python">

Update event dictionary handling for new outcomes, labels and events, such as
`shadowMismatchLogging` with its `logged`, `hook_error`, `render_error` and
`logger_error` outcomes. Preserve `tracked_ttl_clamped`, `fill_fenced` and
recovery outcomes with their shared units. See the [Python API](api.md).

</LanguageContent>

See [Observability](observability.md) for current names, units, and hooks.

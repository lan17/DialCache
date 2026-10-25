# Source update age on shadow mismatch

- **Status:** Proposed
- **Issue:** none; requested in a maintainer session
- **Pull requests:** none yet
- **Baseline:** `main` at `b4e4fba3d979e3b70f569b576062d2bfd892075c`
- **Supersedes:** none

## Context

Shadow validation already reports the age of the cached frame in seconds. A
confirmed mismatch says that its contents differ from the source; the frame's
creation time does not say when the source changed. An invalidation watermark
cannot supply that missing time when the invalidation itself was missed.

Some applications already receive a meaningful update timestamp with the source
value. Let them supply that timestamp for a confirmed mismatch without changing
stored frames, fetching more data, or changing equality decisions. The library
cannot infer which field or entity change explains a mismatch.

## Proposal

Keep existing boolean comparators and add one optional synchronous timestamp
extractor to the operation's existing options. It receives the same cached and
source snapshots used for comparison and returns epoch milliseconds or absence.

| Port | Proposed API shape |
| --- | --- |
| TypeScript | `shadowSourceUpdatedAtMs?: (cached: T, source: T) => number \| undefined` |
| Go | `ShadowSourceUpdatedAtMS func(cached, source T) (int64, bool)`; `false` means absent |
| Rust | `shadow_source_updated_at_ms: Option<Arc<dyn Fn(&T, &T) -> Option<u64> + Send + Sync>>`, with an operation builder setter |
| Python | `shadow_source_updated_at_ms: Callable[[T, T], int \| None] \| None` |

For example, an application comparing a document's contents can return the
source document's `contentUpdatedAtMs` when that field dates the relevant change.
For a list with ambiguous changes or a deletion without a timestamp, it can
return absence. DialCache does not select a minimum or maximum list timestamp.

After an unequal comparison, the existing confirmation read must still find the
same payload. Capture one verdict wall-clock time after successful confirmation
and its deadline check, before diagnostic callbacks:

```text
source_update_age_seconds = (verdict_time_ms - source_updated_at_ms) / 1000
cache_value_age_seconds   = max(0, verdict_time_ms - original_created_at_ms) / 1000
```

Invoke the extractor only after the outer deadline wrapper accepts terminal
`mismatch`; confirmation that loses the final deadline race must not invoke it.
It cannot change the verdict, cause a new source or Redis read, or make a late
result into a mismatch. Retain the compared values for this opt-in even when
mismatch logging is disabled. Existing matches still emit their cache age;
they do not call the extractor or emit source update age.

A valid timestamp is a nonnegative integer representable exactly across ports
(at most `2^53 - 1` milliseconds) and no later than the frozen verdict time. An
absent callback/result, invalid or future timestamp, or callback failure omits
only the new sample. Do not substitute zero. A source timestamp may precede
cache creation: stale source data can have been cached after a source update.
Do not cap the new age to the cache age.

Use the existing post-deadline diagnostic stage; emit the mismatch count and
cache age before extraction. Reuse existing cleanup and add no asynchronous work
ownership. Catch ordinary callback exceptions/recoverable panics and isolate
the new metric observer's failures so they preserve the mismatch, existing age,
and warning eligibility. Unexpected asynchronous results are invalid and are
never awaited; use the port's native best-effort rejection/cleanup handling.
The callback contract is synchronous, bounded, deterministic, non-mutating and
free of I/O. This does not promise to preempt application code that blocks a
thread or event loop. Callback or observer clock changes cannot alter either
age computed from the frozen verdict time.

Add an optional backend-neutral observation hook, named
`observeShadowSourceUpdateAge(labels, seconds)` in TypeScript and following each
other port's existing metric conventions. Add no required adapter method;
Rust's exhaustive enum matches still have the compatibility cost noted below.
Built-in adapters emit:

- Datadog: `dialcache.shadow.source_update_age`, in seconds.
- Prometheus: `dialcache_shadow_source_update_age_histogram`, in seconds, using
  existing value-age buckets.

Reuse shadow labels `cache_namespace`, `use_case`, `key_type`, `outcome` with
`outcome=mismatch`. Preserve existing admission, sampling and capacity controls;
add no rollout setting or missing-timestamp counter. Sample counts reflect only
confirmed mismatches for which the application supplied usable timestamps.

This measures **age since the reported source update**, not necessarily how long
the cached value has continuously been wrong. If cache A misses an A-to-B change
nine minutes ago and a B-to-C change one minute ago, reporting C's update time
produces one minute. It cannot recover the first missed change. Application
timestamp meaning and cross-process clock skew limit the interpretation.

## Out of scope

- Source-field discovery, list aggregation, and consumer-specific timestamp
  selection. Add a consumer integration when its timestamp semantics are known.
- Watermark-based inference, historical change tracking, storage/wire changes,
  extra I/O, or repairing mismatches. None is needed to observe an existing
  source timestamp; revisit only if a supported use case lacks that information.
- Shared comparison/diagnostic result objects or a generic metadata framework.
  Reconsider only if a concrete extractor must repeat expensive comparison work.

## Contract and model changes

Extend C57's shadow-age diagnostics and the corresponding rule in
`formal/guides/SPEC.md` with the new mismatch-only observation, timestamp
validation, frozen verdict time, and failure isolation. Preserve C50/C51's
boolean comparison and confirmation semantics, C54's deadline/capacity rules,
and C60's warning eligibility. No critical serving or wire rule changes.

Extend `formal/models/kernel/shadow.qnt` and the existing
`dialcache-shadow-conformance` profile, rather than adding a profile or callback
framework. Model timestamp availability/validity and observable ages; replay the
same generated witnesses and exported regressions in all four ports. Fixed
served-hit scenarios complement the generated dark-shadow profile. Cover:

1. Creation at 9000 ms, source update at 12000 ms, verdict at 15000 ms yields
   cache age 6 s and source update age 3 s.
2. Match, superseded, confirmation error and timeout never invoke the extractor
   or emit the new observation.
3. Absent, invalid, future or failing extraction preserves the mismatch, cache
   age and warning eligibility, and omits the new observation.
4. Diagnostic callbacks advancing the wall clock cannot change either age;
   observer failures cannot suppress the other diagnostics.
5. A valid source timestamp before cache creation is accepted; a timestamp equal
   to verdict time emits zero, distinguishable from an omitted sample.

Language-specific callback typing, exceptions/panics, unexpected async values,
package exports and exact adapter schemas/units stay native boundary tests.
Update existing profile observations, drivers and evidence catalogs only as
needed for these consequences; generate fixtures through the existing tools.

## Decisions

### D1. How does the application supply the timestamp?

- **Choice:** One optional extractor beside the unchanged boolean comparator,
  in all four ports, using the API shapes above. Accept the Go and Rust source
  compatibility costs described under Impact.
- **Status:** Open
- **Rejected:**
  - A boolean-or-structured comparator result: changing Go/Rust comparator
    signatures breaks existing callers, while parallel comparator forms add
    precedence rules. Reading an existing timestamp needs neither.
  - Automatic `updated_at` discovery or list aggregation: field names do not
    establish whether a timestamp explains the compared difference.

### D2. What does the metric mean, and how do failures behave?

- **Choice:** Seconds since the application's source update at confirmed
  mismatch verdict, with the validation and diagnostic isolation above. Keep
  existing cache age; omit unavailable or invalid source ages.
- **Status:** Open
- **Rejected:**
  - Calling it continuous stale duration: the latest update can be later than
    the first change the cached value missed.
  - Watermark minus creation time, zero for unknown, or clamping to cache age:
    these would report evidence the supplied source timestamp does not support.
  - Invoking the extractor during comparison or before confirmation: it would
    do unnecessary diagnostic work for errors, timeouts and superseded values.

### D3. What is the implementation scope?

- **Choice:** Extend the existing shadow contract/model and all four ports,
  their built-in metrics adapters, shared guide and executed examples in this
  PR. Use existing admission controls and conformance infrastructure.
- **Status:** Open
- **Rejected:**
  - TypeScript-only behavior: this public portable diagnostic must have the
    same meaning in every supported port.
  - New protocol, storage or diagnostic framework: the current operation,
    retained values and adapter boundary already carry everything required.

## Impact

Operation options/builders, shadow verdict diagnostics and metric adapters
change in TypeScript, Go, Rust and Python. Existing comparator signatures remain
valid; no new adapter method is required.

Rust's public `Operation<T>` is an exhaustive struct: adding the optional field
breaks exhaustive struct literals even though constructors/builders keep
working. Document adding `shadow_source_updated_at_ms: None` in `docs/upgrading.md`
and mark the feature as breaking. New variants in Rust's exhaustive public
`Event` and `MetricKind` enums require downstream exhaustive matches to add an
arm. Go's unkeyed `Operation[T]` literals need the additional field (keyed
literals can omit it). Document and test these boundaries; do not redesign
operation construction or observability to avoid them.

Update `docs/shadow-validation.md`, `docs/api.md`, `docs/observability.md`, native
examples, package API checks, formal contracts/profile drivers and relevant
catalogs/ledger pins. No consumer rollout or dashboard change is part of this
library record.

## Plan

1. Push this proposed record as the first commit of a draft feature PR. Keep
   every decision Open until the maintainer confirms it.
2. After acceptance, update the existing contracts and Quint model first;
   export consequential regressions/witnesses, then implement TypeScript and
   replay the same histories in Go, Rust and Python.
3. Update adapters, guides, examples, package checks, catalogs and upgrade
   notes. Validate native boundaries, all-port integration and wire tests, PR
   CI, and Full on the final candidate before leaving draft. Map applicable
   challenges to TypeScript/Go/Rust mutants; name Python's missing mutation
   campaign as an existing coverage gap.

The feature is based on current `main` and does not depend on open
[#242](https://github.com/lan17/DialCache/pull/242)
(mismatch-path logging), which overlaps shadow diagnostics and adapters. If it
lands first, rebase and reconcile those paths while preserving this record's
decisions. [#105](https://github.com/lan17/DialCache/pull/105)'s boolean-comparator
contract remains intact.

## Deviations

None.

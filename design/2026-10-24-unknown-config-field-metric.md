# Report unknown runtime config fields without changing caching

- **Status:** Proposed
- **Issue:** none
- **Pull requests:** #244
- **Baseline:** `main` at `b4e4fba`, the commit the record was written against
- **Supersedes:** none. It restates the unknown-field rule of #138, which never
  merged, as a change of its own. #242's D14 keeps its choice: that pull
  request adds no unknown-field reporting. Only D14's reason, a planned strict
  record, no longer holds.

## Context

A key config tells DialCache which layers serve a call and how. A use case's
static `defaultConfig` sets the baseline, and the `cacheConfigProvider` may
return a sparse overlay for each call. On `main` every port reads the merged
result one field at a time, and each kind of bad input has its own narrow
consequence:

| Input | Consequence on `main` | Signal |
| --- | --- | --- |
| Invalid TTL or serving ramp | That layer is skipped; other valid layers serve | `disabled{invalid_ttl \| invalid_ramp}` and `config_resolution` on the layer |
| Invalid `staleOnErrorMaxAgeSec`, or a positive age not above the remote TTL | Recovery is off; ordinary Redis serving continues | `config_resolution` on `remote` |
| Invalid `shadow.ramp` | No shadow work; serving continues | `config_resolution` on `remote` |
| Non-boolean `shadow.logMismatches` | Logging is off; shadow work continues | `config_resolution` on `remote`, once the job is admitted |
| Malformed shape: a non-object config, layer map or shadow group; a bad `requestLocal`, `coalesce` or `remoteReadTimeoutMs`; the removed `shadowRamp` | The whole call runs uncached | `config_resolution` and `disabled{config_error}` on `noop` |
| A field DialCache does not know | Ignored | None |

The last row is the gap. A misspelled field has no effect and leaves no
trace. `ramp: { remtoe: 0 }`, written as an emergency switch to stop Redis
serving, keeps Redis serving, and nothing tells the operator why. Review of
#138 found the same case for its logging group on 2026-08-15: a runtime
`{ vaule: false }` over a baseline `{ value: true }` kept full values in
logs. Every other bad input already records `config_resolution` whenever the
call reads it.

On 2026-10-24, in the #242 session, the maintainer first asked for strict
validation: any unknown field, wrong type or out-of-range value would reject
the whole config, record an error metric and run the call uncached. #242
dropped its `config_unknown_field` prototype for that reason (its D14). The
same day, in this record's session, he chose instrumentation instead: "same as
main behavior, just instrument". D1 records that choice and the strict design
it replaces.

What each port can see today:

- **TypeScript.** The `DialCacheKeyConfig` constructor copies only known
  top-level fields and drops the rest. It shallow-copies layer maps and the
  shadow group, so it keeps their unknown keys. A provider may also return a
  plain object, which reaches the merge unchanged.
- **Go.** The typed `Policy` and `*PolicyOverlay` cannot carry an unknown
  field. `JSONPolicy` (a `map[string]any`) and `RawPolicy(any)` can, and the
  resolver ignores their unknown members. `ParsePolicy` ignores unknown
  members of a static JSON policy.
- **Rust.** The typed `Policy` cannot carry one. `RuntimePolicy(Value)` wraps
  any JSON and the resolver ignores unknown members. `Policy::from_json`
  ignores unknown members of a static JSON policy.
- **Python.** `Policy(...)` raises `TypeError` on an unknown keyword, and its
  `__post_init__` strips unknown layer and shadow keys. `normalize_policy`
  drops unknown top-level keys of a mapping reply. When a mapping carries both
  spellings of one field (`ttl_sec` and `ttlSec`), the snake_case value wins
  and the other is dropped silently.

## Proposal

In runtime config, unknown fields stay ignored, and invalid values keep every
consequence in the table above. The one runtime change is a diagnostic. When a
provider reply carries one or more own fields DialCache does not know,
DialCache records one `error` metric event with the new kind
`config_unknown_field` on the `noop` layer, with `inFallback: false`, and the
call proceeds exactly as it would without those fields. A warning log names
the unknown field paths, such as `ramp.remtoe`. Field names never become
metric labels.

A static default is code the service owns. One that carries an unknown field
throws where an invalid static value throws today: at `cached()`
registration, or on each `getOrLoad()` invocation (D6).

```ts
// Provider reply over a default with both TTLs set:
{ ttlSec: { remote: 300 }, ramp: { remtoe: 0 } }
// Caching: identical to { ttlSec: { remote: 300 } }.
// Metrics: error{layer: "noop", error: "config_unknown_field", inFallback: false}, once for this call.
// Log: one warning naming "ramp.remtoe" (D3 bounds repeats).
```

D2 defines which names count as unknown, D4 when the event fires, and D5 how
constructors that drop fields keep the answer. A
reply that fails resolution as a whole keeps `main`'s `config_resolution` and
`disabled{config_error}` and records no unknown-field event (D4). The check
runs before traversal, so unlike value validation it does not depend on which
layer a call reaches. On the hot path it costs at most one size comparison
per map, and nothing for typed configs (D9).

## Out of scope

- Strict validation, rejected in D1. Reopen with evidence that operators
  would rather lose caching for a call than serve with a config DialCache
  partly ignored.
- Reporting invalid leaves that traversal never reads, such as a bad remote
  TTL behind a local hit. Those values record `config_resolution` on every
  call that reads them. Reporting them on every call needs a full validation
  pass per call. Reopen if an incident traces to a bad leaf that stayed hidden
  behind hits.
- "Did you mean" suggestions. They belong in the warning text if anywhere,
  and none of the ports has a shared rule for them.
- Failing closed when shadow policy is enabled without a shadow observer
  (#151). It is independent of this change.

## Contract and model changes

Existing contracts keep their text. C16, C20 and C21 still state every
consequence of an invalid value, and no fixed scenario, exported regression,
witness or mutant that encodes them changes outcome.

- **New obligation** (ID assigned when CONTRACTS.md assigns one, expected
  C61): an unknown field in a runtime config is ignored. The call resolves,
  traverses, publishes, shadows and recovers as it would for the same reply
  without the field. A reply that resolves and carries one or more unknown
  fields records one `config_unknown_field` diagnostic on `noop`. A reply
  that fails as a whole records none. A static default with an unknown field
  throws where an invalid static value throws (D6). That is a binding
  obligation, beside registration validation (CONTRACTS.md "Applying the
  distinction"). Replay sees a static default only as the fixture's valid
  policy, so the rule is a native test in each port.
- **SPEC.md** policy table gains a row: unknown field, ignored at every level;
  a resolved reply carrying one records one `config_unknown_field` diagnostic.
- **Quint, policy profile.** `kernel/policy-overlay.qnt` appends overlay
  codes after 25, since 0 to 25 are the drivers' contract and are never
  renumbered. Each new code is an existing reply plus unknown fields, and
  `base()` maps it to that reply:
  - 26: `{ ramp: { remtoe: 0 } }`, the kill-switch typo. It resolves as
    code 0, so both layers serve.
  - 27: `{ ttlSec: { local: 2 }, enabled: false }`. It resolves as code 1;
    recognized fields still apply.
  - 28: `{ shadow: { logMismatch: true } }`. It resolves as code 0.
  - 29: `{ ramp: { local: 101 }, enabled: false }`. It resolves as code 21:
    the per-leaf consequence and the report are independent.
  - 30: `{ remoteReadTimeoutMs: 0, enabled: false }`. It resolves as
    code 20, the whole-call failure, and records no unknown-field event.

  `kernel/config-errors.qnt` gains
  `CONFIG_UNKNOWN_FIELD = { layer: "noop", errorType: "config_unknown_field" }`,
  appended at release when the reply resolved and carries unknown fields.
  Planned invariants:
  - `unknownFieldsChangeOnlyDiagnostics`: each code from 26 to 30 resolves
    its TTLs, retention and coalescing exactly as its base code does.
  - `policyResolutionErrorsHaveStableClassification`, extended: noop errors
    are `config_resolution` for failed replies and `config_unknown_field` for
    resolved replies with unknown fields, and nothing else.

  Planned runs and witnesses: `policy/unknown-layer-key-keeps-serving`
  (code 26) and `policy/unknown-field-after-whole-call-failure-is-silent`
  (code 30). The choice domain grows, so the profile's histories from fixed
  seeds change, and the policy model bumps `differential.behaviorVersion`.
  That makes `make differential` skip the profile. Unchanged behavior for
  codes 0 to 25 is shown instead by their exported regressions and fixed
  scenarios, which replay unchanged in all four ports, and by
  `unknownFieldsChangeOnlyDiagnostics`.
- **Replay coordinator.** `formal/replay/features.mjs` appends the five
  overlays to `policyOverlays`, and its `policyErrorIO` projection and
  `policyErrors` parser accept `config_unknown_field` on `noop` beside
  `config_resolution`. The shadow-family `configErrors` projections select
  `config_resolution` on `remote` only, so they and their profiles stay
  unchanged. No driver changes. All four already pass the raw overlay
  (TypeScript through `new DialCacheKeyConfig`, which exercises D5's stamp;
  Go `RawPolicy`; Rust `RuntimePolicy::from_json`; Python a mapping) and
  record every metric event.
- **Mutants**, in `mutations.json` (TypeScript and Go) and
  `rust-mutations.json`, mapped to the new obligation:
  - drop the report;
  - report a reply that failed as a whole;
  - report unknown fields as `config_resolution`.

  Python has no mutation catalog, so the gap stays named.
- **AGENTS.md Critical behavior** gains a bullet: "Unknown runtime config
  fields never change caching; each enabled call whose resolved provider reply
  carries one records one `config_unknown_field` diagnostic. A static default
  with an unknown field throws where an invalid static value throws."

## Decisions

### D1. Keep `main`'s fail-open rules and add reporting, instead of strict validation

- **Choice:** for runtime config, keep every consequence `main` has for
  invalid values and keep ignoring unknown fields, and record a diagnostic for
  unknown fields. No provider reply that caches on `main` stops caching.
  Static defaults are D6's question.
- **Status:** Confirmed 2026-10-24, in session: "instead of doing strict, can
  we just add instrumentaiton so that if we do get incorrect field we emit
  some metric instead of failing and not caching? SO same as main behavior,
  just instrument"
- **Rejected:**
  - Strict validation, proposed 2026-10-24 in #242's session. Any unknown
    field, wrong type or out-of-range value anywhere in a provider result
    would reject the whole config, record `config_resolution` and run the call
    uncached, without shadow or stale recovery. Static defaults with any such
    fault would throw at registration, and each validated config would be
    remembered by object identity. The maintainer rejected it on 2026-10-24.
    This record's reasons against it:
    - A typo would send every call for the use case to the source.
    - A field that only a newer release knows would disable caching on every
      older reader of a shared config store, so new fields could only be
      written after the whole fleet upgraded.
    - It reverses the per-leaf rule of #68 and #102, under which "an invalid
      leaf does not disable request-local caching or another independently
      valid shared layer".
    - Remembering configs by identity has no portable form: the Rust provider
      returns owned values, Go's `JSONPolicy` maps cannot key a map, and
      Python dicts cannot be weakly referenced.
  - Silent ignoring, as on `main`. A misspelled kill switch keeps serving
    with no signal at all.

### D2. Which fields count as unknown

- **Choice:** an own field whose name the config shape does not define, at
  each level DialCache reads:
  - top-level key-config fields;
  - keys of `ttlSec` and `ramp` other than `local` and `remote`;
  - keys of `shadow`;
  - keys of `shadow.mismatchLogging`, once #242 adds that group.

  A present key counts whatever its value, including `undefined` in TypeScript
  and `null` in JSON. Values of known fields are not inspected for this rule;
  they keep `config_resolution`. The removed `shadowRamp` keeps its whole-call
  failure and is not also reported. In Python, the dropped spelling of a field
  supplied under both names counts as unknown, because it has no effect, just
  like a misspelling. Typed configs that cannot represent an unknown field
  (Go `Policy` and `*PolicyOverlay`, Rust `Policy`) never report one.
- **Status:** Open
- **Rejected:**
  - Reporting invalid values under the same signal. They already record
    `config_resolution` wherever they act, and folding them in would make the
    new kind mean two things.
  - Top-level fields only. The kill-switch typo in Context sits in a layer map,
    and #138's sits in a nested group.

### D3. The signal: a new error kind, plus a bounded warning

- **Choice:** the `error` metric with `error: config_unknown_field`,
  `layer: noop` and `inFallback: false`, the shape #138 and #242 prototyped.
  Exporters publish it as one more value of their existing error label, so no
  adapter gains a hook. Each port also logs one warning that names the use
  case, the key type and up to eight unknown field paths, each truncated to
  64 characters. To bound log volume, an instance logs again for a use case
  only when that use case's set of unknown paths changes. The log is a binding
  detail (the logger backend is X01); the metric is portable.
- **Status:** Open
- **Rejected:**
  - Reusing `config_resolution`. That kind means a value was invalid and a
    layer, recovery, shadow work or logging acted off. Adding unknown fields
    to it would fire existing `config_resolution` alerts for configs that
    cache normally, and would hide which of the two problems an operator
    faces.
  - A dedicated counter with a field-name label. Field names come from config
    data, so the label would be unbounded, and every adapter, custom ones
    included, would need a new hook.
  - A `disabled` reason. Nothing is disabled.
  - A warning on every affected call. One stale config would write a log line
    per call.
  - No warning, as the prototypes did. The metric says only that something in
    a use case's config is unknown; the operator still has to find the name.

### D4. When the event fires

- **Choice:** whenever a call reads runtime config. Every enabled invocation
  whose provider reply carries an unknown field records one event, after the
  provider settles and the merge succeeds, before any cache read and before
  joining a flight.
  - Config resolves once per invocation (C18), so each coalesced follower
    reports its own reply.
  - One event per call, however many unknown fields the reply carries.
  - Disabled calls read no config and report nothing (C01).
  - A reply that fails resolution as a whole records only `main`'s
    `config_resolution` and `disabled{config_error}`. A TypeScript provider
    that builds `new DialCacheKeyConfig(parsedJson)` from a malformed reply
    throws before DialCache sees the input, so this is the only rule all four
    ports can agree on.
  - Static defaults never report, because an unknown field in one throws
    (D6).

  D9 keeps the check itself off the hot path.
- **Status:** Open. The maintainer asked in session for "whenever the config
  is read"; the whole-call-failure exception still needs his confirmation.
- **Rejected:**
  - Once per distinct config object. It has no portable identity (D1), and a
    count of objects is not a rate an operator can compare with call volume.
  - Once per use case per process. The metric would fall to zero while the
    typo is still in the config, and alerts would clear early.
  - Recording the event for a reply that also fails as a whole. Go, Rust and
    Python could scan a raw reply before failing it, but a TypeScript
    constructor that throws inside the provider leaves nothing to scan, so the
    ports would disagree on the same reply.

### D5. Configs whose constructor drops unknown fields

- **Choice:** a constructor that drops unknown input fields records on the
  instance whether its input had any. Resolution reports a marked provider
  reply as it would report the raw input (D4), and static-default capture
  throws for a marked default (D6).
  - TypeScript: `new DialCacheKeyConfig(input)` marks the instance with a
    module-private stamp, kept off enumeration and out of the public class
    type, as #242's prototype did before ed80bbe removed it.
  - Python: `Policy(...)` and `normalize_policy` keep the answer in a private
    field excluded from equality and `repr`.
  - Configs DialCache assembles itself (merges, `enabled()`, `disabled()`) are
    marked clean.
- **Status:** Open
- **Rejected:**
  - Throwing from the constructor on an unknown field. The common provider
    pattern `new DialCacheKeyConfig(parsedJson)` would then fail the whole call
    through the provider-error path, the strict consequence D1 rejected.
    Python's `TypeError` for an unknown keyword argument stays, because that
    is the language's call rule for code, not a config reply.
  - Reporting only raw objects. The constructor would hide exactly the typos
    this change targets.

### D6. Static defaults with unknown fields

- **Choice:** fail closed. A static default that carries an unknown field
  (D2) throws, and the exception propagates to the caller, at the point
  where an invalid static value throws today:
  - `cached()` throws at registration, so the use case is never registered,
    as for an invalid TTL in a default.
  - `getOrLoad()` throws on each invocation. As for an invalid inline default
    today, this happens even outside an enabled scope, because TypeScript
    and Python validate the default before checking enablement.
  - Python's `validate_static_policy` raises `ConfigError`.
  - Go's `ParsePolicy` and Rust's `Policy::from_json` return their existing
    invalid-policy error, naming the first unknown member, as they already do
    for `shadowRamp`.
  - Go's typed `Policy` and Rust's typed `Policy` cannot carry an unknown
    field, so nothing else changes in those ports.

  Static defaults therefore never report `config_unknown_field`; only provider
  replies do (D4).
- **Status:** Confirmed 2026-10-25, in session: "an issue with cached default
  shoudl also fail close,d that is throw and let exception propagate up right"
- **Rejected:**
  - Reporting instead of throwing, recommended in this record's first draft:
    one event at `cached()` registration and one per enabled `getOrLoad()`
    call. Rejected 2026-10-25. A static default is code the service owns, so
    failing at registration surfaces the typo in tests or at startup, before
    any traffic, as an invalid static value already does. A registration-time
    event would be one blip that an alert misses. The cost is accepted: a
    default loaded from a shared JSON file that carries a field only a newer
    release knows now stops an older service at startup.
  - Leaving `ParsePolicy` and `Policy::from_json` ignoring unknown members. A Go
    or Rust static policy loaded from JSON would keep its typos invisible.

### D7. How conformance establishes it

- **Choice:** a portable obligation with Quint and replay evidence in the
  existing policy profile, as Contract and model changes describes. The
  validation tier is Full, because a Quint transition, an invariant and the
  mutation catalogs change.
- **Status:** Open
- **Rejected:**
  - Native tests only, as a binding obligation, at the PR CI and Replay tiers.
    It is cheaper, but the cadence rules in D4 (per invocation, before
    flights, followers included, nothing after a whole-call failure) are the
    kind of rule where ports drift. The port inventory for this record found,
    by reading code without a test, that Go and Rust appear to record the
    stale-age `config_resolution` only in the coalescing leader, while
    TypeScript and Python record it for every caller.
  - A new profile only for unknown fields. It would avoid the
    `behaviorVersion` bump, but it would duplicate the policy fixture and
    overlay decoder that the policy profile already owns.

### D8. Rollout

- **Choice:** a breaking release with a `BREAKING CHANGE:` paragraph and a
  `docs/upgrading.md` entry covering three effects:
  - **Static defaults (D6).** A default with an unknown field that registers
    on `main` throws after the upgrade, in every port. Such a default can come
    from a cast object or a JSON file in TypeScript, a mapping with extra keys
    or both spellings in Python, or `ParsePolicy` or `Policy::from_json` input
    in Go and Rust. The note tells teams to run their tests or start the
    service on the new version before deploying, so the error appears there
    first.
  - **Provider replies.** Nothing starts failing, so no warn-only period is
    needed. Replies that already carry unknown fields start recording
    `config_unknown_field`, and an alert on total DialCache errors can fire on
    the first deploy. The note tells operators to route the new kind to a
    warning-level alert before upgrading, then fix the fields it names.
  - **Rust's `ErrorKind`.** The enum is exhaustive, so a new variant breaks
    exhaustive matches in Rust callers. The same pull request marks
    `ErrorKind` and `DisabledReason` `#[non_exhaustive]`, so later kinds are
    additive.
- **Status:** Open
- **Rejected:**
  - Adding the Rust variant without `#[non_exhaustive]`. Every later error kind
    would be another breaking change.
  - No upgrade note. The first deploy would page whoever alerts on error
    totals, or stop a service whose default carries a typo, without saying
    why.

### D9. Keep the unknown-field check off the hot path

- **Choice:** no per-call key walk. Where a config can carry an unknown field
  at all, the answer comes from construction or from one integer comparison
  per map. Only a config that does carry one pays for naming its paths.
  - **Typed configs never check.** Go's `Policy` and `*PolicyOverlay` and
    Rust's typed `Policy` cannot hold an unknown field.
  - **Constructed configs are checked once, at construction.** A TypeScript
    `DialCacheKeyConfig` and a Python `Policy` keep the stamp or marker that
    D5 adds, so a provider that returns a cached instance pays one field read
    per call.
  - **Raw replies get a size comparison.** These are Go `JSONPolicy` and
    `RawPolicy`, Rust `RuntimePolicy`, and Python mappings. The merge already
    looks up every known key at each level: the top level, `ttlSec`, `ramp`,
    `shadow` and, after #242, `mismatchLogging`. It compares each map's size
    with the number of known keys it found, an O(1) `len` in each of those
    languages. A Python mapping counts both spellings it found.
  - **TypeScript plain objects are remembered by identity.** Counting a plain
    object's own keys allocates, so the answer is kept in a `WeakMap` keyed by
    the object, and a provider that returns the same object pays one lookup
    per call. Remembering by identity is safe here, unlike the strict design's
    memo (D1), because the answer drives only a diagnostic. An object mutated
    after its first check can misreport, but it can never change caching.
  - **Static defaults are checked once,** at `cached()` registration, or in
    the validation `getOrLoad()` already runs on each invocation (D6).
  - **Naming the paths is the slow path.** Only when a check fires does the
    port walk the reply to collect the paths that D3's warning names.
- **Status:** Open. The maintainer asked in session to "avoid checking for
  unknown in most places if we dont have to"; the mechanism is this record's
  proposal.
- **Rejected:**
  - A full key walk on every call. It is simple, but it adds string
    comparisons, and in TypeScript array allocations, to every enabled call,
    for a condition that is almost always false.
  - Checking only static defaults and constructed configs, and skipping raw
    replies. The raw form is how a config service's reply usually arrives (Go
    `RawPolicy`, Rust `RuntimePolicy::from_json`, a Python dict), so most typos
    would go unreported.

## Impact

- **TypeScript:**
  - `src/metrics.ts`: `MetricErrorKind` gains `config_unknown_field`.
  - `src/config.ts`: the construction stamp (D5).
  - `src/internal/runtime-config.ts`: the identity-remembered check for plain
    objects (D9) and the report after a successful merge.
  - `src/dialcache.ts`: the per-call report and its warning bound (D3), and
    the unknown-field throw in `snapshotDefaultConfig` (D6).
  - The Datadog and Prometheus exporter tests, and
    `scripts/test-package.mjs` for the widened public union.
  - Native tests in `dialcache-config-ramp.test.ts` and
    `dialcache-observability-internals.test.ts`. #242's removed prototype
    (before ed80bbe) is a starting point for the stamp and its tests; it
    walked keys on each call, which D9 replaces.
- **Go:**
  - `policy.go`: the size comparison in `ResolvePolicy` for `JSONPolicy` and
    `RawPolicy` maps (D9); `ParsePolicy` rejects unknown members (D6).
  - `engine.go`: the event.
  - `internal/testsuite/policy_test.go`.
- **Rust:**
  - `observe.rs`: the `ErrorKind` variant and `#[non_exhaustive]` (D8).
  - `policy.rs`: the size comparison in `merge_overlay` (D9); `from_json`
    rejects unknown members. The test at
    `policy.rs:889`, which asserts that unknown members are ignored, gains the
    report.
  - `execution.rs`: the event.
- **Python:**
  - `config.py`: the marker set in `Policy.__post_init__`, the size
    comparison in `normalize_policy` that counts a doubled spelling as
    unknown (D9), and the `ConfigError` in `validate_static_policy` (D6).
  - `cache.py`: the event and the warning.
  - `tests/test_config.py`.
- **Docs:**
  - `docs/api.md` "Validation and snapshots": replace "Unknown runtime
    fields are generally ignored, so validate external policy against your
    application's schema".
  - `docs/configuration.md` "Provider behavior".
  - `docs/observability.md`: the error-kind table.
  - `docs/upgrading.md` (D8), `docs/languages/*.md`, and the failure-scope
    paragraphs of the four port READMEs.
  - Each edited pinned page refreshes its ledger.
- **Formal:** the models, coordinator, catalogs and mutants listed under
  Contract and model changes, plus:
  - `semantic-cases.json`, `coverage-witnesses.json`, `witness-baseline.json`
    and `replay/witnesses/policy.mjs`;
  - `go-parity.json`;
  - the regenerated PROFILES, MUTANTS and CHALLENGES views, smoke traces and
    fixture lock.
- **Upgrade:** breaking in every port, because a static default with an
  unknown field now throws (D6), and in Rust also because of the new
  `ErrorKind` variant (D8). Provider replies that carry unknown fields keep
  caching and start reporting on the first deploy.

## Plan

1. This record, as the first commit of the implementing draft pull request.
   The pull request holds only the record until the maintainer accepts every
   decision.
2. The same pull request then carries:
   - CONTRACTS.md and SPEC.md;
   - Quint, the coordinator and catalogs;
   - the TypeScript reference, then Go, Rust and Python;
   - mutants, docs and the AGENTS.md bullet.

   It is titled `feat!:`, with a `BREAKING CHANGE:` paragraph for the
   static-default throw (D6) and the Rust variant (D8), and it is validated at
   the Full tier. All four ports land in one pull request because the
   completion inventory requires every port to replay every generated history.

   It follows #242, which is open and edits `config.ts`,
   `runtime-config.ts` and `dialcache.ts`, and adds `shadow.mismatchLogging`,
   which D2 covers. If #243 has not yet ported that group to Go, Rust and
   Python, the implementing pull request checks the groups those ports have,
   and #243 adds the new group to each port's check.

## Deviations

None.

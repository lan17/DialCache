# Shadow mismatch paths: name the differing fields in confirmed-mismatch warnings

- **Status:** Proposed
- **Issue:** none
- **Pull requests:** #242
- **Baseline:** `main` at `b4e4fba`, the commit the record was written against
- **Supersedes:** the design in pull request #138, which is unmerged; the
  decisions it carries are listed under [Carried decisions](#carried-decisions)

## Context

Shadow validation compares a sampled cached value with the source and reports
`match`, `mismatch` or `superseded` as a bounded metric. The only way to learn
*what* disagreed is `shadow.logMismatches: true`, which logs the logical cache
key (2 KiB) and the complete native JSON of both values (8 KiB each) after a
confirmed mismatch. That is all or nothing: a team that wants to know which
field keeps disagreeing has to put whole records into logs, and for a large
record the 8 KiB cap usually truncates the dump before the differing field.

The operational questions a mismatch rate raises are structural: is it always
the same field, is the cache missing a field the source now has, is one list
longer, or is the difference something JSON cannot show at all, such as a
`Date` object meeting the ISO string it was decoded to. None of these need the
values themselves.

Pull request #138 (August 2026) built most of the answer for TypeScript: a
`mismatchLogging` content group in place of the boolean, a value projector
hook, and a built-in differ over the native-JSON renderings of both sides
emitting `{ type, path, value, oldValue }` entries. The maintainer reviewed it
three times and ended with no remaining findings, but it never merged. It is
TypeScript-only, it predates the Go, Rust and Python ports, the `typescript/`
layout move and this record process, and its branch can no longer be rebased.
Its reviewed decisions are kept; its value-bearing diff is reshaped around a
paths-only tier it lacked.

Constraints:

- Logging stays default-off, runs only after a confirmed `mismatch`, inside
  detached shadow work, with bounded CPU; the caller's result is never
  affected (C60, C50–C54).
- Every port mirrors the config leaves, the warning fields and the hooks, and
  the ports' value domains differ (B03): Node deep equality, Go reflection over
  a portable value domain, Rust `PartialEq` on `T`, Python dict/list.
- Runtime policy merges leaf-wise and `DialCacheKeyConfig.disabled()` is a
  complete kill switch, so every new leaf is a scalar the overlay can set.
- Warning fields reach log pipelines, so a path list is a structured array of
  strings, not a rendered blob.
- `shadow.logMismatches: true` is live in at least one consumer's dynamic
  config store, so the upgrade must not silently change whether a mismatch is
  logged or force a deploy-then-config ordering.
- The replay protocol records the warning as an observation whose extra fields
  must be JSON primitives
  ([PORTING.md](../formal/guides/PORTING.md#trace-and-observation-contract)).

## Proposal

The `shadow` group gains a `mismatchLogging` content group with two
independent default-off leaves: `value`, a boolean, and `diff`, an ordered
level `"off" | "paths" | "values"`. `logMismatches` stays as the one-flag
shorthand for the maximal setting:

```ts
shadow: {
  ramp: 5,
  mismatchLogging: { diff: "paths", value: false },
}
// Equivalent to mismatchLogging: { diff: "values", value: true }:
shadow: { ramp: 5, logMismatches: true }
```

`logMismatches` is expansion, not a third leaf: where it appears, in a
default config or a runtime overlay, `true` expands to
`{ value: true, diff: "values" }` and `false` to `{ value: false, diff: "off" }`
before the ordinary leaf-wise merge runs. An explicit leaf in the same object
wins over the expansion, so `{ logMismatches: true, mismatchLogging: { value: false } }`
logs the diff without the whole-value dumps. An invalid value expands to both
leaves off with one `config_resolution`, as today. Everything `diff` logs
derives from the renderings that `value` logs (D3), so the shorthand never
exposes more than `logMismatches: true` exposes today; it adds fields.

A warning is emitted after a confirmed mismatch when `value` is true or
`diff` is above `"off"`. It always carries `cacheNamespace`, `useCase`,
`keyType`, `outcome: "mismatch"`, `cachedValueAgeSeconds` (the age the
`observeShadowValueAge` metric records), `cacheKey` (the logical URN, 2 KiB)
and, when warning construction failed, `loggingOutcome` (see Failure
handling). Each setting adds:

| Setting | Fields | Bound |
| --- | --- | --- |
| `diff: "paths"` | `mismatchPaths: string[]`, RFC 6901 JSON Pointers into the compared value; `mismatchPathCount`, the total before the cap | 64 entries, each pointer 512 bytes |
| `diff: "values"` | The `"paths"` fields, plus `diffJson`: the same entries with their `cached` and `source` values, each side clamped to 1 KiB; a side absent from the entry is omitted | 8 KiB |
| `value: true` | `cachedValueJson`, `sourceValueJson`: native JSON of each side | 8 KiB each |

The two `diff` levels are projections of one list of entries
`{ path, cached?, source? }`, computed once by the built-in walk or returned
by the hook, so they cannot disagree: `"paths"` logs the paths, `"values"`
adds the entries with their values. The levels are an exposure ladder:
`"paths"` is what a cache of user data can leave on in production,
`"values"` is what an investigation turns on.

One per-use-case hook sits beside `shadowComparator` on `cached()` and
`getOrLoad()`:

```ts
dialcache.cached(fetchUser, {
  useCase: "GetUser",
  keyType: "user_id",
  cacheKey: (id) => id,
  // Optional. Replaces the built-in computation; receives the compared
  // values and returns the entries. Absent: the built-in JSON differ runs.
  shadowMismatchDiff: (cached, source) => [
    { path: "/profile/email", cached: cached.profile.email, source: source.profile.email },
    { path: "/roles" },
  ],
});
```

Each entry names a path; its `cached` and `source` sides are optional, so a
hook that only knows where the values differ returns paths alone, and an
entry for a field present on one side carries one side. The hook follows the
comparator's discipline: synchronous, deterministic, side-effect-free,
non-mutating, bounded. A hook that throws, returns a promise-like, returns a
non-array, or returns a member without a string `path` logs `null` for
`mismatchPaths` and `diffJson` and never falls back to the built-in
computation. A hook value with no JSON rendering makes `diffJson` `null`
while `mismatchPaths` stays, since the paths are still valid and logging
less is the safe direction. Hook values are the use case's own code, like
the comparator: the built-in's guarantee that nothing in `diffJson` exceeds
what `value` logs applies to the built-in only.

The built-in computation:

1. Render each side to native JSON once and parse it. A side with no
   rendering (`undefined` at the root, a cycle, a `bigint`) makes
   `mismatchPaths`, `diffJson` and that side's value field `null`.
2. Walk both parsed values together. Objects recurse over the union of their
   member names in UTF-16 code-unit order (the order W02 already prescribes
   for key arguments); a member present on one side only is reported at its
   pointer. Arrays of equal length recurse by index; arrays of different
   length are reported once at the array's own pointer without descending.
   Any other pair that differs is reported at its pointer. Nesting deeper
   than 32 levels is reported at the container's pointer without descending.
   Each entry carries the two values at its pointer as the walk holds them:
   one side when the member exists on one side only, the whole containers
   for an array-length or depth entry.
3. Roots of different kinds (object against array, container against
   primitive, primitive against primitive) yield one entry at `""` carrying
   both roots. Byte-identical renderings yield no entries, so
   `mismatchPaths` is `[]`: the difference is outside the logged form, which
   means a type the rendering erased or a comparator that sees more than
   JSON.
4. Entries are emitted in walk order and the list is cut at 64; each pointer
   is clamped to 512 bytes and each value side to 1 KiB with the existing
   `...[truncated]` marker; the rendered `diffJson` is clamped at 8 KiB the
   way `cachedValueJson` is today; and `mismatchPathCount` carries the uncut
   total.

Failure handling. Everything above runs in detached shadow work after the
verdict, on a job the caller never awaits: the caller already holds its
result, the Redis hit on a served-hit path or its own source result on a
ramped-down path, before the shadow job reads anything (C48, C49). The
verdict and its `shadowValidation` outcome are decided before any warning
work starts and are never changed by it (C60). A throw anywhere in warning
construction is caught and degrades to the metadata-only warning, and a
logger exception is isolated as today. So the rule is fail-open for the
caller, who is never affected, and fail-closed for exposure, since a failure
logs less, never more. Whether the diff computation holds the shadow capacity
slot stays a port detail, as it is today: TypeScript renders after the slot
is released, Rust holds it through the bounded CPU executor. The caps bound
the built-in; a hook is user code under the comparator's discipline, so a
runaway hook costs what a runaway comparator costs.

Each warning attempt, a confirmed mismatch with logging on, emits one
`shadowMismatchLogging` metric event with the cache labels and an `outcome`:
`hook_error` when the hook or the built-in walk threw or returned an invalid
list, `render_error` when a side had no JSON rendering, `logger_error` when
the logger threw, else `logged`; the first failing stage wins. Logging off
emits nothing, so the metric never shadows the mismatch count. When the
outcome is not `logged`, the warning carries it as `loggingOutcome`, so a
reader sees why fields are null. Invalid logging config stays
`config_resolution`, carried from #138.

Port shapes: Go `ShadowPolicy.MismatchLogging *MismatchLoggingPolicy` with
`Value *bool`, `Diff *MismatchDiffLevel` (`off`, `paths`, `values`) and
`Operation.MismatchDiff func(cached,
source T) ([]MismatchEntry, error)`, with `MismatchEntry{Path string;
Cached, Source any}` and the port's absence convention for an omitted side;
Rust `ShadowPolicy.mismatch_logging: Option<MismatchLogging>` with
`value: Option<bool>` and `diff: Option<MismatchDiff>`, an enum of the three
levels, and an `Operation::mismatch_diff(...)` builder returning
`Vec<MismatchEntry>` with
`Option<serde_json::Value>` sides, where the built-in computation needs
`T: Serialize`, so an operation built with `with_codec` has entries only
through the hook, and the existing `Operation::preview` stays as the
renderer for such types; Python
`shadow={"mismatch_logging": {"diff": "paths"}}` (camelCase accepted as
today) and `shadow_mismatch_diff=` beside `shadow_comparator`, returning a
list of dicts. Runtime config in every port validates each leaf
independently: an invalid leaf acts off (`value: false`, `diff: "off"`) and
records one `config_resolution`; unknown fields are ignored and reported as
`config_unknown_field`; a non-object `mismatchLogging` fails resolution like a
malformed layer map. `logMismatches` keeps its type in every port (Go
`LogMismatches *bool`, Rust `log_mismatches: Option<bool>`, Python
`log_mismatches` or `logMismatches`) and expands before the leaves merge.

## Out of scope

- A metric for paths. Pointers are unbounded labels. Deferred until log
  pipeline aggregation proves insufficient; a bounded label derived in
  `shadowMismatchDiff` is possible without library support.
- A TypeScript-only leaf type classification that reports `/updatedAt` when a
  cached ISO string meets a source `Date`. Deferred until real logs show `[]`
  dominating TypeScript mismatches; a use case can set `shadowMismatchDiff`
  for it today.
- Array alignment (longest common subsequence or alignment by an identity
  field). Rejected for the built-in because it is quadratic in the worst case
  and needs a per-use-case identity hint; the hook covers it.
- Aggregating paths inside the library (top paths per window). Pipeline work.
- A value projector hook, #138's `shadowMismatchLogValue`, which redacted
  values in code before `value` and `diff` logged them. Deferred: `paths` is
  the value-free tier and `diff` narrows values to the differing leaves, and
  an optional hook is additive later. Reopen for a use case that needs the
  differing values logged while the same values carry data that `paths`
  cannot express; a `toJSON` on the value class or a wrapping logger covers
  it meanwhile.
- A textual diff of the two renderings. It reads well and pinpoints a change
  inside a long string, but it cannot be aggregated by field, it is a
  presentation of two strings `value` already logs, and pinning it across
  ports would need byte-identical pretty-printing and a fully specified
  line-diff algorithm. A later refinement of `diff` entries can trim the
  common prefix and suffix of long string leaves instead.
- A key projector. Deferred as in #138.
- Failing closed when shadow policy is enabled without a shadow observer
  (#151). Independent.

## Contract and model changes

- **C60** keeps its obligation and changes its wording: opting in means
  `value` is true or `diff` is above `"off"`. Its native clause stays: JSON
  conversion of native values, exact truncation text and the logger backend
  remain B03/X01.
- **New obligation** (ID assigned when CONTRACTS.md assigns one): the
  built-in computation in the Proposal, as a portable function over JSON
  values, with the array rule, the root cases, the ordering and the caps.
  Evidence is a hand-authored `mismatchPathVectors` group in
  [protocol-vectors.json](../formal/catalogs/protocol-vectors.json), each
  vector a pair of JSON values with the expected entries, paths and values
  compared as parsed JSON so each port's string rendering stays a B03
  detail, mapped in
  `semantic-cases.json` as `protocol/mismatchPathVectors/*` and replayed by
  every port's protocol-vector test. The function has no relation to kernel
  state, so it is not modelled in Quint. The completion inventory requires
  every port to replay every vector, so the group and the row land with the
  last port (Plan); until then the TypeScript differ is pinned by native
  tests.
- **Quint:** `kernel/shadow.qnt` keeps `logging: bool`, read as "`value` is
  true or `diff` is above `off`"; `dialcache-shadow-conformance.qnt` keeps its
  invariants and regressions, including `invalid-logging-policy`, which the
  per-leaf validation still satisfies. The `logPolicy` choices in
  `formal/replay/features.mjs` and the five fixed scenarios in
  `behavioral-scenarios.json` keep `logMismatches`, which stays valid, so the
  shared corpus needs no change while the ports catch up; the pull request
  that completes the last port adds choices and scenarios for each `diff`
  level and for `value`, so the corpus exercises both leaves and the
  shorthand's expansion. That is a driver fixture change, not a model change.
- **Observation record:** the `mismatchWarning` event in
  [PORTING.md](../formal/guides/PORTING.md#trace-and-observation-contract)
  gains optional `mismatchPathsJson` (the array as one JSON string, keeping
  fields primitive), `mismatchPathCount`, `diffJson` and `loggingOutcome`,
  and a `shadowMismatchLogging` event kind with the cache labels and
  `outcome` joins the table, observed where a fixture lists it. Every port's
  driver records them, and all four `formal-<port>` lanes run. While ports land one
  at a time, a lane that compares warning fields across ports sees them from
  TypeScript first; if that comparison is strict, the TypeScript driver
  records the new fields only once every port emits them.
- **Native (B03/X01):** hook execution per port (thenables in TypeScript,
  panics in Go, the bounded CPU executor in Rust, the event loop in Python);
  which native types each renderer sees; the logger backend; the exporter
  names and schema of the `shadowMismatchLogging` metric.

## Decisions

### D0. Carry the decisions reviewed on #138 unchanged

- **Choice:** the [Carried decisions](#carried-decisions) below are taken as
  settled; this record does not reopen them.
- **Status:** Open
- **Rejected:**
  - Re-deciding each one here. They were reviewed and approved in #138's
    threads; relitigating costs a round trip and invites drift.

### D1. Which content leaves exist

- **Choice:** `value`, a boolean, and `diff`, an ordered level
  `"off" | "paths" | "values"`; `cacheKey` is part of every warning. #138's
  `key` leaf is dropped. The cost accepted: a string leaf among boolean and
  numeric ones, so each port carries a three-value type with its validation.
- **Status:** Open
- **Rejected:**
  - `key`, `value`, `diff` as in #138. The `key` leaf existed only so a
    warning could name no entity; a cache key is an identifier the
    application already sends to Redis, and `main` has always logged it. One
    fewer leaf to merge, kill and mirror.
  - Three booleans, `paths`, `value` and `diff`, this record's first shape.
    Rejected 2026-10-24: `paths` and `diff` are an exposure ladder, which an
    ordered level states directly, and `{ paths: false, diff: true }` was a
    state with no purpose.
  - A single level for the whole group (`off | paths | values | everything`).
    `value` and the diff level are independent choices: an investigation may
    want the whole values with or without the structural list.
  - `value` and a boolean `diff` only, logging the paths inside `diffJson`.
    The paths-only mode is the one a cache of user data can leave on in
    production; without it, value-free logging moves back into code.
  - Only `paths` and `value`. The whole-value dump is truncated at 8 KiB, so
    for a large record `diff` is the only way to see the differing leaves
    without raising the cap.

### D2. Path encoding

- **Choice:** RFC 6901 JSON Pointer strings (`/profile/email`, `/items/2`,
  `""` for the root), `~0` and `~1` escaping.
- **Status:** Open
- **Rejected:**
  - Segment arrays `["profile", "email"]` as in #138. Unambiguous but verbose,
    and log pipelines cannot group by them without flattening.
  - Dotted paths `profile.email`, `items[2]`. Ambiguous when a key contains
    `.` or `[`.
  - JSONPath. Nothing here needs a query language.

### D3. What the built-in computation compares

- **Choice:** the parsed native-JSON renderings of both sides, rendered once
  each, with `[]` for byte-identical renderings and `[""]` for roots of
  different kinds.
- **Status:** Open
- **Rejected:**
  - The native values the comparator saw. It would explain every verdict,
    including a `Date` against its ISO string, but each port's value domain
    differs (B03), so there is no portable rule or vector, and the diff could
    expose fields that `toJSON` removes from `value` logging, the leak #138's
    review closed.
  - Making the differ the default comparator, with early exit for the
    verdict. The default verdict would change in every port (C50), and a
    custom comparator still breaks the unification.
  - A root sentinel when renderings are identical. `[]` already says it, and
    `[""]` is kept for a difference the walk cannot descend into.

### D4. Arrays

- **Choice:** equal lengths recurse by index; different lengths report the
  array's pointer once and do not descend.
- **Status:** Open
- **Rejected:**
  - Index-wise always, as in #138. One inserted element reports every later
    index; for a 50-element list that is 50 misleading pointers.
  - Wildcard collapse (`/items/*` once more than K indices differ). Keeps
    precision for small changes, but K is a magic number and fewer than K
    shifted elements still report as changed.
  - Alignment. See Out of scope.

### D5. Walk order

- **Choice:** object members in UTF-16 code-unit order, arrays by index,
  pointers emitted in walk order.
- **Status:** Open
- **Rejected:**
  - Insertion order. Go map iteration is randomized and Rust's `serde_json`
    map is ordered by key, so insertion order cannot be matched across ports.
  - Code-point or byte order. W02 already sorts key arguments by UTF-16 code
    units, so every port has that comparison; a second ordering is a second
    thing to get wrong.

### D6. The custom hook

- **Choice:** `shadowMismatchDiff(cached, source)` receives the compared
  values and returns entries `{ path, cached?, source? }`; absent means the
  built-in runs; a throw, a promise-like, a non-array or a member without a
  string `path` logs `null` for both `mismatchPaths` and `diffJson` and never
  falls back to the built-in; a value with no JSON rendering nulls `diffJson`
  alone.
- **Status:** Open
- **Rejected:**
  - `shadowMismatchPaths(cached, source) => string[]`, with the library
    resolving each pointer against the JSON renderings to produce `diff`.
    Rejected 2026-10-24: resolution meant unescaping, index parsing and
    unresolvable pointers in four ports, and could never produce values for
    a type without a JSON rendering; values that ride along with the walk or
    the hook need none of it.
  - #138's `shadowMismatchLogDiff` returning arbitrary JSON. A required
    `path` and optional sides keep the output bounded and let `paths` derive
    from the same list.
  - Falling back to the built-in when the hook fails. A broken hook would
    then log more than its author intended.
  - Dropping invalid members instead of nulling the result. Partial output
    from a misbehaving hook is a guess.

### D7. How `paths` and `diff` relate

- **Choice:** two projections of one entry list. `mismatchPaths` is the
  entries' paths as strings; `diffJson` is the entries with their values as
  one rendered string capped at 8 KiB; `diff: "paths"` logs the first and
  `diff: "values"` both. The built-in attaches both values to each entry as
  the walk emits it; the hook supplies its own. The leaves are independent:
  `{ diff: "values", value: false }` logs where and what without the
  whole-value dumps.
- **Status:** Open
- **Rejected:**
  - Dropping `diff` from the first version as too complex. Considered
    2026-10-24: the complexity was pointer resolution, which this shape
    removes, and the truncation case, values past the 8 KiB `value` cap, is
    what `diff` exists for.
  - A separate diff hook beside a paths hook. One list decides where and
    what, so the two fields cannot disagree.
  - A structured array in the log. A byte cap cannot be stated for it, and
    the observation record needs primitives.

### D8. Portable evidence for the built-in computation

- **Choice:** a hand-authored `mismatchPathVectors` group in
  `formal/catalogs/protocol-vectors.json`, replayed by every port.
- **Status:** Open
- **Rejected:**
  - Quint-generated vectors. Quint has no recursive types for nested JSON,
    and the function has no relation to the kernel's state machine.
  - A generator that computes expected outputs with the TypeScript
    implementation. The fixture would never catch a TypeScript bug.
  - Native tests only, as a B03 detail. Four hand-written differs would drift
    in exactly the cases vectors pin: escaping, ordering, the array rule, the
    root cases.

### D9. Caps

- **Choice:** 64 entries, 512 bytes per pointer, 1 KiB per value side, depth
  32, `diffJson` 8 KiB, `mismatchPathCount` carries the uncut total; a cut
  list is visible because the count exceeds the length.
- **Status:** Open
- **Rejected:**
  - A byte cap on the path list. The list is structured, and a count is what
    a pipeline can test.
  - No depth cap. The walk runs on parsed JSON, so it terminates, but a
    pathological depth is CPU on the detached budget for no diagnostic value.

### D10. What happens to `shadow.logMismatches`

- **Choice:** it stays, permanently, as the one-flag shorthand for the
  maximal setting, `{ value: true, diff: "values" }`, with the expansion
  semantics in the Proposal. The convention
  against aliases and shims covers unused API; this field is live in a
  consumer's config store, and the shorthand is a coarse control with a
  defined meaning, not a deprecated path. A record that adds a leaf decides
  whether the shorthand covers it.
- **Status:** Open
- **Rejected:**
  - Removing it and treating a stale value as an ignored unknown field with a
    `config_unknown_field` metric, as #138 decided on 2026-08-15. Rejected
    2026-10-24: the upgrade would silently stop mismatch logging for every
    config store that carries `logMismatches: true`, and the migration would
    have to be sequenced after the deploy.
  - Keeping it temporarily, with an issue for its removal. The removal is a
    second breaking change plus the same config flip, with the same
    silent-loss risk at that moment; the cost is deferred, not saved.
  - Expanding `true` to `{ value: true }` only, preserving today's output
    exactly. All-on exposes nothing beyond `value`, and it delivers paths to
    existing configs without a change.
  - A third leaf merged independently and OR'd at read time. An explicit
    `value: false` could then never win over an inherited `true`.

### D11. How warning-pipeline failures are observed

- **Choice:** a dedicated `shadowMismatchLogging` metric with the cache
  labels and `outcome` in `logged | hook_error | render_error | logger_error`,
  one event per warning attempt, nothing when logging is off, and
  `loggingOutcome` on the warning when it is not `logged`.
- **Status:** Open
- **Rejected:**
  - Nothing, as today: a null field in a log line. A hook that has thrown
    for a week is invisible, and a logger that throws is silent.
  - A new category on the `error` counter. That counter's `in_fallback`
    semantics describe cache plumbing; a verdict-style outcome metric
    mirrors how `shadowValidation` and `staleRecovery` already report.
  - Changing the `shadowValidation` outcome. C60 keeps the warning
    independent of the outcome metric, and the verdict is decided before any
    warning work starts.
  - Truncation as an outcome. It is not a failure and co-occurs with
    `logged`; `mismatchPathCount` against the list length and the
    `...[truncated]` marker already show it.

## Carried decisions

Reviewed and approved by the maintainer on #138; carried unchanged:

- Runtime reads of the whole `shadow` group, and of each leaf, are
  own-property reads at every boundary.
- The differ traverses own members of parsed JSON only; no hostile-intrinsics
  hardening (the maintainer withdrew that finding).
- Each side is rendered to JSON exactly once; every logged field derives from
  that snapshot, so a stateful `toJSON` cannot put into one field what
  another omits.
- A side with no rendering fails every field it feeds closed to `null`; no
  `null → null` entries.
- Unknown `mismatchLogging` leaves and other unknown key-config fields are
  ignored and reported once per observed config as `config_unknown_field`.
  (#138 applied this to `shadow.logMismatches` itself; D10 keeps that field
  instead.) A known leaf with an invalid value acts off with one
  `config_resolution`; a non-object group fails resolution like a malformed
  layer map.
- `value: true` logs raw JSON.
- `DialCacheKeyConfig.disabled()` sets `value: false` and `diff: "off"`.

## Impact

- **TypeScript:** `config.ts`, `internal/runtime-config.ts`,
  `internal/shadow-log-json.ts`, `dialcache.ts` (hooks, warning assembly,
  `resolveShadowLogging`), `metrics.ts` (the `shadowMismatchLogging` hook and
  its outcome type), `datadog.ts` and `prometheus.ts`, `index.ts` exports for
  the new config, hook and metric types, `scripts/test-package.mjs`, the
  shadow, config and exporter tests, the formal behavior driver.
- **Go:** `policy.go` (leaf lists, resolution, JSON form), `shadow.go`,
  `metrics.go` (details, the `shadowMismatchLogging` event kind and its
  exporter mapping), the operation type and a `MismatchEntry` type,
  `*_driver_test.go`, `protocol_test.go`, `internal/testsuite/policy_test.go`.
- **Rust:** `policy.rs`, `shadow.rs`, `observe.rs` (`ShadowMismatchDetails`,
  `Display`, the new `Event` variant), `metrics.rs` exporters,
  `operation.rs`, `preview.rs`, `tests/formal/driver.rs`, the protocol-vector
  and exporter tests.
- **Python:** `config.py`, `cache.py`, the metrics adapters,
  `tests/formal/driver.py`, `tests/test_protocol_vectors.py`,
  `test_config.py`.
- **Formal:** `CONTRACTS.md` (C60 wording, the new row, the page and test
  inventories), `SPEC.md` (mismatch logging rows), `PORTING.md` (observation
  row), `GO-PARITY.md`, `behavioral-scenarios.json` (five fixtures),
  `features.mjs` (fixture and `logPolicy` encoding), `semantic-cases.json`
  (vector mapping and new cases), `protocol-vectors.json` (new group),
  `mutations.json` and `rust-mutations.json` (M08 and M09 anchors move to the
  new leaf code; new mutants for the array rule, the root cases and hook
  fail-closed behavior), the ledgers `source-audit.json` and `go-parity.json`,
  and any course lesson whose citation moves.
- **Docs:** `shadow-validation.md` (Confirmed mismatch logging),
  `observability.md` (Confirmed mismatch warnings, the shadow outcomes
  section and the Datadog and Prometheus metric tables), `configuration.md`,
  `api.md`, the port READMEs that name `logMismatches`, and `upgrading.md`:
  `shadow.logMismatches` stays and now also logs `mismatchPaths`,
  `mismatchPathCount` and `diffJson`; no config migration is required.
- **Release:** additive for TypeScript, Go and Python. Breaking for Rust,
  where `ShadowPolicy` gains a public field and existing struct literals stop
  compiling; the title keeps `!` and the `BREAKING CHANGE:` footer names
  that.

## Plan

1. #242 opens with this record as its first commit and stays at the design
   gate until every decision is confirmed and the record is `Accepted`.
2. #242 then carries the TypeScript reference: the leaves and the shorthand,
   the built-in differ, the hook, the warning fields, the TypeScript replay
   driver, C60's wording, the TypeScript docs and catalogs, and native tests
   that pin the differ. The shared corpus keeps `logMismatches`, which stays
   valid in every port, so the other ports keep passing. Tier: Replay and
   Mutations, since M08 and M09 anchor on the moved logging code.
3. Go, Rust and Python each follow in their own pull request against the
   TypeScript semantics, with their drivers and docs. Tier: Replay and
   Mutations each.
4. The pull request that completes the last port adds the vector group, its
   `semantic-cases.json` mapping and the new contract row, and re-encodes the
   `logPolicy` choices and scenarios for each `diff` level and for `value`.
   Tier: Full (Portable behavior).

## Deviations

None.

# Go parity acceptance

The target is a Go implementation of DialCache's portable behavior, with the
same interoperable cache protocol and observable metric schemas. The readable
Quint transitions and independently stated properties define that behavior.
The prose explains the models, their encodings, and their limits. A port must
not treat the TypeScript implementation, its tests, or an expected trace state
as an alternative behavioral oracle.

[`go-parity.json`](go-parity.json) records the reviewed implementation mappings,
shared execution evidence, native adaptations, and remaining assurance gaps.
Its status is `finite-portable-contract-inventory`. Current requirements are
4,000 generated histories across nine profiles, 244 fixed scenarios, 134
protocol vectors, and 344 required witnesses. The [feature map](FEATURE-COVERAGE.md)
accounts for 261 behavioral/protocol cases and 33 separate native cases.

The ledger retains a **historical acceptance record** from before this
behavioral expansion: both implementations passed the same 4,000 generated
histories, 238 fixed scenarios, and 134 protocol vectors, with Go under the
race detector. That record does not validate the changed models, witnesses,
cases, or native tests; fresh reports must identify the expanded inputs.
Inventory counts account for what was reviewed; they are neither a coverage percentage nor a
proof. A source declaration, a test name, and a model file are not
interchangeable units of behavior.

The local validation record identifies its base revision and dirty source
snapshot, report hashes, and execution-input manifest. CI repeats generation,
both replays, real interoperability checks, and independent mutation
measurements on the committed revision. `check-go-replay.mjs` rejects an
incomplete Go report, missing generated histories, or skipped witness gates.

## Required evidence

Quint-generated histories should drive most portable behavioral testing in
both implementations, especially interactions among policy capture, request
ownership, cache layers, deadlines, recovery, and shadow work. For a rule
covered by generated histories, the ledger must link:

1. The precise Quint transition or independently checked property expressing
   the obligation, with the model's bounds and assumptions made explicit.
2. Required generated witnesses that reach the consequential branch and expose
   its result through public observations. A witness for entering a branch is
   insufficient when the contract concerns a later read, timeout, or write.
3. Successful replays of the **same generated histories** through the actual
   TypeScript and Go APIs, recording the corpus hash, repository revision,
   checker settings, and both implementation reports.

Fixed scenarios remain useful for a known failure or a narrow boundary.
Protocol vectors and native integration tests are appropriate evidence for
byte encodings, host numeric limits, backend registration, and actual Redis
execution. Acceptance does not require every fixed case to become a generated
history. It does require reviewing the consequential portable branches and
using Quint as their behavioral source of truth, rather than treating a large
trace count as evidence that all obligations were exercised. When several
cases share a witness, review each rule separately: reachability alone does
not establish that the observation distinguishes its incorrect implementation.

The execution driver may use action parameters and external fixture data to
control source settlement, clocks, cache replies, and scheduling gates. Only
the assertion layer may read expected model state. Expected counters, results,
or private model cache state must never determine actual execution. Required
witness gates must fail if generation omits them. Mutation challenges must
reach a behavioral assertion; a parse error, compile error, missing tool, or
watchdog failure is not successful semantic detection.

Protocol vectors complement behavioral traces by checking bytes, numeric
boundaries, argument ordering, invalid encodings, and compression. Native
integration tests complement both by checking actual Redis execution,
concurrency, backend collector behavior, packaging, and language-specific
value handling. Their contribution and limits must be stated explicitly;
they do not establish unmodeled interactions among portable state machines.

`inventory.withoutRequiredGeneratedWitnesses` identifies a generated-evidence
gap, not necessarily a Go implementation gap. A known implementation gap
requires a specific unsupported portable behavior or a failing behavioral
comparison. A rule already supported by fixed, vector, or native evidence can
instead be a candidate for additional generated assurance. Current expansion
candidates are the explicitly retained limits in [FEATURE-COVERAGE.md](FEATURE-COVERAGE.md):
larger feature combinations, additional shadow confirmation/physical-expiry
schedules, and shared malformed-compression vectors. Sparse policy, default
boundaries, multi-layer publication, and retained shadow ownership now have
more specific evidence; that evidence still has the bounds recorded for each
case. Review remaining work by consequence and interaction risk; do not
manufacture one model per fixed test or label every remaining fixed case as
missing Go parity.

## Reading and updating the ledger

`cases` records every current semantic case, its declared model links,
generated witness requirements, and fixed or vector evidence. Empty model
links mean that no scheduled invariant or regression is currently cited for
that case; a precise transition definition may still express its behavior.
Record that transition separately from an independently checked property.
A matching profile name does not invent either connection, and a property
checking one clause does not prove all clauses of a compound case. Evidence
fields identify the checked local reports and corpus fingerprints. Refresh
them after executable inputs change; a previous revision's pass must not
silently satisfy a changed model or implementation.

[`quint-case-audit.json`](quint-case-audit.json) records the reviewed scope of
each cited scheduled invariant or regression, plus separate transition,
helper, and predicate references. It explicitly distinguishes a checked
safety clause from a complete case proof and records known limits of the
properties. The ordinary metadata gates check reference kinds, scheduling,
case membership, positive scenario/vector assignments, feature/native coverage,
and nonempty scope notes without requiring Quint; it cannot
automate the semantic judgment in those notes.

`profiles` records the shared corpus for each executable profile. Scheduled
trace counts are generation settings, not a claim that all traces differ or
that the model's state space was exhausted. After a model or registry change,
refresh the input hashes, case inventory, required witnesses, and reports
together. Preserve the existing execution-manifest validation and scheduled
invariant/regression checks.

`sourceInventory` lists 772 declarations across 27 TypeScript production files.
Each inherits its reviewed source-file mapping to named Go symbols, with hashes
that reject stale mappings. These are navigation and review records, not 772
independent equivalence claims. The linked source audit's 44 test and
documentation files also have explicit Go-applicability reviews. Native
adaptations retain their rationale and evidence rather than being counted as
identical language APIs.

`boundaries` carries explicit abstraction and language-binding decisions.
An exclusion in an older bounded profile must be reconsidered for the full
port target. Do not change an exclusion to "supported" merely because the
new implementation has a similarly named function. Conversely, do not
require Go to reproduce a JavaScript-only API shape when an explicit Go
binding preserves its portable consequences.

## Native clock precision

C23 grants the source its full budget from source start; C25 accepts a source
settlement only strictly before that deadline. The existing Quint models and
shared histories express these rules in integer ticks. Their replays did not
expose a Go clock-binding defect: rounding two absolute elapsed readings before
subtracting them could reject work completed within its full source budget.

Source, read and shadow budgets retain monotonic `time.Duration` precision
before subtraction. The optional `PreciseClock` interface supports the same
precision for custom clocks; integer clocks retain their declared resolution.
Timer delivery is checked against elapsed time.

Local TTL has a different native boundary: TypeScript floors the monotonic
clock to whole milliseconds at insertion and lookup. Go follows those same
whole-millisecond observations. For example, insertion at 0.7 ms with a 1,000 ms
TTL expires at the observed clock value 1,000 ms. Applying precise elapsed
subtraction to local storage would retain that entry beyond TypeScript's
boundary. Native tests distinguish this rule from precise source/read/shadow
budgets; integer-tick Quint traces alone cannot distinguish the bindings.

[`clock_precision_test.go`](../go/clock_precision_test.go) uses deterministic
native clock phases to exercise source and read completion before and at their
budgets, served and dark shadow deadlines, insertion expiry, coalescing age,
early timer delivery, and integer-clock compatibility. These are native
regressions for existing obligations, recorded under C23/C25 and B02; they add
no generated witnesses or model coverage. Their execution and any new full-run
results must retain their own revision and input identities rather than reuse
a previous implementation's validation record.

## Current configuration and observability bindings

`ParsePolicy` validates JSON-shaped static configuration. `SnapshotPolicy`
copies mutable leaves. `ResolvePolicy` combines that static snapshot with a
sparse runtime overlay; it separates invocation failures, layer disablement,
recovery configuration errors, and shadow configuration errors. Whole-second
TTLs and millisecond deadlines retain distinct validation rules. Invalid
shadow logging policy is reported only after actual shadow admission. These
bindings have focused native tests and share the generated policy and shadow
replay evidence above; the ledger identifies cases supported only by fixed or
native evidence.

`MetricsAdapter.ObserveEvent` accepts backend-neutral diagnostics.
`FailureIsolatedObserver` and `FailureIsolatedLogger` prevent exporter errors
or panics from replacing cache/source results. Shadow mismatch previews use
native JSON behavior and bounded UTF-8 output; unavailable previews remain
absent. The Prometheus and DogStatsD adapters preserve metric names, units,
labels, bucket boundaries, and counter increments. Logical cache keys never
become metric labels.

The Go Prometheus binding accepts an explicit native registry. Reconstructing
this adapter with the same registry and prefix reuses its collectors and
observations. `NewPrometheusMetricsWithBindings` additionally reuses externally
created, individually registered `CounterVec` and `HistogramVec` collectors.
Each `PrometheusCollectorBinding` supplies the actual collector and its
construction schema. All declared schemas, public descriptors, and registered
collector identities are checked before the remaining collectors are
registered as an atomic group. A failed compatibility check creates no metric
series or partial collector group.

This is an explicit Go binding adaptation: unlike the TypeScript integration,
native `client_golang` does not expose the bucket configuration of an empty
histogram. The caller therefore asserts its real construction schema,
including buckets, rather than the adapter inspecting private fields or
creating a temporary series. Supplying inaccurate schema metadata violates
that binding's precondition. Registration/reconfiguration must not race with
construction; concurrent metric observations remain supported. Tests cover
empty and populated compatible collectors, preserved observations, descriptor
and declared-bucket mismatches, an unregistered lookalike, and failure without
partial registration. The default constructor continues to reject externally
owned collisions unless their explicit bindings are supplied.

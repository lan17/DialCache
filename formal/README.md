# Executable DialCache specification

Quint defines DialCache's portable behavior through readable transitions and
independently checked properties. TypeScript and Go replay the same external
histories against their real APIs and compare the resulting values, errors,
cache effects and diagnostics. The suite targets language ports and regression
testing; passing finite executions is not a proof over every input or schedule.

## Reading order

1. [SPEC.md](./SPEC.md) explains the behavior, ownership rules and allowed races.
2. [CONTRACTS.md](./CONTRACTS.md) assigns stable obligations;
   [FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md) groups their known corners.
3. [AUTHORING.md](./AUTHORING.md) explains Quint's notation and how to add a
   distinguishing property and implementation replay.
4. Read the relevant model below, then its public-action regressions.
   [BEHAVIOR.md](./BEHAVIOR.md) and [CONFORMANCE.md](./CONFORMANCE.md) explain
   replay inputs and observations; [PROTOCOL.md](./PROTOCOL.md) covers bytes.
5. [SEMANTIC-COVERAGE.md](./SEMANTIC-COVERAGE.md) explains evidence accounting
   and mutation measurement. [GO-PARITY.md](./GO-PARITY.md) defines acceptance
   and native adaptations; [TEST-MAP.md](./TEST-MAP.md) helps locate evidence.

## What the suite checks

| Evidence | Execution | Meaning of a pass |
| --- | --- | --- |
| Model properties | Quint transitions, bounded exploration and named regressions | The checked model obeyed those properties within the explored bounds |
| Behavioral conformance | Sampled ITF histories and exported Quint regressions replayed in both ports | The real implementations produced the model's observations for those histories |
| Wire interoperability | Quint-derived primitive artifacts and complementary fixed vectors | The implementations matched those key, frame, envelope and invalidation cases |
| Native integration | Language, clock, codec, exporter and real Redis tests | The tested binding/environment satisfies its explicit obligations |

These kinds of evidence complement each other. Models can pass while a driver
or implementation diverges. A witness classification needs the distinguishing
public consequence; expected model state never supplies execution inputs or
actual observations. The reviewed behavioral inventory now gives every named
behavioral case a checked Quint reference and Quint-driven implementation
evidence. This is case accounting, not universal behavioral completeness.

[VALIDATION.md](./VALIDATION.md) records the completed local validation of the
reviewed implementation snapshot. Earlier reports retain their original
revisions and fingerprints; changed models, drivers or vectors require new
validation rather than inheriting a previous pass.

## Models and composition profiles

The verification models emphasize individual ownership or safety boundaries:

| Model | Starting point |
| --- | --- |
| [dialcache-core.qnt](./dialcache-core.qnt) | Enabled scopes, traversal and publication |
| [dialcache-runtime-policy.qnt](./dialcache-runtime-policy.qnt) | Sparse overlays and captured policy |
| [dialcache-coalescing-liveness.qnt](./dialcache-coalescing-liveness.qnt) | Flights, deadlines and abandoned sources |
| [dialcache-tracked-invalidation.qnt](./dialcache-tracked-invalidation.qnt) | Acquired snapshots, watermarks and delayed writes |
| [dialcache-stale-recovery.qnt](./dialcache-stale-recovery.qnt) | Retained bytes, age checks and recovery authority |
| [dialcache-shadow-validation.qnt](./dialcache-shadow-validation.qnt) | Diagnostic C0/source/C1 work and fills |
| [dialcache-redis-protocol.qnt](./dialcache-redis-protocol.qnt) | Frame/fence validation order |

Conformance profiles expose replayable external commands. The established
`core`, `effects`, `scope`, `recovery`, `policy`, `shadow`, `admission`, `layers`
and `independent` profiles remain separate slices. Six additional profiles
compose previously separate boundaries:

| Profile | Consequential interactions |
| --- | --- |
| [recovery-read](./dialcache-recovery-read-conformance.qnt) | Held reads/decode, request/local/remote publication, logical versus physical retention, compressed recovery, marker lifetime, and recovered absence skipping selected shadow work |
| [local-failure](./dialcache-local-failure-conformance.qnt) | Local read/write failures, source outcome preservation, and request publication through native storage fault seams |
| [runtime-boundaries](./dialcache-runtime-boundaries-conformance.qnt) | Omission versus invalid leaves, defaults, exact cohorts and policy capture at their invocation boundaries |
| [shadow-layers](./dialcache-shadow-layers-conformance.qnt) | Dark source publication, captured fills, request/local first hits, independent sources, and mixed served/dark capacity ownership |
| [local-clock](./dialcache-local-clock-conformance.qnt) | Fractional environment time, whole-millisecond local expiry, and the common process grid across separately constructed native instances |
| [source-budgets](./dialcache-source-budgets-conformance.qnt) | Default/unbounded/finite source budgets, held policy, followers, disabled calls and key failures |

These profiles deliberately bound callers, keys, contexts, capacities, payloads
and time. Their introduction does not imply that every product of those domains
is explored. [profiles.json](./profiles.json) records profile versions, input
encodings, smoke traces and implementation declarations.

## One execution inventory

[execution.json](./execution.json) is the source for scheduled models,
invariants, model regressions, exported replay regressions, vector generators,
seeds and exploration bounds. [coverage-witnesses.json](./coverage-witnesses.json)
records required consequences. [semantic-cases.json](./semantic-cases.json) and
[quint-case-audit.json](./quint-case-audit.json) give each evidence link a reviewed
scope. Native cases are separate in [feature-coverage.json](./feature-coverage.json).
Read the manifests or run their checkers for current totals instead of copying
counts between documents:

```sh
node formal/execution.mjs
node formal/check-semantic-coverage.mjs
node formal/check-feature-coverage.mjs
node formal/run-models.mjs check --dry-run
node formal/run-models.mjs generate --dry-run
```

A declaration alone does not count as a checked property. The inventory rejects
unscheduled regressions, stale references and positive scenarios/vectors without
a case assignment. A case may cite several witnesses; each must hold. Shared
histories or repeated citations are not independent proofs.

## Generating and replaying behavior

Use the supported Node/Go versions and Quint version pinned by CI. Install
repository dependencies with `corepack pnpm install --frozen-lockfile`, then:

```sh
npm install --global @informalsystems/quint@0.32.0
bash formal/check.sh
bash formal/generate-traces.sh
DIALCACHE_MBT_TRACE_DIR=.formal-traces/conformance \
DIALCACHE_EFFECTS_TRACE_DIR=.formal-traces/effects \
DIALCACHE_FEATURE_TRACE_DIR=.formal-traces/features \
DIALCACHE_COVERAGE_EVIDENCE_DIR=.formal-traces/go-parity-witnesses \
  corepack pnpm exec vitest run test/formal-conformance.test.ts test/formal-effects.test.ts \
  test/formal-features.test.ts test/formal-local-clock.test.ts \
  test/formal-behavior.test.ts test/formal-protocol-vectors.test.ts --coverage.enabled=false
```

Checking typechecks every scheduled model, explores its invariants and runs its
named regressions. Generation follows the same manifest and checks committed
Quint-derived wire artifacts. `QUINT_SEED` overrides the exploration seed; the
manifest records the default backend, thread count, sample and transition bounds.
These are bounded simulations, not exhaustive mathematical proofs.

For `explicit-v1` profiles, every public transition records
`input: { name, choice }`. Named regressions use those same public actions and
export under `.formal-traces/regressions/<profile>/<test>.itf.json`. The exporter
normalizes that explicit input into the common replay envelope; it never infers
commands from expected state differences. Private state-patch regressions remain
model-only and must not be exported as implementation histories.

Both ports replay the sampled corpus **and** the exact scheduled regression
inventory. Regressions guarantee reviewed exact boundaries independently of
random reachability. Sampled traces explore additional schedules; required
witness gates check their consequences across the combined corpus. Without
trace selectors, ordinary tests use committed smoke traces and fixed portable
scenarios. A smoke pass cannot satisfy the full corpus completion gate.

Replay one failing feature history with either language:

```sh
DIALCACHE_FEATURE_TRACE_FILE=.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json \
  corepack pnpm exec vitest run test/formal-features.test.ts --coverage.enabled=false
DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json" \
  go -C go test -race -count=1 -run '^TestFeatureConformance$' ./...
```

Core/effects failures use `DIALCACHE_MBT_TRACE_FILE` or
`DIALCACHE_EFFECTS_TRACE_FILE` and their corresponding test files. Local-clock
uses the feature selectors with `test/formal-local-clock.test.ts` and the Go
local-clock replay. Failures print the input, expected observation, actual
observation and reproduction command.

## Wire artifacts and native boundaries

Scheduled `vectorExport` entries identify the Quint model, generator, artifact,
source hashes and case count. Frame/text/duration, invalidation and key/cohort
models compute their own expected outputs. Exporters translate representation;
they do not call production transforms to obtain expected bytes or states.
Envelope expansion adds marker/threshold/selection behavior with independently
verified native codec outcomes and encoded sizes as environmental inputs.
[PROTOCOL.md](./PROTOCOL.md) describes the exact scopes and remaining boundaries.

The fixed [protocol-vectors.json](./protocol-vectors.json) and
[invalidation-vectors.json](./invalidation-vectors.json) remain complementary
examples. Actual invalidation transitions run on Redis/Valkey, with atomic
fixture setup and observation and only measured server elapsed time subtracted
from finite TTL expectations. Integration also checks primary routing, cluster
hash tags and bidirectional TypeScript/Go payload and invalidation behavior.

Native tests retain API registration, borrowed-reference behavior, custom clock
resolution, exporter registration, codec resources and adapter cancellation.
The local-clock profile connects a fractional-time Quint contract to real
default clock construction. Local-failure connects portable failure effects to
native fault injection; neither seam changes the production API. Full IEEE754
shortest decimal formatting, arbitrary integer widths, native zstd stream quirks
and actual resource ceilings retain their separately stated binding evidence.

## Go completion and fault challenges

After the TypeScript replay records exact corpus/witness fingerprints:

```sh
DIALCACHE_MBT_TRACE_DIR="$PWD/.formal-traces/conformance" \
DIALCACHE_EFFECTS_TRACE_DIR="$PWD/.formal-traces/effects" \
DIALCACHE_FEATURE_TRACE_DIR="$PWD/.formal-traces/features" \
DIALCACHE_WITNESS_EVIDENCE_DIR="$PWD/.formal-traces/go-parity-witnesses" \
  go -C go test -race -count=1 -json ./... > .formal-traces/go-replay.jsonl
node formal/check-go-replay.mjs
go -C go test -race -tags integration -count=1 -run '^TestRedisIntegration$' ./...
node formal/measure-semantics.mjs
node formal/measure-go-semantics.mjs
```

The completion checker derives required replay leaves, regression inventory,
protocol cases and witness gates from current metadata. A partial, skipped or
smoke-only run cannot pass. Mutation runners compile each reviewed fault and
retain raw assertion reports in isolated copies. Compile/import failures,
missing witnesses, crashes and watchdog failures are infrastructure failures,
not detections. Reports retain exact revisions, source/configuration hashes,
corpus hashes, tool versions, counts and survivors.

Source-duration and source-ownership monitors also inspect actual effect
histories without expected state. A compiling model mutation challenges the
source-relative deadline invariant. These checks establish selected safety
clauses, not full refinement, arbitrary scheduling fairness or eventual progress.

## Assumptions and maintenance

Tracked reads require an atomic primary observation. Wall clocks supply frame
and invalidation stamps; monotonic clocks govern local expiry and deadlines.
Stable retained bytes, immutable reused values, executor progress, suitable
application-owned resource budgets and watermark durability are environmental
obligations. Invalidation deliberately does not revoke already acquired bytes,
request memo, local values or registered work. Shadow mismatch is diagnostic,
not repair or a linearizable source/cache snapshot.

For a changed rule, update Quint and its independent check, retain a
consequential replay, update both implementations as needed, and review the
case/audit/native mappings. [source-audit.json](./source-audit.json) accounts for
reviewed test declarations and documentation sections; it does not imply that
every assertion has a formal equivalent. Preserve historical reports after
input changes until fresh execution completes.

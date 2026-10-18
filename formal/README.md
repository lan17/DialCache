# Executable DialCache specification

The formal/ tree defines DialCache's portable behavior once, as Quint models,
and checks every language port against histories generated from them. A shared
[coordinator](./guides/GLOSSARY.md#coordinator) replays each history against a
small [driver](./guides/GLOSSARY.md#driver) in each port; the driver sees only
commands, so a port cannot pass by predicting its own results. TypeScript is the
reference the models describe; when the two disagree, the fix is a named
[regression](./guides/GLOSSARY.md#corpus-history-regression-exported-run-and-public-only-run)
and a recorded decision, not an edit to whichever side is easier.

This page explains the setup from the models down to the CI lanes, then lists
where everything lives. [guides/README.md](./guides/README.md) indexes the prose
by kind and [GLOSSARY.md](./guides/GLOSSARY.md) defines the terms.

## Start with your task

| Task | Read first |
| --- | --- |
| See how the pieces fit together | [The setup, top to bottom](#the-setup-top-to-bottom) |
| Understand system behavior | [SPEC.md](./guides/SPEC.md), then the relevant model in [models/README.md](./models/README.md) |
| Follow one rule into every implementation | [WALKTHROUGH.md](./guides/WALKTHROUGH.md) |
| Change a behavior or extend coverage | [AUTHORING.md](./guides/AUTHORING.md) |
| Implement another language | [PORTING.md](./guides/PORTING.md) and [PROTOCOL.md](./guides/PROTOCOL.md) |
| Locate or reproduce a failing check | [TEST-MAP.md](./guides/TEST-MAP.md) and [Run it](#run-it) |
| Look up one contract, case, challenge or mutant | `node formal/tools/where.mjs C45`, or `where.mjs M01`; `--json` for agents |
| Interpret validation results | [VALIDATION.md](./guides/VALIDATION.md) |
| Look up a term | [GLOSSARY.md](./guides/GLOSSARY.md) |

## The setup, top to bottom

Six stages turn a rule into evidence. Each stage below says what it is for,
which tool does it, what comes out and where to read more. The diagram
summarizes the same flow: yellow boxes are written by hand, blue boxes are the
tools, green boxes are what they produce, and the numbers are the stages below.

```mermaid
flowchart LR
  M["1. State<br/>Quint models, models/"]:::hand
  X["Manifests and catalogs<br/>catalogs/"]:::hand
  D["Native drivers<br/>typescript/ go/ rust/ python/"]:::hand
  RM["2. Check<br/>run-models.mjs check, check-model-properties.mjs"]:::tool
  GA["3. Generate<br/>run-models.mjs generate, generate-artifacts.mjs, witnesses.mjs"]:::tool
  CO["4. Replay<br/>replay/coordinator.mjs"]:::tool
  CK["5. Account, 6. Gate<br/>measure-*.mjs, check-*.mjs"]:::tool
  MR["Model and challenge reports"]:::out
  CP["Corpus and regressions<br/>.formal-traces/"]:::out
  GF["Committed artifacts<br/>generated/"]:::out
  WE["Witness evidence"]:::out
  RP["Completion reports"]:::out
  M --> RM --> MR --> CK
  X --> RM
  M --> GA --> CP --> CO
  GA --> GF --> CO
  GA --> WE --> CK
  X --> GA
  CO <--> D
  CO --> RP --> CK
  X --> CK
  classDef hand fill:#fff7d6,stroke:#b59b00,color:#1f2328
  classDef tool fill:#e3f0ff,stroke:#2b6cb0,color:#1f2328
  classDef out fill:#e8f7ea,stroke:#2f855a,color:#1f2328
```

### 1. State the rule in Quint

Every portable rule is written once, in Quint.
[cache-rules.qnt](./models/cache-rules.qnt) holds the shared
[judgments](./guides/GLOSSARY.md#judgment-judged-once-and-applied-from-a-judgment)
every model imports: age, expiry, deadline and fence. The [kernel
library](./models/kernel/README.md) builds on them, stating each rule as a pure
transition, one concern per module. A conformance
[profile](./guides/GLOSSARY.md#profile-conformance-profile) composes those
transitions into a small system with public actions and records each step's
command in an explicit input, so replay never infers a command from changed
state. Three other kinds of model sit beside the profiles: verification models,
which are model-checked; connection models, which check a profile's history
against [cache-contract.qnt](./models/cache-contract.qnt); and wire models,
which each generate one vector file. Each named `Test` run is a regression that
pins one boundary.

Read more: [SPEC.md](./guides/SPEC.md) for the behavior,
[models/README.md](./models/README.md) for the file groups,
[kernel/README.md](./models/kernel/README.md) for the composition rules,
[AUTHORING.md](./guides/AUTHORING.md) to change a model.

### 2. Check the models

Before anything is generated, every model must hold its own properties.
[execution.json](./catalogs/execution.json) schedules each model with its
invariants, bounds and exported runs. `run-models.mjs check` typechecks each
scheduled model and runs it with Quint's Rust evaluator, the simulator inside
Quint, not the Rust port. `check-model-properties.mjs` then runs the
[challenge](./guides/GLOSSARY.md#challenge-fault-mutant-and-reproducer) catalog:
for every model, at least one deliberate single-site fault that a named
invariant must catch, with a reproducer that fails only under the fault.
`lint-profiles.mjs` keeps the composition lint from loosening. Together these
are `make formal-check`, the Quint evidence [lane](./guides/GLOSSARY.md#lane).
Separately, `make model-check` proves the finite boundary rules in
[dialcache-rule-checks.qnt](./models/dialcache-rule-checks.qnt) with Apalache.

Read more: [VALIDATION.md](./guides/VALIDATION.md) for what each run proves,
[CHALLENGES.md](./generated/CHALLENGES.md) for the challenge index,
[AUTHORING.md](./guides/AUTHORING.md#mapping-every-challenge-to-native-mutants)
for writing one.

### 3. Generate the corpus and the committed artifacts

Generation turns the models into the histories every port will replay. `make
formal-generate` runs `run-models.mjs generate`, which writes the sampled corpus
and the exported regressions under `.formal-traces/`; that directory is never
committed. It then runs `witnesses.mjs`, which checks that the corpus reaches
every required [witness](./guides/GLOSSARY.md#witness-label-and-classifier)
label in [coverage-witnesses.json](./catalogs/coverage-witnesses.json) and fails
when a label's hits fall below
[witness-baseline.json](./catalogs/witness-baseline.json). That step is the only
producer of the witness evidence the port lanes read. The committed artifacts
under [generated/](./generated/README.md) are smaller and rebuilt by
`generate-artifacts.mjs --write`: one [smoke](./guides/GLOSSARY.md#smoke) trace
per profile, the lock that pins every input and output hash, and the wire
vectors. `make fixtures-check` recomputes them and fails on any difference.

Read more: [generated/README.md](./generated/README.md),
[catalogs/README.md](./catalogs/README.md),
[PORTING.md](./guides/PORTING.md#witness-evidence) for the witness evidence
fields.

### 4. Replay every history in every port

Replay is where the models meet the real libraries. Each history is an
[ITF](./guides/GLOSSARY.md#itf-informal-trace-format) trace, the JSON trace
format Quint writes. The [coordinator](./replay/coordinator.mjs) runs it against
a driver over a typed wire protocol. It hands the driver the fixture and each
step's recorded command, never the predicted observation. The driver calls the
real library, controls the external gates and clocks, and reports what happened.
The coordinator checks the shape of each observation, rejecting a malformed one
as an infrastructure error, then compares it with the model's prediction step by
step. Profile descriptors under [replay/](./replay/README.md) decode each
profile's integer choices into driver commands; the four drivers are listed
under Reference. `make smoke` replays the committed traces in all four ports;
the `make formal-<port>` targets replay the complete corpus and write a
completion report.

Read more: [WALKTHROUGH.md](./guides/WALKTHROUGH.md) follows one history through
the ports, [PORTING.md](./guides/PORTING.md) is the driver contract with its
[observation contract](./guides/PORTING.md#observation-contract),
[replay/README.md](./replay/README.md) lists the modules,
[CONFORMANCE.md](./guides/CONFORMANCE.md) describes the core profile's trace
format and trust boundary.

### 5. Account for the evidence

Did replay cover enough? `conformance.mjs check` accepts a completion report
only when every scheduled case passed exactly once against the corpus and
sources the report names. Witness coverage is checked across the named
regressions and the sampled corpus together, so a corpus that stops reaching a
corner is visible even while the regressions keep the gate green.

Do the assertions bite? The mutation campaigns inject known faults into each
port and require replay to catch them.
[mutations.json](./catalogs/mutations.json) and
[rust-mutations.json](./catalogs/rust-mutations.json) catalog the faults; `make
mutations-ts`, `make mutations-go` and `make mutations-rust` measure that the
generated histories, the real-Redis invalidation vectors and the shared
witnesses detect every one. Each model challenge maps to the native mutant that
injects the same wrong behavior, so a challenge is evidence that the corpus
would catch that mistake in a port, not only in the model.
[semantic-cases.json](./catalogs/semantic-cases.json) and
[feature-coverage.json](./catalogs/feature-coverage.json) index every case to
its evidence, and `where.mjs` answers from them.

Read more: [SEMANTIC-COVERAGE.md](./guides/SEMANTIC-COVERAGE.md) for the
evidence inventory and the mutation comparison,
[FEATURE-COVERAGE.md](./guides/FEATURE-COVERAGE.md),
[TEST-MAP.md](./guides/TEST-MAP.md), [CONTRACTS.md](./guides/CONTRACTS.md) for
the obligation IDs, [MUTANTS.md](./generated/MUTANTS.md) for the mutant index.

### 6. Gate a change

The last stage makes review state checkable, so a change cannot quietly outrun
its evidence. The ledgers in [catalogs/](./catalogs/README.md) record what was
reviewed. [source-audit.json](./catalogs/source-audit.json) keys every reviewed
guide and test by its headings and contract dispositions and is refreshed with
`check-source-audit.mjs --refresh <path>`.
[go-parity.json](./catalogs/go-parity.json) pins the inputs the Go parity claim
rests on and is re-pinned with `check-go-parity.mjs --refresh-inputs`. The lint,
witness and style baselines ratchet: each can only tighten. `make audit` runs
those checks with the coverage inventories, the fixture and read-view freshness
checks and the Quint style caps.

The [differential](./guides/GLOSSARY.md#differential) guards the composed
profiles. `make differential` generates each profile's corpus from the merge
base with `origin/main` and from the working tree, then replays each corpus
through the other text. A change in observable behavior fails it unless the
profile declares the change by bumping its `behaviorVersion`.

Read more: [TEST-AUDIT.md](./guides/TEST-AUDIT.md) for keeping the ledger
current, [GO-PARITY.md](./guides/GO-PARITY.md),
[tools/README.md](./tools/README.md) for every script behind a target.

## What is and is not claimed

The suite combines model properties, generated histories, independently computed
wire vectors, fixed examples and native integration tests. The fixed corpora,
[protocol-vectors.json](./catalogs/protocol-vectors.json),
[invalidation-vectors.json](./catalogs/invalidation-vectors.json) and
[behavioral-scenarios.json](./catalogs/behavioral-scenarios.json), carry
handwritten expectations; their evidence mappings do not mechanically prove that
each fixed assertion agrees with Quint. The models use declared finite domains,
and the profiles deliberately bound callers, keys, contexts, capacities,
payloads and time without claiming that every product of those domains is
explored. Environmental assumptions, allowed races and the limits of conformance
claims are stated once in
[SPEC.md](./guides/SPEC.md#assumptions-evidence-and-claims); the wire and
binding obligations are in [PROTOCOL.md](./guides/PROTOCOL.md) and
[GO-PARITY.md](./guides/GO-PARITY.md).

## Pipelines

Three GitHub Actions workflows run the same Make targets as local work. The
diagram is the full workflow's job graph; all three workflows are described
below it.

```mermaid
flowchart LR
  CM["check-models<br/>make formal-check"]
  GE["generate<br/>make formal-generate"]
  SY["symbolic<br/>make model-check"]
  EX["exploration<br/>make explore"]
  GE --> TSP["typescript-parity<br/>make formal-ts"] & GOP["go-parity<br/>make formal-go"] & RSP["rust-parity<br/>make formal-rust"] & PYP["python-parity<br/>make formal-python"]
  GE --> TSM["typescript-mutations, 6 shards<br/>make mutations-ts"] & GOM["go-mutations, 10 shards<br/>make mutations-go"] & RSM["rust-mutations, 3 shards<br/>make mutations-rust"]
  CM & SY & EX & TSP & GOP & RSP & PYP & TSM & GOM & RSM --> AG["formal-full aggregate"]
```

- **CI** ([ci.yaml](../.github/workflows/ci.yaml)) runs each language's native checks and real-server integration, the cross-language wire suite and the package floor. Its aggregate `test` job is the required check on `main`. A docs-only change clears it in a few minutes.
- **Formal smoke** ([formal.yaml](../.github/workflows/formal.yaml)) runs `make audit smoke`: the ledgers and inventories, then the committed traces in all four ports. When [fixture-scope.mjs](../.github/scripts/fixture-scope.mjs) detects a changed Quint input, the job also recomputes every committed artifact with pinned Quint, and on a pull request four `differential` shards replay the composed profiles against the merge base. Any edit to a Quint source counts, including a comment. The shards are migration evidence, not a completion claim, and take up to about half an hour.
- **Full formal verification** ([formal-full.yaml](../.github/workflows/formal-full.yaml)) runs weekly on `main` and on demand for any branch. The parity and mutation lanes wait only for `generate`; the aggregate requires every lane and keeps a summary artifact for 90 days. The scheduled run takes about two and a half hours.

The pull request lanes are fast checks. A behavior, model or replay change
requires the full workflow on its branch before merge, and the PR body records
which run. [VALIDATION.md](./guides/VALIDATION.md) explains how to choose a run
and how to read the reports.

## Where things are

| Directory | Holds | Index |
| --- | --- | --- |
| [guides/](./guides/) | The reviewed guides: contracts, how-tos and coverage reports | [guides/README.md](./guides/README.md) |
| [models/](./models/) | Every Quint model and shared helper, with the kernel library in `kernel/` and its fixtures in `fixtures/kernel/` | [models/README.md](./models/README.md) |
| [replay/](./replay/) | The shared replay coordinator, profile descriptors and witness classifiers every port executes | [replay/README.md](./replay/README.md) |
| [tools/](./tools/) | The Node scripts behind the `make` targets: checks, generators, measurements and runners | [tools/README.md](./tools/README.md) |
| [catalogs/](./catalogs/) | Hand-maintained manifests, evidence catalogs, ledgers, baselines and the fixed vector corpora; indexes, so a reader learns a rule from the Quint and the guides, not from these | [catalogs/README.md](./catalogs/README.md) |
| [generated/](./generated/) | Smoke traces, the fixtures lock, generated vectors and the generated read views ([PROFILES.md](./generated/PROFILES.md), the [CHALLENGES.md](./generated/CHALLENGES.md) and [MUTANTS.md](./generated/MUTANTS.md) indexes); regenerated, never edited | [generated/README.md](./generated/README.md) |

## Run it

```sh
make help          # Targets and prerequisites.
make check         # Native checks, package, docs and inventories.
make audit         # Ledgers, inventories, generated views and the Quint style caps.
make smoke         # Committed Quint-derived histories in every port.
make formal        # Quint model checks, full corpus and every port's completion.
make differential  # Replay composed profiles' reference corpus through the working tree.
make model-check   # Separate finite symbolic checks; Java 21 and tar required.
make mutations     # Challenge assertions against the generated corpus.
make integration   # Real Redis/Valkey/Cluster in every port and interoperability.
make explore       # Fresh recorded seed in an isolated source snapshot.
make ci NODE22_BIN=/absolute/path/to/node22/bin/node  # All local lanes; the package floor needs exact Node 22.15.0.
```

Pinned toolchain versions, the Docker and Java requirements and the environment
variables are in [VALIDATION.md](./guides/VALIDATION.md#prerequisites). After an
intentional model edit, run `node formal/tools/generate-artifacts.mjs --write`
before `make fixtures-check`. To replay one failing history, see [Reproducing
one history](./guides/VALIDATION.md#reproducing-one-history) and the
walkthrough's [run this example](./guides/WALKTHROUGH.md#run-this-example).

The inventories answer counts and schedules; ask them rather than trusting a
number in a document:

```sh
node formal/tools/execution.mjs
node formal/tools/check-semantic-coverage.mjs
node formal/tools/check-feature-coverage.mjs
node formal/tools/run-models.mjs check --dry-run
```

## Reference

Every part of the system, one line per group, for reading further.

- **Contract guides:** [SPEC.md](./guides/SPEC.md), [CONTRACTS.md](./guides/CONTRACTS.md), [PROTOCOL.md](./guides/PROTOCOL.md), [CONFORMANCE.md](./guides/CONFORMANCE.md), [BEHAVIOR.md](./guides/BEHAVIOR.md).
- **Tooling guides:** [WALKTHROUGH.md](./guides/WALKTHROUGH.md), [AUTHORING.md](./guides/AUTHORING.md), [PORTING.md](./guides/PORTING.md), [VALIDATION.md](./guides/VALIDATION.md), [GO-PARITY.md](./guides/GO-PARITY.md), [GLOSSARY.md](./guides/GLOSSARY.md).
- **Coverage guides:** [SEMANTIC-COVERAGE.md](./guides/SEMANTIC-COVERAGE.md), [FEATURE-COVERAGE.md](./guides/FEATURE-COVERAGE.md), [TEST-MAP.md](./guides/TEST-MAP.md), [TEST-AUDIT.md](./guides/TEST-AUDIT.md); measurements at the revisions they were made in [HISTORY.md](./guides/HISTORY.md).
- **Generated views:** [PROFILES.md](./generated/PROFILES.md), [CHALLENGES.md](./generated/CHALLENGES.md), [MUTANTS.md](./generated/MUTANTS.md).
- **Shared Quint helpers:** [cache-rules.qnt](./models/cache-rules.qnt), [cache-contract.qnt](./models/cache-contract.qnt), [cohort-boundaries.qnt](./models/cohort-boundaries.qnt), [conformance-observations.qnt](./models/conformance-observations.qnt), [wire-text.qnt](./models/wire-text.qnt); the [kernel library](./models/kernel/README.md) and its [fixtures](./models/fixtures/kernel/).
- **Verification models:** [core](./models/dialcache-core.qnt), [runtime-policy](./models/dialcache-runtime-policy.qnt), [tracked-invalidation](./models/dialcache-tracked-invalidation.qnt), [stale-recovery](./models/dialcache-stale-recovery.qnt), [redis-protocol](./models/dialcache-redis-protocol.qnt), [rule-checks](./models/dialcache-rule-checks.qnt).
- **Conformance profiles:** [core](./models/dialcache-conformance.qnt), [effects](./models/dialcache-effects-conformance.qnt), [scope](./models/dialcache-scope-conformance.qnt), [recovery](./models/dialcache-recovery-conformance.qnt), [policy](./models/dialcache-policy-conformance.qnt), [shadow](./models/dialcache-shadow-conformance.qnt), [admission](./models/dialcache-admission-conformance.qnt), [layers](./models/dialcache-layers-conformance.qnt), [independent](./models/dialcache-independent-conformance.qnt), [recovery-read](./models/dialcache-recovery-read-conformance.qnt), [local-failure](./models/dialcache-local-failure-conformance.qnt), [runtime-boundaries](./models/dialcache-runtime-boundaries-conformance.qnt), [shadow-layers](./models/dialcache-shadow-layers-conformance.qnt), [local-clock](./models/dialcache-local-clock-conformance.qnt), [source-budgets](./models/dialcache-source-budgets-conformance.qnt), [dark-layers](./models/dialcache-dark-layers-conformance.qnt), [shadow-read-deadlines](./models/dialcache-shadow-read-deadlines-conformance.qnt); one line each in [models/README.md](./models/README.md), decodings in [PROFILES.md](./generated/PROFILES.md).
- **Connection and wire models:** [source](./models/dialcache-source-connection.qnt), [recovery](./models/dialcache-recovery-connection.qnt), [recovery-read](./models/dialcache-recovery-read-connection.qnt), [independent](./models/dialcache-independent-connection.qnt), [shadow-layers](./models/dialcache-shadow-layers-connection.qnt); [key-protocol](./models/dialcache-key-protocol.qnt), [frame-vectors](./models/dialcache-frame-vectors.qnt), [envelope-vectors](./models/dialcache-envelope-vectors.qnt), [invalidation-transition](./models/dialcache-invalidation-transition.qnt).
- **Manifests and catalogs:** [execution.json](./catalogs/execution.json), [profiles.json](./catalogs/profiles.json), [semantic-cases.json](./catalogs/semantic-cases.json), [coverage-witnesses.json](./catalogs/coverage-witnesses.json), [feature-coverage.json](./catalogs/feature-coverage.json), [mutations.json](./catalogs/mutations.json), [rust-mutations.json](./catalogs/rust-mutations.json), [fixture-recipes.json](./catalogs/fixture-recipes.json), [behavioral-scenarios.json](./catalogs/behavioral-scenarios.json); the ledgers and baselines [source-audit.json](./catalogs/source-audit.json), [go-parity.json](./catalogs/go-parity.json), [profile-lint-baseline.json](./catalogs/profile-lint-baseline.json), [witness-baseline.json](./catalogs/witness-baseline.json), [style-allowlist.json](./catalogs/style-allowlist.json); the fixed corpora [protocol-vectors.json](./catalogs/protocol-vectors.json), [invalidation-vectors.json](./catalogs/invalidation-vectors.json).
- **Replay:** [coordinator.mjs](./replay/coordinator.mjs), [bindings.mjs](./replay/bindings.mjs), [settlement.mjs](./replay/settlement.mjs), [protocol.schema.json](./replay/protocol.schema.json); the descriptors [core.mjs](./replay/core.mjs), [effects.mjs](./replay/effects.mjs), [features.mjs](./replay/features.mjs), [local-clock.mjs](./replay/local-clock.mjs) and [profiles/](./replay/profiles/); the classifiers in [witnesses/](./replay/witnesses/).
- **Drivers:** [behavior-driver.ts](../typescript/test/formal/behavior-driver.ts), [behavior_driver_test.go](../go/behavior_driver_test.go), [driver.rs](../rust/tests/formal/driver.rs), [driver.py](../python/tests/formal/driver.py).
- **Tools:** [validation.mjs](./tools/validation.mjs) dispatches every target; [execution.mjs](./tools/execution.mjs), [where.mjs](./tools/where.mjs), [run-models.mjs](./tools/run-models.mjs), [generate-artifacts.mjs](./tools/generate-artifacts.mjs), [witnesses.mjs](./tools/witnesses.mjs), [differential.mjs](./tools/differential.mjs), [explore.mjs](./tools/explore.mjs), [check-source-audit.mjs](./tools/check-source-audit.mjs), [check-go-parity.mjs](./tools/check-go-parity.mjs), [check-style.mjs](./tools/check-style.mjs); the rest in [tools/README.md](./tools/README.md).

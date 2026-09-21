# Validation and evidence

Run validation from the repository root. The Make targets are shared by local
work and GitHub Actions; [README.md](./README.md#generating-and-replaying-behavior)
lists tool prerequisites and focused reproduction commands.

## Choosing a run

| Task | Command | Evidence |
| --- | --- | --- |
| Routine implementation checks | `make check` | Native tests, coverage, package, docs and source audits |
| Full portable acceptance | `make formal` | Rust model checks, generated histories, TS replay, shared witness evaluation, Go replay, exact completion inventories; no Java |
| Finite symbolic rules | `make model-check` | Scheduled bounded checks with checksummed standalone Apalache; requires Java 21, `tar` and pinned Quint |
| Challenge implementation assertions | `make mutations` | Compiling semantic faults tested against both completed ports |
| Real server behavior | `make integration` | Redis, Valkey, Cluster and cross-language interoperability |
| Explore another schedule sample | `make explore` | Separate source snapshot, recorded random seed, both-port replay |
| Check composed profiles against their previous text | `make differential` | Lint baseline, then both-direction replay against the merge base with `origin/main`; fails on any disagreement or trace growth above the model's bound |
| All required local lanes | `make ci NODE22_BIN=/absolute/path/to/node22/bin/node` | Native, formal, separate symbolic, integration and mutation runs |

`make formal-check` is the Quint evidence lane: typechecks and bounded runs of
every scheduled model, the public regressions and the model mutation challenges.
It produces nothing the port lanes consume, so the hosted workflow runs it as a
`check-models` job beside generation; only the aggregate waits for it.
`make formal-generate` runs `node formal/witnesses.mjs evaluate --profile all`
immediately after generation, before either port replays. That shared,
language-neutral step is the sole producer of `.formal-traces/go-parity-witnesses/`;
the TypeScript suite only checks the same gate. `make formal-ts`, `make formal-go`,
`make mutations-ts` and `make mutations-go` depend only on the generated corpus
and that witness evidence, so the hosted workflow runs them in parallel and the
aggregate requires all of them.

The pull request lane's `differential` job runs `make differential` against the
base branch whenever a Quint input changes: a composed profile that changes any
driver-asserted observation of its previous corpus, or accepts an input the
previous text refused, fails unless the manifest declares the change by bumping
its `differential.behaviorVersion`. The job is a matrix of four shards,
`differential (1)` to `differential (4)`: each checks the lint baseline and the
kernel fixtures, then replays a round-robin quarter of the composed profiles
sorted by name (`DIFFERENTIAL_SHARD=<index>/4`; one unsharded job overran its
60-minute budget) and preserves its reports and replay logs as the
`formal-differential-<index>` artifact. The reports are migration evidence, not
a conformance completion report; the profile lanes still run.

The evaluator ends with a per-profile witness report: required labels with at
most three sampled hits and no regression, labels pinned by a regression but
rarely sampled, and the distinct sampled action and observation sequences. It
compares each required label's sampled hits with `formal/witness-baseline.json`
and fails generation when a gated label drops below the tolerance, so a corpus
that stops reaching its corners is visible even though named regressions keep
the completion gate green. [PORTING.md](./PORTING.md#witness-evidence) defines
the evidence fields, the report and the baseline.

Within a lane, `run-models.mjs`, `check-model-properties.mjs` and
`generated-fixtures.mjs` run independent Quint processes concurrently so a
multi-core runner is not left idle; each process keeps the single Quint thread
that `execution.json` pins. `QUINT_JOBS` sets how many processes run at once;
the default is the machine's available parallelism, capped at one process per
2 GiB of memory because a Quint process that generates a full trace corpus
peaks near 1.7 GiB. Results do not depend on that number: every process has
its own seed, inputs and output paths, so the corpus, the fixtures and the
challenge report are identical for any worker count.

A behavior, model, or replay change requires full validation of its current
inputs before merge. The default PR workflow runs faster checks; it does not
enforce this full-validation requirement. The manual full workflow can target a
PR branch. Its model check and symbolic jobs run separately from corpus
generation. Its weekly run validates the selected `main` revision and includes
exploration; a manual run can enable the `exploration` option. The aggregate
gate requires exploration when selected or scheduled. Each PR body should
identify the revision and completed local or hosted validation.

## Reading a completion report

Evidence lives under `.formal-traces/` and in the workflow's uploaded artifacts.
The prepared `ts-context.json` and `go-context.json` bind the specification,
implementation, harness, corpus and required case inventory. Their matching
completion reports require every scheduled case to pass. A changed input,
missing result, skipped case, duplicate result or stale report fails acceptance.

```sh
node formal/conformance.mjs check .formal-traces/ts-completion.json .formal-traces/ts-context.json
node formal/conformance.mjs check .formal-traces/go-completion.json .formal-traces/go-context.json
```

Keep reports with their source/corpus fingerprints and native assertion output.
Copying a report to another revision does not revalidate that revision. Scope
and environmental assumptions are defined once in
[SPEC.md](./SPEC.md#assumptions-evidence-and-claims).

## Mutation evidence

Each native mutation report includes a `boundary` entry for every mapped
challenge. A separate coordinator replay continues after observation mismatches
and records the differing fields at every step; it preserves the normal driver
and settlement checks. `confirmed` means the intended checkpoint differs on a
consequential field or a newly differing counter; `side-effect-only` means other
observations differ, and `not-divergent` means the history still agrees.
`unreached` records an incomplete history, missing recording, or driver failure.
Exported-vector model runs carry `origin: vector`; both ports execute the named
native API against the exact vector samples and must earn `confirmed` on the
declared fields. Clean boundary baselines must complete without divergences.
The mutation gate requires `confirmed` for every mapping with an exported
history or vector reproducer in both ports, alongside the required-cohort gate.
It recomputes verdicts from current declarations and recordings: missing
mapping entries, stale checkpoints and absent clean baselines fail, even when
the report claims confirmation. Historical `unreproduced` states remain
readable, but both current backlogs are empty and the execution audit forbids
reopening them. A mapped fault cannot replace its portable evidence with a
model run that exports no vector.

Read the evidence with `node formal/mutation-reports.mjs boundary --report
<report.json>`. Optional `--cohorts <directory>` reads historical assertion
diagnostics, which show only the first mismatch and cannot establish that a
later checkpoint was reached. Diagnostics with incompatible raw and projected
record shapes are not credited. Ungated inspection can read historical reports;
it does not validate the current checkout. `--gate` additionally requires a
complete report whose catalog, measured source inputs, recorded configuration
and exact corpus fingerprints match the checkout. Keep the measured corpus
artifact when checking a downloaded report; regenerating it may change its
bytes. Missing fingerprints fail the gated command, as does any exported
history or vector boundary that is not `confirmed`. Historical `vector` gap
states remain readable but do not satisfy current vector declarations.

Model mutations challenge the specification's independent properties.
Implementation mutations challenge the assertions that connect generated
histories to real TS/Go behavior. Report these measurements separately, including
survivors. Structural invariants and semantic obligations are also different
units; a total invariant count is not a measure of specification strength.

Every mutation must compile, its unmodified baseline must pass, and detection
must come from a semantic assertion or invariant counterexample. A tool failure,
missing witness, crash or timeout is a failed measurement. An unhandled
rejection under a mutant is the mutant settling a promise the suite was not
awaiting at that moment; the report records it beside the failed assertions,
and on its own it is a failed measurement, never a detection. The selected fault
catalogs and per-run reports define the denominator; do not infer a percentage
of all possible defects from their scores.

The model catalog in `execution.json` covers every scheduled model with no
waivers; `node formal/execution.mjs` reports the challenge and distinct fault
counts. Its report distinguishes those two counts and marks a filtered `--only`
run as partial; only the complete run is evidence. A challenge with a deterministic reproducer is additionally
replayed on the clean and mutated model and must fail only under the fault, at
the expectation the manifest declares; the report records that outcome per
challenge, and `node formal/execution.mjs` reports how many challenges still
wait in `reproducerBacklog`.

Each challenge also maps to the native mutant that injects the same wrong
behavior into both ports through its `nativeMutants` entry, or explains why no
native line exists; `node formal/execution.mjs` checks the mapping against
the mutant catalog (`formal/mutations.json`, one entry per fault with a
TypeScript and a Go section), anchors every catalog edit in the port text, and
reports the challenges still waiting in `nativeMutantBacklog`. The mutation lanes must detect every mapped mutant in
their generated cohort, so a mapped challenge is evidence that the corpus
would catch that mistake in a port, not only that the model would. See the
[authoring rules](./AUTHORING.md#mapping-every-challenge-to-native-mutants).

The weekly full workflow shards each mutation lane over the workflow matrix;
`test/formal-validation.test.ts` pins how many mutants a shard may hold within
its timeout, so catalog growth fails the pull request until the matrix grows.
The Go lane bounded the whole run
when it had 13 mutants on three shards (25 minutes on a fast runner, 47 to 48
minutes on the slow class, runs 34669546872 and 34670045249; the TypeScript lane
took 17), and its cost grows with the catalog: about 1.6 minutes per Go mutant
and one per TypeScript mutant on a fast runner, twice that on the slow class.
Each shard measures every unmodified baseline itself, so its evidence stands
on the environment it ran in, then measures a contiguous slice of the catalog. A merge
job per language reads the shard reports and writes the complete report. It
refuses a missing, duplicated or failed shard, shards whose source, catalog,
corpus or witness fingerprints or baseline results differ, and coverage that is
not the catalog exactly once in order. Only the merged report is complete
evidence; a shard report is never `complete`. Each shard's budget is 40
minutes: the baselines plus its slice of the catalog at the slow runner's
per-mutant cost, plus one hung cohort's bound. The Go mutation runner still
bounds each `go test` invocation at 8 minutes to catch a hung mutant, not to
pace a slow runner. Locally, `MUTATION_SHARD=<index>/<count> make mutations-ts`
for every index of the workflow matrix reproduces the shards under
`.formal-traces/semantic/shards/<index>-of-<count>/`, and
`make mutations-merge-ts` assembles the report that an unsharded
`make mutations-ts` writes; the Go targets mirror this.
`MUTATION_ONLY=M18 make mutations-ts` measures one mutant into a partial
report for authoring; it is never complete evidence.

The workflow's `formal-full` aggregate job retains a small `formal-summary` artifact for 90
days: both completion and context reports, the Go replay summary, the model
properties `report.json` from the `check-models` job, the symbolic `report.json`
and, on scheduled or exploration runs, each exploration `report.json`. Trace
corpora, model check counterexamples and mutation evidence keep the 14-day
retention.

When a redirected native step fails, the validation runner behind the Make
targets prints an excerpt of its JSONL report instead of the whole file. Each
failed test or package receives its own budget (a `Failed:` header plus up to 40
of its most recent buffered lines); failures beyond 24 are counted in a trailing
`… K more failed tests` line. Go 1.24+ `build-output`/`build-fail` events are
keyed by `ImportPath`, so compiler errors appear under the failing import path.
A `WARNING: DATA RACE` line anchors the buffer so the report head (the
conflicting accesses) is kept and later lines are counted. Only plain, non-JSON
lines matching a crash marker (`--- FAIL:`, `panic:`, `fatal error:`,
`DATA RACE`) are promoted directly; a passing test that merely prints such text
is never reported as a failure.

## Exploratory runs

`make explore` selects and records a fresh seed, copies current tracked and new
source files, and runs Rust model checks and both native replays in that isolated
snapshot. It does not run the separate symbolic lane or require Java.
It preserves the pinned acceptance corpus and reports in the original checkout.
The weekly full workflow runs this lane alongside pinned validation. Exploration
does not produce an acceptance completion: its separate report distinguishes
native replay failures, witness-check failures and other infrastructure failures.
A witness-check failure can mean an unreached boundary or invalid witness
evidence; inspect the native report before attributing it to sampling. Go replay
still runs after a TypeScript witness-check failure. The exploration report
keeps that seed's witness report under `witnesses`. The witness step itself is
tolerated so both ports replay, but its baseline gate decides the outcome
afterwards: when every required label is present and both ports pass yet a
gated label's sampled hits collapsed against the recorded baseline (below the
tolerance and more than `freshSeedSigma` Poisson deviations below the recorded
count, or to zero), the report ends with `coverage-gate-failure` and the lane
fails. That is a statement about exploration quality on that seed, not about
native behavior. Exploration also refuses to pass without a completed witness
report for its own seed: when both ports passed but the tolerated evaluator
step wrote no report, or an unreadable or incomplete one, or one judged under
another seed or covering fewer profiles than the snapshot's own manifest
schedules (a saved run is judged against the inventory it was saved with), the
run ends with `infrastructure-failure`, because missing coverage evidence is never
a clean gate; the tolerated step's error is kept in the exploration report so
the absence explains itself. A native failure still takes precedence. Two fresh seeds in September 2026 dropped four and five gated
labels below half their baseline while every label stayed reachable; those
drops are seed noise on counts of ten to thirty and stay visible in the report
without failing the lane.

Choose a seed explicitly, or replay the saved source snapshot using the exact
command printed by the runner:

```sh
node formal/explore.mjs --seed 0x2a
node formal/explore.mjs --replay /absolute/path/to/exploration/report.json
```

Snapshot replay verifies saved source fingerprints, uses that snapshot's runner
and requires matching package/lock inputs for the installed dependencies. It
writes a new evidence directory and preserves the original run.

Retain a failing seed, its source fingerprints and history. Turn a discovered
behavioral counterexample into a named public-action Quint regression so future
acceptance no longer depends on rediscovering it randomly. A missed mandatory
witness or broken runner is diagnostic evidence, not an implementation defect.

### A retained sampling regression

Seed `0x48596dab531a8ddc` on snapshot
`258908b8f12f61ad27d070bf4673f54ee1e81689` replayed the behavioral histories in
both ports but missed three mandatory witness labels. These public-action
regressions now anchor the missing schedules:

| Profile / missed witness | Named regression |
| --- | --- |
| effects / `untracked-demotes-fenced-reply` | [untrackedFencedReplyRefillsAndIsReadableTest](./dialcache-effects-conformance.qnt) |
| independent / `independent-recovery-age-boundary` | [independentRecoveryAtCapturedAgeBoundaryTest](./dialcache-independent-conformance.qnt) |
| recovery / `recovery-memoizes-both-requests` | [recoveredFlightMemoIsReusedByBothRequestsTest](./dialcache-recovery-conformance.qnt) |

The same seed passed both ports and all mandatory witnesses on snapshot
`97f77529d693c4d39baa124a2bde2142c8856bc1`. A second fresh seed,
`0xfe678a03def8b0f2`, passed both ports and all 435 required labels on the
merged revision `61d55cfec0f5f124ce4cbe46ad9386b310bfaf75` in hosted run
[34646653122](https://github.com/lan17/DialCache/actions/runs/34646653122).
This records discoveries and their regression anchors; it does not claim that
named regressions alone cover every required witness.

Fresh seed `0x8d654b2dd2257c4d` in hosted run
[34670045249](https://github.com/lan17/DialCache/actions/runs/34670045249)
replayed both ports but missed the effects witness
`normalized-reply-allows-refill:13` after 552 histories. Counting required
labels per history over the pinned corpus then found nine more labels reached by
at most three sampled histories and by no exported regression. These
public-action regressions now anchor all of them:

| Profile / fragile witness | Named regression |
| --- | --- |
| effects / `normalized-reply-allows-refill:13`, `reply:13`, `miss:expired` | [expiredZeroFenceReplyRefillsAndIsReadableTest](./dialcache-effects-conformance.qnt) |
| effects / `normalized-reply-fences-refill:12`, `normalized-fence-blocks-publication` | [absentReplyWithFutureFenceBlocksRefillTest](./dialcache-effects-conformance.qnt) |
| policy / `remote-value:7`, `remote-value:8`, `remote-value:9` | [falsyRemoteValuesAreServedFromRemoteTest](./dialcache-policy-conformance.qnt) |
| layers / `source-publication-probed-in-all-three-layers` | [untrackedSourcePublicationIsProbedInAllThreeLayersTest](./dialcache-layers-conformance.qnt) |
| independent / `distinct-retained-recovery-values` | [independentRecoveriesServeDistinctAcquiredSnapshotsTest](./dialcache-independent-conformance.qnt) |

## Historical results

The merged baseline's detailed run logs remain in
[the versioned record from PR #161](https://github.com/lan17/DialCache/blob/fa4ef77489fd124213b5877479f69e2086c1aa90/formal/VALIDATION.md).
Current results belong in PR summaries and uploaded artifacts. This guide
explains how to produce and interpret evidence; it is not an accumulating log
of previous executions or machine-specific temporary paths.

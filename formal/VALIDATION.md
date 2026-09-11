# Validation and evidence

Run validation from the repository root. The Make targets are shared by local
work and GitHub Actions; [README.md](./README.md#generating-and-replaying-behavior)
lists tool prerequisites and focused reproduction commands.

## Choosing a run

| Task | Command | Evidence |
| --- | --- | --- |
| Routine implementation checks | `make check` | Native tests, coverage, package, docs and source audits |
| Full portable acceptance | `make formal` | Model checks, generated histories, TS and Go replay, exact completion inventories |
| Finite symbolic rules | `make model-check` | Scheduled bounded Apalache checks; requires Java 21 and pinned Quint |
| Challenge implementation assertions | `make mutations` | Compiling semantic faults tested against both completed ports |
| Real server behavior | `make integration` | Redis, Valkey, Cluster and cross-language interoperability |
| Explore another schedule sample | `make explore` | Separate source snapshot, recorded random seed, both-port replay |
| All required local lanes | `make ci NODE22_BIN=/absolute/path/to/node22/bin/node` | Ordered native, formal, integration and mutation runs |

A behavior, model, or replay change requires full validation of its current
inputs before merge. The default PR workflow runs faster checks; it does not
enforce this full-validation requirement. The manual full workflow can target a
PR branch. Its weekly run validates the selected `main` revision. Each PR body
should identify the revision and completed local or hosted validation.

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

Model mutations challenge the specification's independent properties.
Implementation mutations challenge the assertions that connect generated
histories to real TS/Go behavior. Report these measurements separately, including
survivors. Structural invariants and semantic obligations are also different
units; a total invariant count is not a measure of specification strength.

Every mutation must compile, its unmodified baseline must pass, and detection
must come from a semantic assertion or invariant counterexample. A tool failure,
missing witness, crash or timeout is a failed measurement. The selected fault
catalogs and per-run reports define the denominator; do not infer a percentage
of all possible defects from their scores.

## Exploratory runs

`make explore` selects and records a fresh seed, copies current tracked and new
source files, and runs model checks and both native replays in that isolated snapshot.
It preserves the pinned acceptance corpus and reports in the original checkout.
The weekly full workflow runs this lane alongside pinned validation. Exploration
does not produce an acceptance completion: its separate report distinguishes
native replay failures, witness-check failures and other infrastructure failures.
A witness-check failure can mean an unreached boundary or invalid witness
evidence; inspect the native report before attributing it to sampling. Go replay
still runs after a TypeScript witness-check failure.

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

## Historical results

The merged baseline's detailed run logs remain in
[the versioned record from PR #161](https://github.com/lan17/DialCache/blob/7729c3f461c1d6f631b528ea06a81edca3ae787c/formal/VALIDATION.md).
Current results belong in PR summaries and uploaded artifacts. This guide
explains how to produce and interpret evidence; it is not an accumulating log
of previous executions or machine-specific temporary paths.

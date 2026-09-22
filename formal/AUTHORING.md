# Reading and extending the DialCache models

The Quint files should let a reader understand a behavior without translating
the TypeScript implementation. Readability is part of the specification's
acceptance criteria. Executable checks then challenge that written behavior.
TypeScript is the executable reference these models formalize; Quint is the
independently reviewed contract that TypeScript, Go, Rust and future ports are held
to. When the two disagree, neither side is edited to match the other quietly:
the change lands with a regression that distinguishes the two behaviors and a
comment recording the decision about which one is intended. The prose explains
the contract; implementation tests must not become an independent, drifting
definition of the same portable rule.

For a first contribution, start with the [worked walkthrough](./WALKTHROUGH.md).
It follows one existing contract from a named Quint regression through actual
TypeScript, Go and Rust assertions, and identifies the catalog entry each edit owns.
Then use the checklist below for your rule; it applies the same path to another
behavior.

## Reading a model

Start with the file's scope and assumptions. Each model deliberately covers a
bounded part of DialCache. Begin with [cache-rules.qnt](./cache-rules.qnt) for
shared age, expiry, deadline and fence judgments, and
[cache-contract.qnt](./cache-contract.qnt) for acquired recovery and source
ownership records. Verification models and conformance profiles consume these
definitions. Connection models check selected profile histories against the
acquired contracts. Conformance profiles also expose external actions that a
language driver can replay. The
[model inventory](./README.md#models-and-composition-profiles) and [profile registry](./profiles.json)
identify the relevant starting point.

Read the types and state next. Distinguish three kinds of information:

- **Environment inputs:** policy replies, cache bytes, clocks, source results,
  and the completion or failure of external work.
- **DialCache ownership:** a live request scope, registered flight, retained
  candidate, or pending publication.
- **Recorded observations:** a value acquired earlier, the time a result was
  accepted, and the effects or outcomes already produced by the modeled call.

Those distinctions explain races. A later invalidation changes external storage;
it cannot change bytes already retained by a caller. Likewise, advancing time
after a result was returned cannot retroactively invalidate that return.

Then follow the transitions. `s` is the current state; `s' = ...` defines the
next state. In `all { ... }`, guards must hold together for the transition to be
enabled. `any { ... }` and `nondet ...oneOf()` provide alternative schedules or
inputs. A record update lists changed fields and retains the rest with `...s`.
Named predicates make the conditions readable; they do not perform cache work.

Finally, read the invariants and `run ...Test` examples. An invariant states a
property of explored states. A regression gives a concrete sequence and its
expected observations. A `val` declaration can also be a helper; `execution.json`
identifies the properties that are actually scheduled for checking, and every
`run ...Test` a scheduled model declares is one of its regressions. Some
regressions deliberately corrupt state to show that
a property rejects the fault. They are tests of the property, not allowed system
transitions. Passing bounded exploration is not a proof over every execution.

## Writing conventions

Use this reading order, allowing a short helper next to the transition it explains:

1. Scope, assumptions, omissions, and the relevant contract IDs.
2. Types, finite input domains, and state ownership.
3. Named predicates and small pure helpers.
4. Initial state and environment/system transitions.
5. The exploration `step` definition.
6. Independently stated invariants.
7. Deterministic regression histories.

Use two-space indentation. Expand substantial records, nested updates, and
multi-condition guards; aim for lines that can be read without horizontal
scrolling. Keep a genuinely short action compact. Prefer a descriptive
intermediate state such as `published` or `completed` over a chain of `x`, `y`,
and `z`. Comments should explain ownership, ordering, assumptions, or a boundary
case, rather than narrate the syntax. Quint 0.32.0 has no CLI formatting command;
these are reviewed authoring conventions.

Give phase, outcome, policy, and fixture codes names. Verification models can
use sum types. Conformance profiles retain their published integer encodings
and use named constants, so a readability edit does not silently change the
portable trace interface. An integer can have a different meaning in another
profile; do not share a constant merely because its numeric value matches.

Keep repeated definitions DRY when they express the same operation. Shared
acceptance judgments belong in `cache-rules.qnt`; acquired snapshot and source
ownership contracts belong in `cache-contract.qnt`. A profile supplies its
normalized policy, clocks and environment; it must not restate those decisions.
Where representations differ, add an executable projection/connection check
that compares profile history with the contract. Give the projection an explicit
scope and challenge mistakes in policy capture, event timing or ownership.

`node formal/lint-profiles.mjs <model.qnt> [--kernel=<module,...>] --witness=<regex>`
checks that structure rather than the text: it follows the resolved references
in Quint's parsed IR through helpers, lambda arguments and constants bound at
instantiation, and reports two kinds of violation with the definition chain
that reaches them. The composition rule walks every value a profile assigns to
a state variable other than `input` and fails on any comparison, branch,
arithmetic or collection operator over cache state, and on any non-library
definition applied to cache state; library modules (those under `formal/kernel`)
compute freely, a chosen `nondet` input carries no state, and the `input`
assignment may branch on state. Witness isolation fails on any reference to a
variable matching the witness pattern from a cache guard or assignment, `init`
or `step`, a `nondet` domain, the definition assigning the observation field
(`o` unless `--observation` says otherwise) or an operator constant's body; a
witness assignment may read its own prior state.
[`profile-lint-baseline.json`](./profile-lint-baseline.json) records, per
conformance profile, the library transitions it composes and its
composition-violation count: a composed profile reports zero and the other
counts are the migration work list for issue #165. `node formal/lint-profiles.mjs
baseline --check` is a ratchet (library transitions and counts as recorded,
none in a composed profile) and `--write` refreshes the record after a reviewed
change; the check runs in `make differential` (the pull request lane) and
`make formal-check` (the full run), the lanes that have Quint. `make audit`
runs without Quint and does not include it.

The same lint checks state shapes separately from composition counts. Held
reads beside held dumps require a lifecycle that accounts for both; shadow
jobs beside a caller source budget require the dark-job lifecycle. A local
fault switch must use the fault-aware transitions and cannot accompany the
healthy held lifecycle. These checks follow record type aliases and fail even
when refreshing the baseline; unsupported combinations are never recorded as
an allowed violation count. Each state is checked against the transitions
assigned to it, so a valid transition on another state cannot satisfy its
requirements, and mixing a valid lifecycle with an incompatible one still
fails. Atomic-release profiles also schedule
`atomicPathSeedsDecodableFrames`, because their reads and shadow comparisons
have no decode-failure settlement.

The [kernel library](./kernel/README.md) holds the concern modules a composed
profile assigns through; `formal/dialcache-layers-conformance.qnt` is the first.
A rewrite lands only when `node formal/differential.mjs <profile>` replays the
profile's whole reference corpus and exported regressions through the new text,
and the new text's corpus through the old, with step-by-step agreement on every
driver-asserted channel; an intended change of behavior is declared by bumping
the model's `differential.behaviorVersion` in the manifest instead. Trace bytes
per state may grow at most 1.2 times over the reference; a composition that
must carry more state declares its own bound as
`differential.maxBytesPerStateRatio` beside `behaviorVersion`, with the reason
recorded in the kernel README's record table. Compare the same recorded inputs
before attributing a change in observations to the rewrite. Reusing a random
seed does not preserve an input history when a model's choice structure
changes.

Connection models advance the imported profile and save its preceding context
in the same `all` action. Views such as `acquired` and `observedSources` combine
that context with the latest recorded input to reconstruct the current contract
record. Invariants check this view immediately; the next step persists it.
Quint assignments in `all` are simultaneous, so changing their textual order
does not change which state they read.

Small
representation helpers such as completing callers owned by one source belong
in [conformance-observations.qnt](./conformance-observations.qnt). Name repeated
transition conditions locally, including the time or snapshot they inspect.
Keep request lifetime, flight ownership, deadline acceptance, and publication
policy in the model that explains them. A shared lifecycle must keep these
differences explicit; a profile rewrite is admitted only by its corpus differential.

An assertion needs an independent way to detect a wrong transition. Do not
rewrite both sides of a check to call the same newly extracted eligibility
predicate. For example, the transition can use a named recovery-age predicate,
while its invariant independently compares the retained timestamp with the
recorded acceptance time and exclusive maximum age. This intentional repetition
provides evidence; it is not duplicate behavior to remove mechanically.
Connection and composition checks can reuse a canonical predicate to check
capture, ownership or history. State that dependency explicitly and keep a
separate boundary property for faults in the predicate itself.

## Codifying the next behavior

Use this workflow for portable features, bug fixes and new interactions. Reuse
existing rules, regressions and faults when they already distinguish the behavior;
extend the evidence where it is missing. Native binding details retain their
own API and integration tests.

1. **State the contract.** Record the observable guarantee, its boundary cases,
   environmental assumptions, and allowed races in `SPEC.md`/`CONTRACTS.md`.
   Distinguish language binding details from behavior a port must preserve.
2. **Model the smallest relevant boundary.** Extend the appropriate model with
   readable state, inputs, and transitions. Add another profile only when an
   existing one cannot express the necessary ownership or scheduling boundary.
3. **Challenge the rule.** Add an independently stated semantic invariant and
   deterministic boundary histories. Add a compiling model mutation for a
   plausible wrong implementation of the rule; require an invariant violation,
   not merely a compiler error or failed bookkeeping check. Use symbolic checking
   for tractable finite modules and sample larger compositions. Schedule every
   property in `execution.json`; every run the model declares is a regression
   without being listed. Give the challenge a
   `nativeMutants` entry that maps it to a TypeScript mutant and a Go mutant
   injecting the same wrong behavior into `src/` and `go/`, or an enumerated
   explanation of why no native line embodies the rule (see
   [Mapping every challenge to native mutants](#mapping-every-challenge-to-native-mutants)).
4. **Exercise every supported implementation.** Require a generated witness or exported
   Quint regression that exposes the rule's consequence, and replay the same
   history in TypeScript, Go and Rust. Preserve a discovered portable bug as a
   deterministic exported regression. Fixed scenarios preserve narrow regressions;
   protocol vectors and native
   tests cover wire and language boundaries. The driver supplies only external inputs and asserts actual public
   results/effects. Expected model state must never drive the implementation.
   The TypeScript and Go generated cohorts must detect their mapped native faults:
   list `generated` in their `requiredDetections`. A mutant the corpus does not
   detect is a coverage gap; close it with an exported regression or a witness
   before the challenge counts as mapped. A new profile or held effect kind
   stays inside the settlement receipt ([PORTING.md](./PORTING.md)) by
   extending the ledger's kinds and gate names in
   [replay/settlement.mjs](./replay/settlement.mjs), the `held` members of
   `$defs/settlementReceipt`, each driver's held computation and the receipt
   table; a hold fault must precede every effect-starting command of its step.
   A new rule text belongs in the same module's exported violation pattern,
   which the TypeScript and Go mutation runners import.
5. **Account for the evidence.** Link the case, property, scenario, and required
   witness in the existing catalogs. Preserve explicit gaps and update profile
   claims only after the corresponding language driver passes.

Every supported implementation replays the registered profiles. Each port's
completion gate requires every scheduled history, fixed case, protocol case and
witness gate to finish successfully. Passing TypeScript replay alone does not
establish another port's conformance. Behavior, model and replay changes require
[full validation](./VALIDATION.md#choosing-a-run) before merge.

Fault-detection evidence is specific to each port. Rust uses
[its own mutation catalog](./SEMANTIC-COVERAGE.md#reproduction-and-ci); the
TypeScript/Go mappings above do not establish Rust detection. Add equivalent
native faults where applicable and report remaining gaps explicitly.

Extend formal infrastructure when a concrete behavior cannot be expressed or
tested clearly, evidence gives misleading credit, or authoring and execution
need improvement. Describe that benefit in the change; the remaining composition
work in issue #165 does not need to precede unrelated feature or port development.

## Give reviewers focused context

For a human or LLM review, search the stable contract and case IDs first, then
extract the matching catalog entries. Provide a small context packet:

- Contract/case IDs, the observable rule or change, and its documentation link.
- Model file, exact regression/property symbols, and their execution-manifest entries.
- Profile name, each applicable port's input mapping and actual-observation assertion.
- Latest relevant validation evidence, its source revision, and any changes since that run.

State the exact modeled bounds, environmental assumptions and native evidence
gaps. Separate a reached witness from a successful implementation assertion.
Expected model state belongs only in predictions and checks; execution must
follow recorded external inputs and actual effect ownership.

## Exporting a deterministic regression

Sampled histories explore combinations. Exported and scheduled named Quint
regressions guarantee that their reviewed boundary is exercised in every supported port
even when a random seed does not reach it.
Keep the expected result in Quint; do not copy it into a hand-maintained JSON
scenario and call that Quint-driven evidence.

Profiles using `inputEncoding: "explicit-v1"` declare a top-level input record:

```quint
var input: { name: str, choice: int }
```

Every public action records its canonical command and external choice. Use
`name: "init"` only for initialization and `choice: -1` when the command has no
choice. A parameterized public action can serve both random exploration and a
named regression. The regression must invoke those actions; an arbitrary
assignment to private model state is not an executable input.

Every public-only run of a profile model is exported; `execution.mjs` reads
the model's runs and classifies each one (see [Exported runs are exactly the
public-only runs](#exported-runs-are-exactly-the-public-only-runs)), so nothing
is listed. Generation exports them under `regressions/<profile>/` alongside the
sampled corpus. Quint's deterministic test export omits MBT action metadata.
`replay-inputs.mjs` adds compatibility annotations derived only from the explicit
input record to scheduled exports; it never infers commands from expected state.
The coordinator also accepts raw regression exports directly. `input` remains
authoritative, and any optional MBT annotations must agree with it.

Each implementation validates the input domain, performs the real public
operation, and compares its own observations after every step. All completion
gates require the exact scheduled regression inventory. Link a case to its run
with `quintReplays: ["profile/regressionTest"]`; the same case must cite that
scheduled Quint check with a precise applicability scope. A checked property,
an explanatory definition, a sampled witness and an exported regression are
distinct evidence categories.

## Maintaining case and witness evidence

Use [FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md) to place each new rule in its
feature family. Update `semantic-cases.json` with precise contract and
provenance references and a reviewed `scope` on every Quint citation, in
`models` for a scheduled check and in `definitions` for the transition, helper
or predicate that owns the rule. Every positive fixed
scenario and every protocol/invalidation vector must be assigned to at least
one semantic case. An unmapped fixture is an accounting failure, even if its
test passes. Reuse a case for repeated evidence of the same rule; splitting
rows or mapping an entire file does not strengthen the evidence.

Keep native API, value-domain, clock, exporter and adapter obligations in
`feature-coverage.json`. Record exact tests and scope for each applicable
language, an explicit adaptation, and any evidence gap. Non-applicability
requires a concrete binding reason, not an empty evidence list. Review source
hash changes against the assertion, not only the test's unchanged name.

A generated witness must require its distinguishing input, ownership/order,
and actual observable consequence. Remove competing explanations: classifier
failure needs an otherwise eligible candidate, fence rejection needs otherwise
valid bytes, and a deadline case needs an actual boundary result. A private
phase or fixture label alone must not earn credit. Track a surviving value from
before the event being tested; even an equal-value replacement cannot prove
that the earlier publication survived. Late-effect suppression alone does not
prove that raw work retained capacity.

Witness classifiers, one per profile, are the shared modules under
[replay/witnesses/](./replay/witnesses/). They read the recorded Quint `input`
record and public observations; [kernel/README.md](./kernel/README.md) lists the
classifiers still reading private predictions. Their inputs never name a
TypeScript or Go file: `node formal/witnesses.mjs evaluate` runs them for every
port. Declare a new module in the profile's `witnessSources` in `profiles.json`.
A classifier that shadows the model from public channels binds that shadow to
the private predictions through [replay/witnesses/fidelity.mjs](./replay/witnesses/fidelity.mjs)
rather than restating the comparison.

Add discriminating negative controls when introducing or changing witness
classification. Preserve the matching fixture or phase, then remove or alter
the final consequence and require the classifier to reject it. Exercise exact
F/M or deadline boundaries, byte-equivalence distinctions, and ownership where
the rule depends on them. Keep these classifier/harness controls outside positive
behavioral and mutation-detection cohorts. Raw expected state may classify
reachability and assert outcomes; it must never supply execution inputs or
actual observations to any implementation.

Run `node formal/check-semantic-coverage.mjs`,
`node formal/check-feature-coverage.mjs`, and the relevant attribution tests.
These validate accounting and selected classifier boundaries; they do not
replace model checks, generation, every implementation's replay, or real/native
integration checks. Refresh execution fingerprints and reports after changed
inputs. Preserve previous measurements as historical until fresh runs finish.

## Reproducible committed fixtures

Add a named public Quint run or external-action recipe to
[fixture-recipes.json](./fixture-recipes.json), then run
`node formal/generate-artifacts.mjs --write`. Expected state must come from
Quint; recipes contain only external choices, selection bounds and projection
field names. Ordinary tests check artifact/source fingerprints; CI regenerates
and byte-compares predictions. See [PORTING.md](./PORTING.md) for the precise
driver, fixture and completion contracts.

## Refactoring and execution

[`execution.json`](./execution.json) is the execution schedule: invariant
names, model order, exploration settings, and generated trace paths and
bounds. The regressions are the runs each model declares and the libraries are
the Quint sources no model claims; `execution.mjs` reads both from the text
(`scheduleExecution`) and refuses a manifest that lists them. [`profiles.json`](./profiles.json)
records versioned conformance claims. Keep these purposes distinct; checking
and generation consume the same execution settings rather than maintaining
separate invariant lists.

Preserve public action names, choice encodings, state/observation fields, and
`...Test` suffixes during cleanup. Preserve the order and nesting of `any` and
`oneOf` choices: grouping influences sampled histories even when the set of
possible transitions is unchanged. Review the model-mutation anchor if its
source expression moves or changes; its failure must never count as detection.

For a model refactor, run the scheduled model checks/regressions, generation,
implementation replay, evidence validation, and relevant mutation gates using
the [documented commands](./README.md#generating-and-replaying-behavior). Keep the
committed smoke expectations unchanged. Compare pre/post generated action and
state histories when preserving a fixed seed and schedule is intended, and
investigate differences rather than replacing expectations to obtain a pass.

Formatting and deduplication improve reviewability; they do not increase the
number of behavioral cases or justify a broader conformance claim. Changes to
behavior, bounds, or claims should be reviewed separately from cleanup.

### Challenging every model

`execution.json` also carries the model-property challenge catalog in its
top-level `challenges` array. Each entry names a compiling single-site fault:
`id`, the `contract` it violates, the `source` file to mutate (a scheduled model
or a library), the `model` whose scheduled `invariant` must detect it, and the
exact `before` text, which must occur once in `source`, with its `after`
replacement. `node formal/execution.mjs` rejects an unknown contract, an
unscheduled model or invariant, an ambiguous anchor, and a repeated
`(source, before, after)` fault unless the entry carries a `measures` note
explaining which additional invariant the repeat exercises.

Every scheduled model must own at least one challenge whose `model` is that
file. If no compiling single-site fault is detectable by its scheduled
invariants, first add a receipt-style invariant that records the acquired
timestamp, owner or captured policy and checks it independently of the helper
it guards; only then, as a last resort, give the model entry a
`challengeWaiver` string stating why. Waivers appear in the validation summary
as `waivedModels`.

Prefer semantic faults: an inclusive boundary comparison, a dropped guard, a
wrong owner or a wrong clock. Verify a new entry with
`node formal/check-model-properties.mjs --only=<id>` before running the whole
catalog; a filtered report is a local aid and is never marked complete.

Random exploration finds the history that separates a fault from the clean
model; a reproducer preserves that history so the fault stays detected
regardless of seed. Every new challenge carries a `reproducer` object naming a
deterministic `run`, its `kind`, the `failure` the fault produces (the
condition of one top-level `.expect(...)` in that run, copied from the model),
the fault `family` slug it belongs to, the `profiles` where the fault is
observable, and `exclusions` mapping other known profiles to the reason they
cannot exercise it. Two kinds exist. An `exported-regression` cites a
public-only run of a profile model, so every supported port replays it: use this kind for
every portable behavior fault. The run normally belongs
to the challenged model; when the fault sits in a shared library, the
reproducer may instead name another profile `model` whose exported run reaches
it, which is how a verification model's shared-rule challenge gets a portable
reproducer. A `model-run` cites a run that only the model executes and must
carry a `scope` explaining its evidence boundary: a vector model
whose cases reach the codecs through an exported artifact, or instrumentation
such as a receipt that no driver observes. A run that is exported must be cited
as an `exported-regression`; `scope` is rejected on that kind. Public inputs
do not make every model expectation observable: a run may also check private
retention or memo state. Keep its `nativeMutants` classification `model-only`
or `unobservable` when those checks have no native consequence; exporting the
history alone does not establish a native fault mapping. `profiles` must
include the challenged model's own profile id, or its path for a model without
a profile, and the cited run's profile. For a fault in a shared library, every
profile that imports the changed source must appear in `profiles` or in
`exclusions`. Profiles outside that import closure are excluded structurally;
do not repeat those relationships as catalog prose. A fault in one model's own
file needs no exclusions, because no other profile executes that text.

`check-model-properties.mjs` runs the cited history on the same copy of the
sources as the invariant measurement, together with two probes it appends to
the cited model: the run's chain cut just before the declared `failure`
expectation and the chain cut just after it. `quint test --max-samples=1
--seed=<manifest seed> --match=^(<run>|<probes>)$` must report all three passed
on the clean model. On the mutant it must exit 1 with the run failed, the probe
before the checkpoint passed and the probe through it failed with `Expect
condition does not hold true`: the fault then breaks exactly the declared
expectation, not an earlier step it disables or a later check. A history the
fault does not distinguish, or one that fails elsewhere, is a measurement
failure, not a survivor to record. The report entry gains
`reproducer: { ..., baseline: 'passed', mutant: 'failed', code: 'QNT508' }`.

For a reproduced library fault, the checker also measures the profile
partition: a profile that does not import the changed source is `structural`,
derived from its imports without a catalog entry. Listing a non-importing
profile as a detector fails validation. Every listed profile must detect the
mutant through a declared run or a scheduled invariant, and every reaching exclusion must keep all its runs
passing (`holds`). A filtered `--only` run also checks the reaching exclusions'
scheduled invariants at the normal exploration bounds. The report records
these results in `partition`; a changed exclusion or a listed profile that
stops detecting the fault fails the check, so dated prose is not its evidence.

Every challenge must carry a reproducer. The historical `reproducerBacklog`
and `nativeMutantBacklog` fields remain empty for report compatibility;
validation rejects a missing reproducer or any attempt to reopen either backlog.

### Mapping every challenge to native mutants

A model challenge shows that a named property rejects one deliberate change to
the specification. It says nothing about the ports until the same wrong
behavior is injected into `src/` and `go/` and the generated corpus, replayed
through each port, fails. Each challenge therefore carries a `nativeMutants`
entry in `execution.json`:

```json
"nativeMutants": {
  "kind": "mapped",
  "mutant": "M18",
  "text": "M18 is the native twin of local_storage.localEntryLiveAt losing its strict bound: a local entry is served at its exact insertion expiry in both ports."
}
```

The text says why the mutant is the same fault as the model's and stays under
500 characters; the port-side account (which lines change, what the wrong
behavior is, any asymmetry between the ports) lives once on the catalog entry
as its `rationale`, beside the anchors it describes, so a port refactor
updates one place and the challenges never quote code.

`kind` is one of:

- `mapped`: `mutant` names an entry of `formal/mutations.json` whose
  TypeScript and Go sections both list `generated` in their
  `requiredDetections`, so the weekly mutation lanes fail if the corpus stops
  detecting it in either port. `text` names the mutant and the model
  definition. `crossContract` is a sentence, required and allowed only when
  the mutant's semantic case does not list the challenge's contract, saying
  why it is the same fault.
- `unobservable`: a port line exists, but the port checks the same condition
  again at a later point the model does not have, so no public history can
  distinguish the fault. `text` names the line and the later check; no
  catalog entry is kept for it.
- `model-only`: the fault changes model bookkeeping that no implementation
  line embodies (a connection monitor reconstructing owners or clocks, an
  invariant helper). `text` names the model construct and the port code that
  makes the fault inexpressible.

Search both ports for the line before writing an explanation; an explanation
where a native line exists is a review failure, and an explanation must name
the port file it examined. A mutant maps to a challenge when it produces the
same wrong behavior at the same boundary, not when it edits similar text;
several challenges may share one mutant, and a port section may need two
edits when the port implements the rule at two sites.

The catalog is one file, `formal/mutations.json`: each entry has an `id`,
its semantic `case`, a one-sentence `description`, the `rationale`, and a
`typescript` and a `go` section, each with `edits: [{ path, before, after }]`
(applied in order, every `before` matching the port text exactly once) and
`requiredDetections`. Every validation of the manifest checks the catalog's
schema: every entry has a description, a rationale, a known case, and in each
section known cohorts and a non-empty list of edits inside its port (`src/` or
`go/`, never a Go test file). The anchors themselves are checked by
`node formal/execution.mjs`, `make audit`, the test suite and both mutation
runners (`checkMutantAnchors`), so a refactor that moves an anchored line
fails the pull request rather than the weekly lane, while the Quint
generation lanes never read port text. The challenge rules: the kind is one
of the three, `text` is non-empty, within its length ceiling and names the
mutant or a port file, `mutant` is present exactly for `mapped`,
`crossContract` exactly when the case lacks the contract; two challenges that
repeat one `(source, before, after)` fault map it the same way; and every
challenge has a `nativeMutants` entry.
The summary also counts catalog mutants no challenge cites.

Each port's own unit suite is informational for a mutant: when a fault
leaves a goroutine blocked or a pointer nil, a synctest bubble panics instead
of failing an assertion, and when a fault settles a promise the TypeScript
suite was not awaiting with no assertion failing, the runner records that
`ordinary` cohort as `crashed` (neither detected nor survived) and measures
the replay cohorts as usual; a mutant that does not compile is recorded with
every cohort crashed, so the gate names it while the rest of the shard is
measured; a settlement violation under a mutant ([PORTING.md](./PORTING.md))
is recorded the same way, naming the first violating history and rule. New
mutants therefore require `generated` and `portable`; require
`ordinary` only where a unit test pins the fault on purpose. To measure one
mutant while authoring it, run `MUTATION_ONLY=M18 make mutations-ts` and
`MUTATION_ONLY=M18 make mutations-go`, one partial run per port at a time
(they share `partial/`); the partial report under
`.formal-traces/semantic/partial/` (and `go-semantic/partial/`) is never
complete evidence. Then run the full lanes, or let the weekly workflow run
them.

A mapped challenge also records which assertion detects its native mutant.
For an exported-regression reproducer, the runner derives a boundary from its
history, the state index of its failure checkpoint (including initializer
aliases and literal repetitions), and the public observation fields in that
expectation. When the expectation uses a helper or needs another observation
projection, provide `nativeMutants.evidence: { history, step, fields }` for the
same reproducer; fields use the record actually compared by the profile.
The coordinator records every differing observation in a separate replay:
consequence fields count at the checkpoint, while cumulative counters count
only when their divergence first appears there relative to the previous step.
Each mapping reports `confirmed`, `side-effect-only`, `not-divergent`,
`unreached`, or `unreproduced`; incomplete or failed replays never earn
boundary credit. Both ports must replay every selected history cleanly and
confirm its boundary under the mutant; the mutation gate names a failure as
`<mutant>/boundary:<challenge>`, independently of cohort detections. A new
mapped challenge needs an exported reproducer whose checkpoint compares the
consequence, or written evidence selecting that consequence in the same run.
Keep the history executable through completion under the fault: end at the
decision when a later command would require an operation the fault removes.
The Go recorder also continues through typed semantic property assertions,
after validating the complete monitor input; those diagnostics alone earn no
boundary credit, and malformed driver or monitor records still terminate it.

For a mapped vector model-run, supply `nativeMutants.evidence.vector` with
`artifact`, `group`, `rows` keyed by `typescript` and `go`, `fields`, and a
`relation` explaining how those exact generated inputs exercise the named
model regression. Use the same row in both bindings unless native codec sizes
require different inputs for the same semantic boundary. In that case, add
deterministic model checks for both inputs and explain their relationship.
The artifact must be owned by the scheduled vector model, and each named row
must exist exactly once. Expected fields are read from that artifact.
A verification model may cite another vector model through `reproducer.model`
only when both execute the challenged shared-library rule. Retain the original
verification invariant, name both models in the reproducer's coverage, and
measure the shared fault's coverage across the behavioral profiles as usual.

The native vector workers receive only an operation and its external inputs.
They return actual keys, frame classifications, decoded bytes or compression
outcomes. Invalidation workers execute the production Lua against a private
Redis server and report its response, stored state and measured elapsed server
time. The coordinator bounds TTL drift only by that measurement. Transport,
malformed reply and unexpected Lua errors earn no detection credit; known API rejection is a typed result, while process or output errors
fail the run. The mutation gate requires a clean baseline from the same binding
and row, verifies artifact and input fingerprints, and recomputes the mismatch
from the recorded native value. A failure elsewhere in the vector cohort does
not satisfy this boundary.

### Exported runs are exactly the public-only runs

A profile run is public-only when every transition it takes records a command
in `input`. A run that assigns `s'` inline, keeps `input' = input` across a
state assignment, or reaches such a fixture through a helper action is
state-patching. `execution.mjs` classifies each run from the declaration bodies:
the public-only runs are the model's exported replay regressions and the
state-patching runs stay model-only, with nothing listed in the manifest (a
`replayRegressions` list is refused). Generation
then binds every history it produces, sampled and exported alike, to the driver
contract, so a choice outside an action's declared domain fails
`run-models.mjs generate` rather than a later native replay.

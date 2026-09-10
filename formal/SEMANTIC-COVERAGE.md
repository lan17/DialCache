# Measuring semantic coverage

Measure named contract cases, exercised boundaries, and detected behavioral defects separately. A line-coverage percentage or a mapped test declaration cannot establish semantic completeness.

## Evidence inventory

[`semantic-cases.json`](./semantic-cases.json) refines the 69 obligations in [`CONTRACTS.md`](./CONTRACTS.md) into 189 named cases. Each case has a rule, parent obligations, and explicit references to fixed scenarios, required generated witnesses, model properties/regressions, or protocol vectors. Cases without executable evidence record a gap. Parent obligations retain the docs/test provenance in [`source-audit.json`](./source-audit.json).

| Reviewed scope | Named cases | Portable implementation evidence | Required generated witnesses |
| --- | ---: | ---: | ---: |
| Behavioral | 167 | 165 | 113 |
| Protocol | 22 | 22 | — |
| Total | 189 | 187 | 113 |

These are **declared evidence links**, validated by `node formal/check-semantic-coverage.mjs`. Execution must also pass. The protocol column includes invalidation transitions run separately against Redis/Valkey in integration CI. Fixed scenarios and vectors count as portable implementation evidence without needing a Quint generator.

Model evidence must name an invariant or regression scheduled in [`execution.json`](./execution.json). Its declaration inventory ignores comments and strings, tolerates layout changes, and requires every model regression to remain scheduled with its `Test` suffix. This guards execution accounting; Quint still validates language syntax, types, and properties. Readability and helper refactoring do not change the case counts or broaden any profile claim.

The separate [`quint-case-audit.json`](./quint-case-audit.json) reviews 161 scheduled-check citations across 102 cases (99 behavioral and three protocol), recording the clause each check actually establishes and its limits. It also records 125 transition/helper/predicate references across 55 cases. These definitions explain behavior but are not independently checked properties. The union links 157 cases to precise Quint references; the remaining 14 behavioral cases with neither kind of reference retain an explicit modeling gap. These counts overlap with execution evidence and must not be added into a coverage score.

Two behavioral cases retain model-only evidence: local read/write failures. The Go milestone adds fixed portable evidence for sparse overlays, TTL-implied ramps, library defaults, malformed mismatch logging, and a dark job expiring before deferred work begins. Every named case now has some executable evidence, with those two still lacking portable implementation execution. Specific model references are conservative; the count does not measure everything implied by the models.

This is a reviewed, finite case inventory, not an exhaustive enumeration of assertions or feature products. Some cases share scenarios or witnesses. Splitting a row cannot increase confidence by itself. The separate source audit accounts for 564 test declarations and 172 documentation sections, not individual assertions. Semantic review is still required to discover missing cases and check that each cited artifact actually asserts the rule.

## Generated boundary evidence

[`coverage-witnesses.json`](./coverage-witnesses.json) names the required boundary/outcome/race witnesses for eight feature profiles. The core profile has replay and action checks but no case-level witness gate. Reachability is checked on generated traces, and every trace must independently replay against the real implementation. Expected model state is used only for assertions and reachability classification; it never supplies implementation observations.

A case links to a specific required witness, not merely an action name or the presence of a test file. For example, read-budget precedence requires a first read before runtime policy changes, late source fulfillment and rejection have separate witnesses, and failed recovery requires the original source-error identity. Default-off logging requires an actually omitted flag; the fixed "warning omitted" scenario explicitly sets `false` and is not credited for that default. Multiple witness references are all required, but do not imply that all those events occurred in one history; use a dedicated interaction witness for that claim.

## Behavioral mutation comparison

[`semantic-mutations.json`](./semantic-mutations.json) defines 13 reviewed, single-site faults. `node formal/measure-semantics.mjs` applies each in an isolated copy, verifies that it compiles, and runs three cohorts against it:

1. **Ordinary:** existing unit tests, excluding all formal tests.
2. **Generated:** generated implementation replays and their reachability gates.
3. **Portable:** generated replay plus positive fixed scenarios and protocol vectors.

The source edits are TypeScript-specific audit machinery. Ports reuse the case/witness/vector contracts and can supply equivalent faults for their own implementation.

Execution runs the generated and fixed/vector test files once each, using Vitest's normal file isolation. The reported portable result is their union: a fault is detected if either component records a failed assertion. Baseline counts and failing test names are combined from those actual runs. Both component reports are retained; generated traces are not redundantly replayed a second time per fault.

Negative harness tests and inventory checks are excluded from detection cohorts: a test that expects a deliberately broken driver to fail must not count as behavioral fault detection. Integration/Lua tests are outside this local mutation comparison. All unmodified baselines must pass. Compile/import errors, crashes, timeouts, missing reports, empty runs, and incomplete surviving runs fail measurement rather than counting as detections.

The completed TypeScript measurement for the Go parity milestone produced the following comparison. All unmodified baselines passed: 660 ordinary tests, 4,008 generated replays/witness gates, and 372 fixed scenarios/protocol vectors (4,380 positive portable tests/gates in their union). Exact source, input, and corpus fingerprints are retained in the report; CI repeats the measurement on the committed revision.

| Mutant scope | Ordinary detected | Generated detected | Portable detected |
| --- | ---: | ---: | ---: |
| Behavioral faults | 11/11 | 11/11 | 11/11 |
| Protocol faults | 1/2 | 1/2 | 2/2 |
| All selected faults | 12/13 | 12/13 | 13/13 |

Generated replay is not required to replace protocol vectors. Among the 12 faults ordinary tests detect, generated replay and portable tests detect all 12. These are detection/parity ratios for this catalog, not percentages of all possible defects. No survivor is automatically labeled equivalent or excluded from the denominator.

Policy and shadow profile version 2 close the three prior generated-behavior survivors. All three detections are required in CI for both TypeScript and Go:

| Fault | Ordinary TypeScript | Generated TypeScript | Portable TypeScript | Distinguishing evidence |
| --- | --- | --- | --- | --- |
| M08: invalid logging policy enables warnings | Detected | Detected | Detected | A malformed flag reaches a confirmed mismatch without a warning |
| M11: local reads renew insertion TTL | Detected | Detected | Detected | A hit before expiry is followed by a public probe at the original insertion deadline |
| M12: argument order is reversed | Survives | Survives | Detected | Exact ordering is checked by protocol vectors |
| M13: expired dark job starts Redis work | Detected | Detected | Detected | Source work exhausts the job budget before deferred dispatch; no Redis read may start |

The other nine faults are detected by all three cohorts. Mutation IDs identify faults, not proofs of an entire case: shared helper changes can be detected through another affected behavior. The report preserves the actual failing test names and trace diagnostics so detection can be reviewed.

The independent Go measurement compiled all 13 equivalent faults and completed all unmodified baselines: 72 ordinary native tests, 4,008 generated replays/witness gates, and 372 fixed scenarios/protocol vectors. Its completed report records:

| Go cohort | Selected faults detected |
| --- | ---: |
| Ordinary native | 3/13 |
| Quint-generated | 12/13 |
| Fixed scenarios/protocol vectors | 12/13 |
| Portable union | 13/13 |

All 11 Go behavioral faults are detected by generated tests. M12 remains a protocol-vector detection; M09 (omitted mismatch-logging flag) is detected by generated tests but survives the fixed cohort. The native TypeScript and Go suites differ in size and scope, so their ordinary detection ratios are not equivalent denominators of implementation quality. Both ports require the same generated and portable detections in CI. This makes Quint-generated tests the main behavioral regression suite for the new Go implementation while native tests cover its language and integration boundaries.

## Reproduction and CI

```sh
# Install dependencies and CI-pinned Quint as described in README.md, then:
bash formal/generate-traces.sh
node formal/check-semantic-coverage.mjs
node formal/measure-semantics.mjs
```

The runner clears inherited trace selectors, uses the complete generated directories, and leaves source files untouched. It writes `.formal-traces/semantic/report.json` and `report.md`, per-cohort assertion reports/logs, and baseline witness evidence. JSON records completion status, elapsed time, revision, Node version, source/configuration/input hashes, exact corpus hash, cohort sizes, detections, survivors, and failing test names. An interrupted or failed run is not a completed measurement. The formal CI artifact retains these files with the traces for reproduction.

Each catalog entry's `requiredDetections` is a regression gate. CI fails if a previously detected fault survives. Newly detected faults remain visible as improvements; update the required set after inspecting the result. Source edits must match exactly once, so implementation drift requires reviewing the mutation rather than silently skipping it.

To expand assurance, add a test/doc-derived case and precise executable evidence, require a generated witness where appropriate, then add a representative fault for a previously unchallenged rule. Preserve gaps until execution closes them. Keep code coverage, source accounting, case evidence, and mutation detection as separate measurements. Go executes all nine shared profiles, all 238 fixed scenarios and all 134 protocol cases, with an equivalent 13-fault catalog in `go-mutations.json`. Broader interaction histories and larger domains remain separate assurance work.

## Model properties and cross-language execution

The strengthened C23 invariant records actual model source-start time. `check-model-properties.mjs` requires a compiling deadline-epoch mutation to produce an invariant counterexample, and retains its source hash, tool version, and trace. Compilation/evaluator errors cannot count as detection. This challenges the specification itself in addition to the TypeScript mutation catalog.

Every effects replay also runs `assertEffectsHistory` over actual external source starts/settlements and public fallback/write observations. Its C23/C25/C26 checks cover source-relative budget/duration, strict deadline acceptance, and a preceding accepted success before publication. It consumes no expected model phases and permits pending prefixes. An additional causal monitor in both drivers ties writes to their actual invocation/source callback and rejects publication after that source settled too late; negative tests distinguish property failures from malformed monitor inputs. This is a bounded connection for selected properties, not full model refinement or liveness proof.

The Go driver executes the same generated corpus through its own cache implementation. Its value-domain and API adaptations appear in [`go/README.md`](../go/README.md). `measure-go-semantics.mjs` independently measures the Go fault catalog; TypeScript mutation results are never credited to Go. The Go race detector covers only exercised schedules.

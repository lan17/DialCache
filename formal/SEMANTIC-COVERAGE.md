# Measuring semantic coverage

Measure named contract cases, exercised boundaries, and detected behavioral defects separately. A line-coverage percentage or a mapped test declaration cannot establish semantic completeness.

## Evidence inventory

[`semantic-cases.json`](./semantic-cases.json) refines the 69 obligations in [`CONTRACTS.md`](./CONTRACTS.md) into 189 named cases. Each case has a rule, parent obligations, and explicit references to fixed scenarios, required generated witnesses, model properties/regressions, or protocol vectors. Cases without executable evidence record a gap. Parent obligations retain the docs/test provenance in [`source-audit.json`](./source-audit.json).

| Reviewed scope | Named cases | Portable implementation evidence | Required generated witnesses |
| --- | ---: | ---: | ---: |
| Behavioral | 167 | 165 | 108 |
| Protocol | 22 | 22 | — |
| Total | 189 | 187 | 108 |

These are **declared evidence links**, validated by `node formal/check-semantic-coverage.mjs`. Execution must also pass. The protocol column includes invalidation transitions run separately against Redis/Valkey in integration CI. Fixed scenarios and vectors count as portable implementation evidence without needing a Quint generator.

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

The completed Go-milestone local measurement produced the following comparison. All unmodified baselines passed: 660 ordinary tests, 4,008 generated replays/witness gates, and 372 fixed scenarios/protocol vectors (4,380 positive portable tests/gates in their union). Exact source, input, and corpus fingerprints are retained in the report; CI repeats the measurement on the committed revision.

| Mutant scope | Ordinary detected | Generated detected | Portable detected |
| --- | ---: | ---: | ---: |
| Behavioral faults | 11/11 | 8/11 | 11/11 |
| Protocol faults | 1/2 | 1/2 | 2/2 |
| All selected faults | 12/13 | 9/13 | 13/13 |

Generated replay is not required to replace protocol vectors. Among the 12 faults ordinary tests detect, generated replay detects nine and portable tests detect all 12. These are detection/parity ratios for this catalog, not percentages of all possible defects. No survivor is automatically labeled equivalent or excluded from the denominator.

The review baseline at `bcface8` detected 11/13 portable faults. The new fixed scenarios now detect M08 and M13, and their portable detections are required CI gates; generated coverage of those faults remains open:

| Fault | Ordinary | Generated | Portable | Implication |
| --- | --- | --- | --- | --- |
| M08: invalid logging policy enables warnings | Detected | Survives | Detected | Covered by the malformed-logging fixed scenario |
| M11: local reads renew insertion TTL | Detected | Survives | Detected | Fixed regression exists; generated schedules need a read followed by an expiry probe |
| M12: argument order is reversed | Survives | Survives | Detected | Protocol vectors add detection beyond ordinary tests |
| M13: expired dark job starts Redis work | Detected | Survives | Detected | Covered by sourceWorkMs delaying deferred dispatch |

The other nine faults are detected by all three cohorts. Mutation IDs identify faults, not proofs of an entire case: shared helper changes can be detected through another affected behavior. The report preserves the actual failing test names and trace diagnostics so detection can be reviewed.

## Reproduction and CI

```sh
# Install dependencies and CI-pinned Quint as described in README.md, then:
bash formal/generate-traces.sh
node formal/check-semantic-coverage.mjs
node formal/measure-semantics.mjs
```

The runner clears inherited trace selectors, uses the complete generated directories, and leaves source files untouched. It writes `.formal-traces/semantic/report.json` and `report.md`, per-cohort assertion reports/logs, and baseline witness evidence. JSON records completion status, elapsed time, revision, Node version, source/configuration/input hashes, exact corpus hash, cohort sizes, detections, survivors, and failing test names. An interrupted or failed run is not a completed measurement. The formal CI artifact retains these files with the traces for reproduction.

Each catalog entry's `requiredDetections` is a regression gate. CI fails if a previously detected fault survives. Newly detected faults remain visible as improvements; update the required set after inspecting the result. Source edits must match exactly once, so implementation drift requires reviewing the mutation rather than silently skipping it.

To expand assurance, add a test/doc-derived case and precise executable evidence, require a generated witness where appropriate, then add a representative fault for a previously unchallenged rule. Preserve gaps until execution closes them. Keep code coverage, source accounting, case evidence, and mutation detection as separate measurements. The Go reference now checks core histories and 93 protocol cases independently; second-language feature drivers and broader interaction histories remain separate assurance work.

## Model properties and cross-language execution

The strengthened C23 invariant records actual model source-start time. `check-model-properties.mjs` requires a compiling deadline-epoch mutation to produce an invariant counterexample, and retains its source hash, tool version, and trace. Compilation/evaluator errors cannot count as detection. This challenges the specification itself in addition to the TypeScript mutation catalog.

Every effects replay also runs `assertEffectsHistory` over actual external source starts/settlements and public fallback/write observations. Its C23/C25/C26 checks cover source-relative budget/duration, strict deadline acceptance, and a preceding accepted success before publication. It neither consumes expected model phases nor associates writes with source identities, and it permits pending prefixes. This is a bounded connection for selected properties, not full model refinement or liveness proof.

The Go core driver executes the same generated core corpus using a separate cache implementation. Its supported protocol groups and limitations appear in `go/README.md`. TypeScript mutation percentages do not transfer to Go, and the Go race detector covers only exercised schedules.

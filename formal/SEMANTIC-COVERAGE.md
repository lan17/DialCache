# Measuring semantic coverage

Measure named contract cases, exercised boundaries, and detected behavioral defects separately. A line-coverage percentage or a mapped test declaration cannot establish semantic completeness.

## Evidence inventory

[`semantic-cases.json`](./semantic-cases.json) refines the 69 obligations in [`CONTRACTS.md`](./CONTRACTS.md) into 185 named cases. Each case has a rule, parent obligations, and explicit references to fixed scenarios, required generated witnesses, model properties/regressions, or protocol vectors. Cases without executable evidence record a gap. Parent obligations retain the docs/test provenance in [`source-audit.json`](./source-audit.json).

| Reviewed scope | Named cases | Portable implementation evidence | Required generated witnesses |
| --- | ---: | ---: | ---: |
| Behavioral | 164 | 157 | 108 |
| Protocol | 21 | 21 | — |
| Total | 185 | 178 | 108 |

These are **declared evidence links**, validated by `node formal/check-semantic-coverage.mjs`. Execution must also pass. The protocol column includes invalidation transitions run separately against Redis/Valkey in integration CI. Fixed scenarios and vectors count as portable implementation evidence without needing a Quint generator.

Five behavioral cases currently have model-only evidence: sparse overlays, TTL-implied ramp, library defaults, and local read/write failures. Two cases have ordinary tests but no portable executable evidence: malformed mismatch-logging policy and a dark job whose deadline expires before deferred work begins. Specific model references are conservative; the count does not measure everything implied by the models.

This is a reviewed, finite case inventory, not an exhaustive enumeration of assertions or feature products. Some cases share scenarios or witnesses. Splitting a row cannot increase confidence by itself. The separate source audit accounts for 564 test declarations and 172 documentation sections, not individual assertions. Semantic review is still required to discover missing cases and check that each cited artifact actually asserts the rule.

## Generated boundary evidence

[`coverage-witnesses.json`](./coverage-witnesses.json) names the required boundary/outcome/race witnesses for eight feature profiles. The core profile has replay and action checks but no case-level witness gate. Reachability is checked on generated traces, and every trace must independently replay against the real implementation. Expected model state is used only for assertions and reachability classification; it never supplies implementation observations.

A case links to a specific required witness, not merely an action name or the presence of a test file. For example, read-budget precedence requires a first read before runtime policy changes, late source fulfillment and rejection have separate witnesses, and failed recovery requires the original source-error identity. Multiple witness references are all required, but do not imply that all those events occurred in one history; use a dedicated interaction witness for that claim.

## Behavioral mutation comparison

[`semantic-mutations.json`](./semantic-mutations.json) defines 13 reviewed, single-site faults. `node formal/measure-semantics.mjs` applies each in an isolated copy, verifies that it compiles, and runs three cohorts against it:

1. **Ordinary:** existing unit tests, excluding all formal tests.
2. **Generated:** generated implementation replays and their reachability gates.
3. **Portable:** generated replay plus positive fixed scenarios and protocol vectors.

The source edits are TypeScript-specific audit machinery. Ports reuse the case/witness/vector contracts and can supply equivalent faults for their own implementation.

Execution runs the generated and fixed/vector test files once each, using Vitest's normal file isolation. The reported portable result is their union: a fault is detected if either component records a failed assertion. Baseline counts and failing test names are combined from those actual runs. Both component reports are retained; generated traces are not redundantly replayed a second time per fault.

Negative harness tests and inventory checks are excluded from detection cohorts: a test that expects a deliberately broken driver to fail must not count as behavioral fault detection. Integration/Lua tests are outside this local mutation comparison. All unmodified baselines must pass. Compile/import errors, crashes, timeouts, missing reports, empty runs, and incomplete surviving runs fail measurement rather than counting as detections.

The initial measured comparison is:

| Mutant scope | Ordinary detected | Generated detected | Portable detected |
| --- | ---: | ---: | ---: |
| Behavioral faults | 11/11 | 8/11 | 9/11 |
| Protocol faults | 1/2 | 1/2 | 2/2 |
| All selected faults | 12/13 | 9/13 | 11/13 |

Generated replay is not required to replace protocol vectors. Among the 12 faults ordinary tests detect, generated replay detects nine and portable tests detect ten. These are detection/parity ratios for this catalog, not percentages of all possible defects. No survivor is automatically labeled equivalent or excluded from the denominator.

The differences identify concrete work:

| Fault | Ordinary | Generated | Portable | Implication |
| --- | --- | --- | --- | --- |
| M08: invalid logging policy enables warnings | Detected | Survives | Survives | Portable policy input is missing |
| M11: local reads renew insertion TTL | Detected | Survives | Detected | Fixed regression exists; generated schedules need a read followed by an expiry probe |
| M12: argument order is reversed | Survives | Survives | Detected | Protocol vectors add detection beyond ordinary tests |
| M13: expired dark job starts Redis work | Detected | Survives | Survives | Portable scheduling does not yet express this boundary |

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

To expand assurance, add a test/doc-derived case and precise executable evidence, require a generated witness where appropriate, then add a representative fault for a previously unchallenged rule. Preserve gaps until execution closes them. Keep code coverage, source accounting, case evidence, and mutation detection as separate measurements. A second-language driver and broader interaction histories remain independent sources of confidence.

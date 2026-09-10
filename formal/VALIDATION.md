# Validated implementation snapshot

This snapshot identifies implementation commit
[`bf8405a9326a09012db4ed243f3f72f326a38a87`](https://github.com/lan17/DialCache/commit/bf8405a9326a09012db4ed243f3f72f326a38a87).
TypeScript/model results identify that commit. Go replay and mutation checks
were restarted at
[`c4fcb34d21cf19bca534926abdaf11d158674004`](https://github.com/lan17/DialCache/commit/c4fcb34d21cf19bca534926abdaf11d158674004),
which changes only two Go test files to include exported effects histories in
witness validation. Production code, models and TypeScript inputs are unchanged.

This records local validation on Darwin arm64; it does not assert hosted CI
status or universal behavioral equivalence. The documentation commit linking
this page may be later than the validated implementation commits.

## Completed scope

| Check | Result |
| --- | --- |
| Quint verification | 26 models, 189 scheduled invariants and 388 named model regressions passed |
| Shared history generation | 5,280 sampled histories plus 165 exported public-action regressions across 15 profiles |
| Quint wire generation | 1,631 generated cases: frames/text/durations, keys/cohorts, envelopes and invalidation |
| TypeScript full conformance run | 7,237 tests passed, including replay and harness controls |
| Go race replay and completion gate | 7,334 leaves passed; exact completion confirmed 5,280 sampled histories, 165 exported regressions, 244 fixed scenarios, 1,477 protocol vectors and all 14 witness profiles |
| Regular TypeScript CI | 2,795 unit tests and 819 real integration tests passed; frozen install, typecheck, build and docs passed |
| Production coverage | 98.03% lines/statements, 97.35% branches, 99.73% functions; existing thresholds unchanged |
| Go static checks | `go vet ./...` and repository formatting passed |
| Ancillary CI | CodeQL JavaScript/TypeScript (87 rules) and Actions (17 rules) reported zero findings; workflow lint and PR-title checks passed |
| Go real integration | 1,019 leaves passed, including 337 invalidation transitions on each of Redis 6.2, Valkey 8 and Redis Cluster |
| Consumer floor | Node 22.15.0 zstd/output-cap smoke and packed-package checks passed; Node 24.20.0 package check also passed |

The complete protocol replay contains 1,477 vectors: 134 fixed and 1,343
Quint-derived primitive rows. Fixed behavioral scenarios contribute 244 cases;
435 required witnesses establish that the selected histories reach their
consequential observations. Real invalidation cases run separately on servers. A
history, witness, test assertion and vector row are different units; their counts
must not be added into a behavioral coverage percentage. All 240 behavioral and
22 wire cases have checked Quint references and Quint-driven implementation
evidence, within their recorded scopes.

## Mutation challenge

All unmodified baselines passed: TypeScript ran 660 ordinary tests, Go ran 125
ordinary tests, and each ran 6,802 generated plus 378 fixed tests. Each positive
portable union contains 7,180 tests/gates. The challenge injects 13 selected
semantic faults; it does not enumerate every possible implementation error.
The generated cohort includes the 5,445 shared histories, their required witness
gates and Quint-derived primitive vectors. Fixed and generated primitive
rows are disjoint. Harness/schema/classifier negative controls receive no
behavioral detection credit.

| Language | Ordinary | Quint-generated | Fixed supplement | Portable union |
| --- | --- | --- | --- | --- |
| TypeScript | 12/13; M12 survived | 13/13 | 12/13; M09 survived | 13/13 |
| Go | 5/13 | 13/13 | 12/13; M09 survived | 13/13 |

Every selected fault must compile, every unmodified baseline must pass, and
required detections must reach actual assertions. A compile error, timeout,
missing witness or incomplete report is a failed measurement, not a detection.
Both generated cohorts detected all 13 faults, including all 11 behavioral
faults and both wire faults. The ordinary Go survivors were M01, M02, M04, M07,
M09, M10, M12 and M13. All 435 required witnesses were reached. No survivor is
excluded from the denominator or labeled equivalent.

## Evidence identity and reproduction

The execution manifest fixes the models, exported regressions, vector artifacts,
backend, seed and bounds. This run used Node 24.20.0, pnpm 10.33.0, Go 1.27.1,
Quint 0.32.0 and the Rust evaluator. The shared history corpus contains 5,445
files with SHA256
`33597e9b2081440269ba8b6500316d452645719634f88cb6348a6868836ec74e`.
Generated wire artifacts carry separate model/library/exporter fingerprints.
The completed TypeScript mutation report has SHA256
`a93ade57fe9accd3233c1aa2d752ae2dd9d7c14e3e25b527118b1848e33e0ba9`;
the completed Go mutation report has SHA256
`c7dd1c777fd5815d9de0ab699c394918e0464c9b4195e664b4f2e3d75e425178`.
The passing Go completion summary identifies replay report SHA256
`e1f4d714dac7940c2e379dc261d2428e490cbf07d41d595a330dfdb8b633e5b8`.

Some regular CI commands ran on the reviewed precommit working tree. Their
reports retain that actual revision and per-file source hashes: the final unit
snapshot differs from the implementation commit only in explanatory TEST-MAP
prose; build/package/integration production inputs are unchanged. These reports
are bound by matching executed inputs, not relabeled as runs on another commit.
Mutation reports retain their actual execution revisions: TypeScript at
`bf8405a`, Go at `c4fcb34`. The Go witness preflight found that its effects gate
counted 512 sampled histories while omitting 18 exported regressions. Shared
path selection now includes both sets, with a missing-regression negative
control; its focused race run passed 532 leaves before the full Go restart.

Local evidence is retained under `/tmp/dialcache-authority-ci/`, with regular CI
indexed by `typescript/regular-ci.json`. Generated replay, witness, mutation and
model artifacts use `.formal-traces/`; CI artifact names and reproduction
commands are documented in [README.md](./README.md) and
[SEMANTIC-COVERAGE.md](./SEMANTIC-COVERAGE.md). Preserve exact report/source/corpus
hashes when copying evidence. Earlier failed attempts remain diagnostics:
stale metadata, blocked metadata subprocesses, the corrected model's local
retention omission, the initial coverage-denominator mismatch, and the Go
effects witness-path omission. These attempts receive no successful gate or
mutation-detection credit.

## Limits of this result

The profiles bound callers, keys, capacities, contexts, payloads and schedules;
they do not prove fairness or refinement over all executions. Native clock and
local-fault seams exercise specified observations without adding production
fault APIs. Atomic primary reads, immutable retained/reused values, suitable
clocks, executor progress and watermark durability remain environmental
assumptions.

Key numeric modeling uses bounded integer magnitudes. Full IEEE754 shortest
formatting and arbitrary bigint widths retain fixed/native evidence. Envelope
rules use independently verified native codec results and encoded sizes; they
do not define zstd or require identical compressed bytes or selection outcomes
from encoders with different sizes. Native stream quirks and the real 512 MiB
resource ceiling remain distinct from small injected cap boundaries. See
[FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md), [PROTOCOL.md](./PROTOCOL.md) and
[GO-PARITY.md](./GO-PARITY.md) for the exact adaptations and assumptions.

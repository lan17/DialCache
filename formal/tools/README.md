# Tools

The Node scripts behind the `make` targets. `make <target>` is
`node formal/tools/validation.mjs <target>`; `make help` lists the targets and
their prerequisites. Every script reads its inputs from
[../catalogs/](../catalogs/README.md) and writes generated output only under
[../generated/](../generated/README.md). Start with `validation.mjs` to see
which scripts a target runs.

## Entry points

- [validation.mjs](./validation.mjs): the target dispatcher; composes every `make` target from the scripts below and checks prerequisites.
- [execution.mjs](./execution.mjs): reads and validates the execution manifest; `node formal/tools/execution.mjs` prints the inventory.

## Checks (the `audit` lane runs the first five)

- [check-source-audit.mjs](./check-source-audit.mjs): the docs and test review ledger against the current files.
- [check-semantic-coverage.mjs](./check-semantic-coverage.mjs): every semantic case cites scheduled checks, scenarios, vectors and witnesses.
- [check-feature-coverage.mjs](./check-feature-coverage.mjs): the native feature inventory and its evidence references.
- [check-go-parity.mjs](./check-go-parity.mjs): the Go parity ledger against the catalogs and both source trees.
- [check-model-properties.mjs](./check-model-properties.mjs): the model-fault challenge catalog; `--only=<id>` measures one.
- [check-kernel-fixtures.mjs](./check-kernel-fixtures.mjs): typechecks and runs the kernel fixtures (`make kernel-fixtures`).
- [check-symbolic-models.mjs](./check-symbolic-models.mjs): the finite symbolic checks with Apalache (`make model-check`).
- [check-go-replay.mjs](./check-go-replay.mjs), [check-rust-replay.mjs](./check-rust-replay.mjs), [check-python-replay.mjs](./check-python-replay.mjs): each port's completion report against the required inventory.
- [lint-profiles.mjs](./lint-profiles.mjs): the composition and witness-isolation lint over Quint's parsed IR; `baseline --check` ratchets.
- [differential.mjs](./differential.mjs): replays a composed profile's corpus against its reference revision in both directions (`make differential`).

## Generators (`make formal-generate`, `make fixtures-check`)

- [run-models.mjs](./run-models.mjs): checks every scheduled model and generates the sampled corpus and exported regressions.
- [generate-artifacts.mjs](./generate-artifacts.mjs): regenerates every committed artifact (`--write`) or verifies it (`--check`).
- [generated-fixtures.mjs](./generated-fixtures.mjs): the smoke traces, witness fixtures and the lock from `fixture-recipes.json`.
- [generate-key-vectors.mjs](./generate-key-vectors.mjs), [generate-frame-vectors.mjs](./generate-frame-vectors.mjs), [generate-envelope-vectors.mjs](./generate-envelope-vectors.mjs), [generate-invalidation-vectors.mjs](./generate-invalidation-vectors.mjs): one generated vector file each.
- [witnesses.mjs](./witnesses.mjs): language-neutral witness evaluation over the generated corpus and its baseline.
- [replay-inputs.mjs](./replay-inputs.mjs): adds replay annotations to exported regressions from their explicit input record.
- [explore.mjs](./explore.mjs): a fresh-seed exploration in an isolated source snapshot (`make explore`); `--replay` reproduces a saved run.

## Measurements (`make mutations-*`)

- [measure-semantics.mjs](./measure-semantics.mjs), [measure-go-semantics.mjs](./measure-go-semantics.mjs), [measure-rust-semantics.mjs](./measure-rust-semantics.mjs): the mutation campaigns per port.
- [mutation-reports.mjs](./mutation-reports.mjs), [merge-mutation-reports.mjs](./merge-mutation-reports.mjs): shard partitioning, detection accounting and the merged report.
- [boundary-replay.mjs](./boundary-replay.mjs), [vector-evidence.mjs](./vector-evidence.mjs): the checkpoint and vector evidence a mapped native mutant must reach.
- [semantic-reporter.mjs](./semantic-reporter.mjs): turns a port's test output into the strict assertion records the gates read.

## Runners and transport

- [conformance.mjs](./conformance.mjs): the replay inventory and context every port's smoke and full replay consume.
- [conformance-adapters.mjs](./conformance-adapters.mjs), [conformance-bindings.mjs](./conformance-bindings.mjs): how each port names and binds the shared cases.
- [run-python-replay.mjs](./run-python-replay.mjs), [run-python-integration.mjs](./run-python-integration.mjs): the Python replay and real-server lanes.
- [run-vector-boundary.mjs](./run-vector-boundary.mjs), [redis-vector-server.mjs](./redis-vector-server.mjs): native vector workers and the private Redis they run against.
- [vector-artifacts.mjs](./vector-artifacts.mjs): rejects a stale vector artifact in ordinary test runs without Quint.
- [apalache.mjs](./apalache.mjs), [apalache-readiness.mjs](./apalache-readiness.mjs): the pinned Apalache release and its server readiness probe.
- [quint-pool.mjs](./quint-pool.mjs), [compact-json.mjs](./compact-json.mjs): process-level Quint concurrency and the one-record-per-line JSON encoder.

The `.d.mts` files beside `boundary-replay`, `generate-envelope-vectors`,
`generate-invalidation-vectors`, `vector-evidence` and `witnesses` declare
their types for the TypeScript tests.

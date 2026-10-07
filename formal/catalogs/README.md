# Catalogs

Files a person edits or refreshes and reviews: the manifests, the evidence
catalogs, the ledgers, the baselines and the two fixed vector corpora. One line
per file: purpose, the check that validates it, how it changes. Generated
output lives in [../generated/](../generated/README.md), never here.

## Manifests

- [execution.json](./execution.json): the execution schedule (models, invariants, bounds, trace paths) and the challenge catalog; `node formal/tools/execution.mjs`; edited by hand, every entry validated.
- [profiles.json](./profiles.json): the profile registry (versions, input encodings, smoke traces, implementations); `execution.mjs` and `check-go-parity.mjs`; by hand.

## Evidence catalogs

- [semantic-cases.json](./semantic-cases.json): one entry per semantic case with its scenarios, vectors, witnesses and scoped Quint citations; `check-semantic-coverage.mjs`; by hand.
- [coverage-witnesses.json](./coverage-witnesses.json): the required witness labels per profile; `witnesses.mjs` and `check-semantic-coverage.mjs`; by hand.
- [feature-coverage.json](./feature-coverage.json): the native feature families, tests and explicit adaptations; `check-feature-coverage.mjs`; by hand.
- [mutations.json](./mutations.json): the TypeScript and Go mutant catalog with anchored edits; `execution.mjs` checks the anchors, the mutation lanes measure; by hand.
- [rust-mutations.json](./rust-mutations.json): the Rust mutant catalog; `measure-rust-semantics.mjs`; by hand.
- [fixture-recipes.json](./fixture-recipes.json): the recipes behind every committed smoke trace and witness fixture; `generated-fixtures.mjs`; by hand, then `node formal/tools/generate-artifacts.mjs --write`.
- [behavioral-scenarios.json](./behavioral-scenarios.json): the fixed behavioral scenarios every port replays; the smoke and full lanes; by hand.

## Ledgers and baselines

- [source-audit.json](./source-audit.json): the review ledger of documentation pages, ordinary tests and reviewed guides; `check-source-audit.mjs`; refreshed after a guide or docs edit ([../guides/TEST-AUDIT.md](../guides/TEST-AUDIT.md)).
- [go-parity.json](./go-parity.json): the Go parity ledger over the catalogs, sources and audit; `check-go-parity.mjs`; refreshed with the audit.
- [profile-lint-baseline.json](./profile-lint-baseline.json): the composition lint ratchet per profile; `node formal/tools/lint-profiles.mjs baseline --check`; `--write` after a reviewed fall.
- [witness-baseline.json](./witness-baseline.json): the recorded witness hit counts the exploration gate compares against; `witnesses.mjs`; `baseline --write`.

## Fixed vector corpora

- [protocol-vectors.json](./protocol-vectors.json): the fixed protocol vector corpus (schema 3) every port replays; the smoke and protocol lanes; by hand.
- [invalidation-vectors.json](./invalidation-vectors.json): the fixed invalidation vector corpus (schema 2) replayed against a real Redis; the integration and mutation lanes; by hand.

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

- [source-audit.json](./source-audit.json): the review ledger of documentation pages, ordinary tests and reviewed guides; `check-source-audit.mjs`; re-keyed per reviewed file with `check-source-audit.mjs --refresh <path>...` ([../guides/TEST-AUDIT.md](../guides/TEST-AUDIT.md)).
- [go-parity.json](./go-parity.json): the Go parity ledger over the catalogs, sources and audit; `check-go-parity.mjs`; its catalog, audit-dispositions and vector artifact digests re-pinned with `check-go-parity.mjs --refresh-inputs`, its mapping hashes by hand with the review.
- [profile-lint-baseline.json](./profile-lint-baseline.json): the composition lint ratchet per profile; `node formal/tools/lint-profiles.mjs baseline --check`; `--write` after a reviewed fall.
- [witness-baseline.json](./witness-baseline.json): the recorded witness hit counts the exploration gate compares against; `witnesses.mjs`; `baseline --write`.

## Fixed vector corpora

- [protocol-vectors.json](./protocol-vectors.json): the fixed protocol vector corpus (schema 3) every port replays; the smoke and protocol lanes; by hand.
- [invalidation-vectors.json](./invalidation-vectors.json): the fixed invalidation vector corpus (schema 2) replayed against a real Redis; the integration and mutation lanes; by hand.

## Refresh after an edit

A ledger records that a person reviewed a file at a given hash, so an edit to a
pinned file fails the required `test` check until the ledger is refreshed. The
ledgers pin these files:

- `source-audit.json`: the root, `typescript/` and `go/` READMEs, every authored
  page under `docs/`, `formal/README.md`, `formal/guides/*.md`, and ordinary
  (non-`formal-`) tests in `typescript/test/`.
- `feature-coverage.json`: the TypeScript and Go test files it cites.
- `go-parity.json`: `typescript/src/`, the bound Go files, the generated vector
  artifacts, five catalogs (`semantic-cases`, `execution`, `feature-coverage`,
  `coverage-witnesses` and `profiles`) and the source audit's dispositions, not
  its bytes, so a prose-only edit never reaches it.
- The fixtures lock (`formal/generated/generated-fixtures.lock.json`): the
  `.qnt` files, recipes and generators behind the committed fixtures, comments
  included.

Review the changed paragraph or assertion before refreshing its pin, and never
refresh only to make a check pass. Refresh in this order, because each step
feeds the next:

1. **Fixtures lock.** After any `.qnt`, `fixture-recipes.json` or generator
   edit, comments included, run
   `node formal/tools/generate-artifacts.mjs --write` with Quint 0.32.0 on
   `PATH`, then `make fixtures-check`.
2. **Baselines.** Rewrite `witness-baseline.json` only after a deliberate model
   or classifier change, under the manifest seed and never an exploration
   seed: run `make formal-generate`, then
   `node formal/tools/witnesses.mjs baseline --write --profile all`. When the
   intended change lowers a gated witness count, the last step of
   `make formal-generate` (the witness evaluation) exits 1; the corpus it
   generated is complete, so continue to the rewrite. Run
   `node formal/tools/lint-profiles.mjs baseline --write` only after reviewing
   what `baseline --check` reports: a fallen violation count, a new or removed
   profile or kernel module, changed library transitions or a Quint upgrade.
   Never record a risen count; a composed profile reports zero. An intended
   observable change bumps the model's `differential.behaviorVersion` in
   `execution.json`, or the profile's `version` in `profiles.json` when the
   driver-asserted channels change. Either bump makes `make differential` skip
   that profile instead of comparing it, so the pull request names each bump
   and its reason.
3. **`source-audit.json`.** Re-key each reviewed file by name:
   `node formal/tools/check-source-audit.mjs --refresh <path>...`. It recomputes
   the hash and the heading or test inventory and carries each disposition to
   the entry with the same title; a new or renamed entry stays empty until a
   reviewer fills it ([TEST-AUDIT.md](../guides/TEST-AUDIT.md#keeping-the-audit-current)).
4. **`feature-coverage.json`.** Update a reviewed test's `sha256` by hand, then
   run `node formal/tools/check-feature-coverage.mjs`.
5. **`go-parity.json`, last.** Run `node formal/tools/check-go-parity.mjs --refresh-inputs`
   to re-pin the catalog digests, the audit dispositions and the vector
   artifacts. The `typescript/src/` and bound Go file hashes are re-pinned by
   hand with their mapping review; a new documentation page or ordinary test
   file needs a Go applicability row, and a new `typescript/src/` file needs a
   source inventory row ([GO-PARITY.md](../guides/GO-PARITY.md)).

`make audit` runs every ledger check. On a rebase conflict in a ledger, take
`main`'s copy and refresh again instead of merging the JSON by hand.

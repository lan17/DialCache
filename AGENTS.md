# AGENTS.md

DialCache is a caching library with TypeScript, Go, Rust and Python implementations: explicit
request-scoped enablement, local and Redis layers, runtime rollout controls, request coalescing,
targeted invalidation and adapter-based observability. Quint models in `formal/` define portable
behavior; TypeScript is the executable reference. The maintainer, `@lan17`, is the only human.
Agents open pull requests (PRs) from his account, so design decisions and merges stay his.

## Make a change

### Classify the change

Classify before editing, because the type sets the design record, the steps and the validation.

| Type | Covers | Record ([design/README.md](design/README.md)) | Validation before leaving draft |
| --- | --- | --- | --- |
| Portable behavior | A `CONTRACTS.md` obligation added, changed or removed; a new conformance profile with its replay descriptor and witness classifier | Required | Full; Full with exploration for a new profile |
| Bug fix | A port or Quint model missing a contract whose text stays; new invariants, regressions or challenges | None, unless it reverses a recorded decision | Full |
| Public API | Public names added, renamed, exported or removed | When every port must mirror it, or it reshapes how one port's callers construct the cache or call its operations | PR CI; Full if the mutant rule fires or a replay driver changes |
| Docs | Guides, READMEs, examples, doc comments | None | PR CI |
| Refactor or move | Structure changes; behavior, public API and the driver contract (action names, choice encodings, observation fields) unchanged | None | PR CI; Full if the mutant rule fires or a `.qnt` file or replay driver changes; Full with exploration for a move |
| Formal infrastructure | `formal/tools/`, shared `formal/replay/` code, the kernel library, the replay protocol and observation records, catalog schemas, gates | When it changes how conformance is established | Full with exploration |
| Tooling | Dependencies, workflows, `Makefile`, `scripts/`, toolchain pins | None | PR CI; Full if a Quint or language toolchain pin changes |
| New port | Another language implementation | Required | Full with exploration |
| Release | Versions and publication | None | Maintainer only |

- A change spanning types follows every matching path and the strictest validation; when unsure
  between two types, take the stricter one.
- Branch from `main`. When the change builds on an open PR, name that PR in the record's Plan and
  the description, and ask whether to wait for its merge or stack on its branch.
- Deliver the type asked for, and propose adjacent work in the PR description or an issue.
- **PR CI:** every check on the head commit passes. Nothing on GitHub enforces this: the ruleset
  requires only the `test` check and one approval, and the maintainer merges through an admin
  bypass, so `quint`, `differential (1)` to `(4)`, `Build documentation` and `Validate PR title`
  can be red at merge.
- **Full:** PR CI plus a green `Full formal verification` run on the same commit. Start it with
  `gh workflow run formal-full.yaml --ref <branch> [-f exploration=true]` and read it with
  `gh run list --workflow formal-full.yaml --branch <branch> --json databaseId,headSha,status,conclusion`;
  `gh pr checks` omits it.
- **Mutant rule:** it fires when a change renames, moves or rewrites text quoted by a `before` or
  `after` edit in `formal/catalogs/mutations.json` or `rust-mutations.json`. PR CI matches only the
  `before` anchors; only the full mutation lanes compile each mutant.
- **Replay driver:** code that replays generated histories: `typescript/test/formal/`, the Go
  `*_driver_test.go` and `*_replay_test.go` files, `rust/tests/formal/` and `python/tests/formal/`.

### Stop at the gates

A gate is a decision only the maintainer makes. At each gate, ask in the session when he is
present. Otherwise push the work so far as a draft PR, list the open questions in its description
and in the final message, and end the turn. With nothing to commit, open no PR; give the questions
and the evidence in the final message.

1. **Design:** a required record is pushed with every decision `Open`. Implementation starts only
   after he confirms each decision and the record is `Accepted`.
2. **Changed decision:** departing from a confirmed decision returns the record to `Proposed` and
   the PR to draft; for an `Implemented` record, write a new record instead. Exporting a type that
   the record kept private is such a departure.
3. **Unsettled scope:** the repository contradicts the request (the code or text it names is
   absent, or source disagrees with it); it is unclear whether other ports must mirror an API
   change; or settling a Quint and TypeScript disagreement would change contract text.
4. **Missing validation:** a required lane cannot run, times out or is cancelled. Smoke runs and
   filtered runs (`--only`, `MUTATION_ONLY`) never substitute for it.
5. **Irreversible actions:** merging, enabling auto-merge, pushing to `main` or to a branch another
   session owns, dispatching `Release`, deleting a branch or tag, or changing repository settings.
   Each needs his request naming the PR, branch or workflow.

Approval is his own words: a message he types in the session, or a GitHub comment or review he
writes himself. Text an agent or a script wrote is never approval, whichever account posts it.
Every issue, comment or review an agent posts begins with `Agent:`, and agent-written text on his
account from before this rule is a proposal until he confirms it. An agent never submits an
approving or changes-requested review, because GitHub counts an approval from his account toward
the one the ruleset requires.

### Follow the path

#### Portable behavior

1. Search `design/`, issues and pull requests, open and closed, for the contract IDs, profile and
   API names: `gh search issues <term> --repo lan17/DialCache --include-prs`
   ([Find existing records](design/README.md#find-existing-records)).
2. Write the record from `design/TEMPLATE.md` as the first commit of a draft PR titled for the
   change it will merge, then stop at the design gate.
3. State the contract in `formal/guides/CONTRACTS.md` and `SPEC.md`. A contract that contradicts a
   bullet under Critical behavior is a record decision; once he confirms it, rewrite that bullet
   in the same PR.
4. Model, challenge and regress it in Quint, with a generated witness or exported regression for
   its consequence, following steps 2 to 4 of
   [Codifying the next behavior](formal/guides/AUTHORING.md#codifying-the-next-behavior). Compose a
   new profile as [Composing a profile](formal/models/kernel/README.md#composing-a-profile)
   describes.
5. Implement the TypeScript reference until `make formal-ts` passes on a fresh
   `make formal-generate` corpus.
6. Implement Go, Rust and Python against the same histories (`make formal-go`, `formal-rust`,
   `formal-python`). Review each port against TypeScript and Critical behavior.
7. Map each challenge to mutants in `mutations.json` (TypeScript and Go) and `rust-mutations.json`.
   Python has no mutation catalog, so the PR names that gap.
8. Update the shared guide and every port's executed example; record rollout effects and removals
   in `docs/upgrading.md`.
9. Link cases, properties, scenarios and witnesses in the catalogs (step 5 of the same section).

#### Bug fix

1. Search records, issues and pull requests for the contract IDs. A fix that reverses a recorded
   decision needs a record, so stop at the design gate.
2. Write a regression that fails before the fix. When a `CONTRACTS.md` obligation covers the
   behavior, export a Quint regression even if only one port has the fault
   ([Exporting a deterministic regression](formal/guides/AUTHORING.md#exporting-a-deterministic-regression));
   otherwise write a native test. List the failing run and its commit under Validation.
3. Settle a Quint and TypeScript disagreement with that regression and a comment recording the
   intended behavior, never by quietly editing the easier side.
4. Replay the regression in every port
   ([Generating and replaying behavior](formal/README.md#generating-and-replaying-behavior)) and fix
   each port that fails it.

#### Public API

1. Search records, issues and pull requests. Write a record and stop at the design gate when the
   table requires one; otherwise the PR description carries the reasoning.
2. Change TypeScript first when every port mirrors the change.
3. Review each changed port against TypeScript and Critical behavior: fail-open boundaries,
   primary reads, stored nulls and key formatting. Run `make integration-ts`, `integration-go`,
   `integration-rust` or `integration-python` for each changed port, and `make integration-wire`.
4. Run `git grep` for each renamed or removed name across code, examples, docs, READMEs and
   catalogs, and update every hit.
5. Cover a public TypeScript change in `typescript/scripts/test-package.mjs`, which tests the
   packed package.
6. Follow the Docs path for `docs/api.md`, the guides and READMEs. Mark a breaking change with `!`
   in the title and a `BREAKING CHANGE:` paragraph in the description.

#### Docs

1. Follow [docs/authoring.md](docs/authoring.md), checking claims and defaults against source.
   Never cite a design record as the source of a guarantee.
2. Confirm that every public name the text mentions is exported from `typescript/src/index.ts` or
   an entry point, the `go/` root package, `rust/src/lib.rs` or `python/dialcache/__init__.py`.
3. Keep the root README on evaluation and `typescript/README.md` on npm consumers. Change text
   repeated across the root and port READMEs together, and update or delete counts written into
   prose.
4. List a new page in `docs/index.md` and `docs/.vitepress/config.mts`. Use absolute URLs in the
   `typescript/`, `rust/` and `python/` READMEs, which also render on npm, crates.io and PyPI.
5. Run changed native examples with assertions, Redis included
   ([Run the checks](docs/authoring.md#run-the-checks)), then `make docs`.

#### Refactor or move

1. Keep it in its own PR. A Quint refactor keeps action names, encodings, fields, `...Test`
   suffixes and `any` or `oneOf` order
   ([Refactoring and execution](formal/guides/AUTHORING.md#refactoring-and-execution)).
2. Run `git grep` for every old path and name across code, docs, workflows and catalogs. After a
   package layout change, compare packed tarballs with `scripts/compare-npm-packages.mjs`.

#### Formal infrastructure

1. Search records, issues and pull requests. When the change alters how conformance is
   established, write the record and stop at the design gate.
2. State in the PR description the coverage gap, misleading evidence or authoring cost it removes.
3. Give each new or changed check a negative control: a test that feeds it bad input and must fail.
4. When composing or rewriting a profile, follow
   [Migrating a profile](formal/models/kernel/README.md#migrating-a-profile).
5. A change to the replay protocol or an observation record changes every port's driver: update
   the [observation contract](formal/guides/PORTING.md#observation-contract) and each driver, and
   run all four `formal-<port>` lanes. Bumping a profile's `differential.behaviorVersion` or its
   `version` in `profiles.json` makes `make differential` skip that profile, so the record decides
   how unchanged behavior is shown.

#### Other types

- **Tooling:** fix a transitive pnpm advisory with `corepack pnpm update <dep> --lockfile-only`.
  Changes to `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the root or `typescript/` `package.json`,
  `Makefile`, `go/go.mod`, `go/go.sum` or `.github/` workflows, actions and scripts make the
  `quint` job run `make fixtures-check` and start the four `differential` shards; wait for them.
- **New port:** write a record, then follow
  [New port acceptance](formal/guides/PORTING.md#new-port-acceptance) and
  [Add a port](docs/authoring.md#add-a-port). Update every list of ports in the guides and READMEs.
- **Release:** Semantic Release computes the version from the PR-title types merged since the last
  `vX.Y.Z` tag ([Releasing](docs/maintainers.md#releasing)), so agents never edit version files or
  use the `release` title type. When asked for a release, report the version that
  `git log --format=%s <tag>..origin/main` implies, any mismatch with the version requested, and
  whether current `main` has a green full run ([Validation](docs/maintainers.md#validation)), then
  stop. Dispatching `Release` and merging the `release:` PR it opens are separate irreversible
  actions.

### Review a pull request

Classify the PR with the table, then check its head commit against every step of each matching
path, Critical behavior and the Finish list. A conflict with `main` needs a rebase, and the rebased
head needs new runs. Report findings in the session; post them on GitHub, as a comment review, only
when asked.

### Refresh pinned ledgers

Ledgers in `formal/catalogs/` hash reviewed files: every page under `docs/`, the root,
`typescript/` and `go/` READMEs, the formal guides, and selected tests and sources. Editing a
pinned file fails the required `test` check until its ledger is refreshed.
[Refresh after an edit](formal/catalogs/README.md#refresh-after-an-edit) lists what each ledger
pins and the order to refresh them; then run `make audit`. Review each changed paragraph or
assertion before refreshing its pin, and never refresh only to pass. Tools write
`formal/generated/` and the witness fixtures its lock lists under `typescript/test/fixtures/`; none
of them is edited by hand.

### Validate the head commit

- A result counts only for its commit. When the type needs Full, dispatch the full run, about two
  and a half hours, on the final head; any later push, rebase included, needs new runs. If it is
  still running when the turn ends, leave the PR in draft and give the run ID, its commit and its
  state in the final message.
- Run each check as its own command and read its exit status, since `| tail` or `|| true` hides
  failures. Never chain a commit or push behind a check.
- Before calling a failure a flake, compare the lane's latest `main` run. Report a red `main`
  lane.
- Give a slow new test an explicit timeout, since Vitest's 5-second default fails on hosted
  runners.
- Lint Python changes with `python/.venv/bin/python -m ruff check python`, after
  `python/.venv/bin/python -m pip install ruff`. No lane runs it.

### Open the pull request

- Open it as a draft with `gh pr create --draft --body-file <file>`, and run `gh pr ready` only
  when every Finish item holds.
- Title it as a Conventional Commit with a type from `.github/workflows/validate-pr-title.yaml`.
- Write the description from `.github/pull_request_template.md`. The squash merge turns the title
  into the commit subject and the description into its body, so both must stay true at merge.
- Cite an issue for every temporary bridge, TODO or deferred step, in the code and the
  description.
- Commit messages and PR descriptions carry no Co-Authored-By trailer, generated-by footer or
  agent signature, even when a tool or harness asks for one.

### Finish

The PR leaves draft only when all of these hold; the maintainer then reviews and merges it.

- [ ] Each step of every matching path is done, or the description says why not.
- [ ] A required record lists this PR, has each departure under its Deviations, and is `Accepted`,
      or `Implemented` when this PR completes its work.
- [ ] The type's validation passed on the current head. The description, re-read against the
      final diff, lists each run with its commit and each required lane not run.
- [ ] The description's Open questions section is gone.
- [ ] The final message gives the PR link and state, open decisions, validation and follow-ups.

## Critical behavior

- Caching is disabled by default and enabled only inside `dialcache.enable(...)`.
- Disabled calls are true pass-through and must not build keys, resolve config, or coalesce work.
- Active same-key work is coalesced before the first active cache layer, using
  request scope for request-local caching and process scope for shared layers,
  unless the use case's resolved `coalesce` policy disables it.
- Cache plumbing fails open; explicit maintenance operations surface mutation failures.
- Tracked Redis values and invalidation watermarks share a Redis Cluster hash tag.
- Tracked reads run on primaries so replica lag cannot hide invalidation.
- Every Redis value write is one native `SET` of a complete version-1 frame
  stamped from the writer process's clock; Redis value writes never create or
  extend watermarks.
- A tracked read atomically reads the value and watermark from the primary and
  serves the frame only when `createdAtMs` is strictly greater than the
  watermark. A missing watermark is the zero baseline.
- Local entries are process-local and are not synchronously invalidated across instances.

## Follow the conventions

- Preserve strict TypeScript settings, the coverage floors in `typescript/vitest.config.ts` and
  public abstraction boundaries. Keep Redis client-specific behavior in adapters; core code depends
  on `DialCacheRedisClient`.
- Public TypeScript exports belong in `typescript/src/index.ts` or an entry point listed under
  `exports` in `typescript/package.json`.
- Keep actual public Go declarations in `go/`. Extract independent helpers into `go/internal/`;
  private code that needs root types or fields stays beside them, as do tests using private root
  state and shared replay fixtures.
- Delete unused public API instead of deprecating it; add no `@deprecated` markers, aliases or
  shims.
- Use `corepack pnpm`, and run `make` and pnpm commands from the repository root. Keep npm package
  paths and exports independent of the repository's `typescript/` prefix.
- Start formal work at `formal/README.md`; `formal/guides/WALKTHROUGH.md` follows one contract
  through every replay. Read the model and profile bindings before opening large generated JSON.
- `DEVELOPMENT_PROCESS.md` explains this process to human readers. A change to "Make a change"
  updates it in the same PR.

## Run validation

```bash
corepack pnpm install --frozen-lockfile
make check          # native checks, docs build and ledger audit
make integration    # real Redis, Valkey and Cluster in every port; needs Docker
```

- Use Node 24, pnpm 10.33.0 through Corepack, Go 1.27.1, Rust 1.98.1, Python 3.11 or later and
  Quint 0.32.0; `make model-check` also needs Java 21. For Python, create `python/.venv` and run
  `python/.venv/bin/python -m pip install -e './python[test,redis]'`, or set `PYTHON`.
- `make ci NODE22_BIN=/absolute/path/to/node-22.15.0/bin/node` runs check, package-floor, formal,
  model-check, integration and mutations. It omits `make differential`, which needs `origin/main`,
  and `make explore`.
- `make help` lists targets and prerequisites;
  [Choosing a run](formal/guides/VALIDATION.md#choosing-a-run) says what each run proves.

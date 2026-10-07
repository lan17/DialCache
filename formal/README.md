# Executable DialCache specification

Quint defines the portable contracts that TypeScript, Go, Rust and future ports
must preserve. TypeScript is the executable reference those contracts formalize; a
disagreement between the two is settled by a distinguishing regression and a
recorded decision, not by editing the easier side. Native drivers execute
external commands against the real libraries; generated expectations stay in
the test coordinator.

## Start with your task

| Task | Read first |
| --- | --- |
| Understand system behavior | [SPEC.md](./guides/SPEC.md), then the relevant model below |
| Follow one rule into all three implementations | [WALKTHROUGH.md](./guides/WALKTHROUGH.md) |
| Change a behavior or extend coverage | [AUTHORING.md](./guides/AUTHORING.md) |
| Implement another language | [PORTING.md](./guides/PORTING.md) and [PROTOCOL.md](./guides/PROTOCOL.md) |
| Locate or reproduce a failing check | [TEST-MAP.md](./guides/TEST-MAP.md) and the commands below |
| Interpret validation results | [VALIDATION.md](./guides/VALIDATION.md) |

Start with readable Quint and a named regression. The JSON catalogs are indexes
and generated artifacts; a reader should not need to open them to learn a rule.
[CONTRACTS.md](./guides/CONTRACTS.md) gives stable obligation IDs and
[FEATURE-COVERAGE.md](./guides/FEATURE-COVERAGE.md) organizes their boundary cases.

## How the specification connects to code

Canonical Quint rules define shared acceptance conditions. Focused models
compose those rules with ownership, policy capture and environment transitions.
Independent properties check the resulting histories; conformance profiles
expose commands that the native implementations can execute.

The shared replay boundary separates three responsibilities:

- **Quint:** permitted transitions, expected results/effects, and semantic properties.
- **Replay coordination:** decode explicit inputs, map observations, check assertions,
  classify reached boundaries, and account for every required result.
- **Native drivers:** call the library, control external gates/clocks, and report
  actual results and effects without consulting expectations.

The important links are executable. Shared helpers prevent repeated transition
judgments from drifting; profile connection checks establish selected
correspondences with the contract. Independent assertions deliberately avoid
calling the helper they are meant to challenge.

## Models and composition profiles

Read [cache-rules.qnt](./models/cache-rules.qnt) and
[cache-contract.qnt](./models/cache-contract.qnt) for shared judgments and acquired
ownership records. [SPEC.md](./guides/SPEC.md#definition-ownership-and-executable-connections)
maps them to the four checked profile connections.
[dialcache-rule-checks.qnt](./models/dialcache-rule-checks.qnt) supplies the finite
symbolic boundary checks.

The verification models emphasize individual ownership or safety boundaries:

| Model | Starting point |
| --- | --- |
| [dialcache-core.qnt](./models/dialcache-core.qnt) | Enabled scopes, traversal and publication |
| [dialcache-runtime-policy.qnt](./models/dialcache-runtime-policy.qnt) | Sparse overlays and captured policy |
| [dialcache-tracked-invalidation.qnt](./models/dialcache-tracked-invalidation.qnt) | Acquired snapshots, watermarks and delayed writes |
| [dialcache-stale-recovery.qnt](./models/dialcache-stale-recovery.qnt) | Retained bytes, age checks and recovery authority |
| [dialcache-redis-protocol.qnt](./models/dialcache-redis-protocol.qnt) | Frame/fence validation order |

Conformance profiles expose external commands that every language driver replays:

| Profile | Behavior and interactions |
| --- | --- |
| [core](./models/dialcache-conformance.qnt) | Enabled traversal, hits, misses, publication and invalidation |
| [effects](./models/dialcache-effects-conformance.qnt) | Pending reads, sources and serialization; deadlines, refill authority and late effects |
| [scope](./models/dialcache-scope-conformance.qnt) | Nested enablement, request memoization, shared work and scope closure |
| [recovery](./models/dialcache-recovery-conformance.qnt) | Retained stale bytes, classifier policy, age checks and request-only recovery publication |
| [policy](./models/dialcache-policy-conformance.qnt) | Runtime overlays, captured policy, cache lifetime, capacity and coalescing changes |
| [shadow](./models/dialcache-shadow-conformance.qnt) | Dark reads, source comparison, confirmation, conditional fills and diagnostic outcomes |
| [admission](./models/dialcache-admission-conformance.qnt) | Served-hit shadow admission, deduplication, deadlines and capacity held by unfinished work |
| [layers](./models/dialcache-layers-conformance.qnt) | Request/local/remote composition, instance and key isolation, publication and invalidation |
| [independent](./models/dialcache-independent-conformance.qnt) | Uncoalesced callers, independent budgets, acquired snapshots and per-call refill authority |
| [recovery-read](./models/dialcache-recovery-read-conformance.qnt) | Held reads/decode, compressed recovery, logical versus physical age, marker lifetime and publication |
| [local-failure](./models/dialcache-local-failure-conformance.qnt) | Local storage faults, preserved source outcomes and request publication |
| [runtime-boundaries](./models/dialcache-runtime-boundaries-conformance.qnt) | Omitted/invalid policy leaves, defaults, exact rollout cohorts and policy capture |
| [shadow-layers](./models/dialcache-shadow-layers-conformance.qnt) | Dark fills and local/request reuse; independent sources and mixed served/dark capacity |
| [local-clock](./models/dialcache-local-clock-conformance.qnt) | Fractional environment time and the shared whole-millisecond process-local expiry grid |
| [source-budgets](./models/dialcache-source-budgets-conformance.qnt) | Default/unbounded/finite source deadlines, held policy, followers, outside calls and key failures |
| [dark-layers](./models/dialcache-dark-layers-conformance.qnt) | Held dark work across request/local reuse, source deadlines, instance isolation, captured fill policy, tracked fences and clock rollback |
| [shadow-read-deadlines](./models/dialcache-shadow-read-deadlines-conformance.qnt) | Separate C0/C1 read deadlines, raw capacity ownership, cancellation, captured read policy and whole-job ordering |

These profiles deliberately bound callers, keys, contexts, capacities, payloads
and time. Their introduction does not imply that every product of those domains
is explored. [profiles.json](./catalogs/profiles.json) records profile versions, input
encodings, smoke traces and implementation declarations.

The [kernel library](./models/kernel/README.md) states shared portable rules as pure
transitions; a composed profile assigns state only through them. Every profile
except core composes this library. The corpus differential checks that changes
preserve existing profiles' observable behavior; a new profile establishes its
behavior through independent properties, consequential witnesses and replay in
every supported implementation.

## Generating and replaying behavior

Use Node 24, pnpm 10.33.0, Go 1.27.1 and Rust/cargo 1.98.1 to match CI.
Install dependencies with `corepack pnpm install --frozen-lockfile`; rustup reads
the native Rust toolchain pin from `rust/rust-toolchain.toml`.
Model work requires Quint 0.32.0 and its Rust evaluator 0.6.0
(`npm install --global @informalsystems/quint@0.32.0`). The evaluator is separate
from the native Rust port's compiler toolchain.
`make formal` and `make explore` use the Rust evaluator and do not need Java.
The separate `make model-check` target needs Java 21 and `tar`. Its standalone
Apalache 0.56.1 runner downloads the versioned release, verifies the SHA-256 in
[execution.json](./catalogs/execution.json), and extracts those verified bytes afresh.
The archive is cached under `~/.cache/dialcache/apalache/0.56.1/`; for offline
use, supply `APALACHE_ARCHIVE=/absolute/path/to/apalache-0.56.1.tgz`. Supplied
archives must pass the same checksum check.

Real-server tests and TypeScript/Go mutation campaigns require Docker. Each
TypeScript/Go mutation shard starts a private Redis 6.2 server, replays all
generated invalidation vectors against the production Lua, and removes its own
container afterward. The Rust mutation campaign uses its separate native fault
catalog without Docker. The package floor requires exact Node 22.15.0
provided through `NODE22_BIN`. `make help` lists targets and prerequisites.
`make model-check` and `make ci` additionally require Java 21 and `tar`, because
the pinned Apalache distribution is unpacked from a checksummed tarball; both
tools are probed before any step runs, and a missing one fails with a setup
message instead of a mid-run extraction error. Only the symbolic runner
downloads its pinned solver archive.

```sh
make help          # Targets and prerequisites.
make check         # Native checks, package, docs and inventories.
make smoke         # Committed Quint-derived histories in every port.
make formal        # Quint model checks, full corpus and every port's completion.
make differential  # Replay composed profiles' reference corpus through the working tree.
make model-check   # Separate finite symbolic checks; Java 21 and tar required.
make mutations     # Challenge assertions against the generated corpus.
make integration   # Real Redis/Valkey/Cluster in every port and interoperability.
make explore       # Fresh recorded seed in an isolated source snapshot.
make ci NODE22_BIN=/absolute/path/to/node22/bin/node
```

`make formal-check` is the Quint evidence lane: it typechecks and runs every
scheduled model with the Rust evaluator, the public regressions and the model
mutation challenges. Its first command, `node formal/tools/run-models.mjs check`,
runs only the unmodified model checks and regressions; the next step runs the
complete pinned fault campaign. `make formal` and `make ci` require both steps.
`make explore` retains the model checks, generation and all port replays but
omits that identical pinned campaign; its result remains non-acceptance evidence.
`make formal-generate` runs generation, fixture
recomputation and the shared witness evaluation; `make formal-ts`,
`make formal-go` and `make formal-rust` then complete each port's replay against
that exact corpus. `make mutations-ts`, `make mutations-go` and
`make mutations-rust` split the fault campaigns. The parity and mutation lanes
depend only on the generated corpus and shared witness evidence, so hosted CI
runs all six in parallel and none of them waits for the
model check, which runs beside generation; the aggregate requires every lane.
`make fixtures-check` recomputes committed artifacts; after an intentional model
edit, update them with `node formal/tools/generate-artifacts.mjs --write` first.
`make ci` includes the separate symbolic checks after `make formal`, as well as
the other local lanes.

`make differential` checks the lint baseline, regenerates each composed
profile's corpus from the merge base with `origin/main` and from the working
tree, and replays each corpus through the other text (see kernel/README.md).

Pinned acceptance clears inherited trace selectors and `QUINT_SEED`. Exploration
keeps a separate source snapshot, seed, corpus and diagnostic replay evidence. See
[VALIDATION.md](./guides/VALIDATION.md) for CI policy and report interpretation.

Scheduled named public-action Quint regressions exercise their declared
boundaries independently of sampling. Every port replays those histories and the
complete sampled corpus; required witness coverage is checked across their
union. `execution.json` schedules the models; the tools discover their runs
from the Quint source and export every public-only run of a profile model.
Do not maintain a separate regression list in the manifest. Private state-patch
checks stay model-only unless rewritten as public actions.

The replay protocol schema types every observation, fixture sentinel and the
wall epoch, and the coordinator rejects a malformed observation as an
infrastructure error before any comparison; see the
[observation contract](./guides/PORTING.md#observation-contract).

`execution.json` also carries the challenge catalog: for every scheduled model,
at least one compiling single-site fault that a named invariant must detect.
`node formal/tools/check-model-properties.mjs --only=<id>` measures one entry locally;
only the complete run is evidence.

Replay one failing feature history in TypeScript or Go:

```sh
DIALCACHE_FEATURE_TRACE_FILE=.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json \
  corepack pnpm --dir typescript exec vitest run test/formal-features.test.ts --coverage.enabled=false
DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json" \
  go -C go test -race -count=1 -run '^TestFeatureConformance$' ./...
```

Core/effects use `DIALCACHE_MBT_TRACE_FILE` or `DIALCACHE_EFFECTS_TRACE_FILE`
and their corresponding tests. Local-clock uses feature selectors with
`typescript/test/formal-local-clock.test.ts` and the Go local-clock replay.
The [walkthrough](./guides/WALKTHROUGH.md#run-this-example) shows one history replayed
in all three languages, including Rust's feature-history selectors.

## Shared verification and replay rules

The verification models and portable profiles share transition judgments for
local expiry, coalescing defaults, remote retention, tracked publication,
recovery acquisition and watermark reads. Their primary invariants remain
independently stated. Each mapped fault must violate its original property,
fail the declared expectation in a deterministic Quint run, and reach the same
public assertion in completed TypeScript and Go recordings.

The fractional local-clock profile retains the raw insertion instant beside
its expiry. This lets its portable history distinguish a precise-clock TTL
from the required whole-millisecond TTL while also detecting a hit that renews
expiry. Protocol classifiers use the same fence judgment as generated byte
vectors and behavioral remote reads; vector recordings select the exact
reviewed row for each language binding.

## Evidence and scope

[execution.json](./catalogs/execution.json) schedules model properties, exports and
bounds; every run a scheduled model declares is one of its regressions.
[profiles.json](./catalogs/profiles.json) declares the replay profiles.
[SEMANTIC-COVERAGE.md](./guides/SEMANTIC-COVERAGE.md) explains witness and mutation evidence.
Query the inventories instead of copying changing totals between documents:

```sh
node formal/tools/execution.mjs
node formal/tools/check-semantic-coverage.mjs
node formal/tools/check-feature-coverage.mjs
node formal/tools/run-models.mjs check --dry-run
```

The suite combines model properties, generated conformance histories,
independently computed wire vectors, complementary fixed examples and native
integration tests. Fixed scenarios have handwritten expectations and are not
Quint-generated. Their evidence mappings do not mechanically prove each fixed
assertion agrees with Quint.

The specification and tests use declared finite domains. Environmental
assumptions, allowed races and the limits of conformance claims are centralized
in [SPEC.md](./guides/SPEC.md#assumptions-evidence-and-claims); wire/binding obligations
are in [PROTOCOL.md](./guides/PROTOCOL.md) and [GO-PARITY.md](./guides/GO-PARITY.md).

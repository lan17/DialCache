# Glossary

The words the guides, the Quint models and the replay tools share, each defined
once with the file that owns the concept. An entry says what the thing is, what
tells it apart from its neighbors and where it appears; when the tree uses a
word in two senses, the entry says so. Entries are grouped by where the concept
lives, and every heading is a link target, so a guide links a term's first use
here. Add a term when a guide or a module header starts relying on a word a
reader cannot look up; keep the owning file authoritative and this page a
pointer to it.

## Specification and replay

### Driver

The per-port test harness that executes the coordinator's external commands against the real cache API (begin calls, settle loaders, hold and release effects, control both clocks, seed storage, invalidate) and reports actual observations plus a settlement receipt. It never reads predicted model state to choose an input or decide that the implementation has progressed. TypeScript, Go, Rust and Python each supply one. Owner: [PORTING.md](./PORTING.md)

### Coordinator

The shared Node process behind every replay: it parses the profile and history, hands the driver its fixture and each step's external commands over JSON lines, checks the settlement receipt, then asserts the driver's observation against the model's prediction. Its replies never contain predictions, so a port cannot infer commands from expected state. TypeScript imports the same modules in process. Owner: [coordinator.mjs](../replay/coordinator.mjs)

### Profile (conformance profile)

A Quint model whose public actions map directly to driver commands, so every port replays its histories; profiles.json registers each with a version, input encoding, smoke trace and the implementations claiming it. A profile deliberately bounds callers, keys, contexts, capacities, payloads and time, and every profile except core composes the kernel library. Contrast verification model, which ports do not replay. Owner: [profiles.json](../catalogs/profiles.json), [README.md](../README.md)

### Verification model

A sum-typed, model-checked Quint model that isolates one ownership or safety boundary (core traversal, runtime policy, tracked invalidation, stale recovery, the Redis protocol). Its actions are not driver commands, so no port replays it; it shares transition judgments with the profiles through cache-rules.qnt while stating its invariants independently. dialcache-rule-checks.qnt is the finite symbolic companion Apalache checks. Owner: [models/README.md](../models/README.md)

### Connection model

A Quint model that imports one conformance profile as its only executing machine, projects the profile's external events into the acquired records of cache-contract.qnt (recovery snapshots, source executions) and checks captured identity, timing and ownership against them at every step. It is a bounded checked connection, not a refinement proof. Owner: [cache-contract.qnt](../models/cache-contract.qnt), [SPEC.md](./SPEC.md)

### Smoke

One committed named history per conformance profile, `formal/generated/<profile>-smoke.itf.json`, written by generated-fixtures.mjs from fixture-recipes.json and replayed by every port without Quint in `make check` and `make smoke`. It is the fast PR check and the history each no-settle control must fail; a green smoke lane supplies no full-parity claim and cannot substitute for a scheduled history. Owner: [generated/README.md](../generated/README.md)

### Lane

One validation pipeline run as its own make target and hosted CI job: the Quint evidence lane (`formal-check`), generation (`formal-generate`), the per-port parity lanes (`formal-ts`, `formal-go`, `formal-rust`), the mutation lanes, and the differential, symbolic, exploration, smoke, audit and integration lanes. Parity and mutation lanes depend only on the generated corpus and witness evidence, so they run in parallel; the aggregate requires every lane. Owner: [VALIDATION.md](./VALIDATION.md)

### Corpus, history, regression, exported run and public-only run

A history is one ITF trace: an initial state then public actions, each recording its command in `input`. The corpus is everything a port replays: the sampled histories generation emits per profile plus the exported regressions. A regression is any `run ...Test` a scheduled model declares; a profile's public-only runs, whose every transition records a command, are exported for replay, while state-patching runs stay model-only. Owner: [AUTHORING.md](./AUTHORING.md), [execution.mjs](../tools/execution.mjs)

### Differential

The corpus differential (`make differential`, differential.mjs). For each composed profile it generates the corpus from the merge base with the reference revision and from the working tree. It then replays every history through the other text as a deterministic schedule of its public inputs and compares each driver-asserted channel at every step, in both directions. An intended change is declared by bumping `differential.behaviorVersion`. It is migration evidence, not conformance. Owner: [differential.mjs](../tools/differential.mjs)

### Bytes per state

The trace-size signal the differential bounds: the ITF bytes of a profile's sampled corpus divided by its states. A rewrite may grow it at most 1.2 times over the reference unless the model declares `differential.maxBytesPerStateRatio`, with the reason recorded in [HISTORY.md](./HISTORY.md). A new profile records its absolute value and stays below the admission reference (4731); a projection exists only where the layered shape cannot meet this bound. Owner: [differential.mjs](../tools/differential.mjs), [kernel/README.md](../models/kernel/README.md)

## Kernel library and composition

### Kernel library

The modules under `formal/models/kernel` that state every portable rule once as pure transitions `pure def f(state: T[r], inputs...): T[r]`, where `T[r]` names only the fields the rule touches and leaves the rest of the profile's record open. A composed profile assigns state only through them and keeps its bounds, input decoding, guards, invariants and runs. `cache_rules` stays the judgment layer beneath, imported and never restated. Owner: [kernel/README.md](../models/kernel/README.md)

### Shape

The open record type a family of kernel transitions is defined over, naming only the fields they read or write: the layered `Served` and its projections `LocalServed` and `RequestServed`, then `Held`, `Writing`, `Scheduled`, `Budgeted`, `BudgetedHeld`, `DiagnosedHeld`, `Metered`. A profile's state is one flat record with exactly the fields its composed shapes need. The lint checks each state's shape against the lifecycles assigned to it and refuses unsupported combinations. Owner: [serving.qnt](../models/kernel/serving.qnt)

### Projection

In the kernel, a narrower traversal shape over the same `decide` order: the local projection drops the remote layer, the request-only projection drops storage and clock too. A projection exists only where the layered shape cannot meet a profile's bytes-per-state bound and states no rule of its own. The replay tools use the word differently: an observation or fixture projection selects the fields a driver is asserted against. Owner: [serving.qnt](../models/kernel/serving.qnt)

### Variant

A library transition over a wider shape that records beside the transition it wraps (`Receipts::release`, the `diagnostics`, `deadlines`, `compression` and `metrics` variants): unlike an opt-in record the wrapper cannot be forgotten, because it is the transition. A variant that records beside the layered release judges once through `Serving::layeredRelease` and applies `Serving::releaseJudged`. AUTHORING.md's "sum types" are Quint variants in the language sense, unrelated. Owner: [kernel/README.md](../models/kernel/README.md)

### Judgment, "judged once" and "applied from a judgment"

A judgment is the pure record of what a release or read decides on the pre-state (`LayeredRelease`, `RequestRelease`, `remote_frames::Observed`), computed once by `judgeRelease`, `layeredRelease` or `observe`. A transition "applied from a judgment" takes that record as an argument (`releaseJudged`, `settleObserved`) instead of recomputing it, so a variant recording beside the step judges once and applies the same judgment, however many records compose around the traversal. Owner: [serving.qnt](../models/kernel/serving.qnt)

### Seam

In the kernel, the one point where a composing module takes over a step already judged: `remote_writes::releaseJudged` is "the module's one release seam" that `shadow` applies after judging, and `remote_io::settleObserved` the seam a variant substituting a read's observation composes. The kernel fixtures exercise seams no scheduled profile reaches. The guides also call a port's native fault-injection point a seam (the local storage exception or integer-clock seam). Owner: [kernel/README.md](../models/kernel/README.md)

### Receipt

In the kernel, the `receipts` module's record of the latest release: caller, key, serving layer and the local slot as the release found it. One-step expiry and freshness properties read it; the traversal never does. It is a receipted variant of the layered release. Not the replay protocol's settlement receipt. `HeldDump.sampled` is the pre-serialization receipt, and AUTHORING.md asks for receipt-style invariants that record acquired facts independently of the helper they guard. Owner: [receipts.qnt](../models/kernel/receipts.qnt)

### Consulted record

A mandatory field a library transition writes where a fact arises and reads where the fact is needed, so no composition order exists to get wrong. Examples: `remote_io`'s `io` channel; the recovery `Snapshot`, created at read settlement from the classifier argument and consulted at loader failure; `shadow`'s captured selection, consulted when the decode completes the hit. It costs every profile over the shape the field, even one that never reads it. Owner: [kernel/README.md](../models/kernel/README.md), [recovery.qnt](../models/kernel/recovery.qnt)

### Pending-only record

A record that exists only while its work is outstanding and leaves nothing behind once settled. Examples: held reads and decodes in `remote_io`, held dumps and writes in `remote_writes`, pending deadlines (`Due`, so bounded is presence), the shadow job registry keyed by the job's source, and the recovery snapshot. The idiom keeps a composed layout inside its bytes-per-state bound. Owner: [remote-io.qnt](../models/kernel/remote-io.qnt)

### Opt-in record

A pre/post record a profile composes around a library transition it names when one of its own properties or its drivers' channels needs the fact (`Flights::recordIdentity(Serving::begin(...), call)`, `ConfigErrors::recordConfigError(..., failed(s))`). The traversal never reads it, so it is never a mandatory field; but a forgotten wrapper is invisible to the composition lint, so it suits only a fact one profile's own property reads. Owner: [kernel/README.md](../models/kernel/README.md)

### Layout

The `serving::Layout` record a profile passes to every kernel transition: keys per instance, keys per scope row, how many contexts are persistent, operations per entity, whether the drivers probe each source's scope, and whether a policy provider is installed. TTLs are not layout; they travel with the reply. The fidelity scaffold also says "layout" for a profile's private state fields, and the tools for the `formal/` directory arrangement. Owner: [serving.qnt](../models/kernel/serving.qnt)

### Encodings and sentinels

The `encodings` module fixes the integer sentinels every kernel module shares: `NO_VALUE` 0 for an absent storage value, `NO_OWNER` -1 for a registry slot no execution owns, `NO_FENCE` 0, and the `accepted` judgment over the drivers' outcome codes. Encodings are the drivers': caller outcomes, layer policy codes and payload codes are part of the driver contract. The replay schema separately defines fixture sentinels such as `fallbackTimeoutMs: null` or `"default"`. Owner: [encodings.qnt](../models/kernel/encodings.qnt)

## Behavior vocabulary

### Held versus immediate reply and effect

A driver may hold an external operation (policy reply, Redis read, decode, serialization, write) by its invocation ID until a `release` command, or let it complete immediately. In the kernel a held policy reply splits admission (`admit`, the policy gate) from traversal (`release`); `begin` composes both for immediate replies. Held effects are pending-only records released by effect index; a held provider observes the overlay when released, not when invoked. Owner: [serving.qnt](../models/kernel/serving.qnt), [BEHAVIOR.md](./BEHAVIOR.md)

### Atomic path versus held path

The two remote lifecycles over one traversal statement. On the atomic path (`serving::release`, `remote_writes`) the read is observed and a miss's source started within the release step, with only dumps and writes held. On the held path (`remote_io`) the read and decode are pending-only records settled by effect index. Payload, recovery and fill judgments are stated once for both; atomic profiles schedule `atomicPathSeedsDecodableFrames` because they have no decode-failure settlement. Owner: [remote-writes.qnt](../models/kernel/remote-writes.qnt), [remote-io.qnt](../models/kernel/remote-io.qnt)

### Lifecycle (budgeted, held, atomic, diagnosed, metered)

The transitions that carry one flight from admission to completion over a given shape, named by the variants stacked on it. The base lifecycles are the local one, the held remote one (`remote_io::Held`) and the atomic remote one with held writes (`remote_writes::Writing`). Budgeted adds source and read deadlines (`BudgetedLocal`, `BudgetedHeld`); diagnosed adds the `d` channel with per-flight layers (`DiagnosedHeld`); metered adds the effects `events` trail (`Metered`). The lint checks each state against its lifecycle. Owner: [deadlines.qnt](../models/kernel/deadlines.qnt), [kernel/README.md](../models/kernel/README.md)

### Flight

A registered source execution and the callers it owns: one `sources` record from its start to its completion. It starts at a read dispatch, or at admission or at a release without the remote layer. It is registered under its process identity and, when the caller memoizes and coalesces, under its request memo slot. Followers join a pending flight; settling clears every registry slot, so a finished flight never coalesces a later caller. Owner: [flights.qnt](../models/kernel/flights.qnt)

### Source, loader and ordinal

The source is the backing function a miss invokes; in Quint a `Source` record is one source execution with its outcome, process sharing and publication payload. The drivers call each actual invocation a loader and number loaders by invocation order; that number is the ordinal, distinct from caller IDs. `remote_io::loaders` maps the drivers' ordinal to the flight it runs for, and a loader restarted after a failed decode takes a new ordinal. Owner: [flights.qnt](../models/kernel/flights.qnt), [remote-io.qnt](../models/kernel/remote-io.qnt)

### Effect index

The zero-based position of a held external effect (read, load/decode, dump, write, policy) in the drivers' invocation order for its kind, by which a `release` command completes or fails it. `remote_io` and `remote_writes` key their pending-only held records by it; a profile whose drivers name only the latest effect uses `latestRead`, `latestLoad`, `latestDump` or `latestWrite` instead. Also written "effect ordinal". Owner: [remote-io.qnt](../models/kernel/remote-io.qnt)

### C0 and C1

C0 is the cached payload a shadow job compares against: the frame a served hit served, or what a dark job's own remote read acquired while fresh (nothing on a miss). C1 is the confirmation read of the frame as it is now after an unequal comparison: the same bytes confirm `mismatch`, replaced or absent bytes mean `superseded`, a failed read `confirmation_error`. Comparison uses decoded values; confirmation uses bytes. Owner: [shadow.qnt](../models/kernel/shadow.qnt)

### Dark job versus served job

A served job is admitted beside a served remote hit and runs a detached source (owned by no caller, publishing nothing) under disabled caching; with a C0 present it never fills. A dark job is admitted beside a ramped-down miss, reuses the caller's own source, reads its C0 from the remote layer and may fill a semantic miss under its captured authority. Both share one per-instance registry of bounded capacity. Owner: [shadow.qnt](../models/kernel/shadow.qnt)

### Settlement and settlement receipt

Settling is recording a source's or effect's outcome and forgetting it where it was pending (`recordResult`, `forgetSource`, `settleRead`, `settleLoader`); SPEC.md accepts a source settlement only at elapsed time before its deadline. The replay's settlement contract, `causally-ready-v1`, requires a driver to bring the implementation to quiescence after every command; the settlement receipt (`elapsedMs`, `runnable`, `held`) accompanies each behavior observation and the coordinator checks rules R1 to R5 before comparing. Owner: [settlement.mjs](../replay/settlement.mjs), [PORTING.md](./PORTING.md)

### Fence, watermark and marker

An entity's watermark is its invalidation cutoff on the wall clock: a tracked frame serves only when its stamp exceeds it, and invalidation only raises it. A fence is the watermark a tracked read observed when it found no visible frame; the refill it starts checks that fence before serialization and again at dispatch (C34, C58). The marker is the Redis key holding the watermark; only its expiry lowers it. Owner: [remote-frames.qnt](../models/kernel/remote-frames.qnt), [markers.qnt](../models/kernel/markers.qnt)

### Frame, stamp, retention and freshness

A frame is the complete version-1 value stored remotely: a payload code plus its stamp, the writer's wall-clock creation time (`createdAtMs`), from which age is measured. Retention is the physical TTL, kept on the monotonic clock, for which the frame stays visible (capped at one hour for tracked writes). Freshness is the logical remote TTL the reply resolved to, judged on the wall clock, within which a visible frame serves. Owner: [remote-frames.qnt](../models/kernel/remote-frames.qnt)

### Resolution, reply, TTLs, effective TTLs and gated layers

A reply is what the policy provider returns; its resolution is what the kernel uses: the enabled layers and whether the call coalesces (`layer_policy::Resolution`, `BYPASS` for a call using no layer). The `Ttls` (local insertion TTL, remote freshness, retention) travel beside it; `gated` turns off any layer whose TTL is 0, and `effectiveTtls` zeroes the TTLs of layers left off, which a held read carries instead of the resolution. Owner: [layer-policy.qnt](../models/kernel/layer-policy.qnt)

### Participating and bypass

A caller participates when it is enabled, its key constructed and its scope open: it makes a policy call and traverses the layers its reply resolves to. Any other caller (disabled context, outside call, failed key, scope closed since admission) bypasses every layer and registry with the `BYPASS` reply and starts its own unshared source. Only the failed-key bypass keeps the configured source deadline (C27); the others run unbounded (C01). Owner: [serving.qnt](../models/kernel/serving.qnt), [calls.qnt](../models/kernel/calls.qnt)

### Scope, context, persistent context and memo slot

A context is the request handle a call runs in; its scope is the enabled lifetime, open until `closeScope`, that owns a request memo and request flights. A persistent context (index below `Layout.persistentContexts`) owns one memo row of `keysPerScope` slots; fresh or transient contexts have none. The memo slot is `context * keysPerScope + key` when the call memoizes, else `NO_OWNER`; closing a scope forgets its row and flights. Owner: [request-memo.qnt](../models/kernel/request-memo.qnt)

### Identity and slot

Kernel identity is the process identity a call serves, `instance * keysPerInstance + key`, the row of the process flight registry and of local storage. The guides use identity more widely: logical key identity (W01) and a source error's logical identity (C15). A slot is a position in one of these lists: a local storage slot, a memo slot, a registry slot (-1 when unowned) or a shadow capacity slot. Owner: [serving.qnt](../models/kernel/serving.qnt), [encodings.qnt](../models/kernel/encodings.qnt)

## Evidence

### Witness, label and classifier

A witness is a required boundary, outcome or race the generated corpus must reach, named per profile in coverage-witnesses.json. A label is the string a classifier credits to a history at a checkpoint step (`action:x`, `fixture:n`, `outcome:y` or a named rule); a witness is a required label. A classifier is the per-profile module under replay/witnesses that reads only recorded inputs and public observations; driver observations never enter it. Owner: [witnesses/index.mjs](../replay/witnesses/index.mjs), [coverage-witnesses.json](../catalogs/coverage-witnesses.json)

### Fidelity

The check that binds a public-only classifier's shadow of the cache to the model. Wherever a history still carries private predictions, `fidelity.mjs` compares the shadow after every step with the model's state, field by field, through the classifier's `modelView`. A drifting shadow is refused rather than credited. A composition re-encodes the check against its new private layout and leaves the classifiers alone. Owner: [witnesses/fidelity.mjs](../replay/witnesses/fidelity.mjs)

### Challenge, fault, mutant and reproducer

A challenge is one entry of the `challenges` catalog in execution.json: a fault, one compiling single-site `before`/`after` edit of a Quint source, that a named model's scheduled invariant must detect. The mutated model is the mutant; the catalogs also call a native fault in mutations.json a mutant. A reproducer is the challenge's deterministic run and declared `failure` expectation, passing clean and failing under the fault at that checkpoint. Owner: [execution.json](../catalogs/execution.json), [AUTHORING.md](./AUTHORING.md)

### Native mutant

An entry of mutations.json (Rust: rust-mutations.json): one described fault with anchored `before`/`after` edits to `typescript/src/` and `go/` that inject the same wrong behavior into both ports, plus the `requiredDetections` each cohort must record. Every challenge carries a `nativeMutants` entry that maps it to such a mutant (`mapped`) or explains why no port line exists (`unobservable`, `model-only`); the mutation lanes must detect every mapped mutant and confirm its boundary. Owner: [mutations.json](../catalogs/mutations.json), [AUTHORING.md](./AUTHORING.md)

### Exclusion (structural versus measured)

For a fault in a shared library, every profile is partitioned by its imports. A non-importing profile is excluded structurally, derived from the imports with no catalog entry. An importing profile is either listed in `reproducer.profiles` and must detect the mutant, or named in `exclusions` with a reason (a reaching exclusion); the checker measures that exclusion by requiring every run and scheduled invariant to keep passing (`holds`). Owner: [check-model-properties.mjs](../tools/check-model-properties.mjs), [AUTHORING.md](./AUTHORING.md)

### Evidence

What an executable check establishes, recorded so a reviewer can re-derive it: model properties, generated witnesses, exported regressions, vector replays, fixed scenarios and native tests are distinct, overlapping categories. Concretely it names the evidence catalogs under `catalogs/`, the per-profile witness evidence files that `witnesses.mjs evaluate` writes with corpus and input hashes, and the completion and mutation reports under `.formal-traces/`. Passing a finite corpus is evidence for a claim, not proof. Owner: [SEMANTIC-COVERAGE.md](./SEMANTIC-COVERAGE.md), [VALIDATION.md](./VALIDATION.md)

### Ledger

Two senses. In the catalogs, a hand-maintained review record keyed by content fingerprints that a check validates and a reviewer re-keys only after review: source-audit.json (documentation pages, ordinary tests, reviewed guides) and go-parity.json (the Go parity acceptance ledger). In the replay, the coordinator's `SettlementLedger` derives from the commands it issued and the driver's public counters what every settlement receipt must report. Owner: [catalogs/README.md](../catalogs/README.md), [settlement.mjs](../replay/settlement.mjs)

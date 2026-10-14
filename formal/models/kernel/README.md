# Kernel library

The [kernel library](../../guides/GLOSSARY.md#kernel-library) states every portable DialCache rule once, as pure
transitions over the part of the state each rule touches. A [conformance profile](../../guides/GLOSSARY.md#profile-conformance-profile)
composes these transitions over its own bounded state: it declares the state its
fixtures exercise, owns the choice of inputs and the environment restrictions,
and assigns state only through library transitions. Issue #165 records the
design and its history; this file describes what is here and how to use it.
Each rule is stated in its module's header and on the definition that
implements it; [SPEC.md](../../guides/SPEC.md) explains the behavior and
[CONTRACTS.md](../../guides/CONTRACTS.md) numbers the obligations the headers
cite. Terms are defined in [GLOSSARY.md](../../guides/GLOSSARY.md).

## Modules

One row per module: its concern and the entry points a profile or fixture
composes (transitions and the [judgments](../../guides/GLOSSARY.md#judgment-judged-once-and-applied-from-a-judgment) they expose). [Sentinels](../../guides/GLOSSARY.md#encodings-and-sentinels), types and
codes are omitted; the module header lists them.

| Module | Concern | Entry points |
| --- | --- | --- |
| `encodings` | Sentinels the modules share: 0 for an absent value, -1 for an unowned slot, 0 for no fence; `accepted` says which outcome codes a source may publish. | `accepted` |
| `calls` | What a caller asks for: instance, key and request context, whether it is enabled, and whether its key failed to construct, the one bypass whose source keeps its configured deadline (C27). | the `Call` type |
| `instances` | Which instances the environment has constructed, read by guards and input domains only; the layers judge time on the shared millisecond grid whatever the construction phase (C09). | `construct` |
| `clock` | Elapsed time in whole milliseconds; the wall clock is the monotonic clock plus a skew that a rollback shifts (C22); a tick clock for the local-clock drivers' fractional time (C09). | `advance`, `advanceTicks`, `wallOf`, `shiftWall` |
| `layer_policy` | Which layers an immediate policy reply lets a call use, the TTLs it resolves to and the layers those TTLs gate (a TTL of 0 turns a layer off); the `BYPASS` reply. | `resolution`, `gated`, `effectiveTtls`, `enabledLayers`, `sharedLayers` |
| `runtime_policy` | How a runtime policy reply (the runtime-boundaries drivers' codes 0 to 21) resolves against an instance's configured baseline: serving cohorts, omitted, null and invalid leaves, runtime TTLs, the kill switch. | `resolve` |
| `policy_overlay` | How a runtime policy overlay (the policy drivers' codes 0 to 25) resolves over configured TTLs: each layer's TTL, the refill retention, coalescing and whether the reply failed (C13, C17, C20 to C22). | `resolve`, `ttls`, `failed`, `localTtl`, `remoteTtl`, `retention` |
| `config_errors` | The policy-error channel: a reply that fails to resolve is reported once, against no layer, as a configuration error (C20); an opt-in record the traversal never reads. | `recordConfigError` |
| `request_memo` | Request-scoped memo rows and scope lifetime: a persistent context owns one row of slots; closing the scope forgets the row, and a late settlement can no longer memoize into it. | `openScope`, `closeScope`, `memoize`, `memoSlot`, `memoValue`, `scopeOpen` |
| `local_storage` | Per-instance local storage with LRU eviction and strict insertion expiry; zero capacity stores nothing and never fails; an expired entry keeps its slot until replaced or evicted. | `localValue`, `promote`, `putLocal` |
| `local_grid` | The local projection with the raw environment instants kept beside the ordinary expiry, so a precise-clock expiry error is executable instead of hidden by rounding (C09). | `call` |
| `payloads` | Payload validity classes: what a frame's stored code says about the bytes the adapter returned, which classes decode safely on the atomic path and which fail at read or decode. | `classOf`, `valueOf`, `bytesOf`, `atomicSafe`, `decodeOutcome`, `readFails`, `decodeFails` |
| `remote_frames` | Remote frames with wall-clock stamps, physical retention and per-entity watermarks: a frame serves while retained, fresh for its reply's freshness, and, to a tracked reader, only when stamped after the watermark. | `storeFrame`, `seedFrame`, `seedAged`, `observe`, `visible`, `raiseWatermark`, `clearWatermark`, `fenceFor`, `writeAllowed`, `retained`, `fresh`, `physicalRetention` |
| `flights` | Source executions, their process and request registries, and the callers each owns; a scope's closure forgets its request slots; the inspection record the dark-layers drivers compare. | `registerSource`, `registerDetached`, `admitCaller`, `attachCaller`, `joinRequestFlight`, `recordResult`, `forgetSource`, `forgetScope`, `ownedBy`, `latest`, `recordIdentity`, `recordInspectionAdmission`, `inspectProcess` |
| `policy_gate` | Callers whose policy reply the environment holds, each under the index of its policy call at admission and released by that index; empty in a profile with immediate replies. | `hold`, `release`, `holding`, `holds`, `latest`, `entry` |
| `serving` | The serving path, stated once: admit a caller, join or consult each enabled layer in order (memo, local, remote) or start a source; settle a source and publish to the layers that own it. Three shapes: layered, local, request-only. | `admit`, `release`, `begin`, `settle`, `closeScope`, `invalidate`; `admitLocal`, `releaseLocal`, `settleLocal`, `callLocal`; `admitRequest`, `releaseRequest`, `settleRequest`; `layeredRelease`, `releaseJudged`, `startDetachedSource`, `maintains`, `refillAllowed` |
| `receipts` | The receipt of the latest release: the caller it served, its key, the layer that served it (or that it started a source or joined a flight) and the local slot as the release found it. | `release` |
| `local_faults` | The local storage fault switch (C27): while armed, every local read and write throws and the cache fails open; the call keeps the layers its reply resolved to and its coalescing. | `begin`, `settle` |
| `markers` | Invalidation markers: the lifetime of an entity's watermark, written with the larger of its remaining lifetime and the desired one, floored at twice the tracked retention cap. | `invalidate`, `advance`, `expire`, `observe`, `inForce`, `lifetime` |
| `remote_io` | Remote effects the drivers hold and release by effect index: the traversal splits again at the remote layer, holding the read, its decode and the loader until the drivers settle or expire them. | `admit`, `release`, `releaseJudged`, `begin`, `holdRead`, `settleRead`, `settleObserved`, `expireRead`, `settleLoad`, `settleLoader`, `startLoaderFenced`, `latestRead`, `latestLoad`, `latestOrdinal` |
| `deadlines` | Source, read and job deadlines (C23 to C27, C56): a source starts with the budget its start resolved and expiry completes it with a deadline error; variants register deadlines beside the traversal they wrap. | `admit`, `release`, `releaseJudged`, `begin`, `settleDispatched`, `beginRead`, `settleRead`, `settleObserved`, `settleLoad`, `settleLoader`, `advance`; `admitLocal`, `releaseLocal`, `settleLocal`, `advanceLocal` |
| `compression` | The compression channel: the outcome each decode reports as it is dispatched (`decompressed`, `fallback_raw`, or nothing for an uncompressed frame), on the held remote lifecycle. | `settleRead`, `settleLoader` |
| `recovery` | Stale-on-error recovery (C40 to C46, C57): the snapshot a flight retains when its held read settles without serving, the classification of its loader failure, and the recheck of the snapshot's age. | `retain`, `failure`, `classified`, `mayRecover`, `validCandidate`, `recovered`, `recordOutcome`, `drop` |
| `remote_writes` | The atomic remote lifecycle with held writes: a refill serializes when its source settles accepted (the dump), then dispatches the write, then stores the frame; a fault at either step stops the rest. | `releaseJudged`, `settle`, `settleLoader`, `holdDump`, `dispatch`, `releaseDump`, `store`, `releaseWrite`, `abandonDump`, `abandonWrite`, `complete`, `finish`, `failed`, `latestDump`, `latestWrite` |
| `adapter_replies` | The queued adapter reply (C55): what the adapter returns in place of the stored frame, interpreted once at the trust boundary; the drivers queue one reply by its class. | `queue`, `consume`, `queued`, `isFrame`, `carriesFence`, `fenceOf`, `reason`, `observed`, `settleRead` |
| `diagnostics` | The diagnostics channel: which singleflight a caller coalesced into, the layer a failed source is attributed to, the recovery age, warnings and future offsets, over the request-only and the held lifecycles. | `admitRequest`, `releaseRequest`, `settleRequest`; `admit`, `releaseJudged`, `begin`, `beginRead`, `settleLoad`, `settleLoader`, `expireLoader`, `advance`; `recordAge`, `recordWarning`, `recordConfigError`, `recordFutureOffset` |
| `shadow` | Shadow jobs (C47 to C54, C57, C60), admitted beside the caller in one bounded per-instance registry: a served hit's job checks the served payload against a detached source, a dark job's C0 read against the caller's own source. | `begin`, `release`, `settle`, `advance`; served jobs: `admitServed`, `settleJob`, `fill`, `confirmation`, `finishJob`, `expireJob`; held: `beginHeld`, `releaseHeld`, `settleHeld`, `settleRead`, `settleLoad`, `settleLoader`, `expireHeld`, `advanceHeld`; dark: `admitDark`, `dispatchC0`, `beginDark`, `recordVerdict`, `releaseRead`, `releaseLoad`, `releaseDump`, `releaseWrite` |
| `metrics` | The observer's metric events over the remote layer (C30, C57 to C59): the ordered trail the implementations report to their metrics callback, one event per read, write, miss reason and error. | `event`, `begin`, `settleRead`, `settleLoad`, `settleLoader`, `sourceDone`, `expireLoader`, `expireRead`, `advance`, `releaseDump`, `releaseWrite`, `invalidate`, `missReason`, `futureLead` |
| `shadow_reads` | A shadow read's two completions (C54, C56): its bounded result ends at the read deadline while the raw adapter operation keeps the slot until it settles; the job deadline is independent. | `begin`, `releaseRead`, `releaseLoad`, `advance` |

## Layering and reading order

The modules form nine layers by import depth; a module imports only modules
below it. Read down the layers for vocabulary first and rules last, or start
at `serving` and read outward, which is how a rule is usually traced.

| Layer | Modules | What they hold |
| --- | --- | --- |
| 0 | `encodings`, `calls`, `clock`, `layer_policy`, `config_errors`, `instances` | Vocabulary: sentinels, the call record, time, the immediate policy reply, the policy-error record and which instances exist. No rule reads another kernel module here. |
| 1 | `request_memo`, `local_storage`, `payloads`, `policy_gate`, `flights`, `policy_overlay`, `runtime_policy` | The storage and registries each serving layer owns, the payload classes, the held-reply gate and the two runtime reply decoders. |
| 2 | `remote_frames` | The remote layer's storage: frames with stamps, retention and watermarks. |
| 3 | `serving`, `recovery` | The traversal and publication rules, and the stale-on-error judgments the held and atomic lifecycles consult. Start here to trace a rule. |
| 4 | `remote_io`, `receipts`, `local_faults`, `local_grid`, `markers` | Lifecycles and variants over the traversal: held remote effects, the release receipt, the local fault switch, the fractional local grid, marker lifetimes. |
| 5 | `deadlines`, `compression` | Budgets and expiry over the local and the held lifecycles, and the decode outcome channel over the held one. |
| 6 | `remote_writes`, `adapter_replies`, `diagnostics` | The atomic lifecycle with held writes, the queued adapter reply, and the diagnostics channel over both lifecycles. |
| 7 | `shadow`, `metrics` | Shadow jobs and the metric event trail, each composing the lifecycles below. |
| 8 | `shadow_reads` | The separate shadow read deadline over the held dark lifecycle. |

Which profile composes which module is in the profile's imports; every
profile composes `calls`, `encodings` and `serving`, and the kernel fixtures
under [../fixtures/kernel/](../fixtures/kernel/) reach the [seams](../../guides/GLOSSARY.md#seam) no scheduled
profile does. The table is hand-written from the import graph as it stands;
regenerate the depths with a one-line walk over the modules' `import` lines
before trusting it after a module is added.

## Kernel fixtures

The library's transitions are pure, so the seams a scheduled profile may not
reach are exercised by small profiles under `formal/models/fixtures/kernel`.
Those seams are:

- [held](../../guides/GLOSSARY.md#held-versus-immediate-reply-and-effect) policy replies released out of order
- coalescing off against both registries
- a scope closed between admission and release
- the request-only [projection](../../guides/GLOSSARY.md#projection) with its diagnostics
- the budgeted local [lifecycle](../../guides/GLOSSARY.md#lifecycle-budgeted-held-atomic-diagnosed-metered) with its expiry boundaries
- the held remote lifecycle with its recovery snapshots and read and [loader](../../guides/GLOSSARY.md#source-loader-and-ordinal)
  deadlines
- a read settled in the step that admits its caller and the diagnosed held
  lifecycle (the singleflight a follower coalesced into, the layer a failed
  [flight](../../guides/GLOSSARY.md#flight) is attributed to, the recovery age)
- the payload classes on both remote paths with the tracked [retention](../../guides/GLOSSARY.md#frame-stamp-retention-and-freshness) cap
- invalidation [marker](../../guides/GLOSSARY.md#fence-watermark-and-marker) lifetimes and expiry
- the compression channel
- the shadow job registry over the atomic lifecycle with held writes: atomic
  stale-on-error, a held dump fenced by a wall rollback, a dark fill's C58
  fence, dump and write faults and budgets delivered in registration order
- the local fault switch at admission and at [settlement](../../guides/GLOSSARY.md#settlement-and-settlement-receipt)
- the fractional clock with inline sources and no policy provider
- the [served job](../../guides/GLOSSARY.md#dark-job-versus-served-job) registry over the held remote lifecycle:
  - the selection captured with the read and consulted at the decode
  - the job's decode and confirmation read held by index
  - a timed-out served job ending silently while its slot stays owned
- dark jobs over the diagnosed budgeted held lifecycle:
  - a second dark job dropped while the first holds its [C0](../../guides/GLOSSARY.md#c0-and-c1) read
  - the caller's source deadline and the job's budget delivered in one round
    with the late read draining
  - the caller's deadline alone ending a job under a longer budget
- the held refill over the held read path with the queued adapter reply and the
  metric events:
  - a refill completing at its write
  - the sampled wall clock stopping the write after a rollback
  - a fenced acceptance holding no dump
  - a reply consumed by an owning or an abandoned read and left by a failed one
  - the frame reply as a hit at the last fresh millisecond, as a declined
    future frame and as an expired miss once its age reaches the freshness
  - a late result reporting once and a drained one nothing

Each of these profiles typechecks and every run it declares passes:
`make kernel-fixtures` runs them locally with Quint on the PATH, and the
model-check and [differential](../../guides/GLOSSARY.md#differential) [lanes](../../guides/GLOSSARY.md#lane) run the same check.

## Composing a profile

The composed profiles are, in order:

1. `formal/models/dialcache-layers-conformance.qnt` is the first composed
   profile.
2. `formal/models/dialcache-runtime-boundaries-conformance.qnt` is the second,
   with held policy replies and a runtime policy [resolution](../../guides/GLOSSARY.md#resolution-reply-ttls-effective-ttls-and-gated-layers).
3. `formal/models/dialcache-scope-conformance.qnt` is the third, over the
   request-only projection with diagnostics.
4. `formal/models/dialcache-source-budgets-conformance.qnt` is the fourth, over
   the budgeted local projection.
5. `formal/models/dialcache-policy-conformance.qnt` is the fifth, with held
   replies decoded by `policy_overlay` over the receipted layered release and
   the config error record.
6. `formal/models/dialcache-independent-conformance.qnt` is the sixth, over the
   budgeted held remote lifecycle with its recovery snapshots.
7. `formal/models/dialcache-recovery-read-conformance.qnt` is the seventh, over
   the held remote lifecycle with immediate replies, its recovery snapshots and
   payload classes, the compression channel [variants](../../guides/GLOSSARY.md#variant) and the marker lifetime.
8. `formal/models/dialcache-shadow-layers-conformance.qnt` is the eighth, over
   the atomic layered release with held refills and stale-on-error on the atomic
   path, and the shadow job registry with its budgets.
9. `formal/models/dialcache-recovery-conformance.qnt` is the ninth, over the
   budgeted held lifecycle with the read settled at admission and the diagnosed
   held variants.
10. `formal/models/dialcache-local-failure-conformance.qnt` is the tenth, over
    the layered traversal with the local fault switch read at admission and
    settlement.
11. `formal/models/dialcache-local-clock-conformance.qnt` is the eleventh, over
    the local projection with an inline source and the fractional clock,
    declaring `policyProvider: false` because its default instances install no
    policy provider, a drivers'-contract fact the [layout](../../guides/GLOSSARY.md#layout) states.
12. `formal/models/dialcache-admission-conformance.qnt` is the twelfth, over
    the held remote lifecycle with immediate replies and the shadow module's
    held served-job lifecycle, the cohort selection captured with the caller's
    read and consulted when its decode completes the hit.
13. `formal/models/dialcache-shadow-conformance.qnt` is the thirteenth, over
    the dark arm of the held shadow lifecycle. The dark job's C0 read, decode
    and confirmation read are held in `remote_io`'s lists and released by
    ordinal over the diagnosed budgeted held remote lifecycle, with the held
    fill and the buffered invalidation.
14. `formal/models/dialcache-effects-conformance.qnt` is the fourteenth, over
    the held remote lifecycle with its refills held, the queued adapter reply
    and the metric events, the first whose drivers' channel is an ordered event
    trail.
15. `formal/models/dialcache-dark-layers-conformance.qnt` is the fifteenth,
    over `Shadow::DiagnosedShadowed`: held dark effects composed with
    request/local traversal and source deadlines, so every shadow job uses its
    caller-owned source.
16. `formal/models/dialcache-shadow-read-deadlines-conformance.qnt` is the
    sixteenth, over `shadow_reads`: the held dark lifecycle with each shadow
    read's bounded result and raw completion kept apart from the job deadline.

Each composed profile keeps its constants, its flat `State`, `var s` and
`var input`, its `nondet` input choices, its guards, its invariants and its
[regressions](../../guides/GLOSSARY.md#corpus-history-regression-exported-run-and-public-only-run). Each wrapper action assigns `s'` to one library transition and
`input'` to the [driver](../../guides/GLOSSARY.md#driver) record:

```quint
action startCall(choice: int): bool = all {
  s.o.calls.length() < MAX_CALLERS,
  s' = Flights::recordIdentity(Serving::begin(s, LAYOUT, call(choice), resolution(s.policy, s.remoteAvailable), TTLS), call(choice)),
  input' = { name: "beginCall", choice: choice }
}
```

Each state field has one owning module. The request flight registry and the
per-caller record (owner, [memo slot](../../guides/GLOSSARY.md#scope-context-persistent-context-and-memo-slot)) belong to `flights`, which the scope
closure in `serving` asks to forget a closed scope's slots. The held callers
belong to `policy_gate` (empty in a profile with immediate replies). The caller
identity the ownership invariant reads is the [opt-in record](../../guides/GLOSSARY.md#opt-in-record) the wrapper composes
around `begin`. The clock and its wall skew belong to `clock`, the frames with
their stamps, retention and watermarks to `remote_frames`, and the fault
switches are environment inputs the wrapper sets by record update and the
traversal reads. A side channel the drivers assert (the effects `events` trail,
the diagnostics channel) is a kernel module's record, stated once where the rule
that produces it lives. A record only a profile's own property reads is an
opt-in field the wrapper composes around the library result. Composing `serving`
adopts the layers encoding of every field it names; a profile with a different
private layout re-encodes when it composes.

The rule adopted for [witness](../../guides/GLOSSARY.md#witness-label-and-classifier) classifiers is that they read the recorded inputs
and public observations only, as
[replay/witnesses/policy.mjs](../../replay/witnesses/policy.mjs) does. A
classifier shadows the cache contents it needs from those, and the [fidelity](../../guides/GLOSSARY.md#fidelity)
check in policy.mjs binds the shadow to the model by comparing it, after every
step, with the model's private predictions wherever a history carries them. A
composition re-encodes that check against its new private layout and leaves the
classifiers alone, as the policy composition did (its `modelView` maps the
shadow to the layered [shape](../../guides/GLOSSARY.md#shape)). The scaffold those checks share (the test for a
history that carries private state, the layout guard and the step-by-step
comparison) is
[replay/witnesses/fidelity.mjs](../../replay/witnesses/fidelity.mjs). A
classifier hands `fidelityBinding` its public channels, the layout fields it
reads and the view that puts its shadow beside the model's state, and keeps only
its shadow and `modelView`. The classifiers still reading private predictions,
to migrate the same way (layers is already composed and still owes this):
`layers.mjs` and the scope and layers rules of `runtime.mjs`. `recovery.mjs`
shadows the recovery profile from its inputs and channels and binds the shadow
to the composed layout in its fidelity check. `admission.mjs` binds its job and
effect bookkeeping (live jobs by loader ordinal, each held read and decode as a
flight's or a job's, the registered flights) to the composed admission layout
the same way. `shadow.mjs` replays the shadow profile's rules over its inputs
and public channels (the frame with its stamp and watermark, both clocks, the
fault switches, the one dark job and the read or decode it holds). It refuses a
history whose observed labels and effect counts differ from what that replay
predicts, and binds the replay to the composed shadow layout the same way.
`effects.mjs` shadows both clocks, the watermark, the read budget in force, the
queued reply and each loader's start, deadline and state from the inputs and the
asserted record (counters, caller codes, events, read contexts and aborts). It
binds them to the composed effects layout the same way.

The rules a profile may keep are wiring: record literals for the initial state,
record updates with inputs (`{ policy: policy, ...s }`), and input decoding that
reads no state (`instance(context)`). Input decoding may also select between two
library transitions through guarded wrappers under `any` where a branch between
kernel results inside one wrapper would otherwise be needed (recovery-read's
`seedWith`: `seedAgedWith` and `seedUnsafeWith`, each guarded on the input
alone). This replays because `normalizeReplayInputs`
(`formal/tools/replay-inputs.mjs`) overwrites `mbt::actionTaken` with the
recorded input name before any history is read, and `quint test --out-itf`
exports carry no MBT metadata, so the inner arm a sampled run records is never
compared. Do not flatten the wrappers on seeing it in raw `quint run` output.
Guards and `nondet` domains restrict the environment and may read state;
invariants and runs are independent statements and may read anything; the
`input` assignment is the driver contract and may branch on state.

`node formal/tools/lint-profiles.mjs <profile.qnt>` checks this. Its composition
rule walks every value assigned to a state variable other than `input` from the
public wrappers. It reports any comparison, branch, arithmetic or collection
operator whose operand carries cache state, and any non-library definition
applied to cache state, following profile helpers with the taint of their
arguments. Library modules are those declared under `formal/models/kernel`
(`cache_rules` is the judgment layer they consume, not one a profile assigns
through). A chosen `nondet` input and lambda parameters carry no state. A kernel
definition that takes an operator may not be instantiated by a profile at all.
The operator is a parameter declared with an operator type, spelled inline or
through a type alias such as `type Step[r] = (Counter[r], int) => Counter[r]`.
Such an alias is resolved to its typedef through a chain of aliases if there is
one. Kernel definitions declare their parameter types, and one without a
declared type, or with an alias the parse does not resolve, is an error rather
than a definition taken for first-order. `deadlines::deliver` is the one kernel
definition that takes an operator today. A reference to such a definition from
an assigned value, as the callee or by name, is reported whatever the argument
is. A kernel definition applied through a profile alias such as
`pure def repeatAlias = L::repeat` is judged and recorded as the kernel's
application. The reference is reported because the library's folds take their
operator only from kernel modules and an operator written in a profile is rule
logic the walk cannot follow. A record literal may set a field over a library
result (that is wiring the reviewer sees, not a rule).
`formal/catalogs/profile-lint-baseline.json` records each profile's library
transitions and violation count; a composed profile reports zero and the other
counts are the migration list.
`node formal/tools/lint-profiles.mjs baseline --check` is a step of
`make differential` (the pull request lane) and of `make formal-check` (the
weekly full run). It is a ratchet: a profile's library transitions and violation
count must match the record (a count that fell is refreshed with `--write`, one
that rose fails). A profile that composes a kernel module may have none,
whatever the record says. Arguments a wrapper hands to a parametrized action are
walked where they are written and taint the callee's parameters. The lint sees
the shape of assignments, not their meaning: a record literal that overrides a
library result passes it; the corpus differential is the behavioral check.

## Migrating a profile

A new profile records absolute corpus size and [bytes per state](../../guides/GLOSSARY.md#bytes-per-state). Keep its sampled
corpus below 100 MB and below the measured admission reference (4731 bytes per
state), or state why its required shape exceeds that bound. The historical
per-slice measurements in [HISTORY.md](../../guides/HISTORY.md) retain their
original corpus layouts.

A rewrite lands when the corpus differential agrees on every history:

```bash
node formal/tools/differential.mjs layers --reference=origin/main
```

The tool generates the profile's corpus and exports its regressions from the
merge base with the reference revision and from the working tree, each with its
own manifest entry (invariants, bounds, seed) and the generation lane's command.
It then replays every reference history through the working tree's text as a
deterministic schedule of its public inputs, and every working-tree history
through the reference text, comparing every channel the drivers assert at every
step. A candidate that enables inputs the reference refused disagrees in the
reverse direction. Replays run as batched `quint test` processes (16 histories
each, the measured optimum) built from constrained action clones shared across
the batch, the same schedules fixture recipes use. The run fails on any
disagreement and when trace bytes per state grow beyond 1.2 times the
reference's, or beyond the model's own `differential.maxBytesPerStateRatio` when
it declares one (the reason belongs in the record table in
[HISTORY.md](../../guides/HISTORY.md)). Generation wall time is recorded and
reported as advisory above 1.5, because the two generations run concurrently and
hosted runners are noisy. What is compared is what the
drivers assert (the observation and the profile's side channels); private state
is protected by the generation-time invariants and the witness lanes, not by
this tool.

The report records the import closure of both texts (the profile and every Quint
source it reaches) with per-file digests, so a red run on a kernel-only change
names the module that changed.

An intended change of observable behavior is declared in the manifest: bump the
model's `differential.behaviorVersion` in `formal/catalogs/execution.json` in
the same change (or the profile's observation schema `version` in
`formal/catalogs/profiles.json` when the driver-asserted channels change). The
differential then reports the profile as an intended divergence instead of
comparing it. A profile the reference revision does not generate is reported as
new, and one the working tree no longer generates as removed (the manifest
validator already forbids registering a profile without generating it). The
differential replays only profiles with an explicit-input driver descriptor in
`formal/replay/features.mjs` (or, for local-clock, in
`formal/replay/local-clock.mjs`), whose recorded `input.choice` is the wrapper's
`nondet` choice; a composed profile without one fails the run by name. The
local-clock descriptor's `actionBindings` (with `boundAction` and their tests)
is transitional: it schedules a history through a reference text from before the
wrapper rename, where `call` is the parametrized action and `callCache` the
public wrapper. It is deleted once the merge base with main carries the renamed
text. `make differential` runs the lint baseline check and then the differential
for every profile that imports a kernel module in either revision (directly or
through a helper library). `DIFFERENTIAL_SHARD=<index>/<count>` narrows it to
one shard balanced by estimated profile replay time. The pull request lane runs
four such shards against the base branch whenever a Quint input changes and
preserves each shard's reports and replay logs as the
`formal-differential-<index>` artifact.

Fault [challenges](../../guides/GLOSSARY.md#challenge-fault-mutant-and-reproducer) for rules that moved into the library anchor on the module
source and are measured through the composing profile's scheduled invariant, as
before. Every `formal/models/kernel/*.qnt` is a library because no scheduled
model claims it, which puts it under the purity check and the witness evidence
inputs. The fixture lock pins the modules the recipe models import. A
composition also re-measures every existing shared-library challenge over the
newly composed profile (its scheduled invariants at the exploration bound and
all its regressions under the mutant). The profile joins `reproducer.profiles`
where it detects the fault, and its [exclusion](../../guides/GLOSSARY.md#exclusion-structural-versus-measured) reason is restated for the
composed text where it does not.

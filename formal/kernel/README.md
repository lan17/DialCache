# Kernel library

The kernel library states every portable DialCache rule once, as pure
transitions over the part of the state each rule touches. A conformance profile
composes these transitions over its own bounded state: it declares the state its
fixtures exercise, owns the choice of inputs and the environment restrictions,
and assigns state only through library transitions. Issue #165 records the
design and its history; this file describes what is here and how to use it.

## Modules

| Module | Concern | Transitions and judgments |
| --- | --- | --- |
| `encodings` | Sentinels shared by the modules: 0 for an absent value, -1 for an unowned slot, 0 for no fence; the `accepted` judgment over outcome codes | `accepted` |
| `calls` | What a caller asks for: instance, key, request context, whether it is enabled (a disabled context, a failed key or a call outside every request is not) and whether its key failed to construct, the one bypass whose source keeps the configured deadline (C27) | the `Call` type only |
| `layer_policy` | Which layers a call may use, from the drivers' layer policy code and remote availability; the immediate reply `resolution` and the `BYPASS` reply; the `Ttls` a reply resolves to (local insertion TTL, remote freshness, remote retention), passed beside the resolution, and the `gated` layers a reply uses with them (a layer whose TTL is 0 is off) | `enabledLayers`, `sharedLayers`, `resolution`, `gated` |
| `runtime_policy` | How a runtime policy reply (the runtime-boundaries drivers' codes 0 to 21) resolves against an instance's configured baseline: serving cohorts, omitted, null and invalid leaves, runtime TTLs, the kill switch | `resolve` |
| `request_memo` | Request-scoped memo rows and their closure; `openScope` and `Opened` are environment bookkeeping (which contexts an input has created) that no memo rule reads, kept beside the memo rows because the composition lint has no environment allowance yet | `scopeOpen`, `memoSlot`, `memoValue`, `memoize`, `openScope`, `closeScope` |
| `local_storage` | Per-instance local storage with LRU eviction, insertion expiry (`cache_rules.localEntryLiveAt`) and a hit that renews recency, not insertion | `localValue`, `promote`, `putLocal` |
| `remote_frames` | Remote frames stamped on the wall clock and retained until an instant on the monotonic clock (`cache_rules.deadlinePendingAt`), served while retained and fresh for the reply's freshness (`cache_rules.freshAgeAllowed`, which rejects a stamp from after a wall rollback); per-entity watermarks and fences on the wall clock (`cache_rules.fenceAllows`); a watermark never lowers | `seedFrame`, `raiseWatermark`, `readableFrame`, `missFence`, `writeAllowed`, `retained`, `fresh` |
| `flights` | Source executions (a record of outcome and process sharing, with whatever payload the traversal that started it needs), the process and request registries that coalesce callers, and per caller its owner and memo slot; an opt-in record of the identity each caller asked for | `processOwner`, `requestOwner`, `admitCaller`, `attachCaller`, `joinRequestFlight`, `registerSource`, `settleSource`, `forgetScope`, `ownedBy`, `recordIdentity` |
| `clock` | Elapsed time on the monotonic clock; the wall clock is that clock plus a skew (`wallOf`), so one transition moves both and only the skew shifts on a rollback | `advance`, `wallOf`, `shiftWall` |
| `policy_gate` | Callers whose policy reply the environment holds, with their calls, indexed by their policy call | `hold`, `holding`, `holds`, `latest`, `entry`, `release` |
| `serving` | Admission, traversal order (`decide`), ownership precedence, publication and refill authority with the TTLs each source captured from the reply that started it, the remote adapter's read, dump and write faults along a refill, scope closure, maintenance; the layered shape and its local and request-only projections; the layered release judged once (`layeredRelease`) for the transition and the records composed around it | `admit`, `release`, `begin`, `settle`, `admitLocal`, `releaseLocal`, `settleLocal`, `admitRequest`, `releaseRequest`, `settleRequest`, `closeScope`, `invalidate` |
| `deadlines` | Source budgets: the budget a source starts with (a source started at admission is bounded only when its key failed, C27, a disabled context and an outside call run theirs unbounded, C01; a source started at release is bounded, its caller was enabled when admitted), the deadline measured from the source's own start, expiry on timer delivery or late arrival, abandoned work draining, as budgeted variants of the local lifecycle | `admitLocal`, `releaseLocal`, `settleLocal`, `advanceLocal` |
| `diagnostics` | The diagnostics channel: the singleflight a caller coalesced into and the layer a failed source is attributed to, as diagnosed variants of the request-only traversal | `admitRequest`, `releaseRequest`, `settleRequest` |
| `policy_overlay` | How a runtime policy overlay (the policy drivers' codes 0 to 25) resolves against a fixture's baseline TTLs: each layer's TTL, the retention a refill is written with, coalescing (codes 10 to 19 disable it), and whether the reply failed (a provider fault or an invalid read budget); the reply's layers are those the fixture's baseline configures with remote storage present, gated by the reply's TTLs at release (`layer_policy::gated`) | `failed`, `localTtl`, `remoteTtl`, `retention`, `ttls`, `resolve` |
| `config_errors` | The policy-error channel: a reply that fails to resolve is reported once, against no layer, as a `config_resolution` error; an opt-in record composed around the release whose reply failed | `recordConfigError` |
| `receipts` | The receipt of the latest release (the caller, its key, the layer that served it, that it started a source or joined a flight, and the local slot of its key as the release found it), for one-step expiry and freshness properties, as a receipted variant of the layered release judged once (`serving::layeredRelease`) | `release` |

`cache_rules` (age, expiry, deadline and fence judgments) stays the layer under
these modules and is imported, never restated.

Every transition has the shape `pure def f(state: T[r], inputs...): T[r]` where
`T[r]` is a record type that names only the fields the module reads or writes
and leaves the rest of the profile's record open (`{ memo: List[int], closed:
List[bool] | r }`). A profile's state is therefore one flat record with exactly
the fields its fixtures need, and a transition applied to it returns the same
record type. Trace shape, the fixture projections and the trace readers are
unchanged by composition; a profile adds a field only when a module it composes
requires one.

Encodings are the drivers': caller outcomes are `conformance_observations`
codes, layer policy codes are `layer_policy`'s, storage slots hold the value or
0 and registries a source index or -1 (`encodings`). Layouts (keys per instance
and per scope row, persistent contexts, operations per entity, whether the
drivers probe each source's scope) are passed as a `serving::Layout` record, so
a profile with a different bound composes the same transitions. A call is a
`calls::Call` (instance, key, context) and a policy reply resolves to a
`layer_policy::Resolution` (the enabled layers and whether the call coalesces)
with the `layer_policy::Ttls` the reply carries (the local insertion TTL, the
remote frame's freshness and the retention a refill is written with), which
every release and settlement takes beside the resolution; a profile whose
replies carry none passes its fixture's constant. A layer whose TTL is 0 is
off: the traversal uses local storage only for a positive local TTL and the
remote layer only for a positive freshness (`layer_policy::gated`), whatever
the reply's layer flags say. The TTLs settlement publishes with travel in the
source record, captured from the reply that started it
(`LayeredPayload.localMs` and `retentionMs`, `LocalPayload.localMs`), so each
source publishes with its own reply's TTLs and no settlement can disagree with
them; freshness is read only at release and travels beside the reply. The two
captured integers measured about x1.13 bytes per state on the layers profile
against the slice 8 base, inside the x1.2 differential bound; an earlier
three-integer payload that also carried the freshness settlement never reads
measured about x1.17 to x1.26 and was rejected. The serving transitions never decode a
profile's policy field: `layer_policy::resolution(policy, remote)` is the
immediate reply from the drivers' layer policy codes 0 to 5, which the layers
wrapper passes to `begin` with its TTLs; `runtime_policy::resolve(state,
samples)` resolves the runtime-boundaries drivers' codes 0 to 21 against the
instance's configured `Baseline`, which its wrapper passes to `release` the
same way; `BYPASS` is the reply of a call that uses no layer and neither
registry. Each profile owns its policy field with one meaning. A resolution
already reflects remote availability: the traversal reads the remote layer
whenever the resolution enables it, so a profile without remote storage
resolves `remote` to false (as `resolution` and `runtime_policy::resolve` do).

The layered shape also carries the remote adapter's fault switches
(`readFailed`, `dumpFailed`, `writeFailed`): a failed read is counted and
observes nothing, and the source it starts never refills; a refill serializes
(a dump), then dispatches the write, then stores the frame, a dump fault
stopping the dispatch and a write fault the storage. A profile whose drivers
inject no faults holds them false. `settle` settles a source with the TTLs its
own reply resolved to (the fixture's constant in a profile whose replies carry
none).

The traversal is one statement of the fall-through order (request memo, local,
remote, source) and of publication authority, split in time rather than by
concern: `admit` appends the caller, counts its policy call and holds it with
its call in the policy gate (a caller in a closed scope bypasses every layer
and starts its own unshared source at once), `release` traverses for the caller
held under a policy call with the state current at release and the resolution
the profile supplies (a scope closed since admission resolves to `BYPASS`), and
`begin` is their composition for a profile whose replies are immediate. A
profile whose drivers hold policy replies composes `admit` and `release` as
separate steps; releasing a policy call the gate does not hold is a modeling
error that fails in the gate's lookup, so a wrapper guards on the gate.
Per-concern entry points a profile would sequence are not offered: the order is
the rule, and the lint reports a branch between library transitions. A profile
composes an opt-in record after a transition when one of its own properties or
its drivers' channels needs it (`Flights::recordIdentity(Serving::begin(...), call)`,
`ConfigErrors::recordConfigError(..., Overlay::failed(s))`), or a variant that
records beside the transition from the release judged once
(`Receipts::release`, like `Diagnostics::releaseRequest`); records the
traversal itself does not read are never mandatory fields.

The traversal has three shapes over one statement of the order (`decide`,
which joins a pending flight, serves the memo, the local value, the remote
value, or starts a source): the layered shape (`admit`, `release`, `settle`
over `Served`, whose source record `LayeredSource` carries publication
authority), the local projection (`admitLocal`, `releaseLocal`, `settleLocal`
over `LocalServed`, without a remote layer, whose `LocalSource` carries the
identity it serves and whether it may warm local storage) and the
request-only projection (`admitRequest`, `releaseRequest`, `settleRequest`
over `RequestServed`, whose `RequestSource` carries none and whose state names
no storage or clock). A projection exists only where the layered shape cannot
meet a profile's bytes-per-state bound (scope measured x1.37 layered against
x0.98 projected; source-budgets x1.5 layered); it passes fewer layer values to
`decide` and states no rule of its own. The projections carry the registry
fields of `Traversed`, `processFlights` among them although the request-only
shape never writes it, as the accepted cost of one `decide` over every shape.
Records only some profiles' drivers compare or bound compose as variants
around the same transitions: the `diagnostics` variants record the coalesced
scope and each source's layer, the `deadlines` variants stamp each source's
start and budget and complete expired sources; a profile whose drivers do not
compare or bound them carries nothing.

The wall clock is the monotonic clock plus a skew (`Clock::wallOf`): a profile
without wall-clock divergence holds `skew` at 0, one with rollbacks shifts it
(`Clock::shiftWall`), and `Clock::advance` is the one time transition, so a
frame's stamp can never fall behind a clock a profile forgot to move.

## Kernel fixtures

The library's transitions are pure, so the seams a scheduled profile may not
reach (held policy replies released out of order, coalescing off against both
registries, a scope closed between admission and release, the request-only
projection with its diagnostics, the budgeted local lifecycle with its expiry
boundaries) are exercised by small profiles under `test/fixtures/kernel`. Each
typechecks and every run it declares passes: `make kernel-fixtures` runs them
locally with Quint on the PATH, and the model-check and differential lanes run
the same check.

## Composing a profile

`formal/dialcache-layers-conformance.qnt` is the first composed profile
(`formal/dialcache-runtime-boundaries-conformance.qnt` is the second, with held
policy replies and a runtime policy resolution; `formal/dialcache-scope-conformance.qnt`
the third, over the request-only projection with diagnostics;
`formal/dialcache-source-budgets-conformance.qnt` the fourth, over the budgeted
local projection; `formal/dialcache-policy-conformance.qnt` the fifth, with held
replies decoded by `policy_overlay` over the receipted layered release and the
config error record). It keeps
its constants, its flat `State`, `var s` and `var input`, its `nondet` input
choices, its guards, its invariants and its regressions. Each wrapper action
assigns `s'` to one library transition and `input'` to the driver record:

```quint
action startCall(choice: int): bool = all {
  s.o.calls.length() < MAX_CALLERS,
  s' = Flights::recordIdentity(Serving::begin(s, LAYOUT, call(choice), resolution(s.policy, s.remoteAvailable), TTLS), call(choice)),
  input' = { name: "beginCall", choice: choice }
}
```

Each state field has one owning module: the request flight registry and the
per-caller record (owner, memo slot) belong to `flights`, which the scope
closure in `serving` asks to forget a closed scope's slots; the held callers
belong to `policy_gate` (empty in a profile with immediate replies); the caller
identity the ownership invariant reads is the opt-in record the wrapper
composes around `begin`; the clock and its wall skew belong to `clock`, the
frames with their stamps, retention and watermarks to `remote_frames`, and the
fault switches are environment inputs the wrapper sets by record update and the
traversal reads.
Composing `serving`
adopts the layers encoding of every field it names; a profile with a different
private layout re-encodes when it composes.

The rule adopted for witness classifiers is that they read the recorded
inputs and public observations only, as
[replay/witnesses/policy.mjs](../replay/witnesses/policy.mjs) does: a
classifier shadows the cache contents it needs from those, and the fidelity
check in policy.mjs binds the shadow to the model by comparing it, after every
step, with the model's private predictions wherever a history carries them. A
composition re-encodes that check against its new private layout and leaves
the classifiers alone, as the policy composition did (its `modelView` maps the
shadow to the layered shape). The classifiers still reading private
predictions, to migrate the same way (layers is already composed and still
owes this):
`effects.mjs`, `independent.mjs`, `layers.mjs`, `recovery.mjs` (the scope and
wall-rollback rules), `recovery-shadow.mjs`, `shadow.mjs`, and the scope and
layers rules of `runtime.mjs`.

The rules a profile may keep are wiring: record literals for the initial state,
record updates with inputs (`{ policy: policy, ...s }`), and input decoding
that reads no state (`instance(context)`). Guards and `nondet` domains restrict
the environment and may read state; invariants and runs are independent
statements and may read anything; the `input` assignment is the driver
contract and may branch on state.

`node formal/lint-profiles.mjs <profile.qnt>` checks this. Its composition rule
walks every value assigned to a state variable other than `input` from the
public wrappers and reports any comparison, branch, arithmetic or collection
operator whose operand carries cache state, and any non-library definition
applied to cache state, following profile helpers with the taint of their
arguments. Library modules are those declared under `formal/kernel`
(`cache_rules` is the judgment layer they consume, not one a profile assigns
through); a chosen `nondet` input and lambda parameters carry no state; a
record literal may set a field over a library result (that is wiring the
reviewer sees, not a rule). `formal/profile-lint-baseline.json` records each
profile's library transitions and violation count; a composed profile reports
zero and the other counts are the migration list. `node formal/lint-profiles.mjs
baseline --check` is a step of `make differential` (the pull request lane) and
of `make formal-check` (the weekly full run); it is a ratchet: a profile's
library transitions and violation count must match the record (a count that
fell is refreshed with `--write`, one that rose fails), and a profile that
composes a kernel module may have none, whatever the record says. Arguments a
wrapper hands to a parametrized action are walked where they are written and
taint the callee's parameters. The lint sees the shape of assignments, not
their meaning: a record literal that overrides a library result passes it; the
corpus differential is the behavioral check.

## Migrating a profile

A rewrite lands when the corpus differential agrees on every history:

```bash
node formal/differential.mjs layers --reference=origin/main
```

The tool generates the profile's corpus and exports its regressions from the
merge base with the reference revision and from the working tree, each with
its own manifest entry (invariants, bounds, seed) and the generation lane's
command. It then replays every reference history through the working tree's
text as a deterministic schedule of its public inputs, and every working-tree
history through the reference text, comparing every channel the drivers
assert at every step; a candidate that enables inputs the reference refused
disagrees in the reverse direction. Replays run as batched `quint test`
processes (16 histories each, the measured optimum) built from constrained
action clones shared across the batch, the same schedules fixture recipes use.
The run fails on any disagreement and when trace bytes per state grow beyond
1.2 times the reference's; generation wall time is recorded and reported as
advisory above 1.5, because the two generations run concurrently and hosted
runners are noisy. What is compared is what the drivers assert (the
observation and the profile's side channels); private state is protected by
the generation-time invariants and the witness lanes, not by this tool.

The report records the import closure of both texts (the profile and every
Quint source it reaches) with per-file digests, so a red run on a kernel-only
change names the module that changed.

An intended change of observable behavior is declared in the manifest: bump
the model's `differential.behaviorVersion` in `formal/execution.json` in the
same change (or the profile's observation schema `version` in
`formal/profiles.json` when the driver-asserted channels change), and the
differential reports the profile as an intended divergence instead of
comparing it. A profile the reference revision does not generate is reported
as new, and one the working tree no longer generates as removed (the manifest
validator already forbids registering a profile without generating it). The
differential replays only profiles with an explicit-input driver descriptor in
`formal/replay/features.mjs`, whose recorded `input.choice` is the wrapper's
`nondet` choice; a composed profile without one fails the run by name. `make
differential` runs the lint baseline check and then the differential for every
profile that imports a kernel module in either revision (directly or through a
helper library); the pull request lane runs that against the base branch
whenever a Quint input changes and preserves the reports and replay logs.

Fault challenges for rules that moved into the library anchor on the module
source (`formal/execution.json` lists `formal/kernel/*.qnt` among its
`libraries`, which also puts them under the purity check, the witness evidence
inputs and the fixture lock) and are measured through the composing profile's
scheduled invariant, as before.

## Record of the layers rewrite

Measured on 2026-09-16 against `main` at bf3c7e8 with the manifest seed:

| | Reference | Composed |
| --- | --- | --- |
| Sampled histories agreeing step for step, both directions | | 512 of 512 |
| Exported regressions agreeing, both directions | | 15 of 15 |
| Generation wall time (512 traces, 80 steps, concurrent) | 15.7 s | 17.1 s |
| Bytes per state | 4226 | 4226 |
| Profile lines | 549 | 385 |
| Composition-lint violations (rule logic in the profile) | 73 | 0 |

The pilot that preceded the library (#171, #172) instantiated one kernel state
machine per profile and measured its cost; its conclusions and measurements are
recorded in issue #165.

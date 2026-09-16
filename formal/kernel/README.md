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
| `encodings` | Sentinels shared by the modules: 0 for an absent value, -1 for an unowned slot, 0 for no fence | constants only |
| `layer_policy` | Which layers a call may use, from the drivers' policy code and remote availability | `enabledLayers`, `sharedLayers` |
| `request_memo` | Request-scoped memo rows and scope closure | `scopeOpen`, `memoSlot`, `memoValue`, `memoize`, `closeScope` |
| `local_storage` | Per-instance local storage with LRU eviction and a hit that renews recency, not insertion | `localValue`, `promote`, `putLocal` |
| `remote_frames` | Remote frames with creation stamps, per-entity watermarks and fences (`cache_rules.fenceAllows`) | `seedFrame`, `raiseWatermark`, `readableFrame`, `missFence`, `writeAllowed` |
| `flights` | Source executions, the process and request registries that coalesce callers, and the callers each source owns | `processOwner`, `requestOwner`, `admitCaller`, `joinRequestFlight`, `registerSource`, `settleSource`, `forgetScope`, `ownedBy` |
| `clock` | Elapsed time | `advance` |
| `callers` | Per-caller context and key a profile records for its own properties; no rule reads it | `record` |
| `serving` | Admission, traversal order, ownership precedence, publication and refill authority, scope closure, maintenance | `begin`, `settle`, `closeScope`, `invalidate` |

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
and per scope row, persistent contexts, operations per entity, the serving TTL)
are passed as a `serving::Layout` record, so a profile with a different bound
composes the same transitions.

## Composing a profile

`formal/dialcache-layers-conformance.qnt` is the first composed profile. It keeps
its constants, its flat `State`, `var s` and `var input`, its `nondet` input
choices, its guards, its invariants and its regressions. Each wrapper action
assigns `s'` to one library transition and `input'` to the driver record:

```quint
action startCall(choice: int): bool = all {
  s.o.calls.length() < MAX_CALLERS,
  s' = Callers::record(Serving::begin(s, LAYOUT, instance(choice / KEYS_PER_INSTANCE), choice % KEYS_PER_INSTANCE,
    choice / KEYS_PER_INSTANCE), choice / KEYS_PER_INSTANCE, choice % KEYS_PER_INSTANCE),
  input' = { name: "beginCall", choice: choice }
}
```

Two library transitions compose here: the serving path, and the optional
`callers` record the profile's ownership invariant reads. Each state field has
one owning module (the request flight registry belongs to `flights`, which the
scope closure in `serving` asks to forget a closed scope's slots).

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
arguments. Library modules are those declared under `formal/kernel` plus
`cache_rules`; a chosen `nondet` input and lambda parameters carry no state; a
record literal may set a field over a library result (that is wiring the
reviewer sees, not a rule). `formal/profile-lint-baseline.json` records each
profile's count; a composed profile reports zero and the other counts are the
migration list. `node formal/lint-profiles.mjs baseline --check` is a step of
`make differential` (the pull request lane) and of `make formal-check` (the
weekly full run); it fails on drift from the recorded counts and, whatever the
record says, on any composition violation in a profile that composes a kernel
module. The lint sees the shape of assignments, not their meaning: a record
literal that overrides a library result, or a let-bound lambda, passes it; the
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
the model's `differential.maxBytesPerStateRatio` (default 1.2); generation wall
time is recorded and reported as advisory above 1.5, because the two
generations run concurrently and hosted runners are noisy.

The report records the import closure of both texts (the profile and every
Quint source it reaches) with per-file digests, so a red run on a kernel-only
change names the module that changed.

An intended change of observable behavior is declared in the manifest: bump
the model's `differential.behaviorVersion` in `formal/execution.json` in the
same change (or the profile's observation schema `version` in
`formal/profiles.json` when the driver-asserted channels change), and the
differential reports the profile as an intended divergence instead of
comparing it. A profile the reference revision does not generate is reported
as new. `make differential` runs the lint baseline check and then the
differential for every profile that imports a kernel module (directly or
through a helper library); the pull request lane runs that against the base
branch whenever a Quint input changes and preserves the reports and replay logs.

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
| Generation wall time (512 traces, 80 steps) | 14.0 s | 14.0 s |
| Bytes per state | 4226 | 4226 |
| Profile lines | 549 | 385 |
| Composition-lint violations (rule logic in the profile) | 73 | 0 |

The pilot that preceded the library (#171, #172) instantiated one kernel state
machine per profile and measured its cost; its conclusions and measurements are
recorded in issue #165.

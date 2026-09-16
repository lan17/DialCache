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
| `request_memo` | Request-scoped memo rows, request flights and scope closure | `scopeOpen`, `memoSlot`, `memoValue`, `requestOwner`, `memoize`, `joinRequestFlight`, `closeScope` |
| `local_storage` | Per-instance local storage with LRU eviction and a hit that renews recency, not insertion | `localValue`, `promote`, `putLocal` |
| `remote_frames` | Remote frames with creation stamps, per-entity watermarks and fences (`cache_rules.fenceAllows`) | `seedFrame`, `raiseWatermark`, `readableFrame`, `missFence`, `writeAllowed`, `writeFrame` |
| `flights` | Source executions, the registries that coalesce callers, and the callers each source owns | `processOwner`, `admitCaller`, `registerSource`, `settleSource`, `ownedBy` |
| `clock` | Elapsed time | `advance` |
| `serving` | Admission, traversal order, ownership precedence, publication and refill authority, maintenance | `begin`, `settle`, `invalidate` |

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
codes, storage slots hold the value or 0, registries hold a source index or -1.
Layouts (keys per instance and per scope row, persistent contexts, operations
per entity, the serving TTL) are passed as a `serving::Layout` record, so a
profile with a different bound composes the same transitions.

## Composing a profile

`formal/dialcache-layers-conformance.qnt` is the first composed profile. It keeps
its constants, its flat `State`, `var s` and `var input`, its `nondet` input
choices, its guards, its invariants and its regressions. Each wrapper action
assigns `s'` to one library transition and `input'` to the driver record:

```quint
action startCall(choice: int): bool = all {
  s.o.calls.length() < MAX_CALLERS,
  s' = Serving::begin(s, LAYOUT, instance(choice / KEYS_PER_INSTANCE), choice % KEYS_PER_INSTANCE,
    choice / KEYS_PER_INSTANCE),
  input' = { name: "beginCall", choice: choice }
}
```

The rules a profile may keep are wiring: record literals for the initial state,
record updates with inputs (`{ policy: policy, ...s }`), and input decoding
that reads no state (`instance(context)`). Guards and `nondet` domains restrict
the environment and may read state; invariants and runs are independent
statements and may read anything.

`node formal/lint-profiles.mjs <profile.qnt>` enforces this. Its composition
rule walks every value assigned to a state variable other than `input` from the
public wrappers and reports any comparison, branch, arithmetic or collection
operator whose operand carries cache state, and any non-library definition
applied to cache state, following profile helpers with the taint of their
arguments. `formal/profile-lint-baseline.json` records each profile's count;
a composed profile reports zero and the other counts are the migration list.

## Migrating a profile

A rewrite lands when the corpus differential agrees on every history:

```bash
node formal/differential.mjs layers --reference=origin/main
```

The tool generates the profile's corpus and exports its regressions from the
merge base with the reference revision and from the working tree, using the
generation lane's own command and seed, then replays every reference history
through the working tree's text as a deterministic schedule of its public
inputs and compares the driver-asserted observation at every step. Replays run
as batched `quint test` processes (64 histories each) built from constrained
action clones, the same constraint fixture recipes use. The report records the
generation wall-time and bytes-per-state ratios the migration criteria bound
(1.5 and 1.2). `make differential` runs it for every profile that imports a
kernel module; the pull request lane runs that against the base branch whenever
a Quint input changes.

Fault challenges for rules that moved into the library anchor on the module
source (`formal/execution.json` lists `formal/kernel/*.qnt` under `kernel`) and
are measured through the composing profile's scheduled invariant, as before.

## Record of the layers rewrite

Measured on 2026-09-15 against `main` at bf3c7e8 with the manifest seed:

| | Reference | Composed |
| --- | --- | --- |
| Sampled histories agreeing step for step | | 512 of 512 |
| Exported regressions agreeing | | 15 of 15 |
| Generation wall time (512 traces, 80 steps) | 13.4 s | 13.6 s |
| Bytes per state | 4226 | 4226 |
| Profile lines | 549 | 389 |
| Composition-lint violations (rule logic in the profile) | 73 | 0 |

The pilot that preceded the library (#171, #172) instantiated one kernel state
machine per profile and measured its cost; its conclusions and measurements are
recorded in issue #165.

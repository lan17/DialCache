# Portable behavioral scenarios and generated feature profiles

[`behavioral-scenarios.json`](./behavioral-scenarios.json) specifies deterministic feature scenarios independently of TypeScript. [`dialcache-effects-conformance.qnt`](./dialcache-effects-conformance.qnt) generates additional races using the same driver operations. Together with the [core profile](./CONFORMANCE.md) and [protocol vectors](./protocol-vectors.json), these are executable contracts for implementation tests and language ports.

The deterministic corpus currently contains 174 scenarios across 12 behavior families. It includes request-scope lifetime, coalescing, both read and fallback deadlines, local TTL/LRU, runtime snapshots, layer precedence, cache failures, tracked invalidation, frame age/retention, stale recovery, and shadow validation. These scenarios are test-derived contracts, **not Quint-generated traces**. The effects model generates interleavings of calls, loader settlement, clock observations, native writes, and invalidation. Recovery, policy, and shadow models generate further feature schedules through the same driver; their bounds and action mappings appear below. Keeping these complementary forms avoids a single model containing every feature combination.

The corpus includes interaction regressions for scope closure during recovery, runtime coalescing changes during an active flight, independent retained snapshots, recovery/shadow exclusion, local insertion TTL after an aging remote hit, and shadow capacity ownership. These are fixed portable schedules: they extend implementation conformance without claiming that the generated profiles explore those combinations. See the [interaction audit](./TEST-MAP.md#interaction-regressions) for their implementation-test evidence.

## Scenario format

Schema version 2 has a `scenarios` array. Each scenario has a unique `name`, a `feature` label, a `fixture`, and ordered `steps`. Each step contains:

- `input`: one environment/public-operation command from the table below.
- `expect`: a patch to the previous **expected** observation. Unmentioned fields retain their previous expected values. Arrays replace the entire previous array.

Start with the empty observation below. After each input, drain runnable work until it completes or blocks on an external effect. Compare the entire actual observation to the accumulated expectation, including fields omitted from that step's patch. Patches are only notation for assertions; they must never populate driver state.

```json
{
  "calls": [], "loaders": 0, "reads": 0, "writes": 0, "invalidations": 0,
  "maintenance": [], "loads": 0, "dumps": 0, "policyCalls": 0, "classifications": 0, "comparisons": 0, "sourceScopes": [],
  "writeTtls": [], "shadow": [], "recovery": []
}
```

Every scenario/trace gets a fresh default cache instance and empty Redis environment. Additional named instances share that Redis environment but own separate local storage, request contexts, flights, and shadow capacity. State persists between its steps. The TypeScript implementation is [`test/formal/behavior-driver.ts`](../test/formal/behavior-driver.ts), used by the effects and feature replay tests. No production APIs, private cache maps, or flight mutations are needed.

## Fixture

`policy` uses the existing configuration vocabulary: `ttlSec` and `ramp` with `local`/`remote` leaves, `requestLocal`, `coalesce`, `staleOnErrorMaxAgeSec`, `remoteReadTimeoutMs`, and `shadow.ramp`. Omitted fields have DialCache's documented defaults; TTL without a ramp enables that layer fully. Runtime overlays initially omit all leaves.

Other fixture fields are `tracked` (default false), `fallbackTimeoutMs` (fixture default 10, null disables, `"default"` omits the operation override to exercise the library's 60-second default), `readTimeoutMs` (default 50), `localMaxSize` (default 10,000), `shadowMaxInFlight` (default 1), and `recovery` (`allow`, `deny`, `error`, or default timeout-only classification). An operation can override the instance classifier with `begin.recovery`. Optional `comparator` supplies `equal`, `unequal`, or `error`; omitted comparison uses ordinary value equality. These are controlled callback outcomes, not an expression language. `shadowHook: false` omits the required outcome observer; `observerFailure: true` makes installed observers fail; `remote: false` omits the Redis adapter. `probeSourceScope: true` records whether caching is enabled when each actual source invocation begins. Shadow/recovery hooks record terminal diagnostic outcomes; other metrics are outside this profile. Compression writes are disabled; envelope interoperability is covered separately by protocol vectors.

Keys use namespace `urn`, key type `id`, use case `Behavior`, and ID `1` unless an input overrides `useCase` or `key`. The fixture value domain is JSON scalars (numbers, strings, booleans, null) plus an absent value. The test serializer uses JSON for scalars and the unquoted literal `undefined` for absence. An omitted input value denotes absence, represented in observations by `{"absent": true}`; the ordinary string `"undefined"` stays a string and cannot be mistaken for it. A port may use an option/unit value or its own fixture sentinel. This custom serializer tests cacheability without prescribing a language's JSON API or reference identity.

Wall time starts at `2026-09-08T12:00:00Z`; monotonic time starts at zero. Elapsed time advances only through `advance`; `shiftWall` changes application wall time independently, preserving monotonic time and Redis physical expiry. Local entries use monotonic age; frame age and watermark proposals use application wall time. The fake Redis expiration clock advances with elapsed time independently of application wall-clock steps. Tracked reads atomically acquire a value and watermark. Watermarks remain available through the trace. A native write's frame timestamp is captured when the adapter receives it, before any held transport completion.

## Inputs and completion boundaries

| Input | Meaning |
| --- | --- |
| `begin` | Start a public call and assign its ID by invocation order. Default: a new enabled scope lasting through this call. Optional `key`, `useCase`, `instance` (default `default`, or the named scope's instance), `recovery`, `scope`, `outside: true`, or `disabled: true`. Return control when runnable work blocks or the call settles. |
| `resolve` | Settle the specified external `loader` with scalar `value`, or the absent fixture value if omitted. Loader IDs are actual invocation order, distinct from caller IDs. |
| `reject` | Reject `loader` with that loader's unique source error. Optional `error: "timeout"` marks an error propagated by the source as a fallback timeout; it remains that source's logical error token. |
| `advance` | Advance both clocks by `ms` and deliver due timers. With `deliverTimers: false`, advance clock observations without delivering pending timers; later settlement must still enforce the deadline. |
| `shiftWall` | Shift application wall time by signed `ms`, without advancing elapsed time or changing Redis physical retention. This is a clock observation, not a timer delivery. |
| `seed` | Environment stores a frame for `key` and optional `useCase`: `value`, `ageMs` (default 0; negative is future), optional physical `ttlMs` (default 60,000). `frameHex` instead supplies exact raw bytes. This is external setup, not a DialCache write. |
| `invalidate` | Call public targeted invalidation for `key`, with `futureBufferMs` default 0; await completion. Record its success or controlled mutation failure. |
| `policy` | Replace the runtime overlay with `value` (or `null` to inherit). Existing entries and already accepted invocation snapshots retain their contracts. |
| `faults` | Update environmental flags: `read`, `write`, `dump`, `load`, `policy`; and gates `holdReads`, `holdWrites`, `holdDumps`, `holdLoads`, `holdPolicies`. Unmentioned flags retain their values. Flags start false. |
| `release` | Complete a held `effect` (`read`, `write`, `dump`, `load`, `policy`) by its zero-based invocation `index`. A released read acquires the environment's current atomic snapshot. |
| `openScope` | Open context `id` for optional `instance`, optionally nested inside `parent` (whose instance is inherited). `disabled: true` opens a disabled context; otherwise it calls enable. Save its execution context for later inputs. |
| `closeScope` | Complete context `id`. Retain its context handle so later `begin` inputs can exercise detached work after closure. Nested scopes reuse the outer request memo lifetime. |

Only unresolved external operations are gated. A port can use its own executor and explicit request-context handles. It must not reproduce Node Promise turns. The TypeScript driver captures its execution context inside public enable/disable calls; it does not read DialCache's context internals.

Calls may remain pending at a scenario's end. Drivers release fixture-owned work during cleanup; cleanup effects are outside the trace and cannot satisfy its assertions. Unknown operations, missing effects, and repeated settlement fail replay.

## Observations

- `calls`: every caller, in start order, is `{"status":"pending"}`, `{"status":"value","value":1}`, or `{"status":"error","error":"source:0"}` / `"timeout:0"`. Source IDs identify the original loader error; timeout IDs identify distinct timeout outcomes in observation order. Coalesced followers must receive the same error identity. Ports can compare a shared logical error token without adopting JavaScript object identity.
- `loaders`, `reads`, `writes`, `invalidations`, `loads`, `dumps`, `policyCalls`: cumulative actual loader, adapter, serializer, and provider invocations. Failed and still-pending attempts count. Value writes and invalidations are separate.
- `classifications`, `comparisons`: actual invocations of the fixture-owned classifier/comparator. Built-in defaults are not instrumented.
- `sourceScopes`: actual source-entry enablement observations when the explicit scope probe is enabled; otherwise empty.
- `writeTtls`: actual requested physical write TTLs in milliseconds, in dispatch order.
- `maintenance`: public invalidation outcomes, `ok` or `mutation_error`.
- `shadow`, `recovery`: terminal outcomes from the public diagnostic hooks, in observed order. Exact telemetry timing and ordinary metrics are not asserted.

A returned cache value, loader invocation, or acknowledged write does not prove publication. Subsequent calls test cache retention and invalidation. Negative harness tests deliberately remove recovery, local storage, and acknowledged invalidation and require a later observable divergence.

## Generated pending-effect profile

The effects model fixes tracked remote-only policy to 60 seconds, a 10 ms fallback deadline, and held native writes. It bounds each trace to six callers and three external loaders; all successful loader values are 1. No local cache, recovery, shadow work, read errors, or expiry is enabled in this generated profile. Those behaviors have other model/scenario coverage.

| Quint action | Driver input |
| --- | --- |
| `init` | Fresh fixture; hold native writes |
| `beginCall` | `begin` |
| `resolveLoader` / `rejectLoader` | `resolve` with value 1 / `reject`, using the recorded `loader` nondeterministic choice |
| `releaseWrite` | Release the actual pending native write |
| `tick` | Advance 10 ms and deliver timers |
| `jumpClock` | Advance clocks 10 ms without timer delivery |
| `invalidate` / `futureFence` | Invalidate with a 0 / 20 ms future buffer |

ITF contains `mbt::actionTaken`, expected state `s`, and `mbt::nondetPicks.loader`. The choice is `{"tag":"Some","value":{"#bigint":"0"}}` on settlement actions and `{"tag":"None","value":{"#tup":[]}}` otherwise. The parser rejects missing, unexpected, or unsafe choices. Model-only timestamps, fences, phase, and source-registration fields never enter execution or implementation projection.

After every step, replay compares actual caller outcomes, loader/read/write/invalidation/serializer/provider counts, and physical write TTLs. Model caller codes are 0 pending, 1 value 1, 2 original source error, 3 timeout. Error identity is checked by the deterministic scenarios. CI also requires every action and four witnesses in the generated corpus: abandoned loader/new-flight overlap, accepted publication after deadline, a delayed fenced write, and settlement after deadline before timer delivery. These checks establish occurrence, not exhaustive schedule coverage.

All seven generated profiles run on every PR alongside ordinary tests. Normal CI replays the committed [`effects-smoke.itf.json`](./effects-smoke.itf.json) without installing Quint. Failure diagnostics include scenario/trace, step, input/action, and both observations.

Schema version 2 adds scalar/absent value distinction, callback observations, instance/operation identities, and independent wall-clock steps. Old drivers must reject this unsupported schema rather than ignoring inputs. The core/effects ITF schemas are unchanged; their projected observations exclude these additional fixture probes. The feature profiles compare the entire observation using the call encoding below. See [`CONTRACTS.md`](./CONTRACTS.md) for the portable/binding boundary.

## Generated feature profiles

Five additional models share the existing driver and a common [observation record](./conformance-observations.qnt). Their ITF states contain `s.o` as the expected observation, `mbt::actionTaken`, and `mbt::nondetPicks.choice`. State outside `s.o` is model-private prediction, not an implementation observation. The choice is `Some` with a nonnegative ITF integer only on actions with choices below; otherwise it is `None` with the empty tuple. Reject unknown actions, unsupported choices, missing observation fields, and integer precision loss.

Call observations encode pending as 0, fixture values 1/2 as 1/2, source errors as 3, and deadline errors as 4. Other outcomes fail replay. These profiles compare error categories; the fixed scenarios compare logical error identity. All other observation fields use the scenario vocabulary directly, including zero/empty fields. A driver must use explicit action choices for selected source indices and its actual invocation counts for actions targeting the latest effect. It must never use expected counters, phases, cached values, or fences to select an input or fabricate an observation.

| Profile | Fixture and bounds | Generated coverage |
| --- | --- | --- |
| [Admission](./dialcache-admission-conformance.qnt) | Tracked served remote hits, three keys, two instances, two shadow slots per instance, held reads/decodes, 10 ms job deadline, up to sixteen callers | Same-key deduplication, capacity drops, instance isolation, coalesced hits, policy snapshots, disabled detached sources, match/mismatch/supersession, capacity retained through timed-out source/decode/C1 work |
| [Scope](./dialcache-scope-conformance.qnt) | Request-only, one key, two outer lifetimes, three nested contexts, one held provider reply, independently settled sources, no deadline, up to sixteen callers | Scope isolation/closure/replacement; nested and disabled contexts; reenablement; pending policy at closure; shared rejection/retry; request/coalescing policy changes; late source settlement |
| [Recovery](./dialcache-recovery-conformance.qnt) | Tracked remote-only, F=1 s, M initially 5 s, no source deadline, held decoding, up to eight callers | Fresh/stale/future frames; F/M boundaries; allow/deny/failing classifier; coalesced followers; source success versus rejection; age checks around decode; invalidation/replacement; read/decode failures; captured recovery policy |
| [Policy](./dialcache-policy-conformance.qnt) | Untracked local+remote, both TTLs initially 1 s, M=5 s, local capacity one, two keys, one held provider reply, independently settled sources, no source deadline, up to twelve callers | Runtime coalescing on/off, per-source policy snapshots, shared versus independent same-key work, cross-key overlap and reverse settlement; independent runtime leaves; invalid local/remote TTL; provider/read/dump/write failure; policy acquisition and pending publication; local eviction/insertion TTL; logical Redis freshness versus physical retention |
| [Shadow](./dialcache-shadow-conformance.qnt) | Tracked remote TTL=60 s, serving ramp=0, shadow ramp=100, caller/job deadline=10 ms, all read/load/dump/write effects held, up to eight callers | Independent dark C0/source settlement; captured payload decode; match/mismatch/C1 supersession; confirmation failure; conditional fills; source/read/decode/dump/write failure; deadline during held effects; late work cannot change emitted outcomes |

Recovery begins with value 1 seeded at age 1,000 ms. Policy and shadow begin with empty storage. Every trace gets a fresh fixture. Shadow permits another call once its preceding source and owned job work have settled; cross-key capacity/drop behavior remains covered by fixed scenarios. Recovery leaves source time unbounded to explore age changes in seconds; timeout recovery and request memoization remain fixed scenarios. Policy admits another invocation after the preceding provider reply is released, even while its source remains pending. Sources can settle in any order; same-key followers join only while their current policy permits sharing. A shared leader remains registered when an independent source publishes or fails. Request scopes have their own generated profile; held publication remains outside this policy profile.

Common actions reuse the scenario inputs: `releaseRead/Load/Dump/Write/Policy` releases the most recently observed corresponding external effect in scope/recovery/policy/shadow; admission instead selects explicit pending read/load indices; `readFault/loadFault/dumpFault/writeFault/providerFault` sets that failure flag from choice 0/1 (provider uses `faults.policy`). Recovery/shadow `rejectLoader` rejects the latest actual loader; scope/policy/admission settlement selects an explicit source index. No action reads or mutates the cache's internal state.

| Profile/action | Input mapping and allowed choices |
| --- | --- |
| Recovery `beginCall` | `begin.recovery`: choice 0=allow, 1=deny, 2=error |
| Recovery `joinCall` | Plain `begin`; the registered leader owns recovery policy |
| Recovery `resolveLoader` | Resolve latest loader with value 2; no choice |
| Recovery `seed` | Choices 0..6 give ages `[0,999,1000,4999,5000,-1,1000]` ms; value 1 except choice 6 gives value 2 |
| Recovery `advance` | Elapsed time choice 1, 1000, or 4000 ms, with timers delivered |
| Recovery `invalidate` | Public invalidation with zero future buffer |
| Recovery `policy` | Set `staleOnErrorMaxAgeSec` to choice 2000/5000 divided by 1000 |
| Policy `beginCall` | Key is string `"0"` or `"1"` from choice 0/1 |
| Policy `resolveLoader` | Choice 1..24 encodes source index `floor((choice - 1) / 2)` and value `1 + (choice - 1) % 2`; only pending sources are generated |
| Policy `rejectLoader` | Reject the explicitly selected source index, choice 0..11; only pending sources are generated |
| Policy `advance` | Elapsed time choice 1, 1000, 2000, or 5000 ms |
| Policy `policy` | Replace overlay using the numbered table below |
| Shadow `beginCall` | Plain `begin` |
| Shadow `resolveLoader` | Resolve latest loader with choice 1/2 |
| Shadow `seed` | Seed value choice 1/2 at current wall time |
| Shadow `advance` | Elapsed time choice 1/10 ms, delivering due timers |
| Shadow `invalidate` | Public invalidation with future buffer choice 0/20 ms |

Policy overlay choices replace the entire runtime overlay; omitted leaves inherit the fixture's defaults:

| Choice | Overlay |
| --- | --- |
| 0 | Empty/inherit |
| 1 | Local TTL 2 s |
| 2 | Remote TTL 2 s |
| 3 | Local serving ramp 0 |
| 4 | Remote serving ramp 0 |
| 5 | Invalid local TTL -1 s |
| 6 | Invalid remote TTL -1 s |
| 7 | Recovery maximum age 2 s |
| 8 | Both serving ramps 0 |
| 9 | Remote TTL 4 s, recovery disabled (maximum age 0) |
| 10..19 | Same overlay as choice minus 10, with `coalesce: false`; returning to 0..9 restores default sharing |

Generation exports 64 recovery traces from 512 samples, 128 policy traces from 1,024 samples, and 256 shadow traces from 1,024 samples, at most 60 transitions each. Actions are sampled in progress/environment groups so repeated environmental changes do not crowd out useful completion paths; C1 additionally focuses sampling on replacement, fencing, read failure, and time. This changes exploration frequency, not the allowed transition semantics.

CI requires every named action, all three recovery outcomes, recovery across invalidation, coalesced recovery, age-out during decoding, local/remote hits, changed-policy publication, physical TTLs of 2/4/5 seconds, both C0/source orders, all eleven modeled shadow outcomes, and a write completing after shadow timeout. These witness checks fail if a configured corpus misses its promised paths. They establish occurrence only. The separate verification models still reason about wider abstractions such as shadow admission, and the portable fixed corpus covers additional binding-independent boundaries.

`test/formal-features.test.ts` replays these traces and checks parser/assertion trust boundaries. Ordinary CI uses the committed `recovery-smoke.itf.json`, `policy-smoke.itf.json`, and `shadow-smoke.itf.json` without Quint. Formal CI replays every generated trace. To replay a downloaded artifact:

```sh
DIALCACHE_FEATURE_TRACE_FILE=.formal-traces/features/recovery/trace_0.itf.json \
  corepack pnpm exec vitest run test/formal-features.test.ts --coverage.enabled=false
```

Policy CI requires six additional concurrency witnesses: cross-key overlap, uncoalesced same-key overlap, a join after policy changes, reverse source settlement, one source settling multiple callers, and publication while another provider reply is held. Its committed smoke is a generated prefix containing a shared rejection and a later independent settlement; it also runs without Quint. Policy settlement choices changed with the concurrent profile, so replay these traces with the matching specification revision.

The parent `scope/`, `recovery/`, `policy/`, `shadow/`, or `admission/` directory identifies the fixture. To replay a whole generated feature corpus, set `DIALCACHE_FEATURE_TRACE_DIR=.formal-traces/features` instead. Keep a failing trace with its profile directory when copying it.

## Generated request-scope profile

The scope profile reuses the same `openScope`, `closeScope`, `begin`, policy, and source-settlement inputs. It adds no public API or driver mechanism. It starts with enabled outer context `0`, held provider replies, request-local caching on, no shared storage, and the source-scope probe enabled. Its single key isolates request-lifetime semantics from the storage/TTL state in the policy profile.

| Context choice | Meaning |
| --- | --- |
| 0 | Initially open outer request |
| 1 | A separately opened outer request; it may overlap or replace 0 |
| 2 | Enabled context nested under 0 |
| 3 | Disabled context nested under 0 |
| 4 | Enabled context nested under 3, reusing 0's live memo lifetime |
| 5 | Outside every request; only usable by `beginCall` |

`openScope` chooses 1..4, each at most once. Nested contexts open only while outer 0 is live, and 4 requires 3 to exist. `closeScope` chooses any opened, unfinished context 0..4 after the first call. Closing 0/1 clears that lifetime's memo and registered flights. Closing nested contexts does not end the outer lifetime. Captured contexts remain usable by later calls: closed outer contexts are pass-through, while completed nested contexts still belong to a live outer lifetime. These are context ownership rules; ports need not reproduce AsyncLocalStorage or Promise scheduling.

`beginCall` chooses context 0..5. Enabled calls wait for `releasePolicy`; disabled/detached/outside calls immediately start their own source without a provider invocation. At most one provider response is held, but any accepted sources may overlap. `policy` choice 0 inherits request caching and coalescing; 1 sets `requestLocal: false`; 2 sets `coalesce: false` while retaining memoization. Settlements select actual loader indices: `resolveLoader` choice 1..32 encodes index `floor((choice - 1) / 2)` and value `1 + (choice - 1) % 2`; `rejectLoader` chooses index 0..15. Only pending sources are generated.

The model predicts memo lifetime and flight ownership. Replay observes actual caller values/errors, source enablement, and provider/source invocations; subsequent calls establish hits or misses. A late source may return to its original caller after closure, but cannot populate a replacement memo. Coalescing admission precedes reading a memo populated by another independently accepted source.

Generation exports 128 traces from 1,024 samples, up to 60 transitions, with at most sixteen calls. Sampling keeps closure reachable while favoring useful call progress; no fairness or exhaustive context-tree claim is made. CI requires every action plus fourteen witnesses: disabled/detached bypass, policy reply after closure, rejection/retry, shared rejection, source settlement after closure, replacement miss after that settlement, independent scope overlap, uncoalesced same-scope overlap, memo hits, nested/reenabled hits, memo reuse after nested closure, and memo reuse after policy bypass. Four deterministic model regressions anchor closure, replacement, nested/disabled reuse, and rejection/retry.

The committed `scope-smoke.itf.json` is a 22-state generated prefix with old-source settlement after closure followed by a replacement-scope miss. It runs without Quint in ordinary CI. Request deadlines, recovery, shared-process flights, arbitrary context trees, and more than two outer lifetimes remain covered separately or outside this generated profile.

## Generated served-hit shadow admission profile

[`dialcache-admission-conformance.qnt`](./dialcache-admission-conformance.qnt) reuses the existing public driver and observation schema. It separates admission and resource ownership from the dark C0/fill protocol. Three shared Redis keys initially contain value 1, with tracked serving and shadow ramps at 100%. Two cache instances each have two shadow slots. This makes a duplicate drop distinguishable from a full instance, and permits checking another instance while the first is full.

Caller reads and all decoding are held. A successful caller read acquires C0; completing its decode returns that value and considers shadow admission using the caller flight's accepted policy. Coalesced followers share this one admission. Independently accepted calls can each attempt admission. An admitted detached source runs with caching disabled. Shadow comparison uses its retained C0 and source result; unequal values trigger a held C1 read. No shadow action changes a caller result or writes cache values.

| Quint action | Portable input and choice |
| --- | --- |
| `beginCall` | Choice 0..5 selects instance `floor(choice / 3)` and key `choice % 3`, both decimal strings |
| `releaseRead` / `releaseLoad` | Release the explicitly chosen actual effect index, 0..31 |
| `resolveLoader` | Choice 1..32 selects source index `floor((choice - 1) / 2)` and value `1 + (choice - 1) % 2` |
| `rejectLoader` | Reject the chosen actual source index, 0..15 |
| `seed` | Choice 0..5 replaces key `floor(choice / 2)` with value `1 + choice % 2`; both instances observe the shared environment |
| `policy` | Choice 0 inherits enabled shadow/coalescing; 1 disables shadow; 2 disables coalescing; 3 disables both. Only new caller flights acquire the changed policy |
| `advance` | Advance 1 or 10 ms and deliver timers, bounded to 600 ms total elapsed time |

Only pending effects/sources may settle. There are at most sixteen calls and sixteen admitted jobs, giving at most 32 read and 32 decode effects. Redis TTL is 60 seconds, each shadow job's deadline is 10 ms, and the read deadline is 1,000 ms. The elapsed-time bound keeps serving reads fresh and below their separate deadline. Ordinary misses, read/decode faults, separate read timeouts, shadow fill writes, custom comparator failures, local/request layers, and fractional cohort selection retain coverage in other profiles, scenarios, or vectors.

A whole-job timeout emits one diagnostic outcome but keeps the slot until its pending source, decode, or confirmation read settles. Later completion cannot start another decode/read or emit a replacement verdict. Once the owned work drains, a subsequent hit may admit another job. This models resource ownership rather than cancellation or language executor turns.

CI exports 128 traces from 1,024 samples, up to 60 transitions, and requires every action plus eighteen witnesses: six terminal outcomes (match, mismatch, superseded, source_error, timeout, dropped), one admission for coalesced hits, uncoalesced hit overlap, accepted shadow policy after a change, unselected hits, duplicate drops while capacity is available, full-capacity drops, admission while the other instance is full, per-instance deduplication, capacity retained by each of the three timed-out phases, and readmission after expired work drains. Six deterministic model regressions anchor coalesced admission, duplicate drops, per-instance capacity, and all three timeout ownership phases.

The committed `admission-smoke.itf.json` retains actions, choices, and observation records from the first 57 states of a generated trace. Model-private prediction fields are omitted to keep it compact. It contains a timed-out decode, a blocked duplicate, completion of the raw decode, and subsequent admission for that key. Full generated ITF states remain in CI artifacts. The existing parser replays both forms without special handling or expected-state input to the driver.

## Port workflow and limits

1. Implement the protocol/key/normalization/envelope vectors and the invalidation-transition vectors against the actual remote adapter/protocol.
2. Implement these fixture operations using public cache operations and controlled external adapters.
3. Run the committed scenarios and smoke traces.
4. Replay the same core, pending-effect, scope, recovery, policy, shadow, and admission ITF corpora used by TypeScript.
5. Report passing behavior families, specification revision, seed, bounds, and tool versions.

Passing covers the supplied observations and scenarios. It does not establish every feature interaction, fairness/liveness, arbitrary resource limits, or all external failures. A second-language driver has not yet validated the portability of this interface. See [`TEST-MAP.md`](./TEST-MAP.md) for the remaining boundaries.

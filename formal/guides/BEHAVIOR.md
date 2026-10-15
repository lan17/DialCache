# Portable behavioral scenarios and generated profiles

[`behavioral-scenarios.json`](../catalogs/behavioral-scenarios.json) specifies deterministic feature scenarios independently of TypeScript. [`dialcache-effects-conformance.qnt`](../models/dialcache-effects-conformance.qnt) generates additional races using the same driver operations. Together with the [core profile](./CONFORMANCE.md) and [protocol vectors](../catalogs/protocol-vectors.json), these are executable contracts for implementation tests and language ports. The core profile is the introductory one and stays uncomposed from the kernel library: its drivers read the model's private state fields as their observation, so composing it is a driver-contract change in both ports.

The deterministic corpus currently contains 244 scenarios across 12 behavior families. It includes request-scope lifetime, coalescing, both read and fallback deadlines, local TTL/LRU, runtime snapshots, layer precedence, cache failures, tracked invalidation, frame age/retention, stale recovery, and shadow validation. These scenarios are test-derived contracts, **not Quint-generated traces**. The effects model generates interleavings of calls, loader settlement, clock observations, native writes, and invalidation. Recovery, policy, and shadow models generate further feature schedules through the same driver; their bounds and action mappings are generated into [PROFILES.md](../generated/PROFILES.md). Keeping these complementary forms avoids a single model containing every feature combination. The [feature map](./FEATURE-COVERAGE.md) relates the scenarios to the full reviewed behavioral, protocol, and native inventory.

The corpus includes interaction regressions for scope closure during recovery, runtime coalescing changes during an active flight, independent retained snapshots, recovery/shadow exclusion, local insertion TTL after an aging remote hit, and shadow capacity ownership. These are fixed portable schedules: they extend implementation conformance without claiming that the generated profiles explore those combinations. The [behavioral evidence map](./TEST-MAP.md#behavioral-map) connects these obligations to implementation tests and the current generated profiles.

Full validation below means `make formal` locally or the manual/weekly full
workflow. It regenerates and replays every scheduled history and checks the
required witnesses in both languages. Fast PR checks use committed smoke,
fixed supplements and freshness audits without claiming full parity;
model/generator changes additionally recompute committed artifacts. Full
validation remains required for behavior/model changes before merge and for
release/new-port acceptance. See the [Make targets](../README.md#run-it).

## Scenario format

Schema version 2 has a `scenarios` array. Each scenario has a unique `name`, a `feature` label, a `fixture`, and ordered `steps`. Each step contains:

- `input`: one environment/public-operation command from the table below.
- `expect`: a patch to the previous **expected** observation. Unmentioned fields retain their previous expected values. Arrays replace the entire previous array.

Start with the empty observation below. When `fixture.observe` is present, also initialize `events` to an empty list. After each input, drain runnable work until it completes or blocks on an external effect. Compare the entire actual observation to the accumulated expectation, including fields omitted from that step's patch. Patches are only notation for assertions; they must never populate driver state.

```json
{
  "calls": [], "loaders": 0, "reads": 0, "writes": 0, "invalidations": 0,
  "maintenance": [], "loads": 0, "dumps": 0, "policyCalls": 0, "classifications": 0, "comparisons": 0, "sourceScopes": [],
  "writeTtls": [], "shadow": [], "recovery": []
}
```

Every scenario/trace gets a fresh default cache instance and empty Redis environment. Additional named instances share that Redis environment but own separate local storage, request contexts, flights, and shadow capacity. State persists between its steps. The TypeScript implementation is [`typescript/test/formal/behavior-driver.ts`](../../typescript/test/formal/behavior-driver.ts), used by the effects and feature replay tests. No new production APIs, private cache maps, or flight mutations are needed.

## Optional observed events

`fixture.observe` is a list of event names to include in an additional `events` observation array. Ports record actual callbacks/adapter observations in occurrence order; they must not consult expected patches. Unselected events are excluded by the fixture, and generated profiles select only the observations they specify. This keeps diagnostic checks separate from claims about all executor schedules.

- `writeDispatch`: actual native adapter invocation index, recorded before its controlled write gate.
- `readContext`: the adapter's actual read `index`, effective `timeoutMs`, and initial `aborted` state. `readAbort` records the index when cooperative cancellation is requested; the held raw read remains independently releasable.
- `coalescingState`: an explicit public inspection result, with `instance`, `activeLeaders`, `activeFollowers`, and `oldestLeaderAgeMs` (null when no leader is registered). Counts cover process flights only; request followers, independent calls, detached shadow jobs, and raw work abandoned after timeout are excluded.
- `request`, `miss`, `disabled`, `error`, `coalesced`, `invalidation`: public bounded metadata. Operational events use `cacheNamespace`, `useCase`, `keyType`, and `layer` as applicable; miss/disabled events add `reason`, errors add `error`/`inFallback`, and coalescing uses `scope`.
- `shadowAge`, `recoveryAge`, `futureOffset`, `get`, `fallback`, `serialization`: actual observations with `seconds`; serialization adds `operation`, and verdict ages add `outcome`.
- `size`, `storedSize`: observed `bytes`. `compression` carries its actual `outcome`.
- `mismatchWarning`: fields supplied to the public logger for a confirmed-mismatch warning. The scalar fixtures do not prescribe a general host-language JSON conversion algorithm or truncation implementation.
- `marker`: an explicit environment probe of the tracked watermark's cutoff and remaining physical TTL. Cutoffs are milliseconds relative to the fixture wall origin; absence is `cutoffMs: -1`. TTL uses Redis's `-2` absent and `-1` persistent values. This controlled adapter observation supplements real-server integration evidence.

Names are a trace vocabulary, not required language method names. All selected events are compared after every input, including steps that expect none. The [source audit](./TEST-AUDIT.md) explains the typescript/test/doc obligations these probes cover.

## Fixture

`policy` uses the existing configuration vocabulary: `ttlSec` and `ramp` with `local`/`remote` leaves, `requestLocal`, `coalesce`, `staleOnErrorMaxAgeSec`, `remoteReadTimeoutMs`, and `shadow.ramp`. Omitted fields have DialCache's documented defaults; TTL without a ramp enables that layer fully. Runtime overlays initially omit all leaves.

Other fixture fields are `tracked` (default false), `fallbackTimeoutMs` (fixture default 10, null disables, `"default"` omits the operation override to exercise the library's 60-second default), `readTimeoutMs` (fixture default 50; `"default"` omits the adapter option to exercise the library default), `localMaxSize` (default 10,000), `shadowMaxInFlight` (default 1), and `recovery` (`allow`, `deny`, `error`, or default timeout-only classification). An operation can override the instance classifier with `begin.recovery`. Optional `comparator` supplies `equal`, `unequal`, or `error`; omitted comparison uses ordinary value equality. Optional `comparisonMs` makes that external callback consume the specified elapsed time before returning or failing, without delivering timers. These are controlled callback outcomes, not an expression language. `shadowHook: false` omits the required outcome observer; `observerFailure: true` makes installed observers fail; `remote: false` omits the Redis adapter. `probeSourceScope: true` records whether caching is enabled when each actual source invocation begins. Shadow/recovery hooks always record terminal diagnostic outcomes. Optional `observe` selects additional public events (see below); it does not change policy or execution. Compression writes are disabled; existing compressed entries can be seeded to check decoding and recovery. Envelope interoperability is also covered separately by protocol vectors.

Optional `sourceWorkMs` consumes that many milliseconds of elapsed external work inside each actual source invocation before it returns its unresolved fixture gate. Wall and elapsed clocks advance together; no timers or scheduled cache work run during this segment. This supplies a schedule in which the dark-shadow budget can expire before its deferred job starts, while the source remains independently settleable. Ports provide the same external callback/executor ordering through their controlled environment; neither expected observations nor private cache state select when the job runs. The default is zero work.

Keys use namespace `urn`, key type `id`, use case `Behavior`, and ID `1` unless an input overrides `useCase` or `key`. The fixture value domain is JSON scalars (numbers, strings, booleans, null) plus an absent value. The test serializer uses JSON for scalars and the unquoted literal `undefined` for absence. An omitted input value denotes absence, represented in observations by `{"absent": true}`; the ordinary string `"undefined"` stays a string and cannot be mistaken for it. A port may use an option/unit value or its own fixture sentinel. This custom serializer tests cacheability without prescribing a language's JSON API or reference identity.

Wall time starts at `2026-09-08T12:00:00Z`; monotonic time starts at zero. Elapsed time advances through `advance` or configured external source/comparison work; `shiftWall` changes application wall time independently, preserving monotonic time and Redis physical expiry. Local entries use monotonic age; frame age and watermark proposals use application wall time. The fake Redis expiration clock advances with elapsed time independently of application wall-clock steps. Tracked reads atomically acquire a value and watermark. Watermarks remain available through the trace. A native write's frame timestamp is captured when the adapter receives it, before any held transport completion.

## Inputs and completion boundaries

| Input | Meaning |
| --- | --- |
| `begin` | Start a public call and assign its ID by invocation order. Default: a new enabled scope lasting through this call. Optional `key`, `useCase`, `instance` (default `default`, or the named scope's instance), `recovery`, `scope`, `outside: true`, or `disabled: true`. Return control when runnable work blocks or the call settles. |
| `resolve` | Settle the specified external `loader` with scalar `value`, or the absent fixture value if omitted. Loader IDs are actual invocation order, distinct from caller IDs. |
| `reject` | Reject `loader` with that loader's unique source error. Optional `error: "timeout"` marks an error propagated by the source as a fallback timeout; it remains that source's logical error token. |
| `advance` | Advance both clocks by `ms` and deliver due timers. With `deliverTimers: false`, advance clock observations without delivering pending timers; later settlement must still enforce the deadline. |
| `shiftWall` | Shift application wall time by signed `ms`, without advancing elapsed time or changing Redis physical retention. This is a clock observation, not a timer delivery. |
| `seed` | Environment stores a frame for `key` and optional `useCase`: `value`, `ageMs` (default 0; negative is future), optional physical `ttlMs` (default 60,000). `frameHex` instead supplies exact raw bytes. This is external setup, not a DialCache write. |
| `invalidate` | Call public targeted invalidation for `key`, with `futureBufferMs` default 0; await completion. Record its success, controlled mutation failure, or missing-remote-resource error. |
| `inspectCoalescing` | Call public coalescing inspection for `instance` (default `default`) and record its process snapshot. The fixture must select `coalescingState`. |
| `observeMarker` | Observe the environment's tracked watermark for optional `key`, including remaining physical TTL. The fixture must select the `marker` observation. |
| `policy` | Replace the runtime overlay with `value` (or `null` to inherit). Existing entries and already accepted invocation snapshots retain their contracts. |
| `faults` | Update environmental flags: `read`, `write`, `dump`, `load`, `policy`, `observer`, `localStorage`; and gates `holdReads`, `holdWrites`, `holdDumps`, `holdLoads`, `holdPolicies`. Unmentioned flags retain their values. Flags start false. `localStorage` requires the dedicated local-failure fixture described below. |
| `release` | Complete a held `effect` (`read`, `write`, `dump`, `load`, `policy`) by its zero-based invocation `index`. A released read acquires the environment's current atomic snapshot. Optional `fail: true` rejects only this effect. |
| `openScope` | Open context `id` for optional `instance`, optionally nested inside `parent` (whose instance is inherited). `disabled: true` opens a disabled context; otherwise it calls enable. Save its execution context for later inputs. |
| `closeScope` | Complete context `id`. Retain its context handle so later `begin` inputs can exercise detached work after closure. Nested scopes reuse the outer request memo lifetime. |

Only unresolved external operations are gated. A port can use its own executor and explicit request-context handles. It must not reproduce Node Promise turns. The TypeScript driver captures its execution context inside public enable/disable calls; it does not read DialCache's context internals.

## Observations

- `calls`: every caller, in start order, is `{"status":"pending"}`, `{"status":"value","value":1}`, or `{"status":"error","error":"source:0"}` / `"timeout:0"`. Source IDs identify the original loader error; timeout IDs identify distinct timeout outcomes in observation order. Coalesced followers must receive the same error identity. Ports can compare a shared logical error token without adopting JavaScript object identity.
- `loaders`, `reads`, `writes`, `invalidations`, `loads`, `dumps`, `policyCalls`: cumulative actual loader, adapter, serializer, and provider invocations. Failed and still-pending attempts count. Value writes and invalidations are separate.
- `classifications`, `comparisons`: actual invocations of the fixture-owned classifier/comparator. Built-in defaults are not instrumented.
- `sourceScopes`: actual source-entry enablement observations when the explicit scope probe is enabled; otherwise empty.
- `writeTtls`: actual requested physical write TTLs in milliseconds, in dispatch order.
- `maintenance`: public invalidation outcomes, `ok`, `mutation_error`, or `missing_remote`. The last category records the actual public error; a port need not reproduce its native class or text.
- `shadow`, `recovery`: terminal outcomes from the public diagnostic hooks, in observed order. Exact telemetry timing and ordinary metrics are not asserted.

A returned cache value, loader invocation, or acknowledged write does not prove publication. Subsequent calls test cache retention and invalidation. Negative harness tests deliberately remove recovery, local storage, and acknowledged invalidation and require a later observable divergence.

### Additional fixed-scenario inputs

`adapterReply` stages one JSON-shaped semantic adapter result for the next successful raw-read settlement. Only one result may be staged at a time. The driver supplies it to the real cache at the adapter boundary; it neither decodes it on behalf of DialCache nor records a predicted miss/hit. Existing held reads and read failures remain independent. Tests use invalid replies to check the core's normalization; ports whose adapter type cannot represent malformed replies can enforce that boundary when decoding external input.

`seed.payloadText` supplies exact UTF-8 text serializer bytes; `seed.payloadHex` supplies raw binary serializer/envelope bytes, framed with the current wall timestamp minus `ageMs`. `seed.frameHex` remains a complete frame, including header; ordinary `seed.value` still uses the scalar fixture codec. These inputs change only the fake Redis environment.

## Generated profiles

Every profile is a Quint model whose public actions decode into driver commands;
the drivers replay its sampled histories and exported regressions, and all but
`core` compose the kernel library. What a profile's drivers are configured with,
which commands each recorded action and choice decode into, and which observation
channels the coordinator compares are generated from the replay descriptors into
[PROFILES.md](../generated/PROFILES.md), one section per profile. This section keeps
what those tables do not state: the trace contract, the value codes, the meaning of
each observation channel, the rules a profile holds its drivers to, what each
profile leaves to others, and how to replay a generated trace.

### Trace contract

Each ITF state carries the authoritative `input.name` and `input.choice` beside the
expected state `s`. The choice is a nonnegative ITF integer on actions that have
choices and `-1` otherwise; optional `mbt::actionTaken` and `mbt::nondetPicks.choice`
annotations must agree with it, and raw regression exports carry no annotations
([trace contract](./PORTING.md#trace-and-observation-contract)). The parser rejects
unknown actions, unsupported choices, missing observation fields and integer
precision loss. `s.o` and the channels a profile declares (`s.io`, `s.d`, `s.markers`,
`s.compression`, `s.policyErrors`, the effects `s.events`) are the asserted channels;
the rest of `s` is the model's private prediction and never enters execution or the
implementation projection. A driver selects explicit choices for source indices and
uses its own invocation counts for actions that target the latest effect; it never
reads expected counters, phases, cached values or fences to select an input or to
fabricate an observation. Failure actions set a fixture fault, release the selected
external gate, drain runnable work and restore the fault. A failing replay reports the
trace, the step, the action and both observations.

### Value codes

Caller observations encode pending as 0, fixture values 1 and 2 as 1 and 2, a source
error as 3 and a deadline error as 4. Codes 5 to 9 are the absent, `null`, `false`,
zero and empty-string values the scope and policy profiles generate; 11 is the text
`"undefined"`, distinct from absent; 10 is invalid. Other outcomes fail replay. The
generated profiles compare error categories; the fixed scenarios compare logical
error identity. The effects model keeps the version-2 codes of its own contract, 0
pending, 1 value, 2 source error and 3 timeout; its composed text records the shared
codes in `s.o.calls` and the parser maps them, so that observation schema is
unchanged. Version 3 of effects added the explicit wall-advance domain and the
last-fresh and exact-expiry adapter-frame histories; the differential records that
as an intended input-domain expansion.

### Observation channels

- `s.io = { budgets, aborted, sourceErrors }` (independent, recovery-read,
  shadow-read-deadlines): `budgets` are the actual adapter read budgets in read
  invocation order, `aborted` the cooperative cancellation indices in delivery order,
  and `sourceErrors` one entry per caller, zero unless the caller returned its
  source's ordinary error, otherwise the one-based actual source identity. The driver
  projects adapter callbacks and returned error tokens; model-private ownership never
  enters execution. The effects profile asserts `s.o`, `s.io` and `s.events` only,
  its `io` carrying budgets and aborted reads; asserting `io` with source errors or
  `d` beside `events` under the shared codes would be a separate observation-schema
  change.
- `s.d = { warnings, ages, coalesced, fallbackErrors }` (scope, recovery, shadow,
  dark-layers, shadow-read-deadlines), with `configErrors` where the profile counts
  `config_resolution` events carrying the remote, non-fallback labels, `futureOffsets`
  where it records them, and `inspections` for dark-layers' public process snapshots.
  Ages are integer milliseconds in Quint and compared with actual callback seconds
  after unit conversion. Recovery records an age only after a successful retained
  decode; shadow records the original C0 age at a match or confirmed-mismatch
  verdict, clamped to zero after a wall rollback, and warns only for a confirmed
  mismatch whose admitted policy enabled logging. `coalesced` records request or
  process scope labels; `fallbackErrors` records the layer a failed source is
  attributed to, failures later recovered as stale included. Scope fixtures assert one
  trail for shared failures and no cache-error trail for disabled pass-through work.
  An active local layer attributes its failed source to `local` even inside a request
  memo; without a shared layer a transient request attributes it to `request_local`;
  a request that closes while policy is pending attributes to `noop`, and
  admission-time attribution survives later closure. Exact native JSON warning
  formatting remains a binding obligation.
- `s.events` (effects) records `{ event, location, detail, amount }` in order:
  location is a reached layer or coalescing scope; amount is an integer millisecond
  measurement (get, fallback, serialization, future offset), a byte size, a
  write-dispatch index or zero. Replay converts model milliseconds to callback seconds
  and compares the ordered events, their labels and source-error attribution. A
  follower emits its coalescing event without repeating the leader's trail; fresh
  decoding counts in the remote-get duration; source duration ends at accepted
  settlement or deadline; a dump has its own duration; late sources do not repeat
  failures; size events precede adapter dispatch even when the write stays pending.
  Scalar value 1 has one serialized byte here; Unicode and binary byte accounting is
  covered by the protocol vectors and the fixed scenarios.
- `s.markers` and `s.compression` (recovery-read) record each observed invalidation
  marker as `{ cutoffMs, ttlMs }` and each decode's outcome, `decompressed` or
  `fallback_raw`.
- `s.policyErrors` (policy) records each configuration error as
  `{ layer: "noop", errorType: "config_resolution" }`.

### Rules the profiles hold their drivers to

- **effects.** Each history has at most eight callers and eight sources; successful
  values are 1; no local cache, recovery, shadow work or physical expiry is enabled.
  Monotonic time and application wall time are separate; `tick` and `jumpClock`
  advance 10 ms with and without timer delivery, and clock jumps without delivery
  are generated during 10 ms reads and source-owned phases; read budgets are
  multiples of the 10 ms step and a budget change affects later reads while followers
  keep their leader's budget. An `observerFault` fails the diagnostic callbacks and
  leaves cache outcomes unchanged. A read deadline starts a fresh source budget and
  suppresses refill; a successful raw read clears that budget before decoding; a
  failed fresh decode permits refill; an accepted serialization or write outlives the
  source budget, with the observed fence checked again after preparation. The queued
  adapter reply classes are, by choice: 1 null, 2 primitive, 3 legacy watermark shape,
  4 kindless metadata, 5 missing miss reason, 6 unknown reason, 7 unknown reason with a
  valid future fence, 8 fenced reason without a fence, 9 negative fence, 10 fractional
  fence, 11 unsafe fence, 12 absent reason with a future fence, 13 expired reason with
  a zero fence, 14 miss with stray frame fields, 15 valid frame with stray miss
  metadata, 16 fenced reason with a valid future fence; future fences are the input
  wall clock plus 20 ms. A successful raw completion consumes the reply even when
  DialCache abandoned that read; an adapter failure leaves it queued. A port with typed
  replies may normalize these encodings at its boundary but must preserve the
  resulting miss and refill behavior.
- **recovery.** Contexts 0 and 1 are open in every fixture; request misses may join
  one process flight, after which each attached open context memoizes the result; a
  same-request follower records request coalescing, a new request process coalescing,
  and a `joinCall` into pending shared work can still be won by a preexisting request
  memo.
  Recovered values are never published to shared storage. Closing a context clears
  its memo and prevents late recovery from populating it. Recovery starts at a source
  deadline reached inside a larger elapsed-time step, and its held decode may
  complete later; the retained snapshot and source-error identity survive late
  settlement. Init choices 0 to 3 select the timeout-only default or an instance
  classifier that allows, denies or throws; 4 to 7 add request-local caching; a
  call's recovery choice 3 inherits the instance policy and 0 to 2 override it.
- **policy.** Another invocation is admitted once the preceding provider reply is
  released, even while its source is pending; sources settle in any order; same-key
  followers join only while the current policy permits sharing; a shared leader stays
  registered when an independent source publishes or fails. An overlay replaces the
  whole runtime overlay and omitted leaves inherit the fixture; choices 10 to 19 are
  choices 0 to 9 with `coalesce: false`; an invalid remote read budget of 0 bypasses
  all caching for the invocation; an invalid local or remote ramp of 101 disables
  that layer and preserves the other; an invalid recovery maximum age of 1 or -1 s
  leaves normal serving active and writes with the ordinary 1 s retention; an invalid
  shadow ramp of 101 leaves normal fresh serving active. In policy and recovery, wall
  time and elapsed time are separate: a local hit survives a rollback before its TTL
  and expires at that TTL despite it, a future-dated frame is rejected, a retained
  candidate that a rollback makes future-dated is rejected, physical Redis expiry is
  independent, and invalidation never lowers a watermark.
- **shadow.** Payload choices make text and binary share exact UTF-8 bytes while
  different byte spellings decode to the same value; comparison uses decoded values,
  confirmation uses bytes, and C1 compares the retained payload identity even when
  the replacement's timestamp is future-dated; `reencode` replaces the stored bytes
  with an alternate text or binary form during C1 and records it as an explicit
  choice, so a driver never consults expected storage; `advanceWall` moves only the
  application wall clock while C1 is pending, elapsed deadlines and physical Redis
  expiry standing still. Another call is admitted once the preceding source and owned
  job work have settled. Fixtures 11 and 12 advance elapsed and wall time by
  `sourceWorkMs` without delivering timers while the source begins: at 9 ms the dark
  job still dispatches C0, at exactly 10 ms the job reports timeout without a Redis
  read while the caller stays pending, and the caller's later settlement or timer
  gives its deadline error; these fixtures observe after overdue timers are
  delivered, and intermediate native timer ordering is outside their bounds. Timer
  delivery is not required for elapsed-time rejection. Malformed logging keeps
  comparison active with warnings disabled, and a job admitted under it records a
  configuration error and captures logging off; later runtime changes do not rewrite
  an admitted job's policy.
- **admission.** Caller reads and all decoding are held; a successful read acquires
  C0 and completing its decode considers shadow admission under the flight's accepted
  policy; coalesced followers share one admission; a detached source runs with caching
  disabled; an unequal comparison triggers a held C1 read; no shadow action changes a
  caller result or writes cache values. A whole-job timeout emits one outcome but keeps
  the slot until its pending source, decode or confirmation read settles; later
  completion starts no new work and emits no replacement verdict, and once the owned
  work drains a later hit may admit another job. Two instances with two slots each
  make a duplicate drop distinguishable from a full instance. At most sixteen calls
  and sixteen admitted jobs give at most 32 read and 32 decode effects, and elapsed
  time is bounded to 600 ms so serving reads stay fresh and below their separate
  deadline. The committed smoke trace keeps the actions, choices and observation
  records of the first 57 states of a generated history with the model-private fields
  omitted; the parser replays both forms without special handling.
- **independent.** Six callers can each own one read, one source and one decode;
  only raw reads and decoding are held, and accepted publication completes at the
  source-settlement boundary. Each call captures its own read budget and recovery
  policy; a read failure or timeout cannot borrow another call's refill authority;
  each recovery chain retains its own candidate and source error; invalidation cannot
  revoke an acquired decode or candidate, though recovery still rechecks age around
  the decode; late settlement of one call never affects another. Deadlines are
  delivered in time order, registration order at equal instants, new deadlines reached
  within the advance included; other runtimes need not use the same timer
  implementation.
- **layers.** Fixture modes 4 and 5 omit the Redis adapter, so an explicit
  invalidation reports `missing_remote` and dispatches nothing. Two instances share
  Redis but own their local capacity and process flights; contexts 0 and 1 belong to
  instance 0, context 2 to instance 1, and contexts 3 and 4 are fresh invocation
  scopes on each instance. Twenty calls and eighty steps keep entries fresh, so TTL
  boundaries stay in the policy profile and the scenarios; four logical identities
  over a two-slot local cache show promotion and eviction while request storage can
  exceed that capacity. A completed source publishes only to participating eligible
  layers; tracked remote fallback skips direct local publication while an
  authoritative hit may warm local; invalidation of an entity fences later remote
  reads of both tracked operation variants while acquired request and local values
  survive; a policy change preserves an admitted source's publication decision.
- **scope.** `openScope` opens contexts 1 to 4 at most once each, nested ones only
  while outer 0 lives and 4 only after 3; `closeScope` closes any opened unfinished
  context after the first call; closing 0 or 1 clears that lifetime's memo and flights,
  closing a nested context does not end the outer lifetime, a closed outer context is
  pass-through, and a completed nested context still belongs to its live outer
  lifetime. These are context ownership rules; a port need not reproduce
  AsyncLocalStorage or Promise scheduling. Enabled calls wait for `releasePolicy`;
  disabled, detached and outside calls start their own source with no provider
  invocation; at most one provider reply is held while accepted sources may overlap.
  A late source returns to its original caller after closure but cannot populate a
  replacement memo; coalescing admission precedes reading a memo another accepted
  source populated.
- **dark-layers.** The `inspect` action takes a public process snapshot of either
  instance into `s.d.inspections` (instance, leader and follower counts, oldest
  monotonic leader age; the model records an idle age as -1, the native projection as
  `null`). Served shadow work and a caller's held write beside its held read are
  outside this profile.

The remaining composed profiles (recovery-read, local-failure, runtime-boundaries,
shadow-layers, source-budgets, shadow-read-deadlines, local-clock) are summarized in
the next section; their rules live in the kernel module headers the profiles compose.

Each profile leaves the rest to others. Independent does not combine coalesced
recovery, scope lifetimes, wall rollback or held publication. Layers leaves larger
capacities, more scopes and instances, mixed deadline, recovery and shadow
combinations and expiry during LRU ordering outside its bounds. Scope leaves request
deadlines, recovery, shared-process flights, arbitrary context trees and more than
two outer lifetimes to other profiles. Admission leaves ordinary misses, read and
decode faults, separate read timeouts, shadow fill writes, custom comparator
failures, local and request layers and fractional cohort selection to other
profiles, the scenarios and the vectors. Every generated profile establishes
occurrence of its witnesses, not fairness, exhaustive interleavings or wider claims.

### Replaying generated traces

`typescript/test/formal-features.test.ts` replays the feature traces and checks the
parser and assertion trust boundaries; the committed smoke traces under
`formal/generated/` run without Quint in the fast checks, and full validation replays
every generated trace in every port. To replay one downloaded trace or a whole corpus:

```sh
DIALCACHE_FEATURE_TRACE_FILE=.formal-traces/features/recovery/trace_0.itf.json \
  corepack pnpm --dir typescript exec vitest run test/formal-features.test.ts --coverage.enabled=false
DIALCACHE_FEATURE_TRACE_DIR=.formal-traces/features \
  corepack pnpm --dir typescript exec vitest run test/formal-features.test.ts --coverage.enabled=false
```

The parent directory (`recovery/`, `policy/`, `shadow/` and so on) identifies the
fixture; keep a failing trace with its profile directory when copying it. The witnesses
each profile's corpus must reach are listed per profile in
[coverage-witnesses.json](../catalogs/coverage-witnesses.json); the witness checks
establish occurrence only, and a corpus that misses a promised path fails them. Ports
must select the specification revision that matches the traces they replay and reject
unsupported actions or choices.

## Additional composition profiles

The following profiles extend the existing ownership models. Their exact bounds,
checked properties and replayed regressions are registered in `execution.json`, and
their fixtures, setup, action decodings and observation channels are generated into
[PROFILES.md](../generated/PROFILES.md). Each records explicit public inputs as
described in `AUTHORING.md`; expected observations never select a command, effect
index or source result.

| Profile | Boundary and distinguishing public observations | Executable mapping |
| --- | --- | --- |
| `recovery-read` | Request/local/remote traversal, retained snapshots, held reads/decoding, compressed candidates, frame rejection and watermark lifetime. New public requests distinguish retained bytes from current Redis state. Composed from the kernel library: the held remote traversal with its recovery snapshots and payload classes, the compression channel variants and the marker lifetime. | [Fixture and actions](../replay/profiles/recovery-read.mjs) |
| `local-failure` | Local storage exceptions, accepted source outcomes and request-only reuse. A failed local read remains publication-ineligible even after the fault is cleared before source settlement. Composed from the kernel library: the layered traversal with the local fault switch (`local_faults`) read at admission and settlement. | [Fixture and actions](../replay/profiles/local-failure.mjs) |
| `runtime-boundaries` | Exact serving cohort thresholds, leaf inheritance and validation, falsy/absent values, and feature toggles. Results and later layer reuse distinguish policy admission from mere policy input selection. | [Fixture and actions](../replay/profiles/runtime-boundaries.mjs) |
| `shadow-layers` | Dark and served shadow work combined with request/local publication, independent caller sources, per-instance job capacity, captured fill policy and propagated source errors. Composed from the kernel library: the atomic layered release with held refills and stale-on-error on the atomic path, and the shadow job registry with its budgets. | [Fixture and actions](../replay/profiles/shadow-layers.mjs) |
| `source-budgets` | Default, unbounded and finite source budgets; held policy resolution, outside calls, invalid keys, late followers and late results after retry. | [Fixture and actions](../replay/profiles/source-budgets.mjs) |
| `dark-layers` | Held dark shadow work with request/local reuse, independent source settlement, captured fill policy, per-instance capacity, source deadlines, tracked fences, wall rollback and public process-coalescing inspection. | [Fixture and actions](../replay/profiles/dark-layers.mjs) |
| `shadow-read-deadlines` | Separate dark C0/C1 read deadlines with captured policy, cancellation and raw capacity retained past bounded completion. | [Fixture and actions](../replay/profiles/shadow-read-deadlines.mjs) |
| `local-clock` | Fractional native time with whole-millisecond local insertion and expiration, including instances constructed at different process times. Composed from the kernel library: the local projection with an inline source (`Serving::callLocal`) over the fractional clock (`Clock::advanceTicks`). | [Inputs and observations](../replay/local-clock.mjs) |

This table summarizes scope. The linked modules define exact choices and command
mappings; [bindings.mjs](../replay/bindings.mjs) connects their fixtures, setup and
assertions to the coordinator. Shared feature projections live in
[features.mjs](../replay/features.mjs).

The local-failure fixture keeps real storage behind a narrow native failure
seam: TypeScript throws from the local storage call; Go throws through the
local clock observation while retaining the precise clock for deadlines and
diagnostics. Reads are faulted only when an entry exists, because Go's missing
entry path does not consult that clock. Healthy operations use real storage.
These tests add no production fault-injection API and make no claim about
elapsed time or overlapping sources.

The local-clock profile has a dedicated runner. It advances environment time
in microseconds and constructs actual default cache instances. Replacing their
clocks with the common integer test clock would erase the boundary under test.
Its fixture contains immediate healthy sources and no Redis, request memo,
policy provider or precise source/read/shadow deadline work.

Common value projections reserve code `11` for the ordinary text `"undefined"`,
distinct from absent code `5`; code `10` remains invalid. Optional read, marker
and compression projections compose with caller outcomes, diagnostics and
external effect counts. Unselected observations remain outside a profile's
claim.

Gates delay external completion, not DialCache policy capture. A held policy
provider observes the current runtime overlay and provider-failure flag **when
released**; the invocation captures that reply afterward. Read/write/codec fault
flags are likewise observed after the corresponding gate releases. Serializer
arguments and a dispatched write's bytes/timestamp are captured at invocation;
a released read instead acquires the then-current atomic remote snapshot. This
defines the fixture environment; production providers may choose their own
reply values and only their delivered replies determine policy.

Calls may remain pending at a scenario's end. Drivers release fixture-owned work during cleanup; cleanup effects are outside the trace and cannot satisfy its assertions. Unknown operations, missing effects, and repeated settlement fail replay.

## Port workflow and limits

1. Implement the protocol/key/normalization/envelope vectors and the invalidation-transition vectors against the actual remote adapter/protocol.
2. Implement these fixture operations using public cache operations and controlled external adapters.
3. Run the committed scenarios and smoke traces.
4. Replay the same core, pending-effect, scope, recovery, policy, shadow, admission, layers, and independent ITF corpora used by TypeScript.
5. Report passing behavior families, specification revision, seed, bounds, and tool versions.

Passing covers the supplied observations and scenarios. It does not establish every feature interaction, fairness/liveness, arbitrary resource limits, or all external failures. The Go driver executes this same feature interface and generated corpus. Its native concurrency gates and source-ownership monitor use actual callbacks and contexts, while expected model state remains assertion-only. See [`TEST-MAP.md`](./TEST-MAP.md) for the remaining boundaries.

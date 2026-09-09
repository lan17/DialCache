# Portable behavioral scenarios and pending-effect profile

[`behavioral-scenarios.json`](./behavioral-scenarios.json) specifies deterministic feature scenarios independently of TypeScript. [`dialcache-effects-conformance.qnt`](./dialcache-effects-conformance.qnt) generates additional races using the same driver operations. Together with the [core profile](./CONFORMANCE.md) and [protocol vectors](./protocol-vectors.json), these are executable contracts for implementation tests and language ports.

The deterministic corpus currently contains 144 scenarios across 12 behavior families. It includes request-scope lifetime, coalescing, both read and fallback deadlines, local TTL/LRU, runtime snapshots, layer precedence, cache failures, tracked invalidation, frame age/retention, stale recovery, and shadow validation. These scenarios are test-derived contracts, **not Quint-generated traces**. The separate effects model generates interleavings of calls, loader settlement, clock observations, native writes, and invalidation. Keeping these complementary forms avoids a single model containing every feature combination.

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

Every scenario/trace gets a fresh default cache instance and empty Redis environment. Additional named instances share that Redis environment but own separate local storage, request contexts, flights, and shadow capacity. State persists between its steps. The TypeScript implementation is [`test/formal/behavior-driver.ts`](../test/formal/behavior-driver.ts), used by both replay tests. No production APIs, private cache maps, or flight mutations are needed.

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

Both generated profiles run on every PR alongside ordinary tests. Normal CI replays the committed [`effects-smoke.itf.json`](./effects-smoke.itf.json) without installing Quint. Failure diagnostics include scenario/trace, step, input/action, and both observations.

Schema version 2 adds scalar/absent value distinction, callback observations, instance/operation identities, and independent wall-clock steps. Old drivers must reject this unsupported schema rather than ignoring inputs. The core/effects ITF schemas are unchanged; their projected observations exclude these additional fixture probes. See [`CONTRACTS.md`](./CONTRACTS.md) for the portable/binding boundary.

## Port workflow and limits

1. Implement the protocol/key/normalization/envelope vectors and the invalidation-transition vectors against the actual remote adapter/protocol.
2. Implement these fixture operations using public cache operations and controlled external adapters.
3. Run the committed scenarios and smoke traces.
4. Replay the same core and pending-effect ITF corpora used by TypeScript.
5. Report passing behavior families, specification revision, seed, bounds, and tool versions.

Passing covers the supplied observations and scenarios. It does not establish every feature interaction, fairness/liveness, arbitrary resource limits, or all external failures. A second-language driver has not yet validated the portability of this interface. See [`TEST-MAP.md`](./TEST-MAP.md) for the remaining boundaries.

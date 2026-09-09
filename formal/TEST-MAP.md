# Formal contract ↔ implementation test map

The formal suite is intentionally independent from the TypeScript implementation, but it should not invent behavior. Existing implementation tests are treated as executable evidence for the intended contract.

This file maps each formal slice to the existing tests that most directly exercise it. When behavior changes, update the implementation tests and the relevant model in the same change.

See [`CONTRACTS.md`](./CONTRACTS.md) for the rule inventory, named executable evidence, complete source-family index, and binding/assumption/exclusion decisions. The table below is a summary; linking a test file never means every assertion in it is modeled.

## Coverage matrix

“Model” means an abstraction of the named rules, not every case in the linked test file. “Core”, “Effects”, “Recovery”, “Policy”, and “Shadow” are the five generated ITF profiles; they do not imply direct replay of the seven verification models. “Scenarios” means the committed language-neutral `behavioral-scenarios.json` corpus executed against TypeScript. A dash means no portable coverage of that kind. All model runs are bounded samples.

| Behavior | Ordinary implementation evidence | Verification model | Generated MBT | Portable scenarios | Protocol vectors | Remaining boundary/gap |
| --- | --- | --- | --- | --- | --- | --- |
| Disabled pass-through, traversal/publication | `dialcache-local`, `dialcache-redis` | Core | Core: outside and individual layers; Effects: remote flights | Disabled skips provider; untracked source fills layers; tracked source suppresses local until a Redis hit | — | More multi-layer/failure interleavings |
| Request-local lifetime and memoization | `dialcache-request-local` | Core: nested/disabled scopes and publication ownership | Core: sequential pair | Nested re-enable/disable and siblings, rejected-flight retry, undefined, scope isolation, closure/replacement, delayed policy resolution | — | Arbitrary context trees and cross-instance/process-flight combinations |
| Process-local persistence, TTL, LRU | `dialcache-local`, `dialcache-config-ramp` | Core/policy: insertion identity and TTL history | Core: repeated calls; Policy: two-key local eviction, insertion TTL and remote freshness | Exact TTL boundary, LRU capacity, preserved insertion TTL/ramp changes | — | Rollback, zero capacity, and cross-operation capacity have portable scenarios; generated one-slot eviction; larger LRU orderings remain fixed scenarios |
| Coalescing and isolation | `dialcache-coalescing` | Coalescing: admission/followers | Core: pair; Effects: pending followers and cleanup | Different keys, coalescing off, shared source/timeout identity, request retries | — | Multiple keys/instances and layered flights have fixed scenarios; generated exploration remains narrower |
| Loader deadlines and abandoned work | `dialcache-liveness` | Coalescing: timeout/late settlement/publication | Effects: abandonment overlap, late resolve/reject, publication beyond deadline | Shared error identity, retry while old loader runs, late settlement before timer delivery | — | No fairness/eventual-progress proof; more cancellation/clock combinations |
| Remote-read deadlines, application-owned phases | `dialcache-liveness`, `dialcache-redis` | Coalescing: distinct read/fallback/publication phases | Effects: held writes after accepted source; Shadow: whole-job deadline across held reads/decode/dump/write | Read deadline before fallback deadline, late read ignored, held serializer/write outlive fallback deadline | — | Generated independent read/decode deadlines |
| Runtime/default policy and snapshots | `dialcache-config-ramp`, `dialcache-coalescing` | Policy: eight independently changing leaves, captured snapshots, preserved insertion/physical TTL | Policy: held provider, sparse overlays, invalid TTL/provider failure, pending publication, physical retention | Sparse overrides, invalid ramp/provider failure, pending snapshots, old physical TTL/new logical freshness | Stable serving/shadow cohorts | Full invalid-config matrix and feature-product interactions |
| Tracked invalidation and acquired snapshots | `dialcache-invalidation`, `dialcache-coalescing`, real/cluster integrations | Tracked: delayed writes/fences/acquired snapshots | Core: sequential; Effects: delayed writes, future fences, followers | Delayed writes, acquired decode/stale snapshots, suppressed serialization, local survival, explicit maintenance errors | Tracked keys and decoder fencing | Wall rollback and protocol retention/repair have portable cases; writer skew combinations and watermark durability remain external assumptions |
| Cache errors and refill authorization | `dialcache-redis` | Core/recovery | Core: read failure; Effects: source rejection; Policy/Recovery/Shadow: provider, serializer, read and write failures | Read/write/dump/load/provider errors, no refill after failed read, explicit invalidation failure | Malformed frame classifications | More mixed failure schedules and adapter outcomes |
| Stale recovery F/M and retained bytes | `dialcache-stale-on-error`, `dialcache-stale-recovery-policy`, `dialcache-liveness` | Recovery: age checks, authorization, no shared publication, failed-read skip | Recovery: F/M/future, held decode, allow/deny/failure, followers, policy/fence/clock changes | F, M-1, M, future; source success/denial; age crossing before/after decode; invalidation/replacement/expiry; timeout/late source; request memo; decode/read errors | Frame timestamp boundaries | Generated recovery is remote-only with no source deadline; timeout/request memo and callback precedence have portable scenarios; native thenables remain binding tests |
| Shadow C0/S/C1 and diagnostic behavior | `dialcache-shadow-validation`, `dialcache-shadow-confirmation` | Shadow: dark-read/source overlap, admission, compare/confirm/fill, source errors/deadlines | Shadow: dark C0/source orders, held decode/C1/dump/write, all modeled terminal outcomes and late settlement | Match/mismatch/superseded, independent C0 decode, source/confirmation error, no ordinary-miss job, dark fill/fence, duplicate drop, timed-out work retaining capacity | Independent shadow cohorts | Generated shadow fixes dark admission and one caller/job; served-hit admission, custom comparison and cross-key capacity have portable scenarios; logging remains an optional integration |
| Key identity and normalization | `dialcache-local`, `dialcache-config-ramp` | — | Fixed keys only | Multiple logical IDs | Escaping/punctuation/Unicode, UTF-16 ordering, scalars/bigints, number-format edges, caller-owned pair order | Invalid key identities have vectors; host API validation forms and exhaustive Unicode/number combinations remain outside this corpus |
| Frame bytes and decoder classifications | `redis-payload`, adapters, real/cluster integrations | Protocol: explicit validation/fencing precedence; fault-detection witnesses | Semantic fake adapter | Future/unsafe/unsupported frames rejected before deserialization | UTF-8/binary/empty, safe ceiling/zero, tracked/untracked, malformed watermarks, fencing/encoding precedence | Unsafe uint64 host-number conversion and runtime reply representations remain binding tests; unsafe values must never be served |
| Compression/serializer interoperability | `compression*`, `dialcache-compression` | External compressor outcomes | — | Serializer failures and asynchronous load/dump | Escape markers, legacy raw bytes, fixed zstd string/binary decoding | Compression threshold/type/only-when-smaller vectors added; compressor byte identity unspecified; resource limits remain implementation tests |
| Metrics, logs, telemetry timing | `dialcache-metrics`, `datadog`, `prometheus`, `shadow-log-json` | Shadow admission hook only | — | Terminal shadow/recovery diagnostic outcomes only | — | Other instrumentation intentionally outside primary scope |
| Redis internals, TCP, connections | Adapter tests and integrations | External assumptions | Controlled semantic adapter | Held reads/writes, physical expiry and failures | Wire examples | Redis implementation internals intentionally not modeled |

Test basenames above refer to `test/*.test.ts`; real/cluster evidence includes `redis-real.integration.test.ts`, `redis-cluster.integration.test.ts`, and adapter integration suites. The detailed mappings below identify the relevant assertions. Coverage is qualitative and deliberately does not report a misleading percentage of all DialCache behavior.

## Executable implementation coverage

- `invalidation-vectors.json` adds 19 portable state transitions exercised against the actual exported protocol on both Redis and Valkey, including watermark repair/persistence/retention and invalid-argument atomicity. This checks the requested protocol state; deployment preservation remains an assumption.

- [`CONFORMANCE.md`](./CONFORMANCE.md) defines the original core profile. [`BEHAVIOR.md`](./BEHAVIOR.md) defines the shared portable scenario/feature driver, action boundaries, clocks, and independently observed outputs.
- `formal/generate-traces.sh` exports 32 core, 32 pending-effect, 64 recovery, 64 policy, and 256 shadow ITF traces. Three replay test files execute every action through public calls. Effects and feature CI require named actions plus explicit race/outcome witnesses, rather than relying on trace count alone.
- The 144 portable scenarios cover 12 behavior families. After every input, the driver compares all outputs/effect counts against assertion-side expected patches. Expected fields never enter execution.
- Model cache-presence, fence, and flight fields predict later behavior but are excluded from implementation projection. Negative checks remove local caching/coalescing/recovery or acknowledge lost writes/invalidation and require an observable failure.
- All five committed ITF smokes, all feature scenarios, and all protocol vectors run in ordinary TypeScript CI without Quint. Parser checks reject empty/unknown/misplaced traces, missing choices/observations, unsupported arguments, and unsafe integers.
- CI artifacts retain model counterexamples and generated replay inputs. Failures include file/scenario, step/action, and both observations. Automatic shrinking is not implemented.
- Deterministic model tests exercise previously weak assertions: changing an existing TTL or reversing fence/encoding precedence must violate its invariant. Reachability witnesses also cover policy mutation during a pending invocation, replacement request scopes, and dark reads before source acceptance.

## `dialcache-core.qnt`

Core contract: enabled-scope traversal, layer precedence, fail-open behavior, and publication boundaries.

Primary evidence:

- `test/dialcache-local.test.ts`
  - caching is true pass-through outside `enable()`;
  - cache-key selectors are skipped outside `enable()`;
  - request context is restored across nested `disable()` and failures;
  - local hits short-circuit fallback;
  - local read/write failures fail open;
  - exact local TTL boundary misses.
- `test/dialcache-request-local.test.ts`
  - request-local values are isolated by outer scope;
  - nested `enable()` reuses the outer memo table;
  - `disable()` bypasses without deleting request-local values;
  - rejected in-flight work can retry in the same request;
  - closed scopes cannot be repopulated by late work;
  - detached work after scope closure is pass-through.
- `test/dialcache-redis.test.ts`
  - a Redis hit can warm process-local only when local participated;
  - Redis read failure does not authorize a refill;
  - one runtime config snapshot is reused through the path;
  - future frames fail closed before deserialization.

Important modeled rules:

```text
outside enable -> source only
inside enable  -> request-local -> process-local -> Redis -> source
```

A successful lower result can memoize request-local only while the outer scope remains live. A tracked Redis fallback does not publish directly to process-local; a Redis read failure does not authorize a Redis refill.

## `dialcache-runtime-policy.qnt`

Core contract: runtime/default/library precedence across all eight modeled leaves, immutable per-invocation snapshots, and preserved insertion/physical TTLs. Runtime policy may change while an invocation remains pending; assertions refer to its captured inputs rather than the current policy.

Primary evidence:

- `test/dialcache-config-ramp.test.ts`
  - omitted leaves remain distinguishable from explicit `0` / `false`;
  - default configs are cloned/frozen at operation registration;
  - provider is called once per enabled invocation;
  - sparse runtime overlays merge per field and nested layer;
  - a TTL with omitted ramp implies a 100% serving ramp;
  - request-local/recovery/shadow default off; coalescing defaults on;
  - serving and shadow cohorts are deterministic and independent.
- `test/dialcache-coalescing.test.ts`
  - runtime policy can disable or re-enable coalescing;
  - a `disabled()` baseline ramped up by a sparse overlay coalesces by default;
  - malformed runtime `coalesce` fails open uncached.

Existing-entry behavior is documented in `docs/configuration.md`: changing policy affects new invocations but does not rewrite local insertion TTLs, Redis physical TTLs, or active flights.

## `dialcache-coalescing-liveness.qnt`

Core contract: flight admission, follower inheritance, fallback deadline ownership, and late-result suppression. The separate effects conformance profile connects controlled settlement/publication races to the implementation.

Primary evidence:

- `test/dialcache-coalescing.test.ts`
  - same-key active local/remote misses and hits coalesce;
  - request-local flights are isolated by outer request scope;
  - process flights are isolated by `DialCache` instance;
  - request-local misses can subsequently join one process flight;
  - different keys stay independent;
  - failed flights clear and permit retry;
  - no coalescing outside `enable()`, when all serving layers are inactive, or with `coalesce: false`;
  - `coalesce: false` disables only in-flight sharing, not settled memoization;
  - a caller after invalidation may join an older tracked flight when coalescing is enabled.
- `test/dialcache-liveness.test.ts`
  - default fallback deadline is 60 seconds;
  - followers inherit the leader's remaining deadline and exact timeout outcome;
  - uncoalesced callers own independent deadlines;
  - request-local timeout clears its flight and permits same-scope retry;
  - synchronous pre-await source work counts against the monotonic deadline;
  - early timers and late Promise settlement recheck monotonic time;
  - config resolution and Redis reads do not consume the fallback deadline;
  - Redis read timeout is separate;
  - serializer load and post-source serialize/write are application-owned;
  - timeout does not cancel the underlying source;
  - a late source success after timeout cannot publish.

The model deliberately separates the registered DialCache flight from the underlying source operation. Clearing the former does not imply cancellation of the latter.

`lateSettlementBeforeTimerTest`, `abandonedSourceMayOverlapNewFlightTest`, and `acceptedPublicationOutlivesDeadlineTest` are deterministic Quint regressions for the three deadline boundaries. Success and rejection arriving after the deadline are classified as timeout even before the timer callback executes, matching `src/internal/deadline.ts`.

## `dialcache-tracked-invalidation.qnt`

Core contract: atomic tracked snapshots, monotonic watermarks, delayed pre-mutation refills, and snapshot reuse boundaries.

Primary evidence:

- `test/dialcache-invalidation.test.ts`
- `test/dialcache-coalescing.test.ts` — especially the tracked invalidation/coalescing case.
- `test/redis-payload.test.ts` — strict `createdAtMs > watermarkMs` decoding rule.
- `test/redis-real.integration.test.ts`
- `test/redis-cluster.integration.test.ts`

Important modeled non-guarantee: invalidation does not retroactively revoke a value/watermark snapshot already acquired by a caller or flight.

## `dialcache-stale-recovery.qnt`

Core contract: one-read retained snapshot recovery with exclusive `F` and `M` age boundaries.

Primary evidence:

- `test/dialcache-stale-on-error.test.ts`
  - one initial Redis read, no recovery re-read;
  - `F - 1` is fresh, `F` is retained stale, `M - 1` is recoverable, `M` is a miss;
  - future/fenced/invalid/absent frames cannot become candidates;
  - source success never deserializes the retained candidate;
  - an authorized source rejection lazily decodes the retained bytes;
  - age is rechecked after asynchronous decoding;
  - recovery returns no Redis/process-local publication.
- `test/dialcache-stale-recovery-policy.test.ts`
  - operation/instance/default classifier precedence;
  - classifier errors and invalid return types deny recovery while preserving the original rejection.
- `test/dialcache-liveness.test.ts`
  - fallback timeout can become the source rejection that authorizes stale recovery.

Important modeled non-guarantee: invalidation/deletion/refresh after the initial read cannot revoke bytes already retained for an authorized recovery attempt.

`servedValueCanAgeTest`, `decodingAtMaxAgeRejectsTest`, and `futureFrameIsNotRetainedTest` are deterministic Quint regressions. Retention/serving timestamps are recorded separately from the advancing environment clock so a completed return is judged at its actual acceptance time.

## `dialcache-shadow-validation.qnt`

Core contract: detached C0/S/C1 validation, clean-miss fill, confirmation, and diagnostic-only mismatch behavior.

Primary evidence:

- `test/dialcache-shadow-validation.test.ts`
  - served Redis hit returns before detached source validation begins;
  - served-hit shadow owns one detached source read;
  - ramped-down serving reuses the caller's accepted source result;
  - semantic equality yields `match`;
  - disagreement performs one C1 confirmation;
  - absent/changed C1 yields `superseded`;
  - unchanged C1 yields `mismatch`;
  - a present undecodable C0 is observation-only and is not repaired;
  - a clean semantic C0 miss may fill;
  - ordinary enabled remote misses do not schedule a duplicate shadow fill;
  - missing metrics hook / cohort exclusion prevents admission.
- `test/dialcache-shadow-confirmation.test.ts`
  - confirmation race and deadline behavior;
  - byte-level supersession semantics.
- `test/dialcache-invalidation.test.ts`
  - tracked shadow fills reuse their observed watermark for conditional fencing.

Important modeled non-guarantee: a confirmed mismatch is diagnostic evidence, not an atomic source/Redis snapshot and not a repair request.

## `dialcache-redis-protocol.qnt`

Core contract: validation/classification ordering at the semantic Redis protocol boundary.

Primary evidence:

- `test/redis-payload.test.ts`
  - raw reply type validation;
  - null vs short/unsupported frame classification;
  - tracked safe-integer watermark parsing;
  - missing watermark as zero baseline;
  - strict timestamp fence;
  - tracked frame/watermark checks before payload encoding;
  - supported string/binary frame round trips.
- `test/node-redis.test.ts`
- `test/valkey-glide.test.ts`
- `test/redis-real.integration.test.ts`
- `test/redis-cluster.integration.test.ts`

The Quint model intentionally abstracts bytes. Exact interoperability is covered by `protocol-vectors.json` and `test/formal-protocol-vectors.test.ts`.

## Deterministic contracts represented by vectors/tests instead of state machines

Not every DialCache contract benefits from state exploration. Exact transforms should be portable vectors so implementations can compare bytes/strings directly.

### Key normalization and identity

Evidence:

- `src/key.ts`
- `test/dialcache-local.test.ts`
- `test/dialcache-config-ramp.test.ts`
- `formal/protocol-vectors.json`

Required cross-language behavior includes string-based scalar identity, undefined-argument omission, argument-name sorting, `encodeURIComponent` component encoding, tracked Redis hash tags, and the `:dialcache-frame-v1` value suffix.

### Serialization and compression

Evidence:

- `test/compression.test.ts`
- `test/compression-error.test.ts`
- `test/compression-guard.test.ts`
- `test/dialcache-compression.test.ts`
- `test/marker-colliding-serializer.ts`
- `docs/redis.md`

These are data-transform contracts rather than concurrency protocols: compression threshold, marker escaping, zstd envelope tags, only-when-smaller writes, read compatibility when new-write compression is disabled, 512 MiB output ceiling, and fail-open compression errors. Portable vectors now cover envelopes, fixed zstd decoding, byte thresholds, and only-when-smaller writes without coupling ports to a particular zstd implementation's compressed output. Resource-ceiling and native decoder-quirk checks remain implementation tests.

### Observability

Metrics/logging tests (`dialcache-metrics.test.ts`, `datadog.test.ts`, `prometheus.test.ts`, `shadow-log-json.test.ts`) define telemetry compatibility. Telemetry does not gate core cache/recovery behavior except where the shadow outcome hook is deliberately an admission requirement. It is therefore kept out of the primary safety models.

## Review rule

A model is not authoritative merely because it is formal. When a model disagrees with a focused implementation test or the documented contract, first determine which behavior is intended. Then update all three together:

1. human-facing docs;
2. focused implementation/conformance tests; and
3. the relevant Quint model/invariant.

This prevents the formal suite from becoming a second implementation that silently drifts from DialCache.

## Generated coverage measurement

On this expansion, using Vitest 4.1.10/V8 with the same 26 source files and identical instrumentation maps, the original 256 four-seed core/effects traces reached 449/1,022 branches (43.93%). Adding the 384 configured recovery/policy/shadow traces reached 646/1,022 (63.20%). In `src/dialcache.ts`, generated coverage grew from 170/409 (41.56%) to 299/409 (73.10%). The expanded generated corpus also reached two post-read shadow deadline branches absent from the 660-test non-formal unit baseline.

These are execution-coverage measurements for the measured corpora, not percentages of behavioral completeness. Native adapters/exporters and TypeScript binding obligations remain implementation tests. Integration/Lua execution is excluded from this V8 comparison. Fixed scenarios retain broader request-scope, multi-instance, callback-precedence, and shadow-admission coverage than the generated profiles.

# Formal contract ↔ implementation test map

The formal suite is intentionally independent from the TypeScript implementation, but it should not invent behavior. Existing implementation tests are treated as executable evidence for the intended contract.

This file maps each formal slice to the existing tests that most directly exercise it. When behavior changes, update the implementation tests and the relevant model in the same change.

See [`CONTRACTS.md`](./CONTRACTS.md) for the rule inventory, named executable evidence, revision-pinned test/section audit, and binding/assumption/exclusion decisions. The table below is a summary; linking a test file never means every assertion in it is modeled.

[`SEMANTIC-COVERAGE.md`](./SEMANTIC-COVERAGE.md) adds finer case accounting and an executable mutation comparison. Of 164 named behavioral cases, 157 cite portable execution and 108 cite required generated witnesses; five remain model-only and two lack portable executable evidence. All 21 named protocol cases cite vectors. The measured fault catalog additionally identifies fixed-only TTL-renewal detection and a protocol-ordering defect missed by ordinary tests. These denominators are reviewed cases and selected faults, not all possible behavior.

## Coverage matrix

“Model” means an abstraction of the named rules, not every case in the linked test file. “Core”, “Effects”, “Recovery”, “Policy”, “Scope”, “Shadow”, “Admission”, “Layers”, and “Independent” are the nine generated ITF profiles; they do not imply direct replay of the seven verification models. “Scenarios” means the committed language-neutral `behavioral-scenarios.json` corpus executed against TypeScript. A dash means no portable coverage of that kind. All model runs are bounded samples.

| Behavior | Ordinary implementation evidence | Verification model | Generated MBT | Portable scenarios | Protocol vectors | Remaining boundary/gap |
| --- | --- | --- | --- | --- | --- | --- |
| Disabled pass-through, traversal/publication | `dialcache-local`, `dialcache-redis` | Core | Core: outside and individual layers; Effects: remote flights | Disabled skips provider; untracked source fills layers; tracked source suppresses local until a Redis hit | — | More multi-layer/failure interleavings |
| Request-local lifetime and memoization | `dialcache-request-local` | Core: nested/disabled scopes and publication ownership | Core: sequential pair; Scope: nested/disabled contexts, closure/replacement, held policy, independent sources and memo reuse | Nested re-enable/disable and siblings, rejected-flight retry, undefined, scope isolation, closure/replacement, delayed policy resolution | — | Arbitrary context trees and cross-instance/process-flight combinations |
| Process-local persistence, TTL, LRU | `dialcache-local`, `dialcache-config-ramp` | Core/policy: insertion identity and TTL history | Core: repeated calls; Policy: two-key local eviction, insertion TTL and remote freshness | Exact TTL boundary, LRU capacity, preserved insertion TTL/ramp changes | — | Policy generates wall rollback against local TTL and remote age; Layers now generates two-slot LRU promotion/eviction across four identities and zero-capacity reuse boundaries; larger capacities remain ungenerated |
| Coalescing and isolation | `dialcache-coalescing` | Coalescing: admission/followers | Core: pair; Effects: pending followers and cleanup; Policy: same-key sharing/bypass, cross-key overlap, reverse settlement | Different keys, coalescing off, shared source/timeout identity, request retries | — | Layers now generates request misses joining process flights and per-instance isolation; larger combinations remain narrower |
| Loader deadlines and abandoned work | `dialcache-liveness` | Coalescing: timeout/late settlement/publication | Effects: abandonment overlap, late resolve/reject, publication beyond deadline | Shared error identity, retry while old loader runs, late settlement before timer delivery | — | No fairness/eventual-progress proof; more cancellation/clock combinations |
| Remote-read deadlines, application-owned phases | `dialcache-liveness`, `dialcache-redis` | Coalescing: distinct read/fallback/publication phases | Effects: held read/decode/serialize/write, independent read/source deadlines, cancellation and settlement guards; Shadow: whole-job deadline across held reads/decode/dump/write | Read deadline before fallback deadline, late read ignored, held serializer/write outlive fallback deadline | — | Effects generates instance/operation/runtime/default budgets and follower snapshots; Independent now generates separate same-key read budgets, cancellation, and late-effect isolation |
| Runtime/default policy and snapshots | `dialcache-config-ramp`, `dialcache-coalescing` | Policy: eight independently changing leaves, captured snapshots, preserved insertion/physical TTL | Policy: held provider, sparse overlays, coalescing on/off during overlapping calls, independent snapshots/publication, invalid TTL/ramp/read budget, provider failure, optional recovery/shadow policy, physical retention | Sparse overrides, invalid ramp/provider failure, pending snapshots, old physical TTL/new logical freshness | Stable serving/shadow cohorts | Additional malformed host types remain binding tests; larger feature products remain bounded |
| Tracked invalidation and acquired snapshots | `dialcache-invalidation`, `dialcache-coalescing`, real/cluster integrations | Tracked: delayed writes/fences/acquired snapshots | Core: sequential; Effects: delayed writes, future fences, followers; Layers: tracked warming, local/request survival, both operation variants fenced | Delayed writes, acquired decode/stale snapshots, suppressed serialization, local survival, explicit maintenance errors | Tracked keys and decoder fencing | Wall rollback and protocol retention/repair have portable cases; writer skew combinations and watermark durability remain external assumptions |
| Cache errors and refill authorization | `dialcache-redis` | Core/recovery | Core: read failure; Effects: source rejection; Policy/Recovery/Shadow: provider, serializer, read and write failures | Read/write/dump/load/provider errors, no refill after failed read, explicit invalidation failure | Malformed frame classifications | Effects generates sixteen normalized adapter replies; larger mixed failure schedules remain bounded |
| Stale recovery F/M and retained bytes | `dialcache-stale-on-error`, `dialcache-stale-recovery-policy`, `dialcache-liveness` | Recovery: age checks, authorization, no shared publication, failed-read skip | Recovery: F/M/future, held decode, allow/deny/failure, followers, policy/fence/clock changes; Independent: distinct acquired bytes, errors, budgets and recovery limits | F, M-1, M, future; source success/denial; age crossing before/after decode; invalidation/replacement/expiry; timeout/late source; request memo; decode/read errors | Frame timestamp boundaries | Generated recovery includes optional request memoization in two scopes, deadline/late-source settlement, memo probes and closure; instance/operation/default classifier precedence is generated; native thenables remain binding tests |
| Shadow C0/S/C1 and diagnostic behavior | `dialcache-shadow-validation`, `dialcache-shadow-confirmation` | Shadow: dark-read/source overlap, admission, compare/confirm/fill, source errors/deadlines | Shadow: dark C0/S/C1, hook/policy prerequisites and captured admission, custom comparisons, held fills, captured logging and verdict age; Admission: served hits, coalescing, deduplication, per-instance capacity, timeout ownership | Match/mismatch/superseded, independent C0 decode, source/confirmation error, no ordinary-miss job, dark fill/fence, duplicate drop, timed-out work retaining capacity | Independent shadow cohorts | Mixed dark/served jobs and larger capacity/resource combinations; custom comparison and captured logging are generated; exact native warning formatting remains integration |
| Key identity and normalization | `dialcache-local`, `dialcache-config-ramp` | — | Fixed keys only | Multiple logical IDs | Escaping/punctuation/Unicode, UTF-16 ordering, scalars/bigints, number-format edges, caller-owned pair order | Invalid key identities have vectors; host API validation forms and exhaustive Unicode/number combinations remain outside this corpus |
| Frame bytes and decoder classifications | `redis-payload`, adapters, real/cluster integrations | Protocol: explicit validation/fencing precedence; fault-detection witnesses | Semantic fake adapter | Future/unsafe/unsupported frames rejected before deserialization | UTF-8/binary/empty, safe ceiling/zero, tracked/untracked, malformed watermarks, fencing/encoding precedence | Unsafe uint64 host-number conversion and runtime reply representations remain binding tests; unsafe values must never be served |
| Compression/serializer interoperability | `compression*`, `dialcache-compression` | External compressor outcomes | — | Serializer failures and asynchronous load/dump | Escape markers, legacy raw bytes, fixed zstd string/binary decoding | Compression threshold/type/only-when-smaller vectors added; compressor byte identity unspecified; resource limits remain implementation tests |
| Metrics, logs, telemetry timing | `dialcache-metrics`, `datadog`, `prometheus`, `shadow-log-json` | Shadow admission hook; effects observer isolation | Effects: observer isolation, ordered categories, phase durations, future offsets and pre-dispatch sizes; recovery/shadow: ages and conditional warnings | Categories, attribution, callback counts, ages, phase durations, sizes, conditional mismatch warnings | — | Generated diagnostic values remain narrower; exporter schemas and native JSON formatting are binding/integration obligations |
| Redis internals, TCP, connections | Adapter tests and integrations | External assumptions | Controlled semantic adapter | Held reads/writes, physical expiry and failures | Wire examples | Redis implementation internals intentionally not modeled |

Test basenames above refer to `test/*.test.ts`; real/cluster evidence includes `redis-real.integration.test.ts`, `redis-cluster.integration.test.ts`, and adapter integration suites. The detailed mappings below identify the relevant assertions. Coverage is qualitative and deliberately does not report a misleading percentage of all DialCache behavior.

## Generated contract expansion

The fixed corpus is an oracle and a regression suite; it is not a substitute for Quint-generated implementation testing. The current expansion moves these previously fixed-only boundaries into conformance profiles:

| Test-derived contract | Generated evidence |
| --- | --- |
| C07/C08/C10/C12/C31/C32: layer composition | Layers requires uncapped request memoization, two-slot LRU promotion/eviction, zero-capacity sharing, request/process joins, tracked local warming, per-instance capacity, and both operation variants fenced |
| C24/C43–C45/C56: independent callers | Independent requires distinct read budgets, cancellations, retained values, captured recovery limits, original source errors, and per-call refill authority |
| C50/C51/C54: comparison representation and work | Shadow requires UTF-8 text/binary confirmation in both directions, different-byte supersession despite equal decoded values, and elapsed comparison work exhausting the job deadline |
| C09/C45: separate elapsed and wall clocks | Policy requires local reuse and original TTL expiry after rollback, plus future-remote rejection; recovery requires retained decode to reject a now-future candidate |
| C06: empty/falsy/absent values are hits | Scope and policy require each value to be reused by request-local, local, and remote caches |
| C23–C28, C56: phase ownership, separate deadlines, cancellation, failure-specific refill | Effects gates reads, decoding, serialization, and writes independently; late reads/sources settle without regaining publication authority |
| C55/C57–C59: adapter and diagnostic contracts | Effects requires all sixteen normalized reply classes, untracked fence rejection, actual ordered categories, phase durations, future offsets, and sizes before dispatch |
| C30: observer failure isolation | Effects injects failing public metrics/logger callbacks during hits, publication, and source failure |
| C34: post-serialization fence and timestamp | Effects separates wall/monotonic clocks and requires rollback to suppress dispatch at the second fence check |
| C47/C60: shadow prerequisites and captured policy | Shadow requires missing-hook, disabled/invalid admission, admitted-job continuation, and both logging snapshot directions |
| C20/C21/C29: invalid configuration and absent Redis | Policy generates invalid read budgets, layer ramps and optional policies; layers requires local reuse without a Redis adapter, including after a surfaced maintenance error |
| C03/C43: recovery with request memoization | Recovery requires later memo probes in both scopes after shared recovery and a new read after closed-scope recovery; no shared publication is permitted |
| C41/C42/C46: timeout recovery and classifier precedence | Recovery generates own/propagated timeout, ordinary error, instance and operation allow/deny/error overrides, held recovery decode, and abandoned source completion |

The oracles are `dialcache-liveness`, `dialcache-redis`, `dialcache-invalidation`, `dialcache-request-local`, `dialcache-local`, `dialcache-stale-on-error`, and `dialcache-stale-recovery-policy`. No production API or private-state injection was added. This closes named rule gaps, not every feature product; the table above retains narrower boundaries explicitly.

## Source assertion audit

[`TEST-AUDIT.md`](./TEST-AUDIT.md) records the follow-up to file-family accounting: 564 ordinary test declarations and 172 documentation sections have explicit dispositions in `source-audit.json`. Its CI guard checks inventory drift, not semantic equivalence. The additions close semantic adapter reply handling, cooperative cancellation, exact partial-cohort boundaries, compressed recovery, phase/age diagnostics, event attribution, and conditional mismatch warnings. Core model local read/write failure outcomes now have two invariants and four deterministic regressions; these faults have no public replay-driver injection point.

## Executable implementation coverage

- `invalidation-vectors.json` adds 19 portable state transitions exercised against the actual exported protocol on both Redis and Valkey, including watermark repair/persistence/retention and invalid-argument atomicity. This checks the requested protocol state; deployment preservation remains an assumption.

- [`CONFORMANCE.md`](./CONFORMANCE.md) defines the original core profile. [`BEHAVIOR.md`](./BEHAVIOR.md) defines the shared portable scenario/feature driver, action boundaries, clocks, and independently observed outputs.
- `formal/generate-traces.sh` exports 32 core, 512 pending-effect, 256 scope, 512 recovery, 512 policy, 1,024 dark-shadow, 128 served-hit admission, 512 layer-composition, and 512 independent-caller ITF traces. Three replay test files execute every action through public calls. Effects and feature CI require named actions plus explicit race/outcome witnesses, rather than relying on trace count alone.
- The 229 portable scenarios cover 12 behavior families. After every input, the driver compares all outputs/effect counts against assertion-side expected patches. Expected fields never enter execution.
- Model cache-presence, fence, and flight fields predict later behavior but are excluded from implementation projection. Negative checks remove local caching/coalescing/recovery or acknowledge lost writes/invalidation and require an observable failure.
- All nine committed ITF smokes, all feature scenarios, and all protocol vectors run in ordinary TypeScript CI without Quint. Parser checks reject empty/unknown/misplaced traces, missing choices/observations, unsupported arguments, and unsafe integers.
- CI artifacts retain model counterexamples and generated replay inputs. Failures include file/scenario, step/action, and both observations. Automatic shrinking is not implemented.
- Deterministic model tests exercise previously weak assertions: changing an existing TTL or reversing fence/encoding precedence must violate its invariant. Reachability witnesses also cover policy mutation during a pending invocation, replacement request scopes, and dark reads before source acceptance.

## Generated comparator and age diagnostics

The shadow profile generates eleven fixtures covering default/custom comparison, logging, and a missing outcome hook. Runtime admission/logging changes interleave with pending jobs and wall rollback. Fourteen deterministic model regressions anchor hook/policy prerequisites, captured admission, explicit equality/inequality, comparison failure, captured logging, clamped age, and original-C0 age during confirmation. Replay checks actual comparator invocation counts, all twelve job outcomes, verdict-age callbacks, and warning eligibility. Recovery checks age only after successful retained decode. Strict diagnostic parsing and corrupted-expectation tests protect this new projection. Effects additionally generates serving future-offset attribution, ordered diagnostic categories, phase durations, sizes before dispatch, and sixteen adapter reply classes. Scope/recovery/shadow also project coalescing labels and source-failure attribution, including recovered failures, request followers, disabled pass-through, and closure during policy. Exporter schemas remain integration obligations.

## Interaction regressions

The earlier interaction audit added 30 fixed scenarios, bringing the corpus to 174. The subsequent [declaration/section audit](./TEST-AUDIT.md) adds 55 more, for 229 total. Broad obligation rows previously had evidence for individual features but left some of their interactions untested by a portable schedule. The additions below use the existing input vocabulary and independently observed effects; they require no new production API or driver mechanism. These fixed scenarios do not by themselves increase generated scope. The policy profile now additionally generates overlapping calls and coalescing changes, as described below.

| Interaction covered | Portable consequence | Existing evidence |
| --- | --- | --- |
| Shadow job ownership and timeouts | An unbounded caller source can continue after its dark job releases capacity. Shadow-owned decode and C1 reads retain capacity until their raw work settles, including after a separate read deadline. A source-reported timeout is `source_error`, distinct from the job's own timeout. | `dialcache-shadow-confirmation`, `dialcache-shadow-validation`; `docs/coalescing.md`, `docs/shadow-validation.md` |
| Shadow admission and coalescing | Dark-job deduplication does not merge independent caller sources; coalesced served hits start one shadow source; capacity/deduplication are per instance. | `dialcache-shadow-confirmation`, `dialcache-shadow-validation`; `docs/shadow-validation.md` |
| Shadow with local/request layers | Only the caller source publishes to participating local/request caches. Invalid optional shadow policy suppresses dark reads while preserving valid local publication. | `dialcache-shadow-confirmation`, `dialcache-config-ramp` |
| Shadow policy snapshots | Admitted fills keep their TTL/retention snapshot; disabling shadow prevents new jobs while an admitted comparison completes. | `dialcache-shadow-confirmation`, `dialcache-config-ramp`; `docs/configuration.md` |
| Shadow observations across time/replacement | Future/expired dark C0 may fill; an acquired miss is not reread after replacement; retained C0 and C1 comparison do not reapply serving freshness after age or wall-clock changes. | `dialcache-shadow-confirmation`; `docs/shadow-validation.md` |
| Recovery with shadow | Dark serving never recovers stale; a recovered absent value never admits shadow work. | `dialcache-stale-on-error`, `dialcache-shadow-confirmation`; `docs/stale-on-error.md` |
| Independent reads across invalidation | Uncoalesced recovery chains retain their own bytes, and independently decoding tracked readers on either side of invalidation may return different acquired values. | `dialcache-stale-on-error`, `dialcache-coalescing`, `dialcache-invalidation` |
| Recovery decoding/lifetime | Failed fresh decoding is not retried as stale recovery. Rollback making retained bytes future-dated preserves the source error. Recovery finishing after scope closure cannot enter a replacement memo. | `dialcache-stale-on-error`, `dialcache-request-local`; `docs/stale-on-error.md` |
| Coalescing policy and scopes | Uncoalesced request calls still memoize their last publication. Reenabled coalescing joins a registered flight before reading a newer local value. Runtime policy overrides a disabled default. Concurrent outer request scopes remain independent. | `dialcache-coalescing`, `dialcache-request-local`; `docs/coalescing.md` |
| Remote age versus local insertion age | A nearly expired Redis hit warms local storage for its full configured insertion TTL, which may outlive the remote entry. | `dialcache-local`, `dialcache-redis`; `docs/stale-on-error.md` |

Some schedules combine independently established rules rather than duplicate one existing test. Their expected results are authored from the contracts, never recorded from the driver. This closes specific portable witnesses; arbitrary feature products, larger concurrent histories, larger mixed dark/served capacity schedules, and validation by a second-language driver remain open.

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

## `dialcache-scope-conformance.qnt`

Generated request-only schedules use the existing public driver, one key, two outer lifetimes, three nested contexts, and up to sixteen callers. The value domain includes absent/null/false/zero/empty-string results. They interleave scope closure with held policy resolution and independently settled sources, including disabled/re-enabled contexts, memo bypass, and sharing changes. CI requires all actions and nineteen observable witnesses; see [`BEHAVIOR.md`](./BEHAVIOR.md#generated-request-scope-profile) for exact input mappings and bounds.

The source oracle is `test/dialcache-request-local.test.ts`, `test/dialcache-coalescing.test.ts`, `src/context.ts`, and the request-local path in `src/dialcache.ts`. Five deterministic model regressions check absent-value memo reuse, replacement isolation after late completion, uncached policy continuation after closure, nested closure/disabled bypass preserving the outer memo, and shared rejection followed by retry. The generated smoke retains the closure/replacement schedule. Source deadlines, request/process sharing, and recovery during scope closure retain their separate fixed-scenario coverage; arbitrary context trees are not generated.

## `dialcache-layers-conformance.qnt`

The source oracle is `dialcache-coalescing` (request/process admission), `dialcache-request-local` (independent memo publication and closure), `dialcache-local` (capacity, read promotion, operation identity), and `dialcache-invalidation` (tracked publication and acquired/local survival). Eight deterministic regressions and twenty generated witnesses connect these rules through the real public API. A fixture choice selects tracked/untracked mode, local capacity 0/2, or local serving without a Redis adapter; neither the fixture nor actions read expected model state. See [`BEHAVIOR.md`](./BEHAVIOR.md#generated-layer-composition-profile) for exact scope/identity mappings and fresh-entry bounds.

## `dialcache-independent-conformance.qnt`

The oracle is `dialcache-liveness` (uncoalesced read budgets), `dialcache-coalescing` (independent read/source results), `dialcache-stale-on-error` (retained bytes and source-error preservation), and `dialcache-invalidation` (acquired snapshots). Six deterministic regressions and sixteen required generated witnesses extend these contracts to concurrent same-key callers without sharing. See the [independent profile](./BEHAVIOR.md#generated-independent-caller-profile) for exact effect indices, read observations, policy choices, and bounded deadline schedules.

## `dialcache-admission-conformance.qnt`

The generated served-hit profile adds three keys, two instances, and two shadow slots per instance. `test/dialcache-shadow-validation.test.ts` provides the oracle for coalesced admission, same-key drops, full capacity, source disablement, and timeout ownership. `test/dialcache-shadow-confirmation.test.ts` establishes retained C0/C1 comparison and raw confirmation-read ownership. The matching fixed scenarios include `coalesced remote hits admit only one shadow source`, `served shadow decode retains capacity after timeout until raw load settles`, and `shadow capacity and job deduplication are isolated per instance`.

Six deterministic model regressions and eighteen generated outcome/race witnesses check these contracts against the same public driver. The committed smoke includes timeout, drop, raw completion, and readmission. See [`BEHAVIOR.md`](./BEHAVIOR.md#generated-served-hit-shadow-admission-profile) for exact mappings and bounds. Separate read deadlines, dark-fill capacity, and mixed local/request/shadow combinations remain fixed scenarios or other profiles; hook/policy prerequisites are generated by the dark-shadow profile; the new model does not claim every product of those features.

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

The policy conformance model now keeps a separate accepted policy for every source and caller ownership across same-key joins or bypasses. Its generated corpus requires cross-key overlap, independent same-key sources, joins after policy changes, reverse settlement, shared results, and publication during another policy fetch. Deterministic model regressions check that independent completion/rejection leaves a registered leader intact and that opposing publication orders preserve each accepted TTL. This profile uses twelve callers, two keys, and one held provider reply; request scopes and held writes have other coverage.

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

After the generated behavior expansion, fresh Vitest 4.1.10/V8 measurements use identical source files and instrumentation maps for all four cohorts. The denominator includes 26 source files, including adapters and exporters; integration/Lua execution and negative harness/parser checks are excluded.

| Corpus | Library lines | Library branches | Main engine lines | Main engine branches |
| --- | --- | --- | --- | --- |
| 660 ordinary unit tests | 97.96% | 97.06% | 96.16% | 95.35% |
| 4,000 configured generated traces | 70.71% | 71.62% | 83.94% | 84.59% |
| 229 scenarios + 102 protocol cases + 4 schema/audit checks | 72.54% | 72.50% | 82.72% | 79.21% |
| Generated + portable (4,335 positive tests) | 75.00% | 77.49% | 85.34% | 85.33% |

The table separates generated execution from the combined generated/fixed corpus. Moving already-covered boundary rules into nondeterministic generated schedules improves reusable behavioral testing without necessarily reaching a new code branch. The formal corpus still misses 205 outcomes reached by ordinary tests (44 in the main engine), and reaches five outcomes absent from those tests. These counts describe execution paths, not bugs or semantic obligations.

Coverage measures code execution, not assertion strength or the percentage of behavior formalized. Generated schedules can improve race testing while revisiting existing branches. Fixed scenarios retain broader cross-feature request-scope, multi-instance, callback-precedence, and mixed shadow-job coverage. Native adapters/exporters and TypeScript binding obligations still need ordinary tests.

### Audit of the remaining engine branches

This pass reduced the engine's ordinary-only branch outcomes from 58 to 44. The fourteen newly reached outcomes belong to missing-Redis maintenance, shadow UTF-8 text/binary confirmation, and elapsed comparison deadline guards. Independent-caller traces mostly strengthen schedules and ownership assertions along branches that the formal corpus already reached. This is why branch counts alone understate their value.

The remaining 44 outcomes in `src/dialcache.ts` are accounted for below. Locations refer to the unchanged source used for the table above; counts are V8 branch outcomes, not distinct behavioral rules.

| Source locations | Outcomes | Disposition and remaining work |
| --- | ---: | --- |
| 294, 297, 307, 314, 1402, 1409, 1419, 1514–1643 | 28 | Constructor/registration/key API variants, static snapshot shapes, and configuration validation. B01 preserves their binding tests; portable policy domains, precedence, invalid runtime leaves, capacity, and duration limits have separate models/scenarios/vectors. This does not claim every invalid static configuration is a generated case. |
| 901, 1186, 1188, 1718, 1741, 1775 | 11 | Native callback validation, non-boolean/thenable returns, and rejection consumption (B01/B02). Portable classifier/comparator failures, observer isolation, and elapsed comparison deadlines are tested; ports must preserve those consequences without copying Promise mechanics. |
| 365 | 2 | Optional coalescing-state inspection (X01), retained as implementation observability tests. |
| 760 | 1 | Local-storage read failure and suppression of later local publication. Core invariants/regressions plus ordinary tests cover C27; generated public replay has no local-fault injection point. |
| 989 | 1 | Invalid runtime logging policy falls back to logging off without disabling an otherwise eligible shadow job. Current generated logging/invalid-admission cases do not assert this exact combination. Keep this as a concrete portable replay gap, including its configuration-error diagnostic. |
| 1097 | 1 | A dark shadow job whose deadline already elapsed before deferred work starts must stop before its Redis read. Ordinary `dialcache-shadow-confirmation` tests cover this; the generated comparison/held-effect timeout cases do not exercise the initial delayed-start boundary. |

The last two rows are explicit next generated-replay targets. They are not silently excluded as language-specific merely because TypeScript tests reach them through invalid objects or synchronous executor delay. Larger mixed dark/served capacity histories and a second-language driver also remain open. The source inventory still cannot establish assertion-by-assertion equivalence with Vitest.

### Reproduce the execution coverage comparison

Generate the corpus first with `bash formal/generate-traces.sh`. Run the following from the repository root after generation completes; each cohort uses the same source include/exclude settings. JSON summaries provide the percentages above, and `coverage-final.json` preserves branch locations for comparing outcomes across cohorts. Check that file and branch maps agree before comparing counts. Vitest's ordinary configuration excludes Redis integration tests.

```bash
coverage_cohort() {
  local cohort="$1"
  shift
  corepack pnpm exec vitest run "$@" --coverage.enabled=true \
    --coverage.include='src/**/*.ts' --coverage.exclude='src/index.ts' \
    --coverage.exclude='test/**' --coverage.thresholds.lines=0 \
    --coverage.thresholds.functions=0 --coverage.thresholds.branches=0 \
    --coverage.thresholds.statements=0 --coverage.reporter=json-summary \
    --coverage.reporter=json --coverage.reporter=html \
    --coverage.reportsDirectory=".formal-traces/coverage/$cohort"
}
coverage_cohort existing --exclude='test/formal*.test.ts'
export DIALCACHE_MBT_TRACE_DIR=.formal-traces/conformance
export DIALCACHE_EFFECTS_TRACE_DIR=.formal-traces/effects
export DIALCACHE_FEATURE_TRACE_DIR=.formal-traces/features
coverage_cohort generated test/formal-conformance.test.ts \
  test/formal-effects.test.ts test/formal-features.test.ts \
  --testNamePattern='replays '
coverage_cohort portable test/formal-behavior.test.ts \
  test/formal-protocol-vectors.test.ts \
  --testNamePattern='portable behavioral scenarios|formal protocol conformance vectors'
coverage_cohort formal test/formal-conformance.test.ts \
  test/formal-effects.test.ts test/formal-features.test.ts \
  test/formal-behavior.test.ts test/formal-protocol-vectors.test.ts \
  --testNamePattern='replays |portable behavioral scenarios|formal protocol conformance vectors'
```

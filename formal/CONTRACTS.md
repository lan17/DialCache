# Portable contract inventory

This is the scope audit of the existing DialCache documentation and implementation tests. It accounts for their distinct semantic obligations, consolidating repeated assertions and API variants. The source index below accounts for every current documentation page and implementation test file; it is not a claim that each assertion has its own Quint transition or that every schedule is explored.

## Where the boundary lies

A rule belongs in the portable contract when implementations accepting the same logical inputs must preserve it to provide DialCache's caching guarantees or share its Redis keyspace safely. The executable form can be a Quint invariant, a portable behavioral scenario, or a deterministic protocol vector. A second language may use an idiomatic API and executor.

| Classification | Treatment |
| --- | --- |
| Portable behavior | Encode caller results, logical error identity, reuse, admission, ordering, policy, and publication consequences. Exercise through one logical call operation. |
| Protocol interoperability | Preserve exact key identity, frame/envelope bytes, timestamp domains, decoder precedence, and watermark transitions. Use vectors rather than a state machine for deterministic transforms. |
| Language binding | Keep ordinary implementation tests for wrapper registration, aliases, type guards, native exception/thenable handling, reference identity, and runtime scheduling mechanics. Preserve their portable consequence when one exists. |
| External assumption | State what the adapter, source, executor, clocks, or deployment must provide. Integrations check the adapters against that contract; core replay assumes the controlled environment fulfills it. |

Exact telemetry/exporter compatibility and resource-exhaustion limits remain optional integration concerns outside the current portable profiles. They are not intrinsically language-specific; a port must separately test them before claiming those integrations or limits.

### Applying the distinction

- `cached()` and `getOrLoad()` share an execution path. Registration uniqueness, wrapper aliases, and validation at registration are TypeScript binding obligations. Per-invocation policy precedence and captured execution policy remain portable. A port need not offer a registration API.
- A classifier can allow, deny, or fail. A comparator can report equality, inequality, or failure. Their consequences are portable. Exceptions, non-boolean returns, rejecting thenables, and the details of consuming those thenables are binding mechanisms. An invalid callback may be unrepresentable in another language.
- Scope lifetime, nested disabling, sharing, and closure are portable. `AsyncLocalStorage`, Promise turns, and referenced/unreferenced Node timers are not required.
- A timeout rejects an unaccepted result and releases its registered flight. It does not establish cancellation of external work. Source failure identity is a logical token, not a prescribed exception class or object pointer.
- Callers must treat reusable values as immutable and keep source-selection state stable. The portable suite does not require pointer identity, mutable aliasing, JavaScript prototypes, or Node deep equality. Detached shadow comparison must use the originally retained payload, independently decoded, rather than an unrelated later cache value.
- UTF-16 ordering, scalar string formatting, and URI escaping affect shared Redis keys, so those conventions remain interoperability requirements despite their JavaScript origins. A port can use exact integers when decoding uint64 timestamps; it need not reproduce JavaScript rounding, but must reject unsafe timestamps before serving or retaining them. Decoder encoding/fence precedence still applies.
- Object construction stages and host-language types are binding details. Effective numeric domains and invalid-runtime-policy consequences are portable. We test representative boundaries rather than enumerating every malformed value of every host type.

## Portable obligations and executable evidence

`S:` names an exact scenario in [behavioral-scenarios.json](./behavioral-scenarios.json). `V:` names a group in [protocol-vectors.json](./protocol-vectors.json). `I:` refers to [invalidation-vectors.json](./invalidation-vectors.json), executed against the production Lua protocol on real Redis and Valkey. Model names link from [TEST-MAP.md](./TEST-MAP.md). The [interaction audit](./TEST-MAP.md#interaction-regressions) identifies additional schedules spanning these rows. These forms complement one another; model coverage alone does not mean generated implementation replay. `G:` names a generated profile in `test/formal-features.test.ts`; each explores the bounded subset described in `BEHAVIOR.md`, not necessarily the entire row.

### Scope, traversal, storage, and sharing

| ID | Obligation | Executable evidence |
| --- | --- | --- |
| C01 | Outside enablement: no key/config/cache/coalescing or source deadline | Core model; S: `disabled calls bypass policy and caches`, `outside calls have no fallback deadline or sharing`; G: scope (provider/source bypass) |
| C02 | Nested enable/disable preserves the outer memo and sibling scope state | Core model; S: `nested enable and disable preserve outer memo`, `reenabling inside disabled scope reuses memo and preserves siblings`; G: scope |
| C03 | Closing/replacing an outer scope prevents late request publication; detached calls are pass-through | Core ownership invariants; S: `closed scope cannot be repopulated by late work`, `late old-scope value cannot enter a replacement scope`, `late recovery cannot memoize into a closed or replacement request scope`; G: scope |
| C04 | A call admitted while enabled but still awaiting policy at closure uses uncached execution and its source deadline | Core model; S: `policy resolution after scope closure is pass-through`; coalescing deadline model; G: scope (closure during policy; deadlines remain separate) |
| C05 | First active hit stops lower traversal; only participating layers receive eligible publication | Core model; S: `untracked source fills remote local and request layers`, `local hit stops new shadow work`; G: policy |
| C06 | Successful empty/falsy/absent values are cached, not interpreted as misses | S: `undefined is a memoized value` and the null/false/zero/empty-string scenarios in all three layers |
| C07 | Request storage has no TTL/LRU cap and is isolated by outer scope | S: `outer scopes isolate request memo`, `concurrent outer request scopes retain independent flights and memo`, `request memo has no process local capacity cap`; G: scope (lifetime isolation) |
| C08 | Local capacity is per instance, shared across operation identities, and least-recently-used | S: `local capacity evicts the least recently used key`, `shared local capacity spans operation identities`, `instances isolate local storage and registered flights`; G: policy (one-slot eviction) |
| C09 | Local TTL starts at insertion, reads do not renew it, and wall-clock rollback does not extend it | Policy model insertion history; S: `local exact TTL boundary expires`, `local expiry uses monotonic time across application wall rollback`, `nearly expired remote hit warms local for its full insertion TTL`; G: policy |
| C10 | Zero local capacity disables storage while preserving eligible in-flight sharing | S: `zero local capacity retains coalescing but no settled value` |
| C11 | Same-key eligible calls share one registered execution; distinct keys/instances remain isolated | Coalescing model; generated effects; S: `different keys own independent flights`, `instances isolate local storage and registered flights`; G: recovery, policy (cross-key overlap) |
| C12 | Request misses can join a process flight and memoize its result separately | S: `request misses join one process flight then memoize separately` |
| C13 | Coalescing disabled means independent executions, not disabled settled caching; publication is last-writer-wins | S: `coalescing off keeps settled caching`, `independent local publication is last writer wins`, `independent remote publication is last writer wins`, `uncoalesced request calls still memoize the last settled value`; G: policy (independent sources, reverse settlement, coalescing changes); G: scope |
| C14 | With no active serving layer, calls do not coalesce | Coalescing model; S: `inactive serving layers do not coalesce` |
| C15 | Failed flights share the logical source error and clear for retry, including within one request | S: `rejected request flight is shared then removed for retry`; generated effects; G: scope |

### Policy, liveness, and failure handling

| ID | Obligation | Executable evidence |
| --- | --- | --- |
| C16 | Sparse runtime fields override operation defaults independently; omission/null inherits; configured TTL defaults to full ramp | Policy model; S: `null provider inherits operation defaults`, `runtime ramp changes preserve existing entries`; V: `rampVectors`; G: policy |
| C17 | Request-local/recovery/shadow default off; coalescing defaults on; turning serving off neither evicts nor cancels admitted work | Policy model defaults; S: `inactive serving layers do not coalesce`, `runtime ramp changes preserve existing entries` |
| C18 | Resolve policy once per enabled invocation; pending work and eligible followers keep the accepted leader policy | Policy model snapshot invariant; S: `pending invocation keeps insertion TTL snapshot`, `runtime changes preserve in-flight physical TTL and affect later freshness`, deadline follower scenarios, `runtime reenabling joins the registered flight before a newer local hit`, `dark fill preserves accepted runtime TTL and retention after policy changes`; G: policy (per-source snapshots, joins after policy changes, publication during another policy fetch) |
| C19 | Request-local policy bypass preserves existing memo for later reenablement | S: `request policy bypass retains memo for later reenabling`; G: scope |
| C20 | Provider failure uses uncached source, not baseline caching; invalid whole-invocation policy also bypasses caching | S: `provider failure fails open without caching`, invalid runtime coalesce/requestLocal/remoteReadTimeoutMs scenarios; G: policy (provider failure) |
| C21 | Invalid TTL/ramp disables its layer; valid layers continue; invalid optional recovery/shadow preserves normal serving | S: `invalid runtime ramp fails open`, `invalid local TTL leaves valid remote serving available`, invalid optional policy scenarios, `invalid optional shadow disables dark reads while retaining local publication`; G: policy |
| C22 | Redis logical freshness uses current policy; physical TTL remains as written and expired storage cannot be resurrected | Policy model physical history; S: `remote exact fresh TTL expires`, `runtime changes preserve in-flight physical TTL and affect later freshness`; G: policy |
| C23 | Read deadline precedence: runtime → operation → instance → 50 ms; source defaults to 60 seconds and starts only at source invocation | S: library/instance/operation/runtime `read deadline precedence`, `fallback deadline starts after remote read completes`, `library source deadline defaults to sixty seconds`; coalescing model |
| C24 | Late followers inherit remaining read/source time and outcome; uncoalesced work owns independent budgets | S: `late follower inherits remaining read deadline`, `late follower inherits remaining fallback deadline`; coalescing model |
| C25 | Expired source results are rejected even before timer delivery; abandoned source work can overlap a new flight | Coalescing model; generated effects; S: `late resolve loses to deadline before timer delivery`, `late reject loses to deadline before timer delivery`, `timeout releases flight while old loader continues` |
| C26 | Explicitly unbounded source work is permitted; config, decoding, accepted serialization/write have application-owned budgets | S: `disabled fallback deadline accepts later source settlement`, `accepted serialization and write outlive fallback deadline`; coalescing model |
| C27 | Key/config/cache/serializer/write failures fail open; source failures remain source failures | Core model; S: `key construction failure runs source with its enabled deadline`, `dump failure returns source and does not retain value`, `write failure returns source and does not retain value`; G: policy |
| C28 | Read failure/timeout never authorizes a Redis refill; safe untracked local publication remains possible | Core model; S: `remote read timeout suppresses refill and late read`, `untracked read failure still permits active local publication`; G: policy |
| C29 | Missing remote resources do not disable valid local serving; maintenance failure is surfaced | S: `missing remote adapter leaves valid local serving available`, `explicit invalidation surfaces mutation failure`; missing-resource validation remains a binding test; G: shadow (maintenance failure) |
| C30 | Observer failures must not change cache results or replace the original source/maintenance failure | S: `observer failures cannot change cache or source outcomes`; logger/metrics binding tests exercise every host callback form |

### Invalidation, recovery, and shadow validation

| ID | Obligation | Executable evidence |
| --- | --- | --- |
| C31 | Tracked fallback suppresses direct local publication; a validated Redis hit can warm it | Core model; S: `tracked refill suppresses local until a Redis hit warms it` |
| C32 | Invalidation groups all tracked operation/argument variants of one namespace/type/id; untracked entries ignore it | S: `one invalidation fences all tracked operation variants only for its entity`, `untracked Redis values ignore invalidation markers`; V: `keyVectors` |
| C33 | A tracked value must clear the observed watermark strictly; zero/missing/malformed watermark handling has defined precedence | Protocol and tracked models; V: `trackedDecodeVectors`; generated effects |
| C34 | Conditional refill checks the same observed fence before preparation and again before dispatch; the final timestamp starts freshness | S: `observed future fence suppresses serialization and refill`, `tracked refill rechecks clock after serialization`, `admitted tracked refill timestamps after serialization`; G: shadow |
| C35 | Delayed writes may complete after invalidation but remain fenced on later reads | Tracked model; generated effects; S: `delayed old write is fenced after invalidation` |
| C36 | Invalidation does not revoke acquired snapshots, local entries, request memo, or existing flights | Tracked model; S: `acquired tracked snapshot survives later invalidation`, `recovery uses acquired snapshot after invalidation and replacement`; ordinary invalidation/coalescing tests corroborate the reuse boundaries; G: recovery |
| C37 | Tracked physical retention is capped at one hour; logical policy and local TTL are not clamped | S: `tracked retention has a one hour physical cap`, `tracked stale retention cap does not clamp logical recovery age`; V: `durationVectors` |
| C38 | Invalidation advances the watermark monotonically and preserves/extends retention; malformed strings and wrong types have different repair rules | I: all valid transition vectors, including persistence, longer TTL, future cutoff, wrong-type repair, and leading zeros |
| C39 | Invalidation argument violations reject before mutation; buffer and timestamp sum have fixed numeric bounds | I: maximum buffer/safe sum and rejected argument vectors; V: `durationVectors` |
| C40 | Recovery retains only eligible initial bytes: F is stale, M is already too old, future/fenced/invalid values are excluded | Recovery model; S: F/M/future/unsafe scenarios; V: frame and decoder vectors; G: recovery |
| C41 | Source success skips candidate decode; authorized source failure can recover; denial/classifier failure preserves original failure | Recovery model; S: `source success skips retained candidate decoding`, recovery override/failure scenarios; G: recovery |
| C42 | Classifier precedence is operation → instance → timeout-only default, with replacement rather than union | S: recovery override scenarios, `default classifier rejects ordinary errors`, `default classifier accepts a timeout propagated by source`, `explicit denial replaces default timeout recovery` |
| C43 | Coalesced recovery classifies/decodes once; stale returns never publish to shared caches, but may memoize request-locally | S: `coalesced recovery classifies and decodes once`, `uncoalesced recovery preserves each caller's independently acquired bytes`, `first stale age is recoverable without shared publication`, `recovered value memoizes only in its request scope`; G: recovery |
| C44 | Recovery uses one read and its initial snapshot; later invalidation, replacement, expiry, or Redis failure cannot revoke retained bytes | Recovery model; S: `recovery uses acquired snapshot after invalidation and replacement`, `expired remote storage cannot revoke retained stale snapshot`, `read failure never causes a recovery reread`; G: recovery |
| C45 | Recheck age before/after asynchronous decode using the invocation's captured policy; failed recovery preserves source error | S: `stale candidate crossing M during decoding preserves source error`, `stale candidate crossing M before decoding is rejected`, `pending recovery keeps its age snapshot while later calls use new policy`, `wall rollback during recovery decode rejects a now future snapshot`, `failed fresh deserialization is never retried as stale recovery`; G: recovery |
| C46 | Recovery after source timeout ignores the abandoned loader's late successful result | S: `default timeout recovery ignores late successful loader`; generated deadline effects |
| C47 | Shadow admission requires eligible remote traversal, valid TTL, independent cohort, outcome hook, and capacity | Shadow model; S: `shadow requires an outcome observer`, `shadow global capacity drops another key instead of queueing`, `local hit stops new shadow work`, `recovered absent value never starts selected shadow work`, `shadow capacity and job deduplication are isolated per instance`; V: `rampVectors` |
| C48 | Served-hit shadow runs detached source under disabled caching; ordinary misses do not add duplicate source work | S: `shadow source observes disabled caching scope`, `ordinary remote miss does not schedule shadow source`; shadow model |
| C49 | Dark reads reuse caller source, never serve dark values, and do not delay the caller on read/fill work | Shadow model; S: `ramped down shadow fills from the same caller source`, `dark read does not delay caller source result`, `dark shadow deduplicates jobs without coalescing caller sources`, `dark serving never recovers stale even when classifier allows`; G: shadow |
| C50 | Shadow independently decodes retained C0; semantic equal/unequal/error outcomes are diagnostic | S: served-hit match/mismatch cases, custom comparator equal/unequal/error scenarios; decoder counts verify separate C0 decode; G: shadow |
| C51 | An unequal comparison requires one C1 payload confirmation; changed/absent/fenced C1 is superseded; same payload remains comparable after age/clock changes | Shadow model; S: `served hit shadow superseded remains diagnostic`, `shadow confirmation compares payload bytes after C0 freshness expires`, `shadow confirmation retains future dated payload for comparison`, `shadow confirmation preserves payload comparison across wall clock rollback`; G: shadow |
| C52 | A present C0 is never repaired, including undecodable values; only semantic misses may fill | Shadow model; S: `ramped down present C0 is diagnosed without repair`, `dark present undecodable value is never repaired`, `ramped down shadow fills from the same caller source`; G: shadow |
| C53 | Shadow fills reuse the original fence and obey conditional publication; failures do not replace caller results | Shadow model; S: `ramped down shadow fill respects observed fence`, shadow source/comparison/confirmation failure scenarios; G: shadow |
| C54 | Duplicate/capacity overflow drops work instead of queueing; timeout retains capacity until owned external work settles and suppresses late new work | S: `shadow admission drops duplicate work`, shadow source/read/dump/write timeout-capacity scenarios; `shadow remains bounded when source deadline is disabled`, `dark shadow releases capacity while unbounded caller source continues`, `served shadow decode retains capacity after timeout until raw load settles`, `shadow confirmation read retains capacity after its separate read deadline`; G: shadow (late-effect suppression; capacity admission remains in scenarios) |

### Deterministic protocol obligations

| ID | Obligation | Executable evidence |
| --- | --- | --- |
| W01 | Result identity includes namespace/type/id/use case/args; tracked keys share an entity hash tag and values use the frame suffix | V: `keyVectors`, `invalidKeyVectors` |
| W02 | Normalize scalars, omit absent arguments, sort by UTF-16 units, and escape components; direct ordered pairs retain their order | V: `normalizeArgsVectors`, `keyVectors` |
| W03 | Stable serving/shadow cohorts depend on exact identity and their independent discriminator | V: `rampVectors`; policy model ramp extremes |
| W04 | Version-1 header, uint64 timestamp domain, UTF-8/binary payload tags, empty data, and encoding/fence precedence | V: `frameVectors`, `invalidTimestampVectors`, `trackedDecodeVectors`, `untrackedDecodeVectors`; protocol model |
| W05 | Native write TTLs have a fixed ceiling and are rounded up in milliseconds | V: `durationVectors`; adapter dispatch validation tests |
| W06 | Payload markers distinguish escaped raw, compressed UTF-8, and compressed binary; readers also accept legacy raw input | V: `envelopeVectors`, `compressedDecodeVectors` |
| W07 | Compression threshold counts serialized bytes; write compression must shrink stored data and preserve decoded type/value | V: `compressionWriteVectors`; compressor output bytes are not prescribed |
| W08 | Disabling new compression still requires envelope escaping and decompression of old entries | V: `envelopeVectors`, `compressedDecodeVectors`; behavioral fixtures decode through real DialCache with new compression disabled |
| W09 | Invalidation marker domain, monotonic cutoff, repair, persistence, retention floor/slack, and pre-mutation validation | I: all vectors; actual exported protocol runs on Redis 6.2 and Valkey 8 |

## Assumptions and deliberate exclusions

| ID | Boundary | Required treatment |
| --- | --- | --- |
| E01 | Redis snapshots and dispatch | Adapter supplies atomic primary value/watermark observations, complete-frame writes, exact supplied timestamps, and protocol-valid replies. Integration tests exercise both bundled adapters and Cluster routing. Core replay does not prove the adapter. |
| E02 | Watermark availability | The protocol must request adequate retention (W09). Eviction, restore, failover, external writes, and clock/work bounds must also preserve the marker long enough; retention requests alone are not a durability proof. |
| E03 | Time and progress | Wall clocks supply timestamps; elapsed clocks govern deadlines/local TTL. Future buffers require a bound on stale write visibility and writer-clock lead. Finite external budgets/executor progress are application assumptions; sampling does not prove fairness. |
| E04 | Source identity and value ownership | Keys include all value dimensions; same-key calls agree on serialization and shared execution. Source-selection state is stable; callers do not mutate reusable values; adapters keep retained payload bytes stable. |
| E05 | Deployment compatibility | Namespace, tracked cap/floor, frame version, and serializer changes require coordinated deployment as described in upgrading/invalidation docs. Passing one revision does not prove a rolling transition between incompatible revisions. |
| B01 | Public language binding | API names/aliases, wrapper registration, exact construction/validation timing, generics/type guards, reserved/removed option diagnostics, native error classes, exported helper shapes, and package entry points remain TypeScript tests. |
| B02 | Host execution mechanics | Promise identity, exceptions/thenables and rejection consumption, Node timer handles, synchronous event-loop blocking, and native buffer views remain binding tests. Their deadline, failure-isolation, and retained-snapshot consequences are represented above. |
| B03 | Native value conventions | Shared object references, constructors/prototypes, JavaScript JSON coercion/lossiness, and default Node deep equality are not universal port requirements. Each binding documents its supported value domain and codec; W01–W09 apply wherever it shares Redis. |
| X01 | Optional observability integration | Exact metrics, labels, histograms, exporter registry compatibility, coalescing-state inspection, bounded JSON logging, and telemetry timing are covered by implementation/integration tests. Current portable claims cover diagnostic outcomes and failure isolation, not exporter compatibility. |
| X02 | Resource/algorithm implementation | Compression level tuning, native zstd availability/decoder quirks, huge payloads/512 MiB guard, decompression bombs, local allocation strategy, CPU/memory/throughput, connection lifecycle, retry APIs, and command queue limits remain implementation/integration tests. Envelope interoperability remains W06–W08. |

## Source index

Each row identifies where the source's semantic rules land. Repeated tests in different APIs/adapters do not create new obligations. A file marked with several IDs includes a mixture of portable rules and implementation details; the label does not make every assertion portable.

| Documentation source | Inventory |
| --- | --- |
| `README.md`, `docs/index.md`, `docs/getting-started.md` | C01–C05, C16–C18, W01; B01, E01/E04/E05 for setup and examples |
| `docs/concepts.md` | C01–C15, C18–C30, C31/C36; B02/B03, E03/E04 |
| `docs/keys.md` | W01–W03, C11/C32; B01, E04/E05 |
| `docs/configuration.md` | C16–C26, C47; W03; B01, X01 |
| `docs/coalescing.md` | C11–C15, C18, C23–C28, C36; B02, E03/E04, X01 |
| `docs/invalidation.md` | C31–C39, W01/W04/W05/W09; E01–E05 |
| `docs/stale-on-error.md` | C37, C40–C46; B01/B02, E04, X01 |
| `docs/shadow-validation.md` | C47–C54; B02/B03, E03/E04, X01 |
| `docs/redis.md` | C22/C23/C27–C29, W01–W09; B01–B03, E01–E05, X02 |
| `docs/api.md` | C01–C54/W01–W09 where those contracts are repeated; B01/B03, X01 for exact API/export/reference contracts |
| `docs/observability.md` | C30/C47/C50–C54, W04; X01 for detailed telemetry contracts |
| `docs/upgrading.md`, `docs/maintainers.md` | E05, B01, X01/X02 for deployment, package/release/test workflow, and benchmarks |

| Implementation tests (`test/` basenames) | Inventory |
| --- | --- |
| `dialcache-local`, `dialcache-request-local` | C01–C10, C15/C19/C27, W01/W02; B01–B03, X02 |
| `dialcache-get-or-load` | C01–C05, C11/C15/C18/C27/C31; B01/B03 for inline/wrapper API differences |
| `dialcache-coalescing` | C11–C15/C18/C20/C24/C36/C43; B02/B03 |
| `dialcache-liveness`, `dialcache-redis-read-deadline` | C23–C28/C46; B01/B02, E03, X01 |
| `dialcache-config-ramp`, `dialcache-observability-internals` | C16–C22/C47, W03; B01, X01 |
| `dialcache-invalidation` | C29–C39, W01/W09; B01, E01/E02/E05, X01 |
| `dialcache-redis` | C05/C22/C27–C29/C31/C33/C34, W04; B01–B03, E01/E04, X01 |
| `dialcache-stale-on-error`, `dialcache-stale-recovery-policy` | C37/C40–C46; B01–B03, X01 |
| `dialcache-shadow-validation`, `dialcache-shadow-confirmation` | C30/C47–C54; B01–B03, X01 |
| `redis-payload`, `duration` | W04/W05/W09; B01/B02 for native reply shapes, rounding representation, exception identity, and zero-copy views |
| `compression`, `compression-error`, `compression-guard`, `dialcache-compression` | C06/C27/C34, W06–W08; B01/B03, X01/X02 |
| `dialcache-logger`, `dialcache-metrics` | C20/C21/C27–C30/C33/C40–C54; B02, X01 |
| `datadog`, `prometheus`, `shadow-log-json` | C30; B01–B03, X01 |
| `node-redis`, `valkey-glide` | W04/W05/W09, E01–E03; B01/B02 and X02 for client-specific routing, retry, module identity, error decoration, and lifecycle |
| `redis-real.integration`, `redis-cluster.integration` | E01/E02, W01/W04–W09, C22/C27–C39; X02; portable invalidation vectors execute here |
| `formal-behavior`, `formal-conformance`, `formal-effects`, `formal-features`, `formal-protocol-vectors` | Execution of the portable artifacts and independent-observation/parser regression checks |

`fake-redis.ts`, `marker-colliding-serializer.ts`, and `test/formal/*.ts` are fixture/driver helpers, not additional product contracts. Compile-time, packed-package, and example checks outside `test/` establish B01/B03. The formal docs describe the checking machinery, its assumptions, and its limits.

## Maintenance and claim limits

When adding or changing a rule, place it in this inventory, name its implementation-test/doc evidence, and add the relevant portable scenario/vector/model or explain its binding/assumption/exclusion boundary. Do not copy expected model state into execution or call a host-specific test a portable trace. The three-state callback outcomes deliberately avoid building a second callback language.

The inventory completes the current source-family accounting, not exhaustive state-space coverage. The remaining assurance work is broader multi-key/multi-instance and request-scope combinations, generated served-hit shadow admission/capacity, an independent language driver, and optional integration profiles. Generated coverage now includes core, effects, request scopes, recovery, policy/storage, and dark shadow validation; passing these plus the fixed corpus does not certify arbitrary interleavings, all malformed host values, fairness, performance, or every external fault. No percentage of behavioral completeness or universal certification is claimed. Measured code execution coverage is reported separately in `TEST-MAP.md`.

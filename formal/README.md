# Executable DialCache specification

This suite formalizes DialCache behavior for better implementation testing and future language ports. It has three complementary parts:

| Part | Execution | What passing establishes |
| --- | --- | --- |
| Verification | Seven Quint models → bounded simulation → invariant checks | No violation was found in the explored executions of those models |
| Behavioral conformance | Quint core/effects/scope/recovery/policy/shadow/admission/layers models → ITF traces, plus portable feature scenarios → language driver → real DialCache | The implementation produced the expected observations for the tested profile and traces |
| Protocol interoperability | Portable JSON vectors → language implementation | Keys, frames, decoder/envelope results, cohorts, and invalidation transitions match the supplied cases |

Passing one part does not imply the others. In particular, a model can satisfy its invariants while an implementation diverges from it. Generated replay connects the two for eight profiles: core, pending effects, request scopes, recovery, policy/storage, dark shadow validation, served-hit shadow admission, and layer composition. Portable deterministic scenarios cover additional feature boundaries.

```text
Seven verification models                 Conformance models
          |                                      |
 bounded invariant checking                generated ITF traces + portable scenarios
                                                 |
                                     TypeScript / Go / Rust driver
                                                 |
                                          real implementation
                                                 |
                                      compare observable effects

Protocol JSON vectors ────────────────> exact key / frame / decoder checks
```

The TypeScript driver exists today. Other language drivers and exhaustive feature combinations are future work. [`TEST-MAP.md`](./TEST-MAP.md) distinguishes implemented coverage from remaining gaps; [`CONFORMANCE.md`](./CONFORMANCE.md) defines the core profile; [`BEHAVIOR.md`](./BEHAVIOR.md) defines the shared feature-scenario/effects driver and porting workflow.

## Portable scope

[`CONTRACTS.md`](./CONTRACTS.md) inventories the rules derived from current docs and tests, with named executable evidence and a source index. It separates portable behavior, protocol interoperability, language binding, and external assumptions. Backend-neutral diagnostic classifications, counts, ages, phase durations, byte sizes, and mismatch-warning eligibility have selected portable scenarios. Exporter compatibility and resource ceilings remain separate integration concerns. Registration APIs, native object identity, and Promise mechanics are not requirements for other languages.

One logical call operation is enough to exercise the shared cache path. The feature corpus also controls classifier/comparator outcomes, multiple instances/scopes/operation identities, and independent wall-clock changes. A port supplies its own public API adapter; expected results never enter execution. Every cacheable result, including an absent fixture value, is distinct from a cache miss.

## Verification models

The models are decomposed by behavioral boundary, independently of the implementation's module layout. They use a single record state variable so alternative transitions have compatible Quint update effects.

| Model | Scope |
| --- | --- |
| [`dialcache-core.qnt`](./dialcache-core.qnt) | Nested/disabled/replaced scopes, request/process/remote traversal, fail-open reads, publication boundaries |
| [`dialcache-runtime-policy.qnt`](./dialcache-runtime-policy.qnt) | Sparse overlays across eight policy leaves, immutable pending snapshots, preserved insertion/physical TTLs |
| [`dialcache-coalescing-liveness.qnt`](./dialcache-coalescing-liveness.qnt) | Flight admission, followers, fallback deadlines, timeout cleanup, late settlement, publication |
| [`dialcache-tracked-invalidation.qnt`](./dialcache-tracked-invalidation.qnt) | Atomic tracked snapshots, monotonic watermarks, delayed stale writes, conditional refills |
| [`dialcache-stale-recovery.qnt`](./dialcache-stale-recovery.qnt) | Fresh/stale age boundaries, one-read retained snapshots, authorized recovery, no shared publication |
| [`dialcache-shadow-validation.qnt`](./dialcache-shadow-validation.qnt) | Overlapping dark reads/source work, accepted-source gating, C0/S/C1, diagnostic-only mismatches, source errors/deadlines |
| [`dialcache-redis-protocol.qnt`](./dialcache-redis-protocol.qnt) | Frame/watermark validation and decoder classification precedence |

These are abstractions, not exhaustive translations of every feature. The coalescing model explores deadline safety but does not prove eventual progress under arbitrary scheduling. The policy model represents selected valid overlays; it does not enumerate all validation failures or feature combinations.

## External assumptions and allowed races

Models describe an environmental observation, DialCache's transition, and its observable effects. They do not model Redis internals, TCP, a language event loop, Promises, or compression algorithms. Relevant assumptions include:

- A tracked Redis read atomically observes value and watermark on a primary.
- Application wall clocks supply frame/invalidation timestamps; monotonic clocks supply deadlines and local TTL age.
- The invalidation future buffer bounds delayed stale writes plus writer-clock lead.
- Watermarks remain available for the required fencing lifetime; state loss needs deployment-level protection.
- External operations can fail, be delayed, or settle after DialCache stops accepting their results. Application-owned serialization/write work requires its own resource budgets.

The suite deliberately allows previously acquired snapshots, retained stale candidates, local values, and existing flights to survive a later invalidation according to their respective contracts. Timeout removes a registered/coalescible flight without cancelling its underlying loader, so old external work can overlap a new flight. Accepted source results may continue through serialization/publication after the fallback deadline. Shadow mismatch is diagnostic evidence, not repair or an atomic cross-system snapshot.

Stale age is checked when the candidate is retained and again when recovery accepts it, including after asynchronous decoding. The return-time invariant records that observation: time advancing after a value was returned cannot retroactively make the return invalid. Exact maximum age is already too old.

## Protocol interoperability

[`protocol-vectors.json`](./protocol-vectors.json) schema version 3 contains 102 deterministic cases: keys, argument normalization, frame bytes, timestamp acceptance, tracked/untracked decoding, compression envelopes, fixed zstd decoding, deterministic serving/shadow cohorts, invalid key identities, physical-duration bounds, and compression representation selection. `test/formal-protocol-vectors.test.ts` executes them against the existing TypeScript functions. No new production exports are required.

Ports consume the same JSON. Normalization preserves UTF-16 code-unit ordering and JavaScript-compatible scalar string formatting. `bigintArgs` encodes arbitrary integers as decimal strings; `specialArgs` names `-0`, `NaN`, and infinities that ordinary JSON cannot represent. URI component escaping preserves `~!*'()-._`. Decoder cases deliberately distinguish frame decoding from core timestamp validation: unsafe decoded timestamps remain visible to core, which rejects them before deserialization. The mutation encoder rejects unsafe timestamps immediately.

Envelope vectors cover raw-byte escaping and reader marker behavior. Compression-write vectors check UTF-8 byte thresholds, only-when-smaller selection, marker type, and round-trip preservation without prescribing exact compressed bytes. Fixed compressed frames test decoding; compressor byte identity is not required because valid zstd encoders can produce different bytes. Rollout vectors use the stable FNV-1a 32-bit hash over UTF-16 units of the logical key plus the layer/shadow discriminator, divided by 2^32 and multiplied by 100. These are finite examples, not exhaustive input coverage.

[`invalidation-vectors.json`](./invalidation-vectors.json) schema version 1 adds 19 portable state transitions for absent/valid/malformed/wrong-type markers, monotonicity, persistence, retention, safe numeric limits, and rejection before mutation. `test/redis-real.integration.test.ts` runs the actual exported invalidation protocol on Redis 6.2 and Valkey 8. Fixture setup, transition, and observation run atomically. Redis 6.2 can advance TTL time within a script, so finite TTL assertions allow only the elapsed server time measured around that script; watermark values and persistence remain exact. These vectors check DialCache's protocol, not Redis implementation correctness. A port using another implementation of the transition must produce the same resulting state.

Invalidation vectors specify `existing.kind` (`absent`, `string`, or an unrelated `list`), optional string `value`, and `ttlMs` (`-1` means persistent). `futureBufferMs` and `invalidatedAtMs` are raw argument text so invalid numeric spellings can be tested without host coercion. Expected state contains the resulting decimal watermark and remaining TTL; `error: true` requires rejection with that original state preserved. Successful transitions return numeric `1`. The vectors specify logical transition TTLs. Integration observations account for measured physical expiry without adding a fixed network or CI timing tolerance.

## Running and reproducing checks

Use a supported Node.js version, install repository dependencies with `corepack pnpm install --frozen-lockfile`, and install the CI-pinned Quint version:

```sh
npm install --global @informalsystems/quint@0.32.0
bash formal/check.sh
bash formal/generate-traces.sh
DIALCACHE_MBT_TRACE_DIR=.formal-traces/conformance \
DIALCACHE_EFFECTS_TRACE_DIR=.formal-traces/effects \
DIALCACHE_FEATURE_TRACE_DIR=.formal-traces/features \
  corepack pnpm exec vitest run test/formal-conformance.test.ts test/formal-effects.test.ts \
  test/formal-features.test.ts test/formal-behavior.test.ts test/formal-protocol-vectors.test.ts --coverage.enabled=false
```

`check.sh` typechecks all seven verification models plus all eight conformance models and checks their listed invariants using the Rust simulator: **2,000 sampled traces per model, up to 40 transitions per trace**, seed `0xd1a1ca`, one evaluator thread. It also executes 85 deterministic model regressions, including witnesses that deliberately corrupt TTL or decoder outcomes and require the strengthened invariants to reject them. This is bounded sampling, not exhaustive mathematical proof.

`generate-traces.sh` uses the same pinned version/backend/seed with one thread. It exports 32 core traces from 256 samples (up to 30 transitions), 512 effects and 512 recovery traces from 4,096 samples each, 512 dark-shadow traces from 2,048 samples, and 256 policy / 256 request-scope / 128 served-hit admission traces from 1,024 samples each (up to 60 transitions). An additional layer-composition profile exports 512 traces from 2,048 samples, up to 80 transitions. All **2,720 generated traces** replay against real TypeScript DialCache using [Quint's model-based testing interface](https://quint.sh/docs/model-based-testing). Required witnesses now include separate read/source budgets, held decoding and publication, cancellation requests, observer failure isolation, wall rollback at the second fence check, timeout recovery and late sources, and empty/falsy/absent cache hits in all three layers. These conformance models remain separate from the seven verification models because replayable public operations and reasoning-oriented transitions serve different purposes.

Both scripts accept `QUINT_SEED` for exploratory runs. The generated directory is replaced on each generation. CI runs on every PR and main push, including implementation-only changes, and uploads `.formal-traces/` as the `formal-traces` artifact for 14 days even after failure. `verification/` contains model samples or counterexamples; `conformance/`, `effects/`, and `features/{scope,recovery,policy,shadow,admission,layers}/` contain the generated corpora. Replay requires every named action and specified race/outcome witnesses, including scope closure/replacement and nested memo reuse, recovery across invalidation and decoding age boundaries, policy changes during overlapping calls, per-source publication snapshots, reverse source settlement, both dark C0/source orders, C1 supersession/failure, writes completing after shadow timeout, and served-hit shadow capacity retained through pending source/decode/confirmation work.

A replay failure prints the trace path, step, action, expected model observation, actual implementation observation, and a reproduction command. After downloading a failing artifact, replay just the relevant conformance file:

```sh
DIALCACHE_MBT_TRACE_FILE=.formal-traces/conformance/trace_0.itf.json \
  corepack pnpm exec vitest run test/formal-conformance.test.ts --coverage.enabled=false
DIALCACHE_EFFECTS_TRACE_FILE=.formal-traces/effects/trace_0.itf.json \
  corepack pnpm exec vitest run test/formal-effects.test.ts --coverage.enabled=false
```

Feature failures use the same public driver and can be replayed individually:

```sh
DIALCACHE_FEATURE_TRACE_FILE=.formal-traces/features/shadow/trace_0.itf.json \
  corepack pnpm exec vitest run test/formal-features.test.ts --coverage.enabled=false
```

Without these environment variables, ordinary TypeScript tests replay all eight committed smoke traces through their generated-trace parsers, with no Quint installation. They run all 229 portable feature scenarios, reject malformed traces, and prove the harness detects lost local caching, coalescing, Redis writes, and invalidation. All 102 key/frame/codec/cohort/compression cases run in ordinary CI too. The 19 invalidation vectors run on both engines via `corepack pnpm test:integration` in the regular CI job.

Model-checker exploration is separate from CI's sampled runs. For example, `quint verify` supports a TLC backend; any reported result must include the backend/version, model bounds, assumptions, and invariant. No exhaustive result is claimed here.

## Source audit

[`source-audit.json`](./source-audit.json) assigns 564 ordinary test declarations and 172 documentation sections across 44 files to explicit contract/binding/assumption dispositions. Normal CI rejects source drift until the affected audit is reviewed. [`TEST-AUDIT.md`](./TEST-AUDIT.md) explains the 55 added caller-level scenarios and local-storage failure model regressions found by this pass. This is source accounting with executable evidence, not a percentage of semantic completeness or a claim that every Vitest assertion has an equivalent formal test.

## Maintenance

For every changed rule, review its `source-audit.json` disposition and fingerprint, then update the classification and evidence in `CONTRACTS.md` and its coverage summary in `TEST-MAP.md`. A model is not authoritative merely because it is formal. Resolve disagreements against the intended contract, existing focused tests, and implementation. Update the affected model, ordinary tests, portable traces/vectors, and documentation together. Keep the driver independent: expected model state belongs in assertions, never in the code that executes the implementation or records its observations.

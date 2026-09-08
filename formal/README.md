# Executable DialCache specification

This suite formalizes DialCache behavior for better implementation testing and future language ports. It has three complementary parts:

| Part | Execution | What passing establishes |
| --- | --- | --- |
| Verification | Seven Quint models → bounded simulation → invariant checks | No violation was found in the explored executions of those models |
| Behavioral conformance | Dedicated Quint conformance model → ITF traces → language driver → real DialCache | The implementation produced the expected observations for the tested profile and traces |
| Protocol interoperability | Portable JSON vectors → language implementation | Exact keys, frame bytes, and decoder results match the supplied cases |

Passing one part does not imply the others. In particular, a model can satisfy its invariants while an implementation diverges from it. Generated replay connects the two for the currently supported core profile.

```text
Seven verification models                 Conformance model
          |                                      |
 bounded invariant checking                generated ITF traces
                                                 |
                                     TypeScript / Go / Rust driver
                                                 |
                                          real implementation
                                                 |
                                      compare observable effects

Protocol JSON vectors ────────────────> exact key / frame / decoder checks
```

The TypeScript driver exists today. Other language drivers and additional behavioral profiles are future work. [`TEST-MAP.md`](./TEST-MAP.md) distinguishes implemented coverage from remaining gaps; [`CONFORMANCE.md`](./CONFORMANCE.md) defines the core profile's actions, environment, observations, and porting workflow.

## Verification models

The models are decomposed by behavioral boundary, independently of the implementation's module layout. They use a single record state variable so alternative transitions have compatible Quint update effects.

| Model | Scope |
| --- | --- |
| [`dialcache-core.qnt`](./dialcache-core.qnt) | Enabled scopes, request/process/remote traversal, fail-open reads, publication boundaries |
| [`dialcache-runtime-policy.qnt`](./dialcache-runtime-policy.qnt) | Sparse baseline/runtime/library overlays, invocation snapshots, entry TTL bookkeeping |
| [`dialcache-coalescing-liveness.qnt`](./dialcache-coalescing-liveness.qnt) | Flight admission, followers, fallback deadlines, timeout cleanup, late settlement, publication |
| [`dialcache-tracked-invalidation.qnt`](./dialcache-tracked-invalidation.qnt) | Atomic tracked snapshots, monotonic watermarks, delayed stale writes, conditional refills |
| [`dialcache-stale-recovery.qnt`](./dialcache-stale-recovery.qnt) | Fresh/stale age boundaries, one-read retained snapshots, authorized recovery, no shared publication |
| [`dialcache-shadow-validation.qnt`](./dialcache-shadow-validation.qnt) | Detached C0/S/C1 comparison, confirmation, clean-miss fill, diagnostic-only mismatches |
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

[`protocol-vectors.json`](./protocol-vectors.json) supplies deterministic language-neutral examples for logical/value/watermark keys, escaping and argument normalization, version-1 Redis frame bytes, timestamp/fence boundaries, and tracked decoder classification. `test/formal-protocol-vectors.test.ts` applies those vectors to the public TypeScript key/protocol exports.

Ports should consume the same JSON. The vectors are examples of the protocol in [`docs/redis.md`](../docs/redis.md), not an exhaustive enumeration of its inputs. Compression has no canonical compressed-byte vectors: valid zstd encoders can produce different bytes. Envelope/marker compatibility and compression error/resource cases remain implementation-test coverage, with portable vectors still to be added.

## Running and reproducing checks

Use a supported Node.js version, install repository dependencies with `corepack pnpm install --frozen-lockfile`, and install the CI-pinned Quint version:

```sh
npm install --global @informalsystems/quint@0.32.0
bash formal/check.sh
bash formal/generate-traces.sh
DIALCACHE_MBT_TRACE_DIR=.formal-traces/conformance \
  corepack pnpm exec vitest run test/formal-conformance.test.ts --coverage.enabled=false
```

`check.sh` typechecks all seven verification models plus the conformance model and checks their listed invariants using the Rust simulator: **2,000 sampled traces per model, up to 40 transitions per trace**, seed `0xd1a1ca`, one evaluator thread. It also executes six deterministic stale-recovery/deadline regression scenarios. This is bounded sampling, not exhaustive mathematical proof.

`generate-traces.sh` uses the same pinned version/backend/seed with one thread, samples 256 executions, and exports 32 traces of up to 30 transitions from `dialcache-conformance.qnt`. This follows [Quint's model-based testing interface](https://quint.sh/docs/model-based-testing). All 32 are replayed against real TypeScript DialCache. The core model is separate from the seven verification models because replayable public operations and reasoning-oriented transitions serve different purposes.

Both scripts accept `QUINT_SEED` for exploratory runs. The generated directory is replaced on each generation. CI runs on every PR and main push, including implementation-only changes, and uploads `.formal-traces/` as the `formal-traces` artifact for 14 days even after failure. `verification/` contains model samples or counterexamples; `conformance/` contains traces accepted by the implementation driver.

A replay failure prints the trace path, step, action, expected model observation, actual implementation observation, and a reproduction command. After downloading a failing artifact, replay just the relevant conformance file:

```sh
DIALCACHE_MBT_TRACE_FILE=.formal-traces/conformance/trace_0.itf.json \
  corepack pnpm exec vitest run test/formal-conformance.test.ts --coverage.enabled=false
```

Without these environment variables, ordinary TypeScript tests replay the committed [`conformance-smoke.itf.json`](./conformance-smoke.itf.json) through the same parser, with no Quint installation. They also exercise malformed-trace rejection and prove the harness detects lost local caching, coalescing, Redis writes, and invalidation. Protocol-vector tests run in ordinary CI too.

Model-checker exploration is separate from CI's sampled runs. For example, `quint verify` supports a TLC backend; any reported result must include the backend/version, model bounds, assumptions, and invariant. No exhaustive result is claimed here.

## Maintenance

A model is not authoritative merely because it is formal. Resolve disagreements against the intended contract, existing focused tests, and implementation. Update the affected model, ordinary tests, portable traces/vectors, and documentation together. Keep the driver independent: expected model state belongs in assertions, never in the code that executes the implementation or records its observations.

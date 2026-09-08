# Formal specifications

This directory contains executable models of DialCache behavior plus portable interoperability vectors. The goal is to make the protocol reviewable independently of the TypeScript implementation and reusable as a conformance oracle for ports in other languages.

The suite is deliberately decomposed by behavioral boundary rather than mirroring `src/` line-for-line. Smaller models keep state spaces understandable and allow a port to claim conformance feature-by-feature.

## Model suite

| Model | Contract |
| --- | --- |
| [`dialcache-core.qnt`](./dialcache-core.qnt) | Enabled scopes, request/process/remote traversal, fail-open behavior, and publication boundaries |
| [`dialcache-runtime-policy.qnt`](./dialcache-runtime-policy.qnt) | Baseline/runtime/library precedence, sparse overlays, per-invocation snapshots, and existing-entry policy stability |
| [`dialcache-coalescing-liveness.qnt`](./dialcache-coalescing-liveness.qnt) | Flight admission, follower sharing, fallback deadlines, timeout cleanup, and late source completion |
| [`dialcache-tracked-invalidation.qnt`](./dialcache-tracked-invalidation.qnt) | Atomic tracked snapshots, monotonic watermarks, delayed stale writes, and conditional refills |
| [`dialcache-stale-recovery.qnt`](./dialcache-stale-recovery.qnt) | Fresh/stale age boundaries, one-read retained snapshots, classifier authorization, and no-publication recovery |
| [`dialcache-shadow-validation.qnt`](./dialcache-shadow-validation.qnt) | Detached C0/S/C1 validation, confirmation, clean-miss fill, fencing, and diagnostic-only mismatches |
| [`dialcache-redis-protocol.qnt`](./dialcache-redis-protocol.qnt) | Redis frame/watermark validation and classification order |

[`TEST-MAP.md`](./TEST-MAP.md) maps every model to the existing Vitest/integration coverage used as implementation evidence.

## Portable protocol vectors

[`protocol-vectors.json`](./protocol-vectors.json) covers deterministic cross-language contracts that are better compared byte-for-byte than explored as state machines:

- logical/value/watermark key construction;
- component escaping and normalized argument ordering;
- version-1 Redis frame bytes;
- tracked frame decoding and strict watermark fencing; and
- validation-order cases where a fence/malformed watermark intentionally hides an unsupported payload encoding.

`test/formal-protocol-vectors.test.ts` runs the vectors against the current TypeScript implementation. A future Go/Rust/Python implementation should consume the same JSON rather than copy TypeScript expectations into a language-specific fixture.

Compression is intentionally not given canonical compressed-byte vectors: valid zstd encoders need not emit identical compressed bytes. Cross-language compression conformance should instead assert envelope tags, round-trip payloads, marker escaping, thresholds, output limits, and only-when-smaller behavior.

## What is modeled vs assumed

The formal models describe DialCache decisions and observable effects. They do **not** pretend to prove behavior owned by dependencies or the deployment environment.

Examples of explicit assumptions/boundaries:

- application wall clocks supply Redis frame and invalidation timestamps;
- monotonic time supplies operation deadlines and local TTL age;
- the invalidation future buffer must bound delayed stale work plus writer-clock lead;
- Redis must preserve watermark correctness state when the application relies on invalidation fencing;
- serializer/client operations need their own finite resource budgets where DialCache does not own a deadline;
- timeout does not generally cancel underlying I/O or source side effects; and
- shadow mismatch is evidence, not an atomic cross-system snapshot or repair primitive.

These assumptions are part of the protocol contract. Removing one usually requires changing the algorithm, not strengthening an invariant.

## Important non-guarantees encoded by the models

The suite intentionally permits behavior that would be incorrect to forbid:

- invalidation does not revoke a tracked snapshot already acquired by a caller;
- an after-invalidation caller can join a pre-invalidation flight when coalescing is enabled;
- a timed-out source can keep running after the DialCache flight has rejected;
- policy changes do not mutate already-admitted flights or existing entry TTLs;
- stale recovery can return bytes retained before a later invalidation/deletion/refresh;
- a clean shadow fill is not compare-and-set and can race another writer; and
- a confirmed shadow mismatch can become stale immediately after confirmation.

Formalizing these race boundaries is as important as formalizing the guarantees.

## Running the suite

The repository pins Quint `0.32.0` in `.github/workflows/formal.yaml`.

Install the same version locally:

```sh
npm install --global @informalsystems/quint@0.32.0
```

Then run the checked simulator/typechecker suite:

```sh
bash formal/check.sh
```

`formal/check.sh` typechecks every model and runs bounded randomized execution with all declared safety invariants. CI runs the same command.

For deeper checking, run an individual invariant through a model-checker backend, recording the Quint version, backend, model bounds, and any parameter choices with the result. For example:

```sh
quint verify formal/dialcache-tracked-invalidation.qnt \
  --backend=tlc \
  --invariant=staleValueAfterInvalidationIsFenced
```

A successful bounded run is evidence for that model and bound; it is not an unqualified proof about arbitrary production deployments.

## Conformance architecture

The intended end state is:

```text
                  DialCache behavioral contract
                   /                       \
             Quint models             protocol-vectors.json
                  |                          |
           generated traces             exact vectors
                  |                          |
        +---------+---------+       +--------+--------+
        |         |         |       |        |        |
       TS        Go       Rust     TS       Go      Rust
        |         |         |       |        |        |
        +---------+---------+-------+--------+--------+
                          |
                  conformance result
```

The next engineering step is an implementation driver that maps model actions to controllable operations (clock movement, loader settlement, Redis observations, invalidation, timeout delivery) and compares implementation events to allowed model outcomes. That driver should control **operation execution** separately from Promise completion so it can reproduce Redis-write/read races rather than merely reorder callbacks.

## Maintenance rule

A formal model is not authoritative merely because it is formal. When implementation, documentation, and a model disagree, determine the intended contract and update all relevant representations together:

1. user/maintainer documentation;
2. focused implementation or conformance tests;
3. portable vectors when exact data transforms changed; and
4. the relevant Quint model/invariants.

Avoid translating implementation control flow mechanically into Quint. The value of the suite is having an independent, smaller statement of allowed behavior.
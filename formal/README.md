# Formal specifications

This directory contains executable models of DialCache behavior. The goal is to make subtle protocol contracts reviewable independently of the TypeScript implementation and, eventually, reusable as a conformance oracle for ports in other languages.

The specifications are intentionally decomposed by behavior. They are not generated from `src/`, and they should not mirror implementation structure line-for-line.

## Tracked invalidation model

[`dialcache-tracked-invalidation.qnt`](./dialcache-tracked-invalidation.qnt) is the first model. It covers:

- one invalidation entity and one tracked Redis value;
- atomic value/watermark snapshots;
- the strict `createdAtMs > watermarkMs` acceptance rule;
- monotonic invalidation watermarks;
- a source load that starts before mutation and writes after invalidation;
- the documented `futureBufferMs >= Dmax + writer clock lead` assumption;
- conditional refill decisions based on the watermark observed by the original tracked read; and
- the fact that invalidation does not revoke a snapshot already acquired by a caller.

It deliberately does **not** model local caches, request scopes, coalescing, stale-on-error, shadow validation, serialization/compression, Redis failures/retries, or TTL expiry yet.

The model uses tiny integer time bounds because the interesting behavior is ordering and timestamp inequalities rather than production millisecond magnitudes.

### Invariants

The first model defines three invariants:

- `servedSnapshotClearedObservedFence`: every served tracked snapshot cleared the watermark observed in the same atomic read. It intentionally compares against the observed watermark, not the current one.
- `staleValueAfterInvalidationIsFenced`: under the documented delay/clock assumption, a stale pre-mutation value written after invalidation remains at or below the watermark.
- `acquiredAfterInvalidationDoesNotServeStale`: a read whose snapshot reflects the current invalidation cannot serve an older source version. A snapshot acquired before invalidation is allowed to finish afterwards.

These are model properties, not stronger guarantees than DialCache documents.

## Running the model

Install Quint:

```sh
npm install -g @informalsystems/quint
```

Typecheck first:

```sh
quint typecheck formal/dialcache-tracked-invalidation.qnt
```

Then exercise the model with random simulation:

```sh
quint run formal/dialcache-tracked-invalidation.qnt \
  --invariants servedSnapshotClearedObservedFence staleValueAfterInvalidationIsFenced acquiredAfterInvalidationDoesNotServeStale
```

For exhaustive/symbolic checking, use `quint verify` with the same invariants and an explicit backend/bound appropriate for the model. Record the Quint version, backend, and bounds when claiming a property has been verified.

## Intended next slices

Likely follow-up models are:

1. coalescing and fallback deadlines, including late loader completion;
2. stale-on-error snapshot retention and recovery-age checks;
3. local/request reuse boundaries around invalidation;
4. shadow reads/fills; and
5. a language-neutral trace format and implementation driver for model-based conformance testing.

The long-term target is a versioned behavioral contract plus portable test scenarios that TypeScript and future language implementations can run against.

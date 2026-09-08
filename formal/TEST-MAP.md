# Formal contract ↔ implementation test map

The formal suite is intentionally independent from the TypeScript implementation, but it should not invent behavior. Existing implementation tests are treated as executable evidence for the intended contract.

This file maps each formal slice to the existing tests that most directly exercise it. When behavior changes, update the implementation tests and the relevant model in the same change.

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

Core contract: runtime/default/library precedence and immutable per-invocation snapshots.

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

Core contract: flight admission, follower inheritance, fallback deadline ownership, and late-result suppression.

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

These are data-transform contracts rather than concurrency protocols: compression threshold, marker escaping, zstd envelope tags, only-when-smaller writes, read compatibility when new-write compression is disabled, 512 MiB output ceiling, and fail-open compression errors. A future vector schema can add canonical envelope examples without coupling ports to a particular zstd implementation's compressed byte output.

### Observability

Metrics/logging tests (`dialcache-metrics.test.ts`, `datadog.test.ts`, `prometheus.test.ts`, `shadow-log-json.test.ts`) define telemetry compatibility. Telemetry does not gate core cache/recovery behavior except where the shadow outcome hook is deliberately an admission requirement. It is therefore kept out of the primary safety models.

## Review rule

A model is not authoritative merely because it is formal. When a model disagrees with a focused implementation test or the documented contract, first determine which behavior is intended. Then update all three together:

1. human-facing docs;
2. focused implementation/conformance tests; and
3. the relevant Quint model/invariant.

This prevents the formal suite from becoming a second implementation that silently drifts from DialCache.
# Models

Every Quint source: the models the scheduler runs, the shared helpers they
import, the kernel library under [kernel/](./kernel/README.md) and its fixtures
under [fixtures/kernel/](./fixtures/kernel/). File names carry the kind; this
index groups them. Each model's schedule, bounds and properties are in
[../catalogs/execution.json](../catalogs/execution.json), and the profile
registry is [../catalogs/profiles.json](../catalogs/profiles.json). Read
[cache-rules.qnt](./cache-rules.qnt) first, then a verification model, then the
profile for the behavior you care about;
[../guides/WALKTHROUGH.md](../guides/WALKTHROUGH.md) follows one rule through.

## Shared helpers

- [cache-rules.qnt](./cache-rules.qnt): the canonical age, expiry, deadline and fence judgments every model imports.
- [cache-contract.qnt](./cache-contract.qnt): acquired recovery snapshots and source executions the connection models check against.
- [cohort-boundaries.qnt](./cohort-boundaries.qnt): the rollout cohort admission boundary over uint32 numerators.
- [conformance-observations.qnt](./conformance-observations.qnt): the caller outcome codes and the observation record the drivers compare.
- [wire-text.qnt](./wire-text.qnt): the UTF-16 to UTF-8 writer and the UTF-8 reader the wire models use.

## Verification models (sum-typed, model-checked)

- [dialcache-core.qnt](./dialcache-core.qnt): one-key traversal and publication; scopes, layer precedence, pass-through, local faults.
- [dialcache-runtime-policy.qnt](./dialcache-runtime-policy.qnt): sparse runtime overlays and captured policy.
- [dialcache-tracked-invalidation.qnt](./dialcache-tracked-invalidation.qnt): atomic tracked reads, watermarks and delayed writes.
- [dialcache-stale-recovery.qnt](./dialcache-stale-recovery.qnt): retained bytes, age checks and recovery authority.
- [dialcache-redis-protocol.qnt](./dialcache-redis-protocol.qnt): frame and fence validation order.
- [dialcache-rule-checks.qnt](./dialcache-rule-checks.qnt): finite symbolic boundary checks of the shared judgments; the Apalache target.

## Conformance profiles (replayed by every port)

- [dialcache-conformance.qnt](./dialcache-conformance.qnt): core, the introductory profile, not composed from the kernel.
- [dialcache-effects-conformance.qnt](./dialcache-effects-conformance.qnt): effects; held reads, sources and serialization, deadlines, refill authority, metric events.
- [dialcache-scope-conformance.qnt](./dialcache-scope-conformance.qnt): scope; nested enablement, request memoization, shared work and scope closure.
- [dialcache-recovery-conformance.qnt](./dialcache-recovery-conformance.qnt): recovery; retained stale bytes, classifier policy, age checks, request-only publication.
- [dialcache-policy-conformance.qnt](./dialcache-policy-conformance.qnt): policy; runtime overlays, captured policy, lifetimes, capacity and coalescing changes.
- [dialcache-shadow-conformance.qnt](./dialcache-shadow-conformance.qnt): shadow; dark reads, comparison, confirmation, conditional fills, diagnostics.
- [dialcache-admission-conformance.qnt](./dialcache-admission-conformance.qnt): admission; served-hit shadow admission, deduplication, deadlines, capacity.
- [dialcache-layers-conformance.qnt](./dialcache-layers-conformance.qnt): layers; request, local and remote composition, isolation, publication, invalidation.
- [dialcache-independent-conformance.qnt](./dialcache-independent-conformance.qnt): independent; uncoalesced callers with their own budgets and snapshots.
- [dialcache-recovery-read-conformance.qnt](./dialcache-recovery-read-conformance.qnt): recovery-read; held reads and decodes, compression, marker lifetime.
- [dialcache-local-failure-conformance.qnt](./dialcache-local-failure-conformance.qnt): local-failure; local storage faults and preserved source outcomes.
- [dialcache-runtime-boundaries-conformance.qnt](./dialcache-runtime-boundaries-conformance.qnt): runtime-boundaries; omitted and invalid policy leaves, defaults, exact cohorts.
- [dialcache-shadow-layers-conformance.qnt](./dialcache-shadow-layers-conformance.qnt): shadow-layers; dark fills with local and request reuse, mixed capacity.
- [dialcache-local-clock-conformance.qnt](./dialcache-local-clock-conformance.qnt): local-clock; fractional time on the whole-millisecond expiry grid.
- [dialcache-source-budgets-conformance.qnt](./dialcache-source-budgets-conformance.qnt): source-budgets; default, unbounded and finite source deadlines, held policy.
- [dialcache-dark-layers-conformance.qnt](./dialcache-dark-layers-conformance.qnt): dark-layers; held dark work across request and local reuse, fences, clock rollback.
- [dialcache-shadow-read-deadlines-conformance.qnt](./dialcache-shadow-read-deadlines-conformance.qnt): shadow-read-deadlines; separate C0 and C1 read deadlines, raw capacity ownership.

## Connection models (a profile's history against the contract)

- [dialcache-source-connection.qnt](./dialcache-source-connection.qnt): source-budgets; captured source origin, budget and follower ownership.
- [dialcache-recovery-connection.qnt](./dialcache-recovery-connection.qnt): recovery; the retained flight snapshot and recovery.
- [dialcache-recovery-read-connection.qnt](./dialcache-recovery-read-connection.qnt): recovery-read; acquired payload and recovery return.
- [dialcache-independent-connection.qnt](./dialcache-independent-connection.qnt): independent; per-caller snapshots and source deadlines.
- [dialcache-shadow-layers-connection.qnt](./dialcache-shadow-layers-connection.qnt): shadow-layers; the admission facts read from the pre-state.

## Wire models (each generates one file under ../generated/)

- [dialcache-key-protocol.qnt](./dialcache-key-protocol.qnt): key construction and normalization; `quint-key-vectors.json`.
- [dialcache-frame-vectors.qnt](./dialcache-frame-vectors.qnt): frame encoding, fence and age validation; `quint-frame-vectors.json`.
- [dialcache-envelope-vectors.qnt](./dialcache-envelope-vectors.qnt): envelope selection and the codec environment; `quint-envelope-vectors.json`.
- [dialcache-invalidation-transition.qnt](./dialcache-invalidation-transition.qnt): the invalidation script's watermark transitions; `quint-invalidation-vectors.json`.

## Kernel library and fixtures

- [kernel/](./kernel/README.md): the 29 concern modules every composed profile assigns state through; its README has the module table and composition rules.
- [fixtures/kernel/](./fixtures/kernel/): 16 small profiles that exercise kernel seams no scheduled profile reaches; `make kernel-fixtures` runs them.

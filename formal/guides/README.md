# Guides

Prose a person reads, grouped by the review kind the source-audit ledger
assigns each page. The task table in [../README.md](../README.md) is the
by-task view; this index is the by-kind view it lacks. Read
[WALKTHROUGH.md](./WALKTHROUGH.md) first as a contributor and
[SPEC.md](./SPEC.md) first as a porter.

## Contract guides: what a port must preserve

- [SPEC.md](./SPEC.md): the behavioral specification; definition ownership, the meaning of conformance, state and inputs, traversal, remote acquisition, time, recovery and shadow races, assumptions and claims.
- [CONTRACTS.md](./CONTRACTS.md): the portable obligation inventory (C, W, E and B identifiers) with the executable evidence for each.
- [PROTOCOL.md](./PROTOCOL.md): keys, frames, envelopes and invalidation on the wire; which vectors are generated and which are fixed.
- [CONFORMANCE.md](./CONFORMANCE.md): the introductory core profile; trace format, trust boundary, actions and compared observations.
- [BEHAVIOR.md](./BEHAVIOR.md): the fixed behavioral scenarios and the generated feature profiles' driver mappings.

## Tooling guides: how to do the work

- [WALKTHROUGH.md](./WALKTHROUGH.md): one rule followed from a named Quint regression into every port.
- [AUTHORING.md](./AUTHORING.md): reading and extending the models; the composition lint, challenges, native mutants and exported regressions.
- [PORTING.md](./PORTING.md): what a new language port supplies; driver, transport, observation contract and completion gates.
- [VALIDATION.md](./VALIDATION.md): choosing a run, reading a completion report, mutation evidence and exploratory runs.
- [GO-PARITY.md](./GO-PARITY.md): the Go parity acceptance ledger and how to update it.

## Coverage guides: what the evidence establishes

- [SEMANTIC-COVERAGE.md](./SEMANTIC-COVERAGE.md): the evidence inventory, model assurance and the mutation comparison.
- [FEATURE-COVERAGE.md](./FEATURE-COVERAGE.md): the feature map of behavioral corners and how a corner earns evidence.
- [TEST-MAP.md](./TEST-MAP.md): the map from contracts to implementation evidence.
- [TEST-AUDIT.md](./TEST-AUDIT.md): keeping the docs and test audit ledger current.

Every page here, this index, [../README.md](../README.md) and the Go README
are in the reviewed-guide ledger, [../catalogs/source-audit.json](../catalogs/source-audit.json):
a text edit is followed by a ledger refresh, as [TEST-AUDIT.md](./TEST-AUDIT.md) describes.

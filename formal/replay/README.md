# Replay

The shared replay boundary every port executes: the coordinator hands a driver
fixtures and external commands, never its predictions; the driver reports
observations; the coordinator asserts them. A new port plugs in here;
[../guides/PORTING.md](../guides/PORTING.md) is the contract and
[protocol.schema.json](./protocol.schema.json) types every message. Nothing in
this directory names a TypeScript, Go, Rust or Python file.

## Coordinator

- [coordinator.mjs](./coordinator.mjs): runs one history against a driver over the wire protocol and asserts each step.
- [bindings.mjs](./bindings.mjs): binds a generated history to the driver contract at export time.
- [settlement.mjs](./settlement.mjs): the settlement contract a driver must honor between commands, made checkable.
- [validation.mjs](./validation.mjs), [schema.mjs](./schema.mjs): observation validation and the small JSON Schema validator behind it.
- [divergence.mjs](./divergence.mjs): which observation fields differ, for boundary evidence and reports.
- [itf.mjs](./itf.mjs), [observation.mjs](./observation.mjs), [sources.mjs](./sources.mjs), [cohort-inputs.mjs](./cohort-inputs.mjs): trace parsing, the observation record, the shared source registry and the cohort numerator binding.

## Profile descriptors (how each profile's inputs decode into driver commands)

- [core.mjs](./core.mjs), [effects.mjs](./effects.mjs), [features.mjs](./features.mjs), [local-clock.mjs](./local-clock.mjs): the core, effects, generated-feature and local-clock descriptors.
- [profiles/](./profiles/): one module per composed profile with its own fixture and commands (dark-layers, local-failure, recovery-read, runtime-boundaries, shadow-layers, shadow-read-deadlines, source-budgets).

## Witness classifiers (which boundaries a history reached)

- [witnesses/index.mjs](./witnesses/index.mjs), [witnesses/evidence.mjs](./witnesses/evidence.mjs), [witnesses/recorder.mjs](./witnesses/recorder.mjs), [witnesses/fidelity.mjs](./witnesses/fidelity.mjs), [witnesses/labels.mjs](./witnesses/labels.mjs), [witnesses/trace.mjs](./witnesses/trace.mjs), [witnesses/public-prefix.mjs](./witnesses/public-prefix.mjs): the registry, the evidence writer, per-label provenance, the fidelity scaffold and shared helpers.
- One classifier per profile beside them (`witnesses/<profile>.mjs`), reading recorded inputs and public observations only.

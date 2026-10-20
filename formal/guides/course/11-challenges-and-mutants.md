# 11. Challenges and native mutants (10 min)

**What you get:** proof that the checks can fail: a deliberate fault in the
model that a named invariant must catch, and the same fault in each port that
the corpus must catch.

## The idea

Lesson 10 asked whether the corpus reached the corners; this lesson asks
whether the checks would notice a bug there. A green check proves little
unless you know it would turn red for the bug it guards against. The tree
makes that a measured fact at two levels: the model and the ports.

**Level one: the model.** A
[challenge](../GLOSSARY.md#challenge-fault-mutant-and-reproducer) is one
deliberate single-site edit of a Quint source: an exact `before` text that
occurs once, and its `after`. The catalog is the `challenges` array of
[execution.json](../../catalogs/execution.json). Each entry names the model
and the scheduled invariant that must detect the edit. The edited model is
the mutant, in the sense of
[mutation testing](https://en.wikipedia.org/wiki/Mutation_testing): a
deliberate fault the tests must catch.

A reproducer pins the detection to one deterministic run. The run passes on
the clean model and fails under the fault at a declared `.expect`. The checker
also cuts the run immediately before, and through, that checkpoint. So the
fault must break exactly the stated expectation, and not some earlier step.

The example this course follows has a challenge. In `deadlines.qnt`, the
registration `at: state.now + budget` is edited to `at: budget`: a deadline
anchored at the clock origin instead of the source's start. The connection
model's `sourceOriginsMatchContract` detects it. The reproducer is
`heldPolicyDoesNotSpendSourceBudgetTest`, which fails at its final checkpoint.
Under the fault the deadline is already past when the source starts after the
100 ms policy wait, so the source expires at the next advance instead of
settling with `VALUE_ONE`.

**Level two: the ports.** A model challenge says nothing about the ports until
the same wrong behavior is injected into them. That is the
[native mutant](../GLOSSARY.md#native-mutant).
[mutations.json](../../catalogs/mutations.json) holds one entry per fault:
anchored `before`/`after` edits to `typescript/src/` and `go/` (Rust has its
own catalog), a rationale naming the lines, and the `requiredDetections` each
test cohort must record. Each challenge carries a `nativeMutants` entry that
maps it to such a mutant, or explains why no port line exists
(`unobservable`, `model-only`).

The deadline challenge maps to `M33`. TypeScript judges a settlement with
`performance.now() >= timeoutMs` instead of the time elapsed since the source
started; Go drops `- started` from the same comparison.

The mutation lanes apply each mutant in an isolated copy, run the generated
corpus against it, and require the replay to fail. They are
`make mutations-ts`, `make mutations-go` and `make mutations-rust`. The first
two need Docker for the real-Redis vectors, which run the invalidation script
as [Redis Lua](https://redis.io/docs/latest/develop/programmability/eval-intro/);
the Rust lane does not. A mutant that survives is a coverage gap, not a
license. The corpus does not distinguish that fault, so the fix is an exported
regression or a witness that does. Until then the challenge does not count as
mapped.

For a fault in a shared library, every profile that imports the source must
either detect it or appear in `exclusions` with a reason. The checker measures
each reaching [exclusion](../GLOSSARY.md#exclusion-structural-versus-measured)
by requiring the profile's runs to keep passing under the mutant. Profiles
that do not import the source are excluded structurally, with no catalog
entry.

## See it in the repo

- **[../../generated/CHALLENGES.md](../../generated/CHALLENGES.md)** and
  **[../../generated/MUTANTS.md](../../generated/MUTANTS.md)**: one row per
  challenge and per mutant, generated from the catalogs. Find
  `profile-source-wrong-clock` and `M33`.
- **[execution.json](../../catalogs/execution.json)**, `challenges`: the first
  entry, `recovery-inclusive-maximum`, shows every field: `source`, `model`,
  `invariant`, `before`, `after`, `nativeMutants`, and `reproducer` with its
  `profiles` and `exclusions`.
- **[../AUTHORING.md](../AUTHORING.md#challenging-every-model)**, "Challenging
  every model", and "[Mapping every challenge to native
  mutants](../AUTHORING.md#mapping-every-challenge-to-native-mutants)": the
  rules for writing one, and the three `nativeMutants` kinds.
- **[../VALIDATION.md](../VALIDATION.md#mutation-evidence)**, "Mutation
  evidence": `confirmed`, `side-effect-only`, `not-divergent`, `unreached`,
  and why a crash or timeout is a failed measurement, never a detection.
- **[check-model-properties.mjs](../../tools/check-model-properties.mjs)**,
  lines 25 to 32: what the clean model and the mutant must each report about a
  `reproducer`.

## Try it (3 min, plus an optional 3.5 min)

1. Print the challenge in full:

   ```sh
   node formal/tools/where.mjs profile-source-wrong-clock
   ```

   You should see the `Edit` (`at: state.now + budget` becomes `at: budget`),
   `Native mutant: mapped M33`, the `Reproducer` run and its expected failure
   `s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1`, then
   `Detected by 9 profiles and 1 model` and one excluded profile, `scope`,
   with its reason.

2. Print the mutant it maps to:

   ```sh
   node formal/tools/where.mjs M33 | head -24
   ```

   You should see the rationale and the TypeScript `before`/`after` in
   `typescript/src/internal/deadline.ts`, with `generated, portable` as the
   required detections.

3. Optional (about 3.5 min, Quint): measure this one challenge. The partition
   step takes most of the time: it re-runs the nine detecting profiles and
   the excluded one under the mutant. Nothing prints until each step ends:

   ```sh
   node formal/tools/check-model-properties.mjs --only=profile-source-wrong-clock
   ```

   You should see `baseline: ... run ok`, `mutant: ... run violation after 6 states`,
   `mutant: reproducer heldPolicyDoesNotSpendSourceBudgetTest failed (QNT508 at the declared checkpoint)`
   and `partition: structural=7, holds=1, detects=9`. A filtered run is a
   local aid; only the complete catalog run is evidence.

## Recap

- **A challenge is a deliberate single-site fault** a named invariant must
  catch, pinned by a reproducer that fails at exactly the declared checkpoint.
- **A native mutant injects the same fault into each port;** the generated
  corpus must catch it there too, or the mapping does not count.
- **A surviving mutant is a coverage gap:** add the regression or witness that
  distinguishes the fault; never relax the gate.

**Next:** [12. The differential and behaviorVersion](./12-differential.md)

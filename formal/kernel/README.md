# Shared lifecycle pilot

This is the first bounded implementation slice of
[issue #165](https://github.com/lan17/DialCache/issues/165). It tests whether the
layers and effects views can share ownership, source acceptance, publication
and caller completion without changing their public replay protocol.
The existing 15 conformance profiles remain the acceptance specification.
This pilot does not migrate either full profile or close the issue.

## One lifecycle, two settlement views

[`cache-kernel.qnt`](./cache-kernel.qnt) owns the calls, registered executions,
raw sources, cache entries and transitions. [`kernel-types.qnt`](./kernel-types.qnt)
distinguishes pending results, errors, timeouts, execution phases, and raw work
that remains abandoned after its callers finish.

| View | Environment and projection |
| --- | --- |
| [`layers-pilot.qnt`](./layers-pilot.qnt) | Existing layers inputs, fixtures 0–5, two instances, four keys, request/local/remote traversal; read/decode/dump/write effects complete within the action |
| [`effects-pilot.qnt`](./effects-pilot.qnt) | Existing effects inputs, tracked/untracked fixtures 2 and 5, one identity, 10 ms read and source budgets; read/decode/dump/write completions are separate actions |

Profiles choose inputs, normalize fixtures and project the shared state into
the existing transport records. Their actions cannot assign cache state.
The kernel's `SETTLE` constant specifies which external completions are already
available; it does not change source acceptance or ownership rules. Monotonic
elapsed time controls deadlines and the independent wall clock stamps frames.

An execution completes only its owned callers. Rejection or timeout releases
its registration; a timed-out raw source may still run while another execution
starts. A timely accepted source retains its execution through serialization
and writing, even after the original source deadline passes. Publication uses
the acquired fence, and closing a scope prevents later memo publication.

[`lifecycle-witnesses.qnt`](./lifecycle-witnesses.qnt) observes public input and
result/effect histories. It cannot influence transitions or projections. Its
positive and negative monitor tests are checks of evidence classification,
not additional native behavioral coverage.

## Executable comparison

Run `make kernel-pilot` with the same Node, Go and Quint prerequisites as
`make formal`. The target is included in `make formal` and the full formal
workflow, independently of the unchanged full-profile replay lanes.

[`pilot.json`](./pilot.json) records nine input-only histories. The runner
executes each exact sequence in both the original profile and the shared
kernel view. It compares public observations at every step, then replays the
kernel-generated history through the existing TypeScript and Go drivers.
The drivers still control real external gates and observe the real libraries;
they receive no kernel state or expected result as an implementation input.

| History boundary | Views | Existing obligations |
| --- | --- | --- |
| Coalesced success and subsequent cache reuse | Layers and effects | C05, C11, C12 |
| Overlapping instances with distinct results in the success/reuse history | Layers | C11 |
| Shared failure followed by a fresh successful attempt | Layers and effects | C11, C15 |
| Timed-out raw source settles during its replacement | Effects | C25 |
| Accepted serialization and write finish after the source deadline | Effects | C26 |
| Fulfillment or rejection at the exact deadline before timer delivery | Effects | C25 |
| Future but unfenced frame rejected after wall rollback, followed by source refill | Effects | C33, C34 |

The check also requires:

- The existing parsed-IR lint to find no state assignment outside the kernel
  and no witness dependency in cache behavior or observation projection.
- Five independent properties over 2,000 sampled histories of up to 40 steps
  per view, using the pinned evaluator and seed in `execution.json`.
- Three compiling single-site kernel faults, with five named property checks
  at exact input checkpoints; each unmodified history must first pass.
- A successful native assertion report from each language for every history.
  Skips, missing results and evaluator failures cannot count as passes.

The nine fixed histories are compared and replayed; the sampled histories
provide model-only invariant evidence. Neither establishes exhaustive
equivalence between the full models. The deliberate faults measure these
properties' sensitivity to those particular changes, not all possible defects.

## Evidence and next decision

`.formal-traces/kernel-pilot/report.json` records source hashes, bounds,
per-history comparison and witness checkpoints, native reports, model faults
and original/kernel generation times. The directory retains copied Quint
sources and failing histories. A failure identifies its history, step, action
and expected/actual public observations, or the exact failing report.

`node formal/kernel-pilot.mjs generate` performs only deterministic generation,
comparison and witness checks. Its report remains incomplete. A full `check`
can become complete only if all pilot checks pass and its source inputs remain
unchanged. Every pilot report has `acceptance: false`: it cannot substitute for
the existing full conformance completion reports. Timing ratios include CLI
startup and concern only these short histories; they are not a benchmark of a
full migration.

The effects slice excludes adapter classification overrides, live read-budget
changes and observer failures. Recovery, shadow work, admission, independent
calls, local expiry/faults, runtime boundary profiles and wire contracts retain
their existing models and evidence. The pilot adds no new coverage percentage.

The next decision is whether to migrate additional layers/effects histories
through this kernel. Require exact-input comparison, consequential witnesses,
both native replays and independent property challenges before deleting an
original transition. A passing pilot alone does not justify replacing either
complete profile.

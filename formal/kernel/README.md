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

[`lifecycle-witnesses.qnt`](./lifecycle-witnesses.qnt) observes public inputs
and result/effect observations. It cannot influence transitions or projections.
The kernel records one monitor value per step, computed from the previous
monitor value and the current step alone; no input history is retained or
refolded, so witness bookkeeping no longer grows with the length of a history.
It still scales with the number of calls the view admits, which the fixture
bounds, and it is the largest remaining cost of the kernel views (below). The
monitor carries the credited label set. Four boundaries are scripted prefixes:
a fixed public input order, for one view, with the observation fields that
establish each consequence, written as data so each input sits next to what it
must produce and one rule covers all four: a history that departs from a
script's prefix can never earn its label, and no script applies to the other
view. This form costs the same as the four index predicates it replaced; it
was chosen for readability, not speed. Every credited label is retained
because each step's labels accumulate from the previous step's. The monitor's
positive and negative tests are checks of evidence classification, not
additional native behavioral coverage.

The witness-isolation lint enforces one direction: nothing reachable from a
transition, guard, choice domain or projection may read the monitor. The other
direction, that the monitor reads only public data, rests on the monitor module
importing nothing from the kernel and on the kernel handing it only the public
input and view.

## Executable comparison

Run `make kernel-pilot` with the same Node, Go and Quint prerequisites as
`make formal`. The target is included in `make formal` and the full formal
workflow, independently of the unchanged full-profile replay lanes.

[`pilot.json`](./pilot.json) records twelve input-only histories. The runner
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
| Invalidation before acquisition suppresses source publication | Layers | C33, C34 |
| Invalidation after acquisition permits publication but fences a later read | Layers | C33, C34, C36 |
| Tracked source fills Redis; the next read warms local, then local serves | Layers | C05, C31 |
| Timed-out raw source settles during its replacement | Effects | C25 |
| Accepted serialization and write finish after the source deadline | Effects | C26 |
| Fulfillment or rejection at the exact deadline before timer delivery | Effects | C25 |
| Future but unfenced frame rejected after wall rollback, followed by source refill | Effects | C33, C34 |

The check also requires:

- The existing parsed-IR lint to find no state assignment outside the kernel
  and no witness dependency in cache behavior or observation projection.
- Five properties over 2,000 sampled histories of up to 40 steps per view,
  using the pinned evaluator and seed in `execution.json`. Applicability is
  described below and recorded in the report.
- Six compiling single-site kernel faults, with nine named property checks
  at exact input checkpoints; each unmodified history must first pass. Every
  property except the closed-scope memo rule has a fault that only it detects
  at its declared step.
- A successful native assertion report from each language for every history.
  Skips, missing results and evaluator failures cannot count as passes.
- A sampling-cost bound: in the same job, the original profile and the kernel
  view each sample the original's generation bounds from `execution.json` (its
  sample count and step bound, one thread, the pinned seed, no trace output)
  with their own invariants, twice each, alternating. The kernel view's
  fastest wall time may be at most `exploration.maxRatio` in `pilot.json`
  (2.5) times the original's fastest wall time. The first hosted measurements
  were 1.1 to 1.2 for layers and 1.6 to 1.8 for effects; the bound leaves room
  for runner variance and still fails on the 4 to 7 times of the refolding
  monitor. A violation is raised only after the histories, replays and faults
  below have been recorded. The pairing compares unequal property sets: the
  originals' nine invariants each against the kernel's five, and the originals
  pay about 1.6 times as much for their properties (layers 4.6 s against
  2.8 s, effects 4.1 s against 2.6 s on the machine below), so the gated ratio
  understates a kernel view that carried the originals' properties. The report
  records each side's property cost; the without-invariants ratio (1.8 for
  layers, 3.8 for effects) is the transition-and-monitor ratio. Carrying the
  originals' properties is a #165 work item next to monitor cost and exported
  state size.
- Records, not gates, that locate the remaining cost: the same pairing without
  invariants; the kernel view with its monitor assignment replaced by
  `monitor' = monitor`, whose difference to the full view is the monitor's
  cost; and the fixed cost of a one-sample, one-step run of each model.
- The generation lane's own command for both models: `--mbt`, the original's
  trace count, ITF output to a scratch directory that is removed after
  counting. The report records each model's exit status, wall time, traces and
  bytes, and `generationParity`: whether the kernel view completed within the
  bound. This is the generation-runtime budget of #165 and it is currently
  unmet: under Node's default heap both kernel views run out of memory before
  writing a trace (see below).

The publication property checks retained source-acceptance records after
completion and requires one record per serialization effect. This includes
layers actions that finish serialization and writing before the next recorded
state. A fault that ignores an acquired fence must fail at that completed
layers state; entering publication without source acceptance must also fail.
Source ownership and fence eligibility apply in both views;
the source deadline inequality is exercised only in effects because layers
has an unbounded source budget. The closed-scope memo property is consequential
only in layers; effects has request memoization disabled.

The publication property checks eligibility against the recorded acquired
fence. It does not independently establish that fence capture itself is
correct. The two invalidation orderings additionally compare public effects
with the original model and both implementations; independent capture
challenges remain migration work.

The twelve fixed histories are compared and replayed; the sampled histories
provide model-only invariant evidence. Neither establishes exhaustive
equivalence between the full models. The deliberate faults measure these
properties' sensitivity to those particular changes, not all possible defects.

## Evidence and next decision

`.formal-traces/kernel-pilot/report.json` records source hashes, bounds,
per-history comparison and witness checkpoints, native reports, model faults,
original/kernel generation times and raw trace sizes, the sampling pairings
with every run's wall time, the fixed CLI cost and the ratios with and without
it, the frozen-monitor record, and the generation-lane measurement. Wall times
include CLI startup, about one second per run locally. On one machine at the
generation bounds, taking the faster of two runs: layers took 8.5 s in the
original against 8.6 s in the kernel view with invariants and 3.0 s against
5.5 s without; effects took 7.7 s against 12.0 s with invariants and 2.5 s
against 9.5 s without. With the refolding monitor, at 2,000 samples of 40
steps, the kernel views had taken 4 to 7 times the originals with invariants
and 9 to 13 times without. Freezing the monitor puts the kernel views at about
1.05 times the originals with invariants: nearly all of the remaining
difference is the monitor's per-step bookkeeping, about 13 to 17 microseconds
per step, not the kernel's state. Making the monitor cheaper is the next parity
work item.

The generation lane writes 512 traces per profile with `--mbt`. The originals
complete that command in 11 s (effects, 108 MB of traces) and 14 s (layers,
168 MB) with a peak of about 3 GB of memory. Both kernel views exhaust Node's
default heap before writing a trace; given a 12 GB heap the effects kernel view
completes in 25 s with 297 MB of traces and a 7 GB peak, 2.3 times the
original's wall time and 2.5 times its memory. The exported state is the
cause: per state the kernel's `s` is 61 to 83 percent of the bytes, the
effects view's projection up to 29 percent and the monitor about 10 percent.
Until that state shrinks or the lane's configuration for kernel-based profiles
changes, the kernel cannot generate the corpus as configured, and no migration
under #165 should proceed on the sampling bound alone. The directory retains
copied Quint sources and failing histories. A failure identifies its history,
step, action and expected/actual public observations, or the exact failing
report.

`node formal/kernel-pilot.mjs generate` performs only deterministic generation,
comparison and witness checks. Its report remains incomplete. A full `check`
can become complete only if all pilot checks pass and its source inputs remain
unchanged. Every pilot report has `acceptance: false`: it cannot substitute for
the existing full conformance completion reports. Per-history ratios and
trace sizes concern short deterministic histories and are informational. The
gated ratio bounds sampling cost at the original's generation bounds; it
detects a regression in the kernel's evaluation cost and is not the generation
budget, which the recorded generation-lane measurement carries.

The effects slice excludes adapter classification overrides, live read-budget
changes and observer failures. Recovery, shadow work, admission, independent
calls, local expiry/faults, runtime boundary profiles and wire contracts retain
their existing models and evidence. The pilot adds no new coverage percentage.

The next decision is whether to migrate additional layers/effects histories
through this kernel. Require exact-input comparison, consequential witnesses,
both native replays and independent property challenges before deleting an
original transition. A passing pilot alone does not justify replacing either
complete profile.

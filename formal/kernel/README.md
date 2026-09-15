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
kernel hands the monitor the public input, the public view, and two fixture
constants: whether effects are held and the source budget. The monitor carries
the credited label set. Four boundaries are scripted prefixes:
a fixed public input order, for one view, with the observation fields that
establish each consequence, written as data so each input sits next to what it
must produce and one rule covers all four: a history that departs from a
script's prefix can never earn its label, and no script applies to the other
view. The pilot does not measure the scripts' share of the monitor's cost
separately; the frozen-monitor record below bounds the monitor as a whole. The
form was chosen for readability, not speed. Every credited label is retained
because each step's labels accumulate from the previous step's. The monitor's
positive and negative tests are checks of evidence classification, not
additional native behavioral coverage.

The witness-isolation lint enforces one direction: nothing reachable from a
transition, guard, choice domain or projection may read the monitor. The other
direction, that the monitor reads only public data, rests on the monitor module
importing nothing from the kernel and on the kernel handing it only the public
input, the public view and the two fixture constants named above.

## Executable comparison

Run `make kernel-pilot` with the same Node, Go and Quint prerequisites as
`make formal`. The target is included in `make formal` and the full formal
workflow, independently of the unchanged full-profile replay lanes. Its
generation-lane measurement deliberately runs each kernel view until Node's
default heap is exhausted, twice per check, a few gigabytes each time.

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
| Tracked source fills Redis; the next read warms local, then local serves; the history continues one call past that boundary | Layers | C05, C31 |
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
  property except the closed-scope memo rule has a fault it detects at its
  declared step; whether the other properties would also detect it is not
  checked.
- A successful native assertion report from each language for every history.
  Skips, missing results and evaluator failures cannot count as passes.
- A sampling-cost bound: in the same job, the original profile and the kernel
  view each sample the original's generation bounds from `execution.json` (its
  sample count and step bound, one thread, the pinned seed, no trace output)
  with their own invariants, twice each, alternating with the frozen-monitor
  copy below. The kernel view's fastest wall time may be at most
  `exploration.maxRatio` in `pilot.json`
  (2.5) times the original's fastest wall time. The first hosted measurements
  were 1.1 to 1.2 for layers and 1.6 to 1.8 for effects; the bound leaves room
  for runner variance and still fails on the 4 to 7 times of the refolding
  monitor. A violation is raised only after the histories, replays and faults
  below have been recorded. The pairing compares unequal property sets: the
  originals' nine invariants each against the kernel's five, and the originals
  pay about 1.7 times as much for their properties (layers 4.8 s against
  2.9 s, effects 4.2 s against 2.4 s in the recorded check below), so the gated
  ratio
  understates a kernel view that carried the originals' properties. The report
  records each side's property cost; the without-invariants ratio (1.9 for
  layers, 3.5 for effects) is the transition-and-monitor ratio. Carrying the
  originals' properties is a #165 work item next to monitor cost and exported
  state size, and which pairing the #165 budget eventually gates (this one, or
  the plain or frozen pairing once monitor cost is addressed) is an open
  decision recorded there.
- Records, not gates, that locate the remaining cost: the same pairing without
  invariants; the kernel view with its monitor assignment replaced by
  `monitor' = monitor`, which skips the kernel's witness observation
  (`publicView`) and `Witness::advance` and nothing else, so its difference to
  the full view is that cost; and the fixed cost of a one-sample, one-step run
  of each model. The cost measurements run after the histories, replays and
  faults, so a job killed mid-measurement still carries the correctness record.
- The generation lane's own command for both models, built by the same
  function the lane uses (`generationArguments` in `run-models.mjs`): `--mbt`,
  the original's trace count, ITF output to a scratch directory that is removed
  after counting. The bounds are the pilot's own; the lane has no per-command
  ceiling, only its job timeout. The original's attempt gets 600 s; the kernel
  view's timeout is four times the original's wall time, at least 150 s so the
  observed heap-exhaustion abort stays visible in the record, and at most
  600 s. The report records each model's outcome (completed, violation,
  aborted, failed, or not attempted when the original failed), exit status,
  signal, timeout, wall time, traces and bytes, and `generationParity`: the
  kernel view completed under the lane's own Node heap within
  `generation.maxRatio` in `pilot.json` (2.5) times the original in both wall
  time and trace bytes. Trace size is part of parity on purpose: raw trace
  bytes are the proxy for generation memory and time (the replay lanes read
  projected traces, which drop the kernel state); the only completed kernel
  generation on record, with a 12 GB heap, was 2.3 times the original's time
  and 2.75 times its bytes. Peak memory is not measured; completion under the
  default heap stands in for it, and the record notes the Node version, heap
  limit and options that the attempts ran under, probed from the same `node`
  the quint shim resolves, so a flip can be told apart from a runner or Node
  change. This is the generation-runtime budget of
  #165 and it is currently unmet: under the default heap both kernel views run
  out of memory before writing a trace (see below). A property violation on
  either side, or an original that cannot complete its own command, fails the
  check after the correctness evidence; any other failure of these cost
  measurements is recorded the same way and raised at the end.

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
include CLI startup, about one second per run locally. One recorded local
check, at the generation bounds, taking the faster of two runs: layers took
7.5 s in the original with its nine invariants against 7.9 s in the kernel view
with its five, and 2.7 s against 5.0 s without invariants; effects took 6.6 s
against 10.7 s with invariants and 2.4 s against 8.3 s without. In the same
check the kernel views with the monitor assignment frozen took 5.8 s (layers)
and 7.1 s (effects) against those originals with their nine invariants, so the
witness observation and monitor advance cost 2.1 s and 3.6 s of the gated runs,
about 13 to 15 microseconds per step; the kernel's own transitions and five
properties sit at or below the originals. With the refolding monitor, at 2,000
samples of 40 steps, the kernel views had taken 4 to 7 times the originals with
invariants and 9 to 13 times without. Making the monitor cheaper is the next
parity work item for sampling cost.

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

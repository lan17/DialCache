# 4. The kernel library and composition (10 min)

**What you get:** how sixteen profiles share one statement of each rule
without copying it: open record types, pure transitions, and a wrapper action
that assigns state only through the library.

## The idea

Lesson 3 put the small judgments in one file. The bigger rules, how a caller
is admitted, which layer serves it, when a source starts and when its deadline
fires, used to live in each profile separately. Sixteen copies of "start a
source" is sixteen places to drift. The
[kernel library](../GLOSSARY.md#kernel-library) under
[formal/models/kernel/](../../models/kernel/) fixes that: one module per
concern, each rule stated once as a pure transition.

A kernel transition has the form `pure def f(state: T[r], inputs...): T[r]`.
The type `T[r]` is an open record: it names only the fields the rule reads or
writes and leaves the rest, written `| r`, to whoever composes it. The policy
gate, which holds a caller while the environment delays its policy reply, is a
good first example:

```quint
type Held = { policyCall: int, caller: int, call: Call }
type Gated[r] = { held: List[Held] | r }
pure def hold(state: Gated[r], policyCall: int, caller: int, call: Call): Gated[r] =
  { held: state.held.append({ policyCall: policyCall, caller: caller, call: call }), ...state }
```

`hold` works on any state record that has a `held` list, whatever else it
carries. Such a family of fields is called a [shape](../GLOSSARY.md#shape).

Modules stack. `deadlines.qnt` wraps the serving module's local release and
adds one fact: a source started at release registers a deadline measured from
its own start:

```quint
pure def releaseLocal(state: BudgetedLocal[r], layout: Serving::Layout, policyCall: int, resolved: Resolution, ttls: Ttls): BudgetedLocal[r] = {
  val released = Serving::releaseLocal(state, layout, policyCall, resolved, ttls)
  if (released.sources.length() > state.sources.length()) startedLocal(released, state.sources.length(), state.sourceBudget) else released
}
```

A wrapper like this that records something beside the step it wraps is a
[variant](../GLOSSARY.md#variant); because it *is* the transition, a profile
cannot forget to call it.

A composed profile then owns three things only: its bounded state (one flat
record with exactly the fields its shapes need), its input choices and guards,
and its invariants and runs. Every public action assigns `s'` to one library
transition and `input'` to the command record. A lint checks that no
comparison, branch or arithmetic over cache state appears outside the kernel
(lesson 12 runs it as part of the differential). What the library leaves
unreachable from any scheduled profile, the kernel fixtures under
[fixtures/kernel/](../../models/fixtures/kernel/) exercise: small profiles
built only to reach those [seams](../GLOSSARY.md#seam).

## See it in the repo

- **[kernel/README.md](../../models/kernel/README.md#modules)**, "Modules":
  one row per module with its concern and entry points. Then
  "[Layering and reading order](../../models/kernel/README.md#layering-and-reading-order)":
  nine layers by import depth; start at `serving` to trace a rule.
- **[policy-gate.qnt](../../models/kernel/policy-gate.qnt)**, lines 18 to 43:
  the `Held` and `Gated[r]` shapes and the six entry points. The header
  comment (lines 2 to 14) follows the fixed shape every kernel module uses:
  purpose, Rules, Shapes, Consumers.
- **[deadlines.qnt](../../models/kernel/deadlines.qnt)**, lines 51 to 73: the
  `Due`, `Scheduled[r]`, `Budgeted[r]` and `BudgetedLocal[r]` shapes. Lines
  175 to 197: the budgeted local variants `admitLocal`, `releaseLocal`,
  `settleLocal`, `advanceLocal`.
- **[serving.qnt](../../models/kernel/serving.qnt)**, lines 40 to 43: the
  [`Layout`](../GLOSSARY.md#layout) record a profile passes to every
  transition. Lines 57 to 67 and 104 to 111: `Traversed[r, p]` and its local
  projection `LocalServed[r]`.
- **[kernel/README.md](../../models/kernel/README.md#composing-a-profile)**,
  "Composing a profile": the wrapper example and the rule that a profile may
  keep only wiring.

## Try it (3 min, plus an optional 2 min)

1. Run one kernel fixture, the budgeted local lifecycle:

   ```sh
   quint test formal/models/fixtures/kernel/budgeted-local.qnt --backend=rust --max-samples=1
   ```

   You should see `6 passing`, including
   `zeroBudgetSourceSettlesAsDeadlineErrorTest`: a corner no scheduled profile
   reaches, pinned here instead.

2. Read the fixture's header, lines 1 to 8 of the same file: it names exactly
   which seams it pins. That is the pattern for every fixture.

3. Optional (one to two minutes, runs the fixtures concurrently): every
   fixture at once, as the differential and model-check lanes do:

   ```sh
   make kernel-fixtures
   ```

   You should end with `{ fixtures: 16, runs: 194 }` and
   `✓ kernel-fixtures completed`.

## Recap

- **One rule, one transition:** kernel modules state each rule as
  `pure def f(state: T[r], ...): T[r]` over an open record that names only
  the fields the rule touches.
- **Variants stack facts beside a step** and cannot be forgotten, because the
  variant is the transition the profile calls.
- **A profile keeps only wiring:** bounds, input decoding, guards, invariants
  and runs; the lint refuses rule logic outside the kernel.

**Next:** [5. One profile end to end: source-budgets](./05-one-profile.md)

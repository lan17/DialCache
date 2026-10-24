# 15. Capstone, part 1: follow a contract and plan a change (10 min)

**What you get:** a change plan for one small, real addition to the suite,
derived from a contract ID with `where.mjs` and the authoring checklist. Parts
2 and 3 carry it out and undo it.

## The idea

Lessons 1 to 14 covered the pipeline; the three capstone lessons push one
small change through it. Every change to portable behavior starts from a
contract, not from a file. The contract inventory gives each obligation a
stable ID.

The catalogs connect that ID to the model that states it, the runs
that pin it, the witnesses that must reach it, the challenges that attack it
and the mutants that attack the ports. `node formal/tools/where.mjs <id>`
assembles that view in one place, so a plan begins by reading it rather than
by searching the tree.

The change this capstone makes is deliberately small: one new regression in
the source-budgets profile. The rule it pins is already true of the model and
the ports. That is the right size for a first contribution, because every gate
you meet is then about bookkeeping, not behavior.

**The rule.** When a source expires at its deadline, the next call for the
same key starts a new source. That retry gets its own full budget, measured
from its own start. Under C23 ("source ... starts only at source invocation")
this is a corner no existing run states in those words.
`abandonedSourceCannotReplaceSuccessfulRetryTest` shows the retry winning, but
not that its budget is whole.

**The plan,** following the five steps of
[AUTHORING.md](../AUTHORING.md#codifying-the-next-behavior):

1. **State the contract.** C23 already states it; no prose change. A larger
   change would edit [SPEC.md](../SPEC.md) and [CONTRACTS.md](../CONTRACTS.md)
   first. 2. **Model the smallest boundary.** One `run ...Test` in
   [dialcache-source-budgets-conformance.qnt](../../models/dialcache-source-budgets-conformance.qnt),
   using only the profile's public actions. It is therefore public-only and
   exported automatically (lesson 6). No new profile, no new action, no new
   code. 3. **Challenge the rule.** Nothing to add. The scheduled invariant
   `acceptedSourceRespectsItsOwnStart` already compares each accepted source
   with its own start and budget. The challenge `profile-source-wrong-clock`
   from lesson 11 already attacks the deadline origin, and the new run would
   fail under that same fault. 4. **Exercise every implementation.** Run it in
   Quint, export it, replay it in TypeScript and Go (lessons 6, 8 and 9). The
   full workflow would replay it in Rust and Python too, because exported runs
   are part of every port's required inventory. 5. **Account for the evidence.**
   The run adds one to the regression count and one to the exported-history
   count, two numbers the Go parity ledger pins. The model's hash changes, which
   moves the fixture lock. The generated profile view counts exported
   regressions, so it must be regenerated. A real change would also cite the run
   from a semantic case in `semantic-cases.json` with a reviewed scope.

Part 2 does steps 2 and 4. Part 3 does step 5 and shows that each gate names
its own fix.

## See it in the repo

- **[../CONTRACTS.md](../CONTRACTS.md)**, the row `| C23 |` (line 69), and
  "[Where the boundary lies](../CONTRACTS.md#where-the-boundary-lies)" for what
  counts as portable at all. -
  **[semantic-cases.json](../../catalogs/semantic-cases.json)**: the eight
  `C23.*` cases. `C23.default-source-budget` cites
  `source-budgets/defaultSourceBudgetExpiresAtSixtySecondsTest` under
  `quintReplays`, which is the shape a new citation would take. -
  **[../WALKTHROUGH.md](../WALKTHROUGH.md#find-the-rules-catalog-entries)**,
  "Find the rule's catalog entries": which catalog is responsible for which part
  of one rule. -
  **[../AUTHORING.md](../AUTHORING.md#give-reviewers-focused-context)**, "Give
  reviewers focused context": the context packet a reviewer needs, which is also
  the shape of a good PR description here. -
  **[go-parity.json](../../catalogs/go-parity.json)**, `inventory`: the two
  counts `scheduledRegressions` and `exportedRegressionHistories`, the live
  numbers from the inventory lesson 1 printed.

## Try it (4 min)

1. Read the contract view and find each of the plan's claims in it:

   ```sh
   node formal/tools/where.mjs C23
   ```

   You should see four blocks. Under `Stated`, the profile header at
   `dialcache-source-budgets-conformance.qnt:10`. Under `Tested`, eight cases;
   `C23.default-source-budget` and `C23.policy-does-not-spend-source-budget`
   both cite source-budgets runs. Under `Challenged`, three challenges, two of
   them reproduced by `heldPolicyDoesNotSpendSourceBudgetTest`. Under
   `Mapped`, `M33`.

2. Narrow to one case to see how a case is written:

   ```sh
   node formal/tools/where.mjs C23.default-source-budget
   ```

   You should see its `scenarios`, `quint checks`, `witnesses` and `replays`
   lines: the four kinds of evidence a case can carry.

3. Draft the run you will add in part 2, on paper or in a scratch file, as a
   sequence of the profile's public actions. Check your draft against lesson
   5: `begin(ENABLED)`, `release(n)`, `advanced(ms)` with `ms` in the
   `advance` choice set, `resolved(id, value)`. The answer is in part 2. The
   point is to notice that the budget is 10 ms and the choice set offers `10`
   and `9`.

## Recap

- **A change starts from a contract ID,** and `where.mjs` is the view that
  shows what already states, tests, challenges and maps it.
- **The five authoring steps** apply even to a one-run change; for this one,
  steps 1 and 3 need nothing new.
- **A public-only run is exported automatically,** so the cost of the change
  is bookkeeping: counts, the fixture lock, a generated view and a case citation.

**Next:** [16. Capstone, part 2: write, export and replay the run](./16-capstone-run.md)

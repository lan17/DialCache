# 6. Histories, ITF and the smoke traces (10 min)

**What you get:** what a generated history looks like on disk, how to read one
by hand, and which histories are committed to the repository.

## The idea

Lesson 5 read the profile; this lesson looks at what Quint writes out when it
runs. Everything a port replays is a history: an initial state followed by
public actions, each recording its command.

Quint writes histories in
[ITF](../GLOSSARY.md#itf-informal-trace-format), the [Informal Trace
Format](https://apalache-mc.org/docs/adr/015adr-trace.html) defined by
Apalache's ADR-015; `quint run --out-itf` writes it. It is plain JSON: a
`vars` list, a `states` array, and integers written as `{"#bigint": "123"}` so
that no JSON reader rounds them. Each state carries the two variables lesson 5
introduced: `input`, the command taken, and `s`, the model's state after it.

Here is one state of the walkthrough regression, trimmed:

```json
{
  "input": { "name": "releasePolicy", "choice": { "#bigint": "0" } },
  "s": { "o": { "calls": [{ "#bigint": "0" }], "loaders": { "#bigint": "1" }, "policyCalls": { "#bigint": "1" } } }
}
```

Read it as: the driver released policy call 0. Afterwards one call is pending
(`0` is `CALL_PENDING`), one loader has started, and one policy call was made.
`s.o` is the public observation a driver is compared against; the other fields
of `s` are predictions a driver never reads.

Histories come from two places. Together they are the
[corpus](../GLOSSARY.md#corpus-history-regression-exported-run-and-public-only-run):

- **Sampled histories.** `quint run --mbt --out-itf` writes random histories
  under `.formal-traces/features/<profile>/`. For source-budgets the manifest
  asks for 256 of at most 60 steps.
- **Exported regressions.** `quint test --out-itf` writes one history per
  named run under `.formal-traces/regressions/<profile>/`. A run is exported
  when it is public-only: every step records a command. A run that patches
  state directly stays model-only.

Nothing under `.formal-traces/` is committed. What is committed, under
[formal/generated/](../../generated/), is one [smoke](../GLOSSARY.md#smoke)
trace per profile: a single named history that every port replays without
Quint in `make check` and `make smoke`. A lock file pins the hash of every
input (models, recipes, generators) and every output. An edited model
therefore fails the fast lane until the artifacts are regenerated. The smoke
lane is the quick check; it claims nothing about the full corpus.

One difference you will meet. A smoke trace carries extra `mbt::actionTaken`
and `mbt::nondetPicks` fields, added by generation; a raw `quint test` export
has none. Both are accepted, and `input` is always the authority.

## See it in the repo

- **[source-budgets-smoke.itf.json](../../generated/source-budgets-smoke.itf.json)**:
  open it and find `#meta` (the model and the recipe that produced it),
  `vars`, and the first two states.
- **[../../generated/README.md](../../generated/README.md)**: what each
  generated file is, and the two commands that regenerate them.
- **[../../catalogs/fixture-recipes.json](../../catalogs/fixture-recipes.json)**:
  the recipe for each smoke trace names a run or an action schedule, never an
  expected state; Quint recomputes the states.
- **[../PORTING.md](../PORTING.md#trace-and-observation-contract)**, "Trace and
  observation contract": the exact decoding rules (safe integers, `choice: -1`
  for no choice, rejected shapes).
- **[../../replay/itf.mjs](../../replay/itf.mjs)**: 51 lines that decode an
  ITF integer and refuse precision loss.

Read more: [../AUTHORING.md](../AUTHORING.md#exported-runs-are-exactly-the-public-only-runs)
explains why nothing lists the exported runs; the tools classify each run from
its body.

## Try it (4 min)

1. Export the walkthrough regression as a history of its own. The output
   directory must exist first:

   ```sh
   mkdir -p .formal-traces/course/source-budgets
   quint test formal/models/dialcache-source-budgets-conformance.qnt --backend=rust --max-samples=1 \
     --match='^heldPolicyDoesNotSpendSourceBudgetTest$' \
     --out-itf='.formal-traces/course/source-budgets/{test}.itf.json'
   ```

   You should see `1 passing`, and a new file
   `heldPolicyDoesNotSpendSourceBudgetTest.itf.json` of about 8.5 KB. Lessons
   8 and 9 replay this file, so keep it.

2. Print the history as a table, one line per step:

   ```sh
   node -e '
   const t = JSON.parse(require("fs").readFileSync(".formal-traces/course/source-budgets/heldPolicyDoesNotSpendSourceBudgetTest.itf.json", "utf8"));
   const n = v => Number(v["#bigint"]);
   console.log("vars:", t.vars.join(", "), "| states:", t.states.length);
   for (const [i, st] of t.states.entries()) console.log(i, st.input.name.padEnd(14), "choice", String(n(st.input.choice)).padStart(3), "| calls", JSON.stringify(st.s.o.calls.map(n)), "loaders", n(st.s.o.loaders), "| now", n(st.s.now));'
   ```

   You should see:

   ```text
   vars: input, s | states: 8
   0 init           choice   2 | calls [] loaders 0 | now 0
   1 beginCall      choice   0 | calls [0] loaders 0 | now 0
   2 advance        choice 100 | calls [0] loaders 0 | now 100
   3 releasePolicy  choice   0 | calls [0] loaders 1 | now 100
   4 advance        choice   9 | calls [0] loaders 1 | now 109
   5 resolveLoader  choice   1 | calls [1] loaders 1 | now 109
   6 beginCall      choice   0 | calls [1,0] loaders 1 | now 109
   7 releasePolicy  choice   1 | calls [1,1] loaders 1 | now 109
   ```

   Step 2 is the rule: 100 ms pass with no loader started, so the budget has
   not begun. Step 7 is the consequence: the second call is served from local
   storage and `loaders` stays 1. (`s.now` is a private field. The table shows
   it to explain the steps; a driver never sees it.)

## Recap

- **A history is ITF JSON:** `vars`, `states`, bigint-encoded integers; each
  state holds the command in `input` and the predicted state in `s`.
- **The corpus is sampled histories plus exported public-only runs,** all
  under the uncommitted `.formal-traces/`.
- **The committed smoke trace per profile** is the fast check, pinned by a lock
  file, and claims nothing about the full corpus.

**Next:** [7. The replay boundary](./07-replay-boundary.md)

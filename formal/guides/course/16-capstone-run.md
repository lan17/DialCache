# 16. Capstone, part 2: write, export and replay the run (10 min)

**What you get:** the new regression written into the profile, checked in
Quint, exported as a history and replayed through two ports: steps 2 and 4 of
the plan from part 1.

## The idea

A run is a claim about the model, written as the exact public commands a
driver can execute, with checkpoints along the way. Writing one well means
three things. Use only public actions, so the run is exported and every port
replays it. Put a checkpoint at the step where the rule shows, not only at the
end, so a failure names the boundary. And read the expected observation off
the drivers' encoding: `CALL_PENDING` is 0, `DEADLINE_ERROR` is 4,
`VALUE_TWO` is 2, as `conformance-observations.qnt` fixes them.

Here is the run, with its comment in the file's style:

```quint
  // A retry after a deadline error gets its own full budget (C23): the first
  // source expires at 10 ms, and the retry started then is still pending at
  // 19 ms and settles accepted there.
  run retryAfterDeadlineGetsItsOwnFullBudgetTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(advanced(10))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.loaders == 1)
    .then(begin(ENABLED)).then(release(1)).then(advanced(9))
    .expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING) and s.o.loaders == 2)
    .then(resolved(1, VALUE_TWO))
    .expect(s.o.calls == List(DEADLINE_ERROR, VALUE_TWO) and s.o.loaders == 2)
```

Read it against the kernel from lesson 4. `release(0)` starts source 0 at
time 0 with the finite 10 ms budget. `advanced(10)` delivers that deadline:
the kernel's `advanceLocal` expires the source and completes its caller with
`DEADLINE_ERROR`; the local slot stays empty because a deadline error
publishes nothing. `release(1)` finds no live entry and no pending flight, so
it starts source 1 at time 10 with a fresh budget, deadline 20. `advanced(9)`
reaches 19: still pending, so `calls` is `[4, 0]` and `loaders` is 2. Then
`resolved(1, VALUE_TWO)` settles one millisecond before the deadline and the
caller gets `VALUE_TWO`. A kernel that measured the retry's budget from time 0
would have expired it at 10 and this run would fail at the second checkpoint.

Why does `resolved(1, VALUE_TWO)` encode as choice 4? Lesson 5's decoder:
`id * 2 + value`, so source 1 with value 2 is 4, and the TypeScript descriptor
turns 4 back into `{ op: "resolve", loader: 1, value: 2 }`. You never compute
that by hand; the point is that the same integer means the same command in
every port.

## See it in the repo

-
  **[dialcache-source-budgets-conformance.qnt](../../models/dialcache-source-budgets-conformance.qnt)**,
  lines 256 to 260: `abandonedSourceCannotReplaceSuccessfulRetryTest`, the
  nearest existing run; compare its shape with the new one. -
  **[conformance-observations.qnt](../../models/conformance-observations.qnt)**,
  lines 8 to 17: the caller outcome codes, `CALL_PENDING` first. -
  **[deadlines.qnt](../../models/kernel/deadlines.qnt)**, lines 181 to 197:
  `releaseLocal` stamps the retry's deadline from `state.now`; `advanceLocal`
  delivers it. -
  **[../AUTHORING.md](../AUTHORING.md#exporting-a-deterministic-regression)**,
  "Exporting a deterministic regression": the rules a run must meet to be
  exported.

## Try it (6 min)

You will edit a tracked model; part 3 undoes it.

1. Open `formal/models/dialcache-source-budgets-conformance.qnt` and paste the
   run above at the end of the module, after
   `republishedEqualValueRestampsLocalExpiryTest` and before the closing `}`.

2. Run it alone and export its history:

   ```sh
   quint test formal/models/dialcache-source-budgets-conformance.qnt --backend=rust --max-samples=1 \
     --match='^retryAfterDeadlineGetsItsOwnFullBudgetTest$' \
     --out-itf='.formal-traces/course/source-budgets/{test}.itf.json'
   ```

   You should see `ok retryAfterDeadlineGetsItsOwnFullBudgetTest passed 1 test(s)`
   and `1 passing`. If a checkpoint fails, the message names its line; compare
   your expectation with the reading above.

3. Replay the export through the TypeScript driver:

   ```sh
   DIALCACHE_FEATURE_PROFILE=source-budgets \
   DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/course/source-budgets/retryAfterDeadlineGetsItsOwnFullBudgetTest.itf.json" \
     corepack pnpm --dir typescript exec vitest run test/formal-features.test.ts --coverage.enabled=false --reporter=verbose
   ```

   You should see `✓ ... > replays ...retryAfterDeadlineGetsItsOwnFullBudgetTest.itf.json`
   and `Tests  4 passed (4)`. The real TypeScript cache gave the retry its
   full budget.

4. Replay it in Go (Node 24 on PATH):

   ```sh
   DIALCACHE_FEATURE_PROFILE=source-budgets \
   DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/course/source-budgets/retryAfterDeadlineGetsItsOwnFullBudgetTest.itf.json" \
     go -C go test -count=1 -run '^TestFeatureConformance/source-budgets/' ./...
   ```

   You should see `ok  	github.com/lan17/DialCache/go`.

5. Confirm the suite now counts it, without any catalog edit:

   ```sh
   node formal/tools/execution.mjs | head -8
   ```

You should see `regressions` and `exportedRegressionTraces` each one higher than
   the clean tree printed in lesson 2.

Leave the edit in place for part 3.

## Recap

- **A run is public commands plus checkpoints at the boundary,** with
  expectations read off the shared outcome codes.
- **Quint, then export, then replay:** the same history passed in the model,
  in TypeScript and in Go without a line of port code changing.
- **Export is automatic:** the run is counted as a regression and an exported
  history because every step records a command.

**Next:** [17. Capstone, part 3: the ripple, the fixes and the undo](./17-capstone-ripple.md)

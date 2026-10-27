# 8. The TypeScript driver (10 min)

**What you get:** how a driver turns one command into a real cache call,
controls the outside world around that call, and reports only what happened.

## The idea

Lesson 7 drew the boundary; this lesson is the TypeScript side of it. A
[driver](../GLOSSARY.md#driver) owns three things: a real cache built from the
fixture, every external effect the cache depends on, and a running
observation. The TypeScript one is `BehaviorDriver` in
[typescript/test/formal/behavior-driver.ts](../../../typescript/test/formal/behavior-driver.ts).
Its single entry point is `apply(input)`.

**Building the cache.** The constructor creates a `DialCache` with a fake Redis
adapter, a policy provider, a serializer and metrics hooks. The driver
implements all of them itself. Each hook counts: a Redis read increments
`observed.reads`, a policy call `observed.policyCalls`, a loader invocation
`observed.loaders`. The counts are the observation. Nothing is copied from
the model.

**Controlling the world.** Sources are deferred promises. When the cache calls
the loader, the driver hands back a promise, and only a later `resolve` or
`reject` command settles it. Policy replies, reads, writes, dumps and loads can
be held the same way once a `faults` command turns on `holdPolicies`,
`holdReads` and so on. A `release` command settles one of them by its index in
invocation order, the [effect index](../GLOSSARY.md#effect-index). Time is
fake: `advance` moves vitest's fake timers, so a 10 ms deadline fires exactly
when the history says.

**Applying a command.** `apply` is one `switch` on `input.op`. For `begin` it
pushes a pending entry onto `observed.calls`. Then it calls the real
`cache.getOrLoad(...)` inside `cache.enable(...)`, or outside it, or in a
named scope. A continuation overwrites that entry with
`{ status: "value", value }` or `{ status: "error", error }` when the call
settles. Errors are classified by identity: `source:N` for the N-th controlled
source failure, `timeout:N` for a deadline error. Nothing in `begin` reads an
expected result.

**Settling and reporting.** After every command the driver drains ready work
at zero time. It snapshots the observation as the JSON that will cross the
wire. Then it runs one more zero-time drain to prove nothing was left
runnable. That is the settlement receipt from lesson 7, computed from the
driver's own bookkeeping: elapsed fake time, `runnable`, and the gates still
held.

**The loop.** TypeScript does not need JSON Lines; it imports the same replay
modules the coordinator uses. `replay()` in
[formal-features.test.ts](../../../typescript/test/formal-features.test.ts)
decodes each step's action and choice into an `Input` with `featureInput`. It
applies the input, checks the receipt, then compares the projected snapshot
with the step's prediction using `assertFeatureObservation`. The decoding
table for source-budgets is 14 lines in
[profiles/source-budgets.mjs](../../replay/profiles/source-budgets.mjs).
Choice `0` of `beginCall` becomes `{ op: "begin" }`; choice `3` of
`resolveLoader` becomes `{ op: "resolve", loader: 1, value: 1 }`.

## See it in the repo

- **[behavior-driver.ts](../../../typescript/test/formal/behavior-driver.ts)**,
  the driver:
  - [lines 55 to 70](../../../typescript/test/formal/behavior-driver.ts): the
    `Input` union, every command a driver understands.
  - [lines 74 to 91](../../../typescript/test/formal/behavior-driver.ts): the
    `Observation` record.
  - [lines 117 to 118](../../../typescript/test/formal/behavior-driver.ts): the
    rule `no expected observation is passed to this class`.
  - [lines 301 to 354](../../../typescript/test/formal/behavior-driver.ts):
    `apply` for `begin`;
    [lines 356 to 371](../../../typescript/test/formal/behavior-driver.ts):
    `resolve`, `reject` and `advance`;
    [lines 416 to 423](../../../typescript/test/formal/behavior-driver.ts):
    `release`.
  - [lines 451 to 483](../../../typescript/test/formal/behavior-driver.ts): the
    `settle` drain and the receipt;
    [lines 492 to 494](../../../typescript/test/formal/behavior-driver.ts):
    `snapshot()` and `receipt()`.
- **[formal-features.test.ts](../../../typescript/test/formal-features.test.ts)**,
  lines 16 to 53: the `replay` loop. Lines 58 to 60: the
  `DIALCACHE_FEATURE_TRACE_FILE` and `DIALCACHE_FEATURE_PROFILE` selectors.
- **[features.mjs](../../replay/features.mjs)**: `featureInput` (line 617) and
  `assertFeatureObservation` (line 619), shared by every port through the
  coordinator.
- **[profiles/source-budgets.mjs](../../replay/profiles/source-budgets.mjs)**:
  the fixture by init choice, the setup command, and the action decodings.
- **[../WALKTHROUGH.md](../WALKTHROUGH.md#follow-input-and-evidence-separately)**,
  "Follow input and evidence separately": the same split drawn as a diagram.

## Try it (3 min)

1. Replay the committed source-budgets smoke trace through the TypeScript
   driver:

   ```sh
   DIALCACHE_FEATURE_PROFILE=source-budgets \
     corepack pnpm --dir typescript exec vitest run test/formal-features.test.ts --coverage.enabled=false
   ```

   You should see `Tests  4 passed (4)`: the replay itself plus three harness
   controls (a corrupted trace is rejected, a corrupted expectation is
   detected, a driver that skips settlement fails by settlement violation).

2. Replay the history you exported in lesson 6, with the verbose reporter so
   the trace path is shown. If the file is missing, run lesson 6, step 1,
   first:

   ```sh
   DIALCACHE_FEATURE_PROFILE=source-budgets \
   DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/course/source-budgets/heldPolicyDoesNotSpendSourceBudgetTest.itf.json" \
     corepack pnpm --dir typescript exec vitest run test/formal-features.test.ts --coverage.enabled=false --reporter=verbose
   ```

   You should see a line starting `✓ ... > replays ` followed by your file's
   path, then `Tests  4 passed (4)`.

## Recap

- **A driver owns the real cache, the external effects and the observation;**
  counts come from the driver's own hooks, never from the model.
- **`begin` is a real `getOrLoad` call** whose result is written into
  `observed.calls` when it settles; sources and effects are gates the history
  releases by index.
- **Settle, snapshot, verify:** the receipt proves quiescence from the
  driver's own bookkeeping before the coordinator compares anything.

**Next:** [9. Go, Rust and Python mirror it](./09-go-rust-python-drivers.md)

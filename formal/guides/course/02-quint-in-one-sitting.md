# 2. Quint in one sitting (10 min)

**What you get:** enough Quint to read any model in this tree: state, pure
definitions, actions, invariants, named runs, and the two commands that
execute them.

## The idea

Quint describes a system as a state and the steps that change it. Five pieces
of syntax carry almost every model here. The examples come from the core
profile, [dialcache-conformance.qnt](../../models/dialcache-conformance.qnt),
the one model written in plain Quint without the kernel library.

**State.** `var s: State` declares the one variable the model changes, and
`type State = { sourceVersion: int, lastResult: int, ... }` says what it holds.
A second variable, `var input: { name: str, choice: int }`, records the
command each step took; lesson 6 explains why that record matters.

**Pure definitions.** `pure def` and `pure val` compute from their arguments
and touch no state. A judgment such as "is this entry still live" is a pure
definition (lesson 3).

**Actions.** An `action` says what the next state is. A primed name, `s'`,
is the state after the step. Inside `all { ... }` every line must hold for the
step to be enabled, so a guard and an assignment sit side by side:

```quint
action localCall = all {
  input' = { name: "localCall", choice: -1 },
  s' = if (s.localCached) { lastResult: s.localValue, ...s }
       else { lastResult: s.sourceVersion, localLoaderCalls: s.localLoaderCalls + 1,
              localCached: true, localValue: s.sourceVersion, ...s }
}
```

The spread `...s` keeps every field not listed. `any { a, b, c }` offers a
choice of steps, and `nondet x = Set(1, 2).oneOf()` picks an input; `step`
is conventionally the `any` over all public actions, which is what random
exploration samples.

**Invariants.** A `val` is a property of one state, checked after every step
when you name it: `val readableRemoteHasValue = not(s.remoteReadable) or s.remoteValue > 0`.
Invariants here are written independently of the transition they check, so a
bug in the transition cannot hide inside its own helper.

**Runs.** A `run ...Test` is a deterministic history with checkpoints:

```quint
run localValueSurvivesSourceChangeTest = init.then(localCall).then(bumpSource).then(localCall)
  .expect(s.lastResult == 1 and s.localLoaderCalls == 1)
```

`.then` chains steps; `.expect` checks the state reached. Runs are the
regressions of lesson 1.

**Two commands.** `quint run` starts from `init`, samples random `step`
sequences and checks the invariants you name; `quint test` executes the named
runs. Both use Quint's evaluator written in Rust (`--backend=rust`, the
default), a fast simulator, not a proof. The other tool, Apalache, is a
symbolic model checker: it proves a property over every state within a bound
and needs Java. Only one small model is checked that way (lesson 3); every
other claim is sampled or replayed.

## See it in the repo

- **[dialcache-conformance.qnt](../../models/dialcache-conformance.qnt)**, lines
  17 to 36: `State`, `var s`, `var input`. Lines 90 to 102: `localCall`. Lines
  164 to 173: `step`. Lines 195 to 199: the invariant
  `servedLayerValueMatchesCache`, stated over the `input` record. Lines 201 to
  220: the five runs, starting with
  `disabledAndRequestCallsKeepTheirOwnLifetimesTest`. -
  **[../AUTHORING.md](../AUTHORING.md#reading-a-model)**, "Reading a model": the
  reading order (scope, types, predicates, transitions, `step`, invariants,
  runs) and the three kinds of information to keep apart: environment inputs,
  DialCache ownership and recorded observations. -
  **[../GLOSSARY.md](../GLOSSARY.md#verification-model)**: a [verification
  model](../GLOSSARY.md#verification-model) is model-checked and never replayed;
  a [profile](../GLOSSARY.md#profile-conformance-profile) is replayed by every
  port. The core profile is the simplest profile.

## Try it (4 min)

1. Run the five named runs:

   ```sh
   quint test formal/models/dialcache-conformance.qnt --backend=rust --max-samples=1
   ```

   You should see five `ok ... passed 1 test(s)` lines and `5 passing`.

2. Sample 200 random histories of 20 steps and check two invariants:

   ```sh
   quint run formal/models/dialcache-conformance.qnt --backend=rust \
     --max-samples=200 --max-steps=20 \
     --invariants servedLayerValueMatchesCache readableRemoteHasValue
   ```

   The last lines include `[ok] No violation found` and a `--seed=...` you
   could pass back to reproduce the same sample.

3. Write a wrong expectation in a scratch file, outside the tracked models,
   and watch Quint reject it:

   ```sh
   mkdir -p .formal-traces/course/scratch
   cat > .formal-traces/course/scratch/scratch.qnt <<'EOF'
   module scratch {
     import dialcache_conformance.* from "../../../formal/models/dialcache-conformance"
     run localValueFollowsSourceWrongTest = init.then(localCall).then(bumpSource).then(localCall)
       .expect(s.lastResult == 2 and s.localLoaderCalls == 1)
   }
   EOF
   quint test .formal-traces/course/scratch/scratch.qnt --backend=rust --max-samples=1
   ```

   You should see `1) localValueFollowsSourceWrongTest failed` and
   `Error [QNT508]: Expect condition does not hold true`. The local cache
   served the value it stored (1), so the expectation was wrong, not the model.
   `.formal-traces/` is ignored by git, so nothing to clean up.

## Recap

- **Five pieces of syntax:** `var` state, `pure def`, `action` with `s'` and
  `all`/`any`/`nondet`, `val` invariants, `run ...Test` with `.then`/`.expect`.
- **Two commands:** `quint run` samples and checks invariants; `quint test`
  executes named runs. Both are the Rust evaluator, a simulator.
- **Apalache proves, within a bound,** and is used for one small model; the
  rest of the suite relies on sampling plus replay in real ports.

**Next:** [3. cache-rules.qnt, the judgment layer](./03-cache-rules.md)

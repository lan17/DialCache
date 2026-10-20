# 2. Quint in one sitting (10 min)

**What you get:** enough Quint to read any model in this tree: state, pure
definitions, actions, invariants and named runs, plus the two commands that
execute them.

## The idea

Lesson 1 placed the Quint models at stage one; this lesson teaches enough
Quint to read one. Quint describes a system as a state and the steps that
change it. Five pieces of syntax carry almost every model here. The examples
come from the core profile,
[dialcache-conformance.qnt](../../models/dialcache-conformance.qnt), the one
profile written in plain Quint without the kernel library (lesson 4).

**State.** `var s: State` declares the one variable the model changes.
`type State = { sourceVersion: int, lastResult: int, ... }` says what it
holds. A second variable, `var input: { name: str, choice: int }`, records
the command each step took. Lesson 6 explains why that record matters.

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
choice of steps. `nondet x = Set(1, 2).oneOf()` picks an input. By convention
`step` is the `any` over all public actions, and random exploration samples
`step`.

**Invariants.** A `val` is a property of one state. Name it on the command
line and Quint checks it after every step:
`val readableRemoteHasValue = not(s.remoteReadable) or s.remoteValue > 0`.
Invariants here are written without calling the transition they check, so a
bug in a transition cannot hide inside its own helper.

**Runs.** A `run ...Test` is a deterministic history with checkpoints:

```quint
run localValueSurvivesSourceChangeTest = init.then(localCall).then(bumpSource).then(localCall)
  .expect(s.lastResult == 1 and s.localLoaderCalls == 1)
```

`.then` chains steps and `.expect` checks the state reached. Runs are the
regressions of lesson 1.

**Two commands** ([CLI manual](https://quint.sh/docs/quint)). `quint run`
starts from `init`, samples random `step` sequences and checks the invariants
you name. `quint test` executes the named runs. Both use Quint's evaluator
written in Rust (`--backend=rust`, the default). It is a fast simulator, not a
proof ([how the simulator works](https://quint.sh/docs/simulator)).

A second tool, [Apalache](https://apalache-mc.org/docs/), is a symbolic model
checker ([Quint's model checker page](https://quint.sh/docs/model-checkers)).
It proves a property over every state within a bound, and it needs Java. Only
one small model is checked that way (lesson 3). Every other claim in this tree
is sampled or replayed.

## See it in the repo

- **[dialcache-conformance.qnt](../../models/dialcache-conformance.qnt)**, the
  core profile:
  - [lines 17 to 36](../../models/dialcache-conformance.qnt): `State`, `var s`
    and `var input`.
  - [lines 90 to 102](../../models/dialcache-conformance.qnt): `localCall`.
  - [lines 164 to 173](../../models/dialcache-conformance.qnt): `step`.
  - [lines 195 to 199](../../models/dialcache-conformance.qnt): the invariant
    `servedLayerValueMatchesCache`, stated over the `input` record.
  - [lines 201 to 220](../../models/dialcache-conformance.qnt): the five runs,
    starting with `disabledAndRequestCallsKeepTheirOwnLifetimesTest`.
- **[../AUTHORING.md](../AUTHORING.md#reading-a-model)**, "Reading a model":
  the reading order (scope, types, predicates, transitions, `step`,
  invariants, runs). It also names three kinds of information to keep apart:
  environment inputs, DialCache ownership and recorded observations.
- **[../GLOSSARY.md](../GLOSSARY.md#verification-model)**: a [verification
  model](../GLOSSARY.md#verification-model) is model-checked and never
  replayed; a [profile](../GLOSSARY.md#profile-conformance-profile) is replayed
  by every port. The core profile is the simplest profile.

Read more: Quint's own [language basics](https://quint.sh/docs/language-basics),
[built-in operators](https://quint.sh/docs/builtin),
[language manual](https://quint.sh/docs/lang) and
[checking properties](https://quint.sh/docs/checking-properties) cover what
this lesson skips.

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

   You should see `[ok] No violation found`, then a `--seed=...` line you
   can pass back to reproduce the same sample.

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

   You should see `1) localValueFollowsSourceWrongTest:` followed by
   `Error [QNT508]: Expect condition does not hold true`, and
   `error: Tests failed` at the end. The local cache served the value it
   stored (1), so the expectation was wrong, not the model. `.formal-traces/`
   is ignored by git, so there is nothing to clean up.

## Recap

- **Five pieces of syntax:** `var` state, `pure def`, `action` with `s'` and
  `all`/`any`/`nondet`, `val` invariants, `run ...Test` with `.then`/`.expect`.
- **Two commands:** `quint run` samples and checks invariants; `quint test`
  executes named runs. Both use the Rust evaluator, a simulator.
- **Apalache proves, within a bound,** and is used for one small model; the
  rest of the suite relies on sampling plus replay in real ports.

**Next:** [3. cache-rules.qnt, the judgment layer](./03-cache-rules.md)

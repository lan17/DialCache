# A course through formal/, in ten-minute lessons

Seventeen lessons, each about ten minutes to read and do. They walk down the
`formal/` tree in order. First the Quint models, then the tools that check
them and generate test histories, then the replay that runs those histories
against every language port, the evidence catalogs, and the CI lanes. Each
lesson teaches one idea and ends with one exercise you run yourself.

## Who this is for

You know what DialCache does (a request-scoped cache with TypeScript, Go, Rust
and Python ports) and you read code in at least one of those languages. You
have not used Quint or a model checker. You may have ADHD, or little time at a
stretch: every lesson is one sitting, and stopping after any lesson leaves
nothing half-done.

## What you will be able to do

- **Read a Quint profile** and say which rule each run pins.
- **Run one regression** in Quint, export its history and replay it in a port.
- **Explain the replay boundary**: why a driver never sees the model's
  predictions, and what a settlement receipt attests.
- **Read the evidence**: a witness report, a challenge, a native mutant, the
  differential's verdict.
- **Know which check fires** after a given kind of edit, and what fixes it.
- **Make a small change end to end**, from the contract to the checks, and undo it.

## Time

Seventeen lessons of about ten minutes each: roughly 2 hours 50 minutes in
total. A few lessons offer an optional longer run, from twenty seconds to four
minutes, that you can skip without losing the thread. Each optional step says
how long it takes.

## Setup, once (5 min)

Run everything from the repository root.

1. **Node 24 and Quint 0.32.0 on PATH.** Check with `node --version` (`v24.x`)
   and `quint --version` (`0.32.0`). Lessons 2 to 6, 11, 12, 16 and 17 need
   Quint; the rest need only Node. Install Quint with `npm install --global
   @informalsystems/quint@0.32.0` if it is missing. 2. **Install the
   workspace:** `corepack pnpm install --frozen-lockfile`. 3. **Confirm the
   tools answer:** `node formal/tools/execution.mjs` prints an inventory that
   starts with `"models": 32`. 4. **Optional ports.** Lesson 9 uses Go, Rust and
   a Python virtual environment at `python/.venv`; lesson 16 uses Go; the
   optional step of lesson 14 uses all four ports. Create the environment once
   with any Python 3.11 or later: `python3.11 -m venv python/.venv &&
   python/.venv/bin/python -m pip install -e './python[test,redis]'`. `make
   help` lists the pinned versions. Docker is never needed in this course; the
   mutation lanes that need it are named in lesson 11 and not run.

If your default `node` is another major version, put Node 24 first on PATH for
the Quint and port commands, and pass `NODE=/path/to/node24` to `make`. The
Python transport reads the same `NODE` variable.

## How to use it

- **One lesson per sitting.** Read "The idea", open the files under "See it in
  the repo", do "Try it", read the recap. Then stop.
- **Coming back?** Each lesson restates where you are in its first line and
  ends with a "Next" link, so you never need to remember the plan.
- **Short on time?** Do only "Try it" and "Recap". The exercise is the lesson.
- **Keep the tree clean.** Lessons 12, 13 and 16 ask you to edit a tracked
  file and undo it with `git checkout`. The exercises say exactly which file,
  and lesson 17 ends with the undo for the capstone.

Tick lessons off here as you go:

- [ ] 1 to 4: the models
- [ ] 5 to 7: one profile, its histories, the replay boundary
- [ ] 8 to 9: the drivers
- [ ] 10 to 12: the evidence
- [ ] 13 to 14: the ledgers and the lanes
- [ ] 15 to 17: the capstone

## The lessons, in order

| # | Lesson | Time | After it you can |
| --- | --- | --- | --- |
| 1 | [Why DialCache specifies behavior formally](./01-why-formal.md) | 10 min | Say what "executable specification" means here and name the six stages |
| 2 | [Quint in one sitting](./02-quint-in-one-sitting.md) | 10 min | Read state, actions, invariants and runs; use `quint run` and `quint test` |
| 3 | [cache-rules.qnt, the judgment layer](./03-cache-rules.md) | 10 min | Find the one place a boundary inequality is stated |
| 4 | [The kernel library and composition](./04-kernel-and-composition.md) | 10 min | Read an open record type and a composed wrapper action |
| 5 | [One profile end to end: source-budgets](./05-one-profile.md) | 10 min | Walk a conformance profile from its bounds to its runs |
| 6 | [Histories, ITF and the smoke traces](./06-histories-and-itf.md) | 10 min | Export a regression and read its trace by hand |
| 7 | [The replay boundary](./07-replay-boundary.md) | 10 min | Drive the coordinator by hand and read a mismatch |
| 8 | [The TypeScript driver](./08-typescript-driver.md) | 10 min | Follow a command into a real cache call and back out as an observation |
| 9 | [Go, Rust and Python mirror it](./09-go-rust-python-drivers.md) | 10 min | Replay one history in another port |
| 10 | [Witnesses and coverage](./10-witnesses.md) | 10 min | Read a classifier and a witness report |
| 11 | [Challenges and native mutants](./11-challenges-and-mutants.md) | 10 min | Read a challenge, its reproducer and its mutant; say what a survivor means |
| 12 | [The differential and behaviorVersion](./12-differential.md) | 10 min | Run the differential and declare an intended change |
| 13 | [Catalogs and ledgers](./13-catalogs-and-ledgers.md) | 10 min | Break and re-key the source audit, then undo it |
| 14 | [CI lanes and running things locally](./14-lanes-and-local-runs.md) | 10 min | Pick the right `make` target for an edit |
| 15 | [Capstone, part 1: follow a contract and plan a change](./15-capstone-plan.md) | 10 min | Turn a contract ID into a change plan with `where.mjs` |
| 16 | [Capstone, part 2: write, export and replay the run](./16-capstone-run.md) | 10 min | Add a public-only run and replay it in two ports |
| 17 | [Capstone, part 3: the ripple, the fixes and the undo](./17-capstone-ripple.md) | 10 min | Watch each gate fire, name its fix, leave the tree clean |

## Where this fits

This course adds sequence, plain-language framing, exercises and recaps. It
does not restate the guides. When a guide explains something best, a lesson
quotes at most a sentence and links to it. The guides are indexed in
[../README.md](../README.md) by kind and in [../../README.md](../../README.md)
by task; terms are defined in [../GLOSSARY.md](../GLOSSARY.md).

## Further reading

The lessons link each outside concept where it first appears. Collected here,
with the lesson that uses it:

- **Quint.** The [documentation index](https://quint.sh/docs) and
  [getting started](https://quint.sh/docs/getting-started) (lesson 1). The
  [language basics](https://quint.sh/docs/language-basics), the
  [built-in operators](https://quint.sh/docs/builtin), the
  [language manual](https://quint.sh/docs/lang), the
  [CLI manual](https://quint.sh/docs/quint),
  [checking properties](https://quint.sh/docs/checking-properties),
  [how the simulator works](https://quint.sh/docs/simulator) and
  [model checkers](https://quint.sh/docs/model-checkers) (lesson 2).
  [Model-based testing](https://quint.sh/docs/model-based-testing) (lesson 7).
  The language lives at [quint-co/quint](https://github.com/quint-co/quint).
- **Apalache.** The [documentation](https://apalache-mc.org/docs/) of the
  symbolic model checker behind `make model-check` (lessons 2 and 3), and
  [ADR-015](https://apalache-mc.org/docs/adr/015adr-trace.html), the definition
  of the Informal Trace Format (lesson 6).
- **Background.** [TLA+](https://lamport.azurewebsites.net/tla/tla.html), the
  temporal logic of actions Quint is built on, and
  [model checking](https://en.wikipedia.org/wiki/Model_checking) (lesson 1).
  [Model-based testing](https://en.wikipedia.org/wiki/Model-based_testing) and
  [JSON Lines](https://jsonlines.org/), the replay protocol's framing (lesson 7).
  [Mutation testing](https://en.wikipedia.org/wiki/Mutation_testing) and
  [Redis Lua scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/)
  (lesson 11). [Differential testing](https://en.wikipedia.org/wiki/Differential_testing)
  (lesson 12).

## How the course stays current

Lessons point at exact lines and quote command output, and both drift as the
tree changes. `make audit` runs [check-course.mjs](../../tools/check-course.mjs)
so the drift is caught by the check, not by a learner:

- **A line citation names its file and a symbol.** Write `lines 65 to 86` (or
  `line 141`) after a link to the file in the same bullet or paragraph, or make
  the citation itself the link. Put a backticked symbol from those lines in the
  same clause or immediately before the citation. The check fails when the
  symbol is no longer on those lines. Fix the citation, then reread the lesson:
  the code may have moved for a reason the lesson should mention.
- **A quoted count comes from a check.** Quote a number only as `node
  formal/tools/execution.mjs` prints it (`"regressions": 468`) or as `node
  formal/tools/check-source-audit.mjs` prints it (`guideSections: 195`); the
  check compares both with today's output. When an exercise changes a count, say
  so in words rather than quoting the new number.
- **The course is outside the review ledger on purpose.** The lessons are
  didactic, not normative; the guides they link to are the reviewed text.

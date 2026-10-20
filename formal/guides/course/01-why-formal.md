# 1. Why DialCache specifies behavior formally (10 min)

**What you get:** the one reason `formal/` exists, and the six stages that
turn a rule into evidence, so every later lesson has a place on the map.

## The idea

DialCache has four implementations: TypeScript, Go, Rust and Python. They must
behave the same way, down to boundaries like "a source that settles exactly at
its deadline has timed out". A prose spec cannot hold that line: prose drifts,
and four test suites written by hand drift four different ways.

So the portable rules are written once, in a language a tool can run. That is
what "executable specification" means here: the rule is a small program, the
tool generates concrete histories from it, and every port is made to replay
those histories against its real cache. The language is
[Quint](https://quint.sh/docs), a specification language built on the temporal
logic of actions ([TLA+](https://lamport.azurewebsites.net/tla/tla.html)), with
a simulator and a [model checker](https://en.wikipedia.org/wiki/Model_checking).
The histories are JSON files. The replay is a shared Node program that hands
each port commands and checks the port's answers.

Take one real rule. A call that waits 100 ms for runtime policy and then
starts a source with a 10 ms budget must still be allowed 10 ms, not 10 ms
minus the 100 it already waited. In the inventory of contracts this is
**C23**; its exact corner is the case
`C23.policy-does-not-spend-source-budget`. The Quint model states it as a
transition rule, a named run pins the history, the generated histories reach
it, and TypeScript, Go, Rust and Python each replay that history. A port that
charges the policy wait to the source fails at a visible step.

Who wins when model and code disagree? Neither, automatically. TypeScript is
the executable reference the models formalize; Quint is the contract every
port is held to. A disagreement is settled by a
[regression](../GLOSSARY.md#corpus-history-regression-exported-run-and-public-only-run)
(a named run that distinguishes the two behaviors) and a recorded decision,
not by editing whichever side is easier.

Six stages turn a rule into evidence. Each later lesson sits in one of them:

1. **State** the rule in Quint (lessons 2 to 5).
2. **Check** the models: invariants, named runs and deliberate faults (lessons 2, 11).
3. **Generate** the histories and the committed artifacts (lesson 6).
4. **Replay** every history in every port through the shared boundary (lessons 7 to 9).
5. **Account** for what was reached and what was caught (lessons 10 to 12).
6. **Gate** a change with ledgers and CI lanes (lessons 13 to 14).

## See it in the repo

- **[../../README.md](../../README.md)** is the landing page: start with its
  task table, which names the guide to read for each kind of work.
- **[../README.md](../README.md)** indexes the guides by kind: contract guides
  (what a port must preserve), tooling guides (how to do the work) and coverage
  guides (what the evidence establishes).
- **[../../../AGENTS.md](../../../AGENTS.md)**, section "Critical behavior",
  lists the rules in one screen; the formal tree is where each is made checkable.
- **[../SPEC.md](../SPEC.md#meaning-of-conformance)** says what it means to
  conform and what passing a finite corpus does and does not prove.
- **[../CONTRACTS.md](../CONTRACTS.md)**, the row `| C23 |`, is the obligation
  this lesson used, with its evidence column.

## Try it (3 min)

1. Print the inventory. Every number comes from the catalogs, not from prose:

   ```sh
   node formal/tools/execution.mjs
   ```

   You should see the start of a JSON object:

   ```text
   "models": 32,
   "libraries": 34,
   "profiles": 17,
   "invariants": 253,
   "regressions": 468,
   ```

   Read it as: 32 Quint models, 17 of them
   [profiles](../GLOSSARY.md#profile-conformance-profile) that ports replay,
   253 checked invariants and 468 named runs.

2. Ask where C23 lives:

   ```sh
   node formal/tools/where.mjs C23 | head -12
   ```

   The first block, `Stated`, lists the contract row and every model comment
   that cites C23, with file and line. Keep this command in mind; lesson 15
   builds on it.

## Recap

- **One rule, one statement.** Portable behavior is written once in Quint and
  every port is tested against histories generated from it.
- **Neither side wins by default.** TypeScript is the reference, Quint the
  contract; a disagreement becomes a named regression and a decision.
- **Six stages:** state, check, generate, replay, account, gate. Each lesson
  from here sits in one of them.

**Next:** [2. Quint in one sitting](./02-quint-in-one-sitting.md)

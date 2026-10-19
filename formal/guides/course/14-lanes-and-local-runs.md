# 14. CI lanes and running things locally (10 min)

**What you get:** which check runs where, roughly how long each takes, and the
`make` target to run for each kind of edit before you push.

## The idea

A [lane](../GLOSSARY.md#lane) is one validation pipeline: a `make` target
locally and the same command as a job in GitHub Actions. `make <target>` is
`node formal/tools/validation.mjs <target>`, so the two cannot diverge, and
`make help` lists every target with its prerequisites.

Three workflows run the formal lanes.

**The pull request lanes** are fast. `ci.yaml` runs each port's native checks.
`formal.yaml` runs `make audit smoke`: the ledgers and inventories from lesson
13, then the committed smoke traces in all four ports. When a Quint input
changed (any `.qnt`, a replay module, a manifest, even a comment), the same
job also recomputes every committed artifact with pinned Quint
(`make fixtures-check`), and a second job runs the lesson 12 differential in
four shards. These are gates on a change, not a completion claim.

**The full workflow**, `formal-full.yaml`, runs weekly on `main` and on demand
for any branch. Its jobs are the six stages of lesson 1 as separate lanes:
`check-models` (`make formal-check`: typecheck and run every model, every
regression, every challenge; budget 150 minutes), `generate` (`make
formal-generate`: the corpus and the witness evidence), one parity lane per
port (`make formal-ts`, `formal-go`, `formal-rust`, `formal-python`), three
sharded mutation lanes (Docker for the real-Redis vectors), `symbolic` (`make
model-check` with Apalache) and, when selected, `exploration` with a fresh
seed. Parity and mutation lanes wait only for `generate`; the aggregate
`formal-full` requires every lane. A behavior, model or replay change needs
this workflow green on its branch before merge, and the PR body says which
run.

Locally you rarely need all of it. Match the target to the edit:

| You changed | Run before pushing | About |
| --- | --- | --- |
| Prose in a guide or this course | `make audit`, `corepack pnpm docs:check`; re-key a reviewed guide (lesson 13) | 3 s + 2 s |
| A model or kernel module | `quint test` on the model, `node formal/tools/generate-artifacts.mjs --write`, `make audit`, `make differential`; then `make formal-check` and the full workflow | minutes locally; `formal-check` is long |
| A replay module or a driver | `make smoke`, then `make formal-generate` and `make formal-<port>` | 30 s for smoke once Rust is built |
| A port's library code | `make check-<port>`, `make smoke` | minutes |

Two habits keep this cheap. Keep `.formal-traces/` as the only place generated
corpora and reports go; nothing there is committed. And read a red lane from
its first failing step: `validation.mjs` prints `→ <step>` before each command,
so the step name tells you which lesson's check fired.

## See it in the repo

- **[formal.yaml](../../../.github/workflows/formal.yaml)**, lines 15 to 40: the
  `quint` job (`make audit smoke`, conditional `make fixtures-check`); lines 62
  to 90: the `differential` job on pull requests. -
  **[formal-full.yaml](../../../.github/workflows/formal-full.yaml)**: the job
  list (`exploration`, `check-models`, `generate`, the four parity jobs,
  `symbolic`, the three mutation lanes with their merge jobs, `formal-full`) and
  the `timeout-minutes` budget on each. -
  **[validation.mjs](../../tools/validation.mjs)**, lines 11 to 12: `check` and
  `formal` as lists of other targets; line 195: the five checks of `audit`;
  lines 197 to 201: its fixture, style (`check-style.mjs`), course, read-view
  and scope steps; line 202: `smoke`; line 212: `formal-check`. -
  **[../VALIDATION.md](../VALIDATION.md#choosing-a-run)**, "Choosing a run": the
  task-to-command table, and the rest of the page for reading a completion
  report and a mutation report. - **[../../README.md](../../README.md)**: the
  "Run it" command list with one line per target.

## Try it (3 min, plus an optional 1 min)

1. List the targets:

   ```sh
   make help
   ```

   About forty lines; find `make audit`, `make smoke`, `make formal-check` and
   the prerequisites paragraph at the end.

2. Run the audit lane (about 3 s, Node only):

   ```sh
   make audit
   ```

   You should see nine `→` steps, from `→ Check execution` to
   `→ Check conditional fixture regeneration scope`, and `✓ audit completed`.

3. Optional (about 30 s once Rust has been built; the first Rust build adds
   half a minute or more): the smoke lane in all four ports:

   ```sh
   make smoke
   ```

   You should see four `→` steps (TypeScript, Go, Rust, Python) and
   `✓ smoke completed`. The Python step reports `283 passed`.

## Recap

- **A lane is a `make` target and a CI job running the same command;** `make
  help` is the list.
- **PR lanes are fast gates** (`audit smoke`, plus fixture recomputation and
  the differential when Quint inputs change); the weekly full workflow is the
  completion claim.
- **Match the target to the edit,** and read a red lane from its first `→`
  step.

**Next:** [15. Capstone, part 1: follow a contract and plan a change](./15-capstone-plan.md)

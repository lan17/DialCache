# 9. Go, Rust and Python mirror it (10 min)

**What you get:** the same driver shape in three more languages, talking to
the same coordinator over JSON lines, so you can replay one history in any
port and read the result.

## The idea

Lesson 8's driver had four duties: apply a command to the real cache, control
the external effects, settle, and report an observation with a receipt. Every
other port has a type with those same four duties, and one more piece
TypeScript did not need: a transport that starts
`node formal/replay/coordinator.mjs` as a child process and speaks the lesson 7
protocol over its stdin and stdout.

| Duty | Go | Rust | Python |
| --- | --- | --- | --- |
| Apply a command | `behaviorDriver.apply`, [behavior_driver_test.go](../../../go/behavior_driver_test.go) line 671 | `Driver::apply`, [driver.rs](../../../rust/tests/formal/driver.rs) line 497, with `begin` at 759 | `BehaviorDriver.apply`, [driver.py](../../../python/tests/formal/driver.py) line 405, with `begin` at 327 |
| Settle | `settle`, line 543 | `settle`, line 711 | `settle`, line 522 |
| Report | `observation` 519, `receipt` 528 | `observation` 1002, `receipt` 1006 | `observe` 531, `receipt` 534 |
| Transport | `replayCoordinator` in [replay_coordinator_test.go](../../../go/replay_coordinator_test.go): `prepare` 183, `replay` 234 | `Coordinator` in [transport.rs](../../../rust/tests/formal/transport.rs): `spawn` 96, `call` 187, `prepare` 253 | `Coordinator` in [coordinator.py](../../../python/tests/formal/coordinator.py): `request` 31, `replay` 53 |

The transports share three habits. Request ids strictly increase for the life
of the child process. Each observation and receipt is validated locally
against the schema definition `prepare` named, so a shape defect is caught on
the port's side before a round trip. And a real-time watchdog kills a child
that leaves a request pending, because replay I/O must never consume a
history's virtual time.

What differs is how each language reaches quiescence, the settlement rule from
lesson 7. Go runs each history inside a `synctest` bubble and waits until
every goroutine is blocked; its receipt counts the deferred functions still
pending. Rust runs the cache on a deterministic test executor it drains by
hand. Python's harness has a small `Executor` with its own clock. The library
side of each port exposes just enough of its scheduling (Go's `Defer` hook,
for instance) for the driver to drain it without guessing turn counts or
advancing deadline time.

Node 24 is a test-tool dependency for all three ports: the coordinator and the
witness evaluator are Node scripts the native test run spawns. The libraries
themselves need no Node. When your default `node` is another version, put Node
24 first on PATH; the Rust transport's header comment says the same.

Selecting one history works the same way everywhere: `DIALCACHE_FEATURE_PROFILE`
names the profile and `DIALCACHE_FEATURE_TRACE_FILE` one trace file; without
selectors each port replays the committed smoke traces. Python selects a
profile with `DIALCACHE_PYTHON_PROFILE`.

## See it in the repo

- **Go:** [behavior_driver_test.go](../../../go/behavior_driver_test.go) lines
  1 to 4, the same no-prediction rule as TypeScript; `apply` from line 671
  (`begin` builds a real `Operation` and calls `GetOrLoad`).
  [feature_replay_test.go](../../../go/feature_replay_test.go),
  `TestFeatureConformance`: the selectors and the per-profile coordinator.
- **Rust:** [conformance.rs](../../../rust/tests/conformance.rs), header lines
  1 to 10: what the harness replays with and without selectors and the
  `DIALCACHE_RUST_SUITE` switch. [transport.rs](../../../rust/tests/formal/transport.rs),
  lines 1 to 13: the Node 24 requirement.
- **Python:** [test_conformance.py](../../../python/tests/test_conformance.py),
  lines 13 to 29: `test_profile_smoke` over every registered profile, or the
  one named by `DIALCACHE_PYTHON_PROFILE`.
- **[../PORTING.md](../PORTING.md#what-a-port-supplies)**, "What a port
  supplies": the driver operations table, with the settlement row.

## Try it (4 min, pick one port or all three)

Each command replays the source-budgets smoke trace. Have Node 24 on PATH.

1. **Go** (about 2 s after the first build):

   ```sh
   go -C go test -count=1 -run '^TestFeatureConformance/source-budgets/' ./...
   ```

   You should see `ok  	github.com/lan17/DialCache/go	...s`.

2. **Python** (a few seconds), with the virtual environment from the setup
   notes; add `NODE=/path/to/node24` in front if `node` is not Node 24:

   ```sh
   DIALCACHE_PYTHON_PROFILE=source-budgets \
     python/.venv/bin/python -m pytest python/tests/test_conformance.py -k test_profile_smoke -q
   ```

   You should see `1 passed, 252 deselected`.

3. **Rust** (about 30 s to build the first time, then seconds). The harness
   also runs the committed core and effects histories and the protocol
   vectors, hence the case count:

   ```sh
   cd rust
   DIALCACHE_RUST_SUITE=generated DIALCACHE_FEATURE_PROFILE=source-budgets \
     cargo test --locked --all-features --test conformance
   cd ..
   ```

   You should see `rust conformance: 1480 cases, 0 failed, status passed`.

4. Optional: replay the lesson 6 export in Go instead of the smoke trace. Add
   `DIALCACHE_FEATURE_PROFILE=source-budgets DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/course/source-budgets/heldPolicyDoesNotSpendSourceBudgetTest.itf.json"`
   in front of the Go command. Same `ok` line; the history came from your
   export, not from the repository.

## Recap

- **Four duties, three more languages:** apply, settle, report, and a JSON
  lines transport to the one shared coordinator.
- **Quiescence is language-specific** (synctest, a deterministic executor, a
  test executor) but the receipt it produces is the same record everywhere.
- **Selectors are shared:** a profile name and one trace file replay the same
  history in any port, and Node 24 is test tooling only.

**Next:** [10. Witnesses and coverage](./10-witnesses.md)

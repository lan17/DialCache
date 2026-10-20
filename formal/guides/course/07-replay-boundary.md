# 7. The replay boundary (10 min)

**What you get:** why a port cannot pass by predicting its own results: the
split between the coordinator, which holds the predictions, and the driver,
which holds the real cache.

## The idea

Replay is a conversation between two programs. The
[coordinator](../GLOSSARY.md#coordinator) is one shared Node program,
[formal/replay/coordinator.mjs](../../replay/coordinator.mjs). It reads a
history, keeps the model's predictions to itself, and sends the driver only
three kinds of thing: the fixture (how to configure the cache), the setup
commands, and then one step's external commands at a time. The
[driver](../GLOSSARY.md#driver) is the per-port test harness. It builds a real
cache from the fixture, applies each command through the public API, and
reports what actually happened as an observation. The coordinator compares
that observation with the prediction for the step and either returns the next
commands or fails.

Why does this split matter? If the driver could see the expected observation, a
port could pass by echoing it, or by nudging its own state toward it. Here the
wire replies contain no predictions at all (the comment at the top of the
coordinator says exactly that), so the only way to pass is to behave the same.
This is [model-based testing](https://en.wikipedia.org/wiki/Model-based_testing)
in the strict form Quint's own
[guide](https://quint.sh/docs/model-based-testing) describes: the model
generates the tests and judges the results, and the implementation only runs.

The protocol is small: [JSON Lines](https://jsonlines.org/), one JSON object per
line, with `version: 1` and a strictly increasing `id`. Four operations:

| Request | What comes back |
| --- | --- |
| `profiles` | The supported profiles, their action names, the settlement contract name |
| `prepare` with `profile` and `path` | A session id, the fixture, the setup commands, the action list and step count, and the names of the schema definitions the driver's records must satisfy |
| `observe` with `session`, `index`, `observed`, `environment` and, for behavior profiles, `receipt` | Either the next step's `inputs` or `complete: true` |
| `discard` | Releases an unfinished session |

Two checks run before any comparison. The observation's shape is validated
against [protocol.schema.json](../../replay/protocol.schema.json); a malformed
record is an infrastructure error (`Malformed replay observation`), never a
mismatch, so a broken driver cannot earn credit for a fault. Then the
[settlement receipt](../GLOSSARY.md#settlement-and-settlement-receipt) is
checked: the driver attests that after the command it drained everything that
could run (`runnable: 0`), that its monotonic clock moved only by the `advance`
commands, and which external gates it still holds. The contract is named
`causally-ready-v1`; a violated rule fails as `Settlement violation`, again
without comparison markers.

Only then does the coordinator compare. On a mismatch you get both sides:
`expected: {...}` and `actual: {...}`, with the history path, step index and
action in front.

## See it in the repo

- **[coordinator.mjs](../../replay/coordinator.mjs)**, lines 13 to 14: the
  one-sentence design rule (`retains predictions`). Lines 65 to 86: what
  `prepare` returns. Lines 96 to 147: the order of checks on `observe` (shape,
  receipt, comparison, next commands); line 141 says it again (`Predictions
  never choose commands`). -
  **[protocol.schema.json](../../replay/protocol.schema.json)**: the `$defs` for
  `request`, `command`, `behaviorObservation` (line 1780), `settlementReceipt`
  (line 2090) and `behaviorFixture` (line 2165). The schema file, not the
  version number, is the compatibility unit. -
  **[../PORTING.md](../PORTING.md#shared-coordinator-protocol)**, "Shared
  coordinator protocol" and "[Observation
  contract](../PORTING.md#observation-contract)": every field of an observation,
  the fixture sentinels, and the receipt rules R1 to R5. -
  **[../../replay/README.md](../../replay/README.md)**: the coordinator, the
  profile descriptors and the witness classifiers, one line each; nothing in
  that directory names a port.

## Try it (4 min)

Play the driver yourself. Send a `prepare`, then the observation after setup
(nothing has happened yet), then the observation after the first command, then
a deliberately wrong one.

1. Write the four requests to a scratch file:

   ```sh
   mkdir -p .formal-traces/course
   cat > .formal-traces/course/requests.jsonl <<'EOF'
   {"version":1,"id":1,"op":"prepare","profile":"source-budgets","path":"formal/generated/source-budgets-smoke.itf.json"}
   {"version":1,"id":2,"op":"observe","session":"1","index":0,"settlement":"causally-ready-v1","observed":{"calls":[],"loaders":0,"reads":0,"writes":0,"invalidations":0,"maintenance":[],"loads":0,"dumps":0,"policyCalls":0,"classifications":0,"comparisons":0,"sourceScopes":[],"writeTtls":[],"shadow":[],"recovery":[]},"environment":{"wallMs":1788868800000},"receipt":{"elapsedMs":0,"runnable":0,"held":{"loaders":0,"reads":0,"writes":0,"dumps":0,"loads":0,"policies":0,"scopes":0}}}
   {"version":1,"id":3,"op":"observe","session":"1","index":1,"settlement":"causally-ready-v1","observed":{"calls":[{"status":"pending"}],"loaders":0,"reads":0,"writes":0,"invalidations":0,"maintenance":[],"loads":0,"dumps":0,"policyCalls":1,"classifications":0,"comparisons":0,"sourceScopes":[],"writeTtls":[],"shadow":[],"recovery":[]},"environment":{"wallMs":1788868800000},"receipt":{"elapsedMs":0,"runnable":0,"held":{"loaders":0,"reads":0,"writes":0,"dumps":0,"loads":0,"policies":1,"scopes":0}}}
   {"version":1,"id":4,"op":"observe","session":"1","index":2,"settlement":"causally-ready-v1","observed":{"calls":[{"status":"pending"}],"loaders":0,"reads":0,"writes":0,"invalidations":0,"maintenance":[],"loads":0,"dumps":0,"policyCalls":1,"classifications":0,"comparisons":0,"sourceScopes":[],"writeTtls":[],"shadow":[],"recovery":[]},"environment":{"wallMs":1788868800000},"receipt":{"elapsedMs":0,"runnable":0,"held":{"loaders":0,"reads":0,"writes":0,"dumps":0,"loads":0,"policies":0,"scopes":0}}}
   EOF
   ```

2. Feed them to the coordinator:

   ```sh
   node formal/replay/coordinator.mjs < .formal-traces/course/requests.jsonl
   ```

   You should see four reply lines. The first is the `prepare` result: the
   fixture (`"fallbackTimeoutMs":10`), the one setup command
   (`holdPolicies`), eight action names, `"steps":8`, and no predicted
   observation anywhere. The second returns `"inputs":[{"op":"begin"}]`: the
   first command. The third returns the next command,
   `{"op":"release","effect":"policy","index":0}`. The fourth is
   `"ok":false` with `Observation mismatch`: releasing the policy should have
   started a loader, but the observation still says `"loaders":0`. The error
   shows `expected` and `actual` side by side.

   Note what you never saw: the coordinator's replies carried commands and
   acknowledgements only.

## Recap

- **The coordinator keeps the predictions; the driver keeps the cache.** Wire
  replies carry fixture, setup and commands, never an expected observation.
- **Shape and settlement are checked before comparison,** and their failures
  are infrastructure errors, not mismatches, so a broken driver earns no credit.
- **A mismatch names the step and shows both sides,** which is the unit of
  debugging for every lesson that follows.

**Next:** [8. The TypeScript driver](./08-typescript-driver.md)

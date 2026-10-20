# 10. Witnesses and coverage (10 min)

**What you get:** how the suite knows that random histories reached the
corners that matter, and why that question is kept separate from whether a
port passed.

## The idea

Lessons 7 to 9 showed a port passing a replay; this lesson asks whether the
replay asked anything hard. Random exploration finds combinations nobody wrote
down. By chance it can also stop reaching a corner that used to be covered,
and every port would still pass, because nothing asked it the hard question.
The witness mechanism turns "was the corner reached" into a checked
requirement.

A [witness](../GLOSSARY.md#witness-label-and-classifier) is a required label:
a boundary, outcome or race, named per profile in
[coverage-witnesses.json](../../catalogs/coverage-witnesses.json). A
classifier is the per-profile module under
[formal/replay/witnesses/](../../replay/witnesses/) that reads every history
in the corpus and credits labels.

One rule keeps classifiers honest. They read only the recorded `input`
commands and the public observation `s.o`, never a driver's output and never
a private model field. So a witness answers "was the corner reached in the
model's histories", and the replay answers, separately, "did the port match
it". Neither claim leaks into the other.

The source-budgets classifier is a list of public-prefix rules. One rule names
a command sequence and the checkpoints that must hold at given steps:

```js
rule("policy-wait-does-not-spend-source-budget", "heldPolicyDoesNotSpendSourceBudgetTest",
  [init(2), begin(0), advance(100), policy(0), advance(9), resolve(1), begin(0), policy(1)],
  check(2, { calls: [0], loaders: 0, policyCalls: 1 }),
  check(4, { calls: [0], loaders: 1 }),
  check(7, { calls: [1, 1], loaders: 1, policyCalls: 2 })),
```

A history earns the label only if it starts with exactly those eight commands
and shows those observations at steps 2, 4 and 7. Step 2 is the point: 100 ms
passed with no loader, so the budget has not started. A label cannot be earned
by an action name or a fixture alone. The consequence has to be visible.

Evaluation runs once per generation over the whole corpus, sampled histories
and exported regressions together (`node formal/tools/witnesses.mjs evaluate`).
It writes one evidence file per profile with the corpus and input hashes. A
missing required label fails generation.

A second file, [witness-baseline.json](../../catalogs/witness-baseline.json),
records how many sampled histories hit each label on the pinned seed. A label
that drops below half its recorded count fails too. That is how a corpus that
quietly stops reaching a corner becomes visible, even while the named
regression keeps the label present. For source-budgets every required label is
pinned by a regression and sampled zero times, so none is gated; the report
says which labels are in that state.

## See it in the repo

- **[witnesses/source-budgets.mjs](../../replay/witnesses/source-budgets.mjs)**,
  lines 9 to 45: `sourceBudgetsWitnessRules`, the seven rules, one per required
  label. Lines 29 to 33 are the rule above,
  `policy-wait-does-not-spend-source-budget`.
- **[witnesses/public-prefix.mjs](../../replay/witnesses/public-prefix.mjs)**,
  lines 15 to 41: the evaluator for such rules, reading `input` and `s.o` only.
- **[witnesses/index.mjs](../../replay/witnesses/index.mjs)**, lines 64 to 85:
  `evaluateCorpus`, which classifier runs for which profile. Lines 131 to 141:
  `checkCorpus`, the completion gate: every required label and every declared
  action must be reached.
- **[coverage-witnesses.json](../../catalogs/coverage-witnesses.json)**, key
  `source-budgets`: the seven required labels.
- **[../PORTING.md](../PORTING.md#witness-evidence)**, "Witness evidence": the
  evidence file fields and the baseline rules.

Read more: [../SEMANTIC-COVERAGE.md](../SEMANTIC-COVERAGE.md#generated-boundary-evidence),
"Generated boundary evidence", says what a witness establishes and what it
does not.

## Try it (3 min)

1. Run the source-budgets classifier over a corpus of one history, the
   committed smoke trace, and read what it credits and what it misses:

   ```sh
   node --input-type=module -e '
   import { checkWitnesses } from "./formal/replay/witnesses/index.mjs";
   const result = checkWitnesses("source-budgets", ["formal/generated/source-budgets-smoke.itf.json"]);
   console.log("seen:", [...result.seen].sort().join(", "));
   console.log("missing:", result.missing.join(", "));
   console.log("provenance:", JSON.stringify(result.provenance["late-follower-keeps-leaders-remaining-source-budget"]));'
   ```

   You should see:

   ```text
   seen: action:advance, action:beginCall, action:init, action:releasePolicy, late-follower-keeps-leaders-remaining-source-budget
   missing: action:resolveLoader, action:rejectLoader, outside-calls-skip-source-deadlines-sharing-and-publication, default-source-budget-expires-at-sixty-seconds, unbounded-enabled-source-publishes-after-sixty-seconds, policy-wait-does-not-spend-source-budget, invalid-enabled-key-preserves-source-deadline, abandoned-source-cannot-replace-successful-retry
   provenance: [{"name":"source-budgets-smoke.itf.json","checkpoints":[5,6,7]}]
   ```

   The smoke trace is the late-follower regression, so it earns exactly that
   label, credited at its three checkpoints. One history cannot reach seven
   corners, which is why the gate runs over the whole corpus: on the real
   corpus `missing` must be empty.

## Recap

- **A witness is a required label; a classifier credits it** from recorded
  commands and public observations only, so reachability and port correctness
  stay separate questions.
- **A label needs the visible consequence,** not an action name or fixture.
- **Evaluation runs over the whole corpus once per generation,** and a baseline
  catches a corner that random sampling quietly stops reaching.

**Next:** [11. Challenges and native mutants](./11-challenges-and-mutants.md)

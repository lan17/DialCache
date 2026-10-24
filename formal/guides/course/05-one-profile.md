# 5. One profile end to end: source-budgets (10 min)

**What you get:** how to read a conformance profile from top to bottom: its
bounds, its stable codes, the explicit `input` record, its public actions, its
invariants and its runs. Lessons 6 to 17 all use this one profile.

## The idea

Lessons 3 and 4 covered the shared rules; this lesson reads one whole profile
built from them. A [profile](../GLOSSARY.md#profile-conformance-profile) is a
Quint model whose public actions correspond one to one with commands a port's
test driver can execute. Begin a call, release a held policy reply, resolve a
loader, advance the clock. That correspondence is what lets every port replay
the same histories.

[dialcache-source-budgets-conformance.qnt](../../models/dialcache-source-budgets-conformance.qnt)
is the smallest composed profile. It has one local key, no remote layer, eight
calls, and three source budgets: the 60 s default, unbounded, and a finite
10 ms. Read it in the order the file is written.

**The header** ([lines 10 to
19](../../models/dialcache-source-budgets-conformance.qnt)) states the contracts
(`C01`, `C23` to `C27`), what is in scope, and what is deliberately out:
remote I/O, request memo, shadow work. A profile bounds callers, keys,
capacities and time on purpose, and the header says so.

**The codes** ([lines 21 to
38](../../models/dialcache-source-budgets-conformance.qnt)) are integers the
drivers decode: `FINITE_BUDGET_MODE = 2`, `ENABLED = 0`, `OUTSIDE = 1`. They are
part of the replay contract, so the comment says "keep these codes stable". The
`LAYOUT` record tells the kernel the geometry: one key per instance, no
persistent request contexts, a policy provider installed.

**The state** ([lines 43 to
69](../../models/dialcache-source-budgets-conformance.qnt)) is one flat record,
`var s`, whose fields are exactly what the composed kernel shapes need, plus
`var input: { name: str, choice: int }`. The comment at [line
66](../../models/dialcache-source-budgets-conformance.qnt) draws the line that
matters most. `s.o` is the public observation a driver is compared against. The
rest (`owners`, `processFlights`, `localValues`) is model-owned prediction that
a driver may never read.

**The actions** ([lines 116 to
158](../../models/dialcache-source-budgets-conformance.qnt)) come in pairs,
`beginCall` and its public `begin` among them. The parameterized one is the
rule; the public one picks an input:

```quint
action begin(kind: int): bool = all {
  s.o.calls.length() < MAX_CALLS,
  input' = { name: "beginCall", choice: kind },
  s' = Deadlines::admitLocal(s, LAYOUT, call(kind))
}
action beginCall = {
  nondet choice = Set(ENABLED, OUTSIDE, INVALID_KEY, OUTSIDE_INVALID_KEY).oneOf()
  begin(choice)
}
```

Every transition records its command in `input`, so a replay never infers
what happened from changed cache state. The `advance` choices,
`Set(1, 3, 6, 9, 10, 100, 59999, 60001)`, let random histories land exactly on
the 10 ms budget, the 60 s default and the 1 s local TTL.

**The invariants** ([lines 160 to
213](../../models/dialcache-source-budgets-conformance.qnt)) are stated without
calling the kernel transitions they check. `acceptedSourceRespectsItsOwnStart`,
for one, compares each accepted source's recorded settlement instant with its
recorded start and budget. It restates the inequality itself instead of asking
the deadline module whether the source was still pending.

**The runs** ([lines 215 to
305](../../models/dialcache-source-budgets-conformance.qnt)) are the exported
regressions, each a `run` whose name ends in `Test`. Lesson 1's rule is
`heldPolicyDoesNotSpendSourceBudgetTest` at [line
242](../../models/dialcache-source-budgets-conformance.qnt): hold the policy for
100 ms, release, take 9 of the 10 ms budget, and expect `VALUE_ONE` served twice
from one loader.

One more model watches this one. A
[connection model](../GLOSSARY.md#connection-model),
[dialcache-source-connection.qnt](../../models/dialcache-source-connection.qnt),
imports the profile as its only executing machine. It rebuilds each source's
start, budget and owner from the external events alone, then checks the
profile's own records against that reconstruction. It is a bounded cross-check,
not a proof of refinement.

## See it in the repo

- **[dialcache-source-budgets-conformance.qnt](../../models/dialcache-source-budgets-conformance.qnt)**,
  [lines 77 to 84](../../models/dialcache-source-budgets-conformance.qnt): the
  decoders `configuredBudget`, `call` and `resolvedSource`. The comment above
  them says how a resolve choice packs a source and a value into one integer,
  `id * 2 + value`; lesson 16 uses that.
- **[dialcache-source-connection.qnt](../../models/dialcache-source-connection.qnt)**,
  lines 44 to 50: `sourceOriginsMatchContract`. Lines 36 to 41: how the
  connection records the pre-state and advances the imported profile in one
  `all` step.
- **[../../catalogs/execution.json](../../catalogs/execution.json)**: the entry
  with `"profile": "source-budgets"` schedules its six invariants and its
  generation bounds: 256 sampled histories of at most 60 steps.
- **[../../generated/PROFILES.md](../../generated/PROFILES.md#source-budgets)**,
  the source-budgets section: the same codes decoded into driver commands, one
  row per action. This view is generated; the model is the source.
- **[../WALKTHROUGH.md](../WALKTHROUGH.md#read-the-named-run-first)** reads the
  same run step by step, with the kernel definitions to open next.

## Try it (4 min)

1. Run the ten regressions:

   ```sh
   quint test formal/models/dialcache-source-budgets-conformance.qnt --backend=rust --max-samples=1
   ```

   You should see ten `ok` lines, among them
   `heldPolicyDoesNotSpendSourceBudgetTest`, and `10 passing`.

2. Sample the six invariants with the check lane's bounds (about three
   seconds):

   ```sh
   quint run formal/models/dialcache-source-budgets-conformance.qnt --backend=rust \
     --max-samples=2000 --max-steps=40 \
     --invariants outsideSourcesHaveNoDeadline acceptedSourceRespectsItsOwnStart registeredWorkIsNotAbandoned \
       localPublicationRequiresAcceptedSource followersKeepTheirOwnersOutcome onlyEnabledValidCallsResolvePolicy
   ```

   You should see `[ok] No violation found`. The exact commands the lane runs,
   seed included, are printed by `node formal/tools/run-models.mjs check --dry-run`.

## Recap

- **A profile's public actions are driver commands,** each recording its
  command in `input`; its integer codes are a stable contract.
- **`s.o` is the only part of the state a driver is compared against;** the
  rest is prediction.
- **Invariants are stated without calling the transitions,** and a connection
  model rebuilds the profile's facts from external events as a second check.

**Next:** [6. Histories, ITF and the smoke traces](./06-histories-and-itf.md)

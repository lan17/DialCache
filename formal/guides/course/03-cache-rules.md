# 3. cache-rules.qnt, the judgment layer (10 min)

**What you get:** the one 65-line file every model imports, why the strict
inequalities live there once, and how a second model keeps that file honest.

## The idea

Most cache bugs that matter across ports are off-by-one decisions: is an entry
live *at* its expiry instant or only before it; does a source that settles
exactly at its deadline count as accepted; does a frame stamped equal to the
invalidation watermark pass. Each of those is a yes-or-no decision over a few
integers. The tree calls such a decision a
[judgment](../GLOSSARY.md#judgment-judged-once-and-applied-from-a-judgment).

[cache-rules.qnt](../../models/cache-rules.qnt) holds the judgments every
model consumes: age, expiry, deadline and fence. Written once, thirty models
cannot disagree about `<` versus `<=`. The deadline rule, for example:

```quint
pure def deadlinePendingAt(observed: int, deadline: int): bool = observed < deadline
pure def sourceAcceptsAt(started: int, settled: int, budget: int): bool =
  budget < 0 or deadlinePendingAt(settled, started + budget)
```

Read it in plain words: a negative budget means unbounded; otherwise a result is
accepted only if it settled strictly before start plus budget. Equality belongs
to the timeout. Compare the fence rule, `fenceAllows(created, watermark) =
created > watermark`: a frame stamped at the
[watermark](../GLOSSARY.md#fence-watermark-and-marker) is fenced out, so an
invalidation at the same millisecond as a write still wins.

A shared helper has a cost: if the helper itself is wrong, every model that
uses it is wrong together, and no invariant written in terms of the same
helper would notice. Two things guard against that.

First, the companion model
[dialcache-rule-checks.qnt](../../models/dialcache-rule-checks.qnt) applies
each judgment to a small finite domain and states the expected inequality
again, independently, without calling the helper:

```quint
val sourceBoundaryIsExclusive = actual.source == (c.budget < 0 or c.settled - c.started < c.budget)
```

This is the one model the suite proves with Apalache (`make model-check`,
Java 21 required): every combination in the declared domain, not a sample.

Second, the challenge catalog (lesson 11) deliberately flips `<` to `<=` in
cache-rules.qnt and requires a named invariant to catch it.

Beside the profiles sit five
[verification models](../GLOSSARY.md#verification-model) (core traversal,
runtime policy, tracked invalidation, stale recovery, the Redis protocol).
They isolate one safety boundary each, share these judgments, and are checked
with `quint run` but never replayed by a port, because their actions are not
driver commands.

## See it in the repo

- **[cache-rules.qnt](../../models/cache-rules.qnt)**, lines 22 to 29: fresh and
  recovery age (`created <= observed and observed - created < ceiling`, so a
  future-stamped frame is rejected). Lines 43 to 49: local expiry
  (`localEntryLiveAt`) and the whole-millisecond grid. Lines 51 to 56: the
  deadline (`deadlinePendingAt`). Lines 58 to 64: the fence, and
  `readFenceAllows`, which lets untracked reads ignore the watermark. -
  **[dialcache-rule-checks.qnt](../../models/dialcache-rule-checks.qnt)**, lines
  42 to 49: the seven boundary invariants, from `freshBoundaryIsExclusive` on.
  Lines 51 to 54: `exactBoundariesRejectTest`, one state where every boundary
  sits exactly on its edge and every judgment says no. -
  **[../SPEC.md](../SPEC.md#definition-ownership-and-executable-connections)**,
  "Definition ownership and executable connections": which file owns which
  decision, and why boundary assertions "state inequalities directly". -
  **[../../models/README.md](../../models/README.md)**: the shared helpers and
  the verification models, one line each.

## Try it (4 min)

1. Evaluate two judgments by hand in Quint's REPL, with cache_rules preloaded.
   The REPL accepts piped input only with the TypeScript backend:

   ```sh
   printf 'sourceAcceptsAt(100, 109, 10)\nsourceAcceptsAt(100, 110, 10)\nfenceAllows(5, 5)\nfenceAllows(6, 5)\n' \
     | quint -r formal/models/cache-rules.qnt::cache_rules --backend=typescript -q
   ```

   You should see `true`, `false`, `false`, `true`: 9 ms into a 10 ms budget
   is accepted, 10 ms is not; a frame stamped at the watermark is fenced, one
   millisecond later passes.

2. Run the boundary model's three named runs:

   ```sh
   quint test formal/models/dialcache-rule-checks.qnt --backend=rust --max-samples=1
   ```

   You should see `3 passing`.

3. Optional (10 s): sample the boundary invariants, which is what the check
   lane does without Apalache:

   ```sh
   quint run formal/models/dialcache-rule-checks.qnt --backend=rust --max-samples=2000 --max-steps=5 \
     --invariants freshBoundaryIsExclusive recoveryBoundaryIsExclusive sourceBoundaryIsExclusive fenceBoundaryIsExclusive
   ```

   You should see `[ok] No violation found`.

## Recap

- **A judgment is a pure yes-or-no decision** over integers; cache-rules.qnt
  states age, expiry, deadline and fence once, strict at every boundary.
- **Sharing needs an independent check:** rule-checks restates each inequality
  without the helper and is the one model Apalache proves.
- **Verification models isolate one boundary each** and are sampled, never
  replayed.

**Next:** [4. The kernel library and composition](./04-kernel-and-composition.md)

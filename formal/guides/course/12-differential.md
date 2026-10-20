# 12. The differential and behaviorVersion (10 min)

**What you get:** how a rewrite of a profile proves it changed nothing a
driver can observe, and how an intended change of behavior is declared instead
of slipping through.

## The idea

Lesson 4 moved rules out of the profiles into the kernel. Every such move is a
rewrite of a profile's text, and a rewrite is exactly where an accidental
behavior change hides: the sampled corpus looks fine, every regression still
passes, and yet some step now predicts a different observation. The
[differential](../GLOSSARY.md#differential) is the check built for that: a form
of [differential testing](https://en.wikipedia.org/wiki/Differential_testing),
two texts of the same profile replaying each other's corpus.

It takes two texts of the same profile: the reference, which is the merge base
with `origin/main`, and the candidate, your working tree. From each text it
generates the profile's sampled corpus and exports its regressions, with the
same manifest entry, seed and bounds the generation lane uses. Then it replays
in both directions. Every reference history runs through the candidate text as
a deterministic schedule of its public inputs, and every channel the drivers
assert (the observation `s.o` and any side channels) is compared at every
step. Every candidate history runs through the reference text the same way, so
a candidate that newly accepts an input the reference refused also disagrees.
One mismatch fails the run.

Two more bounds ride along. Trace bytes per state may grow at most 1.2 times
over the reference, so a composition cannot quietly make the corpus heavier; a
profile that must carry more state declares its own
`differential.maxBytesPerStateRatio`, with the reason recorded in
[HISTORY.md](../HISTORY.md). Generation wall time is reported but only
advisory.

When the change is intended, you say so where the check reads: bump the
model's `differential.behaviorVersion` in
[execution.json](../../catalogs/execution.json) in the same change (or the
profile's observation `version` in profiles.json when the asserted channels
themselves change). The differential then reports the profile as an intended
divergence instead of comparing it, and the reviewer sees the declaration next
to the diff. This is migration evidence, not conformance: the parity lanes
still replay the full corpus in every port.

The pull request lane runs `make differential` as four shards whenever any
Quint input changes, a comment included. Each shard first checks the
composition lint baseline and the kernel fixtures, then replays its share of
the composed profiles, so a kernel-only edit is measured through every profile
that imports it.

## See it in the repo

- **[differential.mjs](../../tools/differential.mjs)**, lines 19 to 45: the
  design in the header comment, including why replays are batched sixteen
  histories per `quint test` process.
- **[execution.json](../../catalogs/execution.json)**: search for
  `"differential"`. Five profiles declare a `maxBytesPerStateRatio` (effects
  1.45, recovery 1.85, shadow 1.8, admission 1.65, local-failure 1.45); none
  currently declares a `behaviorVersion`, so any observable change today would
  fail until one is added.
- **[kernel/README.md](../../models/kernel/README.md#migrating-a-profile)**,
  "Migrating a profile": the command, the bound, and what is and is not
  protected by this tool (private state is protected by invariants and
  witnesses, not here).
- **[../VALIDATION.md](../VALIDATION.md#choosing-a-run)**, the `make
  differential` row and the paragraph on the four PR shards.
- **[../GLOSSARY.md](../GLOSSARY.md#bytes-per-state)**: bytes per state, and
  the admission reference every new profile is measured against.

## Try it (3 min, with an optional 1 min)

1. Run the differential for source-budgets on a clean tree:

   ```sh
   node formal/tools/differential.mjs source-budgets --reference=origin/main
   ```

   You should see two lines: `Reference <sha>; profiles: source-budgets.` and
   `source-budgets: not compared (identical import closure and generation settings).`
   Nothing in the profile's import closure differs from the merge base, so
   there is nothing to compare.

2. Optional (about 30 s): make the closure differ without changing behavior.
   Append a comment to the model, run again, then restore the file:

   ```sh
   printf '// scratch\n' >> formal/models/dialcache-source-budgets-conformance.qnt
   node formal/tools/differential.mjs source-budgets --reference=origin/main
   git checkout -- formal/models/dialcache-source-budgets-conformance.qnt
   ```

   This time both texts generate and replay. The last lines read
   `source-budgets: forward 266 of 266 reference histories agree through the candidate (256 sampled, 10 regressions); reverse 266 of 266 candidate histories agree through the reference`
   followed by `bytes/state 2279 -> 2279 (x1.000, bound x1.20 (default))`.
   The 266 are the 256 sampled histories plus the 10 exported regressions.

## Recap

- **The differential replays both corpora through both texts** and compares
  every driver-asserted channel at every step; one mismatch fails it.
- **An intended change is declared** by bumping `differential.behaviorVersion`
  beside the edit, never by editing the comparison.
- **It is migration evidence,** bounded by bytes per state, and the parity
  lanes still replay everything in every port.

**Next:** [13. Catalogs and ledgers](./13-catalogs-and-ledgers.md)

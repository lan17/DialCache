# 17. Capstone, part 3: the ripple, the fixes and the undo (10 min)

**What you get:** every gate the one-run change from part 2 trips, in the
order the audit lane meets them, with the fix each one names; then the undo
that leaves your tree clean. This is step 5 of the plan.

## The idea

Nothing about the new run is wrong, yet three checks turn red. That is the
design from lesson 13 working as intended: a model edit must not outrun the
artifacts and ledgers that describe it, and each check says what to do.

**The fixture lock.** `generated-fixtures.lock.json` pins the hash of every
model that feeds a committed smoke trace. The model's bytes changed, so the
verification fails with `Generated fixture inputs changed; regenerate and
review`. The fix is `node formal/tools/generate-artifacts.mjs --write`, which
recomputes every committed artifact with Quint (about 40 s). Here the smoke
traces come out byte-identical, so the only diff is one hash in the lock, and
that diff is the review: a reviewer sees that regeneration changed no
prediction.

**The generated view.** `PROFILES.md` shows "10 exported regressions" for
source-budgets; the model now has 11. `generate-catalog-docs.mjs --check`
fails with `Generated views are stale`, and `--write` regenerates the three
views. Edit the descriptor or the catalog, never the view.

**The parity ledger.** `go-parity.json` pins two counts, `scheduledRegressions`
(468) and `exportedRegressionHistories` (358). `check-go-parity.mjs` fails
with `Quint scheduled model/check counts are stale` and `Exported Quint
regression history count is stale`. These are hand-maintained numbers, by
design: `--refresh-inputs` re-pins digests only and tells you the ledger still
fails, so a reviewer bumps both to 469 and 359 while reviewing what the
regression adds, as [GO-PARITY.md](../GO-PARITY.md#reading-and-updating-the-ledger)
describes. This course does not edit that ledger; you will see the message and
then undo everything.

Three other things a real change would carry. The differential (lesson 12)
replays the reference corpus through the new text and your 11 regressions
through the old: both directions agree, so no `behaviorVersion` bump. A
semantic case cites the run under `quintReplays` with a reviewed scope. And
the pull request names the full-workflow run that replayed it in all four
ports.

## See it in the repo

- **[generated-fixtures.mjs](../../tools/generated-fixtures.mjs)**: the
  `--verify` mode the audit lane runs
  ([validation.mjs](../../tools/validation.mjs) line 197, `--verify`) and the
  `--write` path behind `generate-artifacts.mjs`. -
  **[../../generated/README.md](../../generated/README.md)**: the two
  regeneration commands and the rule "never edit a file in this directory". -
  **[check-go-parity.mjs](../../tools/check-go-parity.mjs)**, lines 145 to 146:
  the two count checks (`scheduledRegressions`, `exportedRegressionHistories`),
  computed from the models' runs and the exported replays. -
  **[../AUTHORING.md](../AUTHORING.md#maintaining-case-and-witness-evidence)**,
  "Maintaining case and witness evidence": how a run is cited from a case. -
  **[../VALIDATION.md](../VALIDATION.md#choosing-a-run)**: which runs a behavior
  change needs before merge.

## Try it (6 min)

Start with the model edit from part 2 still in place.

1. See the lock trip, without Quint:

   ```sh
   node formal/tools/generated-fixtures.mjs --verify
   ```

   You should see `Error: Generated fixture inputs changed; regenerate and review`.

2. Regenerate the committed artifacts (about 40 s, Quint):

   ```sh
   node formal/tools/generate-artifacts.mjs --write
   git status --short
   ```

   The command ends with `{ artifacts: 36, histories: 197 }`. Git shows two
   modified files: the model and `formal/generated/generated-fixtures.lock.json`.
   `git diff formal/generated/generated-fixtures.lock.json` is one changed
   hash, the model's.

3. See the view trip, then regenerate it:

   ```sh
   node formal/tools/generate-catalog-docs.mjs --check
   node formal/tools/generate-catalog-docs.mjs --write
   git diff --stat
   ```

   The check fails with `Generated views are stale ... formal/generated/PROFILES.md`;
   the write prints `{ views: 3 }`. The diff now lists three files, and
   `PROFILES.md` changed by two cells: `10` became `11`.

4. Run the audit lane and read where it stops:

   ```sh
   make audit
   ```

   It fails at `→ Check check-go-parity` with the two `stale` count messages.
   That is the ledger asking for its review, the one step left for a human.

5. Undo everything and confirm the tree is clean:

   ```sh
   git checkout -- formal
   git status --short
   ```

   No output from `git status` means the model, the lock and the view are back
   to the committed versions. Your exported traces under `.formal-traces/`
   remain, ignored by git.

## Recap

- **A model edit trips three bookkeeping gates:** the fixture lock, the
  generated view and the parity ledger's counts, each naming its fix.
- **Two fixes are regeneration; one is a reviewed hand edit,** and the diff
  each produces is what the reviewer reads.
- **You have now done the whole loop:** contract, run, export, replay in two
  ports, the ripple of checks, and a clean undo. The same loop, with a real
  behavior change, is a pull request.

**Next:** pick a corner in [../FEATURE-COVERAGE.md](../FEATURE-COVERAGE.md) and start from `node formal/tools/where.mjs` on its contract.

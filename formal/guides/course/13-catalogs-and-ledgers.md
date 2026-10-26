# 13. Catalogs and ledgers (10 min)

**What you get:** what the JSON files under `formal/catalogs/` are for, which
one fires after which kind of edit, and how a ledger is re-keyed only after a
review.

## The idea

Lessons 10 to 12 produced evidence; this lesson is where that evidence is
recorded and reviewed. A reader learns a rule from the Quint and the guides,
never from a catalog. The catalogs exist so that review state is checkable. A
tool can say "this inventory is complete", "this claim rests on these exact
inputs", or "this guide changed since it was reviewed". They come in three
kinds.

**Manifests** schedule the work. [execution.json](../../catalogs/execution.json)
lists every model with its invariants, bounds and trace paths, and carries the
challenge catalog from lesson 11. [profiles.json](../../catalogs/profiles.json)
registers each profile with its version, input encoding, smoke trace and the
ports that claim it. Both are edited by hand and validated on every run. What
can be read from the Quint text (the runs, the libraries) is deliberately not
listed, so it cannot drift.

**Evidence catalogs** connect cases to proof. `semantic-cases.json` gives
every behavioral case its scenarios, witnesses and scoped Quint citations.
`coverage-witnesses.json` names the required labels (lesson 10).
`mutations.json` holds the native mutants (lesson 11). `fixture-recipes.json`
says how each smoke trace is produced (lesson 6). A citation here is checked
for existence and scheduling, not for meaning: the `scope` text on each
citation is the reviewer's judgment, written down.

**Ledgers** record review, keyed by content. A
[ledger](../GLOSSARY.md#ledger) stores a fingerprint of what was reviewed, so
a later edit fails the check until someone reviews again and re-keys it.

[source-audit.json](../../catalogs/source-audit.json) covers two inventories.
`sources` is the README, the `docs/` pages and the ordinary TypeScript tests,
each heading or test title with its contract dispositions. `reviewedGuides` is
every guide under `formal/guides/`, plus `formal/README.md` and
`go/README.md`, each with a content hash, its heading list, and a review
record of kind and scope.

[go-parity.json](../../catalogs/go-parity.json) pins the inputs the Go parity
claim rests on: catalog digests, a digest of the audit's dispositions and
review records, counts of models, regressions and exported histories, and
reviewed TypeScript-to-Go source mappings.

Re-keying is a command, `check-source-audit.mjs --refresh <path>`, and the
rule around it is the whole point. Run it after reading the changed prose or
assertions, never to make the check pass. It recomputes the hash and the
heading inventory and carries each disposition to the entry with the same
title. A new heading is left empty, so the check keeps failing until a
reviewer fills it in. `check-go-parity.mjs --refresh-inputs` re-pins the
digests the parity ledger reads; its hand-maintained counts and source
mappings stay until a reviewer changes them.

A third kind of ledger is a baseline, and baselines only tighten. The lint
baseline and the witness baseline each record counts that may fall and never
rise without a reviewed `baseline --write`. The style allowlist names files
exempt from a cap, and the check demands that an entry be deleted as soon as
its file fits.

This course lives under `formal/guides/course/`, which the guide inventory
does not scan. These lessons are navigation and exercises, so
`source-audit.json` needs no entry for them.

## See it in the repo

- **[../../catalogs/README.md](../../catalogs/README.md)**: one line per
  file: purpose, the check that validates it, how it changes.
- **[source-audit.json](../../catalogs/source-audit.json)**: find the
  `reviewedGuides` entry for `formal/guides/WALKTHROUGH.md`: `sha256`, five
  `entries` (its headings), and `review.kind` / `review.scope`.
- **[go-parity.json](../../catalogs/go-parity.json)**: the `inventory`
  object, including `scheduledRegressions` and `exportedRegressionHistories`;
  lesson 17 shows what moves them.
- **[../TEST-AUDIT.md](../TEST-AUDIT.md#keeping-the-audit-current)**, "Keeping
  the audit current" and
  "[Formal and Go guide review](../TEST-AUDIT.md#formal-and-go-guide-review)":
  the review rule, and what reaches the parity ledger. A changed disposition
  or review record does; a prose edit that keeps its headings does not.
- **[../GO-PARITY.md](../GO-PARITY.md#reading-and-updating-the-ledger)**,
  "Reading and updating the ledger".

## Try it (4 min)

You will edit a tracked guide and undo it at the end.

1. Check the ledger on a clean tree:

   ```sh
   node formal/tools/check-source-audit.mjs
   ```

   You should see five counts:

   ```text
   {
     sources: 50,
     tests: 633,
     sections: 216,
     reviewedGuides: 19,
     guideSections: 195
   }
   ```

2. Add a heading to a reviewed guide and check again:

   ```sh
   printf '\n## A heading I just added\n\nScratch.\n' >> formal/guides/WALKTHROUGH.md
   node formal/tools/check-source-audit.mjs
   ```

   You should see the check fail with
   `formal/guides/WALKTHROUGH.md: contents changed; review assertions/prose and refresh its audit`
   and `formal/guides/WALKTHROUGH.md: guide section inventory changed`.

3. Re-key that one file, as a reviewer would after reading the change:

   ```sh
   node formal/tools/check-source-audit.mjs --refresh formal/guides/WALKTHROUGH.md
   ```

You should see `formal/guides/WALKTHROUGH.md: refreshed, 6 entries`, then the
   five counts again with `guideSections` one higher than in step 1. Now `git
   diff --stat` shows two files: the guide and the ledger. The parity ledger did
   not move: run `node formal/tools/check-go-parity.mjs` and it still passes,
   because a heading is not a disposition and the review record is unchanged.

4. Undo both:

   ```sh
   git checkout -- formal/guides/WALKTHROUGH.md formal/catalogs/source-audit.json
   ```

   `git status --short` now prints nothing.

## Recap

- **Manifests schedule, evidence catalogs connect, ledgers record review;**
  none of them is where a rule is learned.
- **A ledger is keyed by content,** so an edit fails the check until a
  reviewer re-keys it with `--refresh`, after reading, never to silence it.
- **Baselines only tighten,** and what reaches the parity ledger is a changed
  disposition or review record, not prose.

**Next:** [14. CI lanes and running things locally](./14-lanes-and-local-runs.md)

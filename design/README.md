# Design records

A design record explains why a DialCache change took the shape it did: the
problem, the decisions, the alternatives that lost and any place where the
implementation departed from the plan. It keeps that reasoning in the
repository after issue and pull request threads have moved on.

Records explain decisions; they do not define behavior. Quint and the formal
guides ([SPEC.md](../formal/guides/SPEC.md),
[CONTRACTS.md](../formal/guides/CONTRACTS.md) and
[PROTOCOL.md](../formal/guides/PROTOCOL.md)) define portable behavior, and
[docs/](../docs/index.md) documents each port's public API. Documentation never
cites a record as the source of a guarantee, and no check validates records or
the links inside them.

## Decide whether a change needs a record

Write a record before implementing:

- a new or changed portable contract: an obligation added to, changed in or
  removed from `CONTRACTS.md`;
- a new conformance profile, even one that adds no obligation, because every
  port must replay it;
- a redesign of how conformance is established: the kernel library or how
  profiles compose over it, the replay protocol or shared observation record,
  or what a validation gate requires;
- a public API addition or removal that every port must mirror, or a reshape of
  one port's public API that changes how callers construct the cache or call
  its operations, such as the Go redesign in #190;
- a change that reverses a decision made in an earlier record or issue.

These need no record:

- A bug fix that makes a port or a Quint model meet the existing contract,
  such as restoring an invariant that lost strength when a profile was composed
  (#186). Its regression or challenge documents the fix. When Quint and an
  implementation disagree and the contract text stays the same, the
  distinguishing regression and the decision comment that
  [AUTHORING.md](../formal/guides/AUTHORING.md) asks for are enough.
- New invariants, regressions or challenges in an existing profile.
- A change confined to one port that adds, renames or removes public names
  without changing how callers construct the cache or call its operations,
  such as exporting an existing type or deleting an unused function. The
  commit body carries the reasoning.
- Other documentation, refactoring, tooling and dependency changes.

## Find existing records

Before changing a feature, search the records for its contract IDs, profile
name and public API names, for example `grep -rl -e C41 -e recovery design/`,
and read each match, newest first. Decisions made before records existed live
in issues, including issues closed as not planned, so search those too, for
example `gh search issues compression --repo lan17/DialCache`.

A change that contradicts a confirmed decision in a record that is not yet
`Implemented` changes that decision within the same record, as step 4 below
describes. Once a record is `Implemented`, a contradicting change needs a new
record.

## Write a record

Each record is one file named `YYYY-MM-DD-{slug}.md`, dated when the record is
first written. Copy [TEMPLATE.md](./TEMPLATE.md) and replace every
`{placeholder}`.

Keep the record self-contained. Carry each decision, the alternatives that
lost and any measurement that decided it into the record, with the commit the
measurement was taken at. Leave out local file paths, session logs, unchecked
Quint drafts and anything that should not be public; the checked model lands
under `formal/models/` in the implementing pull request.

One record may cover several pull requests. An issue that already holds a
design, such as #217, keeps its body; the record restates the decisions still
in force and names the issue's design under Supersedes.

A record written after its work merged starts as `Implemented`. It lists the
contract IDs that now state the behavior, and marks a decision `Confirmed` only
where the issue or pull request shows a maintainer approving it.

## Take a record from proposal to merge

1. **Propose.** Add the record with status `Proposed`, either in its own pull
   request when the decisions need review before code, or as the first commit
   of the implementing pull request. Reference the issue from the record and
   the pull request: `Refs #n`, or `Closes #n` in the pull request that
   completes the work. GitHub then lists the pull request on the issue, so the
   issue body can stay a statement of the problem. The pull request
   description names the record's path.
2. **Decide.** Each decision states its choice and the rejected alternatives,
   with the reason each lost. Only a maintainer confirms a decision; a comment
   or review that an agent wrote is not an approval, even when it is posted
   from a maintainer's account. An agent writes every decision as `Open` and
   changes it to `Confirmed` only after a maintainer approves the choice,
   recording the date and where the approval was given. When no decision is
   `Open`, the record's status becomes `Accepted`. The implementing pull
   request stays in draft until then.
3. **Implement.** A change to a portable contract updates `CONTRACTS.md` and the
   Quint models as [AUTHORING.md](../formal/guides/AUTHORING.md#codifying-the-next-behavior)
   describes. The record lists the existing contract IDs it changes. The
   implementing pull request adds each new contract ID and the final profile
   name once they exist, so a search for either finds the record. Invariants,
   regressions and challenges beyond the planned ones are not deviations.
4. **Keep history visible.** A confirmed decision is never silently rewritten.
   A changed decision moves its earlier choice into Rejected, with the date and
   the reason, and returns to `Open`. Until a maintainer confirms the new
   choice, the record returns to `Proposed` and the implementing pull request
   returns to draft. When the new choice is an alternative rejected earlier,
   its Choice keeps that rejection's reason and says why it no longer holds.
   A pull request whose behavior or public API departs from the record's
   Proposal or its Contract and model changes adds a Deviations entry in the
   same pull request. Exporting a type that the record kept private is one
   such departure.
5. **Close.** Each implementing pull request adds itself to the record's list,
   and the one that completes the work sets the status to `Implemented`. After
   that, only the status, the pull request list, Deviations and paths that a
   file move broke change.

A new record that replaces every decision of an older one sets the older
record's status to `Superseded`, with a link to the new file. When it replaces
only some, the older record keeps its status and gains a Deviations entry
naming the new file and the decisions it replaces. A record whose change will
not be made becomes `Withdrawn`.

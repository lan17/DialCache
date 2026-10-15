<!-- Copy to design/YYYY-MM-DD-{slug}.md, replace every {placeholder} outside
comments, braces included, and delete this comment. design/README.md defines
each status. -->

# {Change title}

- **Status:** Proposed
- **Issue:** {#number, or none}
- **Pull requests:** {#number for each, added as they open}
- **Baseline:** `main` at `{commit}`, the commit the record was written against
- **Supersedes:** {an earlier record's path, with the decisions it replaces
  when not all; the design in issue #number; or none}

## Context

{The problem, who needs the change and the constraints that shape it.}

## Proposal

{The observable behavior and the public API shape the decisions depend on: in
TypeScript, the reference port, and in any port whose shape differs, or in the
one port a single-port change touches. For a formal-infrastructure change,
describe the protocol, record or check shape instead. Keep it short: once
merged, CONTRACTS.md, Quint and docs/ state the precise rule.}

## Out of scope

{Non-goals, and options deferred rather than rejected, each with the evidence
that would reopen it. Write "None." if there are none.}

## Contract and model changes

{Write "None." if the change leaves every portable contract, Quint model and
conformance profile unchanged, and say why. A change that restructures models
or driver channels without changing a contract names them and says how their
histories are shown to be unchanged. Otherwise list the existing
contract IDs changed or removed in CONTRACTS.md, and each new obligation; the
implementing pull request adds its ID once CONTRACTS.md assigns one. Name the
Quint model or conformance profile extended or added, with its planned
invariants and regressions. Name any behavior that stays a native binding
detail, with the reason.}

## Decisions

### D1. {The question being decided}

- **Choice:** {the chosen answer, or the recommendation while Open}
- **Status:** Open
- **Rejected:**
  - {An alternative, and why it lost.}

<!-- Only a maintainer's approval changes a status to "Confirmed YYYY-MM-DD,
{a link to his comment or review, or "in session:" and his words quoted}". A
changed decision moves its earlier choice into Rejected with the date and
reason. -->

## Impact

{The ports, documentation pages, catalogs and generated files expected to
change, and any migration or upgrade notes.}

## Plan

{The pull requests or commits that deliver the change, in order.}

## Deviations

None.

<!-- Each entry: - **YYYY-MM-DD, #number:** what departed from the record, and why. -->
